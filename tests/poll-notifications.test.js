const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { poll, MAX_REQUESTS, MAX_RETRIES, MAX_BYTES, RETRY_LIFETIME } = require('../bin/poll-notifications.js');

function fixture(t, handler, tick = 60 * 1000) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'notification-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'notification-since'), '2026-10-09T11:00:00Z');
  const calls = [];
  let clock = Date.now();
  const run = (command, args, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 2000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    calls.push(args);
    if (args[1] === 'user') return { status: 0, stdout: 'bot\n' };
    const { status = 200, body = [], link = '' } = handler(args[2]);
    return { status: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} Result\nDate: Fri, 09 Oct 2026 12:00:00 GMT\nX-Poll-Interval: 0\nLink: ${link}\n\n${JSON.stringify(body)}` };
  };
  return { calls, dir, advance: ms => { clock += ms; }, poll: () => {
    clock += tick;
    return poll({ dir, tools: dir, bot: 'bot', operator: 'human', run, now: () => clock });
  }, state: () => JSON.parse(fs.readFileSync(path.join(dir, 'notification-work'))) };
}

const thread = id => ({ subject: { type: 'Issue', url: `https://api.github.com/repos/o/r/issues/${id}`, latest_comment_url: `https://api.github.com/repos/o/r/issues/comments/${id}` } });
const comment = id => ({ user: { login: 'human', type: 'User' }, html_url: `https://github.com/o/r/issues/1#issuecomment-${id}`, updated_at: '2026-10-09T11:30:00Z' });
const issue = { state: 'open', user: { login: 'bot' } };

for (const failure of [404, 410, 451, 500, 403, 429]) {
  test(`mixed success and ${failure}, with recovery`, t => {
    let recovered = false;
    const f = fixture(t, url => {
      if (url.startsWith('notifications?')) return { body: [thread(1), thread(2)] };
      if (url.endsWith('comments/2') && !recovered) return { status: failure };
      if (url.includes('comments/')) return { body: comment(url.split('/').pop()) };
      return { body: issue };
    });
    assert.equal(f.poll().length, 1);
    assert.equal(f.state().retry.length, failure >= 500 || [403, 429].includes(failure) ? 1 : 0);
    assert.equal(fs.readFileSync(path.join(f.dir, 'notification-since'), 'utf8'), '2026-10-09T12:00:00Z');
    recovered = true;
    assert.equal(f.poll().length, [403, 429, 500].includes(failure) ? 1 : 0);
    assert.equal(f.state().retry.length, 0);
    assert.deepEqual(f.poll(), []);
  });
}

test('over-budget feed resumes without advancing past unprocessed work', t => {
  const f = fixture(t, url => url.startsWith('notifications?') ? { body: Array.from({ length: 100 }, (_, i) => thread(i)) } : { body: url.includes('comments/') ? comment(url.split('/').pop()) : issue });
  let delivered = f.poll().length;
  assert.ok(delivered > 0 && delivered < 100);
  assert.ok(f.calls.length <= MAX_REQUESTS);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notification-since'), 'utf8'), '2026-10-09T11:00:00Z');
  while (f.state().queue.length) delivered += f.poll().length;
  assert.equal(delivered, 100);
});

test('repeated next link stops and retains the acquisition window', t => {
  const next = 'https://api.github.com/notifications?page=2';
  const f = fixture(t, () => ({ body: [], link: `<${next}>; rel="next"` }));
  assert.deepEqual(f.poll(), []);
  assert.equal(f.calls.length, 3);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notification-since'), 'utf8'), '2026-10-09T11:00:00Z');
});

for (const failure of [403, 429, 503]) {
  test(`large ${failure} backlog cannot starve later pages or windows`, t => {
    const next = 'https://api.github.com/notifications?page=2';
    let firstPages = 0;
    let laterPages = 0;
    const f = fixture(t, url => {
      if (url.startsWith('notifications?')) {
        firstPages++;
        return firstPages === 1
          ? { body: Array.from({ length: 100 }, (_, i) => thread(i)), link: `<${next}>; rel="next"` }
          : { body: [thread(102)] };
      }
      if (url === next) {
        laterPages++;
        return { body: [thread(101)] };
      }
      if (url.includes('comments/')) {
        const id = Number(url.split('/').pop());
        return id < 100 ? { status: failure } : { body: { ...comment(id), updated_at: id === 102 ? '2026-10-09T12:01:00Z' : comment(id).updated_at } };
      }
      return { body: issue };
    });
    const delivered = [];
    for (let iteration = 0; iteration < 30; iteration++) {
      const before = f.calls.length;
      delivered.push(...f.poll());
      assert.ok(f.calls.length - before <= MAX_REQUESTS);
      if (f.state().queue.length) {
        assert.equal(fs.readFileSync(path.join(f.dir, 'notification-since'), 'utf8'), '2026-10-09T11:00:00Z');
      }
    }
    assert.equal(laterPages, 1);
    assert.ok(firstPages > 1, 'acquisition continues into later windows');
    assert.deepEqual(delivered, [
      `${comment(101).html_url} ${comment(101).updated_at}`,
      `${comment(102).html_url} 2026-10-09T12:01:00Z`,
    ]);
    assert.equal(f.state().retry.length, 100, 'repeated failures stay separate and deduplicated');
    assert.equal(f.state().queue.length, 0);
  });
}

test('page cap resumes at the next page', t => {
  let page = 0;
  const f = fixture(t, () => ({ body: [], link: `<https://api.github.com/notifications?page=${++page}>; rel="next"` }));
  f.poll();
  assert.equal(page, 4);
  assert.equal(f.state().next, 'https://api.github.com/notifications?page=4');
  f.poll();
  assert.equal(page, 8);
});

test('timeout retains work and still publishes prior verified news', t => {
  const f = fixture(t, url => {
    if (url.startsWith('notifications?')) return { body: [thread(1), thread(2)] };
    if (url.endsWith('comments/2')) throw new Error('request timed out');
    return { body: url.includes('comments/') ? comment(1) : issue };
  });
  assert.equal(f.poll().length, 1);
  assert.equal(f.state().retry.length, 1);
});

test('expired deadline makes no network requests', t => {
  const f = fixture(t, () => { throw new Error('must not run'); });
  assert.deepEqual(poll({ dir: f.dir, tools: f.dir, bot: 'bot', operator: 'human', seconds: 0, run: () => { throw new Error('must not run'); } }), []);
  assert.equal(f.state().queue.length, 0);
});

test('304 still retries transient work', t => {
  let recovery = false;
  const f = fixture(t, url => {
    if (url.startsWith('notifications?')) return recovery ? { status: 304 } : { body: [thread(1)] };
    if (url.includes('comments/')) return recovery ? { body: comment(1) } : { status: 503 };
    return { body: issue };
  });
  assert.deepEqual(f.poll(), []);
  recovery = true;
  assert.equal(f.poll().length, 1);
  assert.equal(f.state().retry.length, 0);
});

test('unavailable issue does not suppress another verified thread', t => {
  const f = fixture(t, url => {
    if (url.startsWith('notifications?')) return { body: [thread(1), thread(2)] };
    if (url.includes('comments/')) return { body: comment(url.split('/').pop()) };
    return url.endsWith('/2') ? { status: 404 } : { body: issue };
  });
  assert.equal(f.poll().length, 1);
  assert.equal(f.state().retry.length, 0);
});

test('changing failing threads coalesce across windows without resetting backoff or age', t => {
  let window = 0;
  let reads = 0;
  const f = fixture(t, url => {
    if (url.startsWith('notifications?')) return { body: [{ ...thread(1), updated_at: String(++window) }] };
    reads++;
    return { status: 403 };
  }, 1000);
  for (let i = 0; i < 100; i++) {
    f.poll();
    assert.equal(f.state().retry.length, 1);
    assert.equal(f.state().retry[0].pollSince, '2026-10-09T11:00:00Z');
    assert.ok(fs.statSync(path.join(f.dir, 'notification-work')).size <= MAX_BYTES);
  }
  assert.equal(window, 100);
  assert.equal(reads, 2, 'new activity does not bypass exponential backoff');
  f.advance(RETRY_LIFETIME);
  f.poll();
  assert.equal(f.state().retry[0].retryAttempts, 1, 'expiry starts fresh work, not an immortal retry');
});

test('distinct failing threads remain count bounded across windows', t => {
  let window = 0;
  const f = fixture(t, url => url.startsWith('notifications?')
    ? { body: Array.from({ length: 10 }, (_, i) => thread(window++)) }
    : { status: 503 }, 1000);
  for (let i = 0; i < 100; i++) {
    f.poll();
    assert.ok(f.state().retry.length <= MAX_RETRIES);
    assert.ok(fs.statSync(path.join(f.dir, 'notification-work')).size <= MAX_BYTES);
  }
  assert.equal(f.state().retry.length, MAX_RETRIES);
});

test('oversized legacy state is discarded before parsing and reported as sweep fallback', t => {
  const f = fixture(t, () => ({ status: 304 }));
  fs.writeFileSync(path.join(f.dir, 'notification-work'), 'x'.repeat(MAX_BYTES + 1));
  const warnings = [];
  t.mock.method(console, 'error', message => warnings.push(message));
  assert.deepEqual(f.poll(), []);
  assert.equal(f.state().retry.length, 0);
  assert.ok(warnings.some(message => message.includes('falling back to the full sweep')));
});

test('retry lifetime expires even without further activity', t => {
  let first = true;
  const warnings = [];
  t.mock.method(console, 'error', message => warnings.push(message));
  const f = fixture(t, url => {
    if (url.startsWith('notifications?')) {
      if (!first) return { status: 304 };
      first = false;
      return { body: [thread(1)] };
    }
    return { status: 403 };
  });
  f.poll();
  f.advance(RETRY_LIFETIME);
  f.poll();
  assert.equal(f.state().retry.length, 0);
  assert.ok(warnings.some(message => message.includes('falling back to the full sweep')));
});

test('oversized acquired work is not persisted', t => {
  const warnings = [];
  t.mock.method(console, 'error', message => warnings.push(message));
  const f = fixture(t, url => url.startsWith('notifications?')
    ? { body: [{ ...thread(1), extra: 'x'.repeat(MAX_BYTES) }] }
    : { status: 503 });
  f.poll();
  assert.ok(fs.statSync(path.join(f.dir, 'notification-work')).size <= MAX_BYTES);
  assert.equal(f.state().retry.length, 0);
  assert.ok(warnings.some(message => message.includes('falling back to the full sweep')));
});

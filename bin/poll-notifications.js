// Read-only notification polling; the caller holds the poll-loop lock.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_REQUESTS = 24;
const MAX_PAGES = 4;
const MAX_BYTES = 1024 * 1024;
const MAX_THREADS = 100;
const MAX_RETRIES = 200;
const RETRY_LIFETIME = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;
const MAX_RETRY_DELAY = 60 * 60 * 1000;
const terminal = new Set([404, 410, 451]);
const commentURL = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(issues\/comments|pulls\/comments|pulls\/[0-9]+\/reviews)\/[0-9]+$/;
const issueURL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/([0-9]+)$/;

function poll({ dir, tools, bot, operator, seconds = 10, run = spawnSync, now = Date.now }) {
  const read = (name, fallback = '') => {
    try { return fs.readFileSync(path.join(dir, name), 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  };
  const write = (name, value) => {
    fs.writeFileSync(path.join(dir, `${name}.tmp`), value);
    fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
  };
  const deadline = Date.now() + Math.min(10, seconds) * 1000;
  let requests = 0;
  const invoke = (command, args) => {
    if (requests >= MAX_REQUESTS || Date.now() >= deadline) throw new Error('notification batch budget exhausted');
    requests++;
    const result = run(command, args, { encoding: 'utf8', timeout: Math.max(1, Math.min(2000, deadline - Date.now())), killSignal: 'SIGKILL', maxBuffer: MAX_BYTES });
    if (result.error) throw new Error(`notification request failed: ${result.error.message}`);
    return result;
  };
  const api = (url, headers = []) => {
    const result = invoke('gh', ['api', '-i', url, ...headers]);
    const raw = result.stdout.replace(/\r\n/g, '\n');
    const split = raw.indexOf('\n\n');
    const lines = raw.slice(0, split).split('\n');
    const status = Number(lines.shift()?.split(' ')[1]);
    const values = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) values[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    if (terminal.has(status)) return { status, headers: values };
    if (status === 304) return { status, headers: values };
    if (result.status !== 0 || status !== 200 || split < 0) throw new Error(`notification API read failed (${status || 'no HTTP status'})`);
    return { status, headers: values, body: JSON.parse(raw.slice(split + 2)) };
  };
  const fallback = reason => console.error(`warning: ${reason}; falling back to the full sweep`);
  const emptyState = () => ({ queue: [], retry: [], next: null, visited: [] });
  let state;
  try {
    // Check before allocating or parsing an old, potentially unbounded backlog.
    if (fs.statSync(path.join(dir, 'notification-work')).size > MAX_BYTES) {
      fallback('notification retained state exceeds byte limit');
    } else state = JSON.parse(read('notification-work', 'null'));
  } catch (error) {
    if (error.code !== 'ENOENT') fallback(`invalid notification retained state: ${error.message}`);
  }
  if (!state) state = { queue: [], retry: [], next: null, visited: [] };
  const keyOf = thread => thread.subject?.url;
  const coalesce = threads => {
    const merged = new Map();
    for (const thread of threads) {
      const key = keyOf(thread);
      if (!key) continue;
      const previous = merged.get(key);
      merged.set(key, previous ? {
        ...previous, subject: thread.subject,
        pollSince: [previous.pollSince, thread.pollSince].filter(Boolean).sort()[0],
      } : thread);
    }
    return [...merged.values()];
  };
  const boundRetries = () => {
    const merged = coalesce(state.retry);
    for (const thread of merged) thread.retryStarted ??= now();
    state.retry = merged.filter(thread => now() - thread.retryStarted < RETRY_LIFETIME).slice(0, MAX_RETRIES);
    if (state.retry.length < merged.length) fallback('notification retries expired or exceeded count limit');
  };
  boundRetries();
  const seen = new Set(read('comment-seen').split('\n').filter(Boolean));
  const news = [];
  let failed = false;
  let board;
  const since = read('notification-since', new Date(Date.now() - 600000).toISOString().replace('.000', ''));
  if (!read('notification-since')) write('notification-since', since);
  try {
    if (Date.now() / 1000 < Number(read('notification-due', '0'))) return [];
    const identity = invoke('gh', ['api', 'user', '--jq', '.login']);
    if (identity.status !== 0 || identity.stdout.trim() !== bot) throw new Error('notification bot identity verification failed');
    // Acquisition and first attempts have priority over retries. Keep retries
    // separate so a failing backlog cannot pin pagination or the next window.
    let retriesRemaining = state.retry.length;
    let pages = 0;
    while (!state.queue.length && pages < MAX_PAGES) {
      if (!state.next && state.visited.length) break;
      const url = state.next || `notifications?all=true&since=${since}&per_page=100`;
      if (state.visited.includes(url)) {
        // A cyclic feed cannot be completed: restart the same window later.
        state.next = null;
        state.visited = [];
        failed = true;
        break;
      }
      if (state.next && !/^https:\/\/api\.github\.com\/notifications\?/.test(url)) throw new Error('unsafe notification pagination URL');
      const modified = read('notification-modified');
      const response = api(url, !state.next && modified ? ['-H', `If-Modified-Since: ${modified}`] : []);
      const interval = /^\d+$/.test(response.headers['x-poll-interval'] || '') ? Number(response.headers['x-poll-interval']) : 60;
      write('notification-due', String(Math.floor(Date.now() / 1000) + interval));
      if (response.status === 304) break;
      if (!Array.isArray(response.body) || response.body.length > MAX_THREADS) throw new Error('invalid or oversized notification page');
      if (!state.visited.length) {
        const date = new Date(response.headers.date || Date.now());
        state.until = date.toISOString().replace('.000', '');
        state.modified = response.headers['last-modified'] || '';
      }
      state.visited.push(url);
      state.next = response.headers.link?.match(/<([^>]+)>; rel="next"/)?.[1] || null;
      state.queue = response.body.filter(t => ['Issue', 'PullRequest'].includes(t.subject?.type)).map(t => ({ ...t, pollSince: since }));
      pages++;
    }
    state.queue = coalesce(state.queue);
    const count = Math.min(MAX_THREADS, state.queue.length + retriesRemaining);
    for (let index = 0; index < count; index++) {
      if (requests + 3 > MAX_REQUESTS || Date.now() >= deadline) break;
      let thread;
      if (state.queue.length) thread = state.queue.shift();
      else {
        if (!retriesRemaining) break;
        retriesRemaining--;
        thread = state.retry.shift();
      }
      // New activity refreshes the endpoint, not the retry's age or backoff.
      const existing = state.retry.findIndex(retry => keyOf(retry) === keyOf(thread));
      if (existing >= 0) {
        const previous = state.retry.splice(existing, 1)[0];
        thread = coalesce([previous, thread])[0];
        retriesRemaining = Math.min(retriesRemaining, state.retry.length);
      }
      if (thread.retryAfter > now()) {
        state.retry.push(thread);
        continue;
      }
      try {
        const latest = thread.subject?.latest_comment_url;
        const match = thread.subject?.url?.match(issueURL);
        if (!commentURL.test(latest) || !match) continue;
        const response = api(latest);
        if (terminal.has(response.status)) continue;
        const comment = response.body;
        const timestamp = comment.updated_at || comment.submitted_at || comment.created_at || '';
        if (comment.user?.login !== operator || comment.user?.type !== 'User' || timestamp < (thread.pollSince || since)) continue;
        const issueResponse = api(`repos/${match[1]}/issues/${match[3]}`);
        if (terminal.has(issueResponse.status)) continue;
        const issue = issueResponse.body;
        if (issue.state !== 'open') continue;
        if (issue.user?.login !== bot && !issue.assignees?.some(user => user.login === bot)) {
          if (!board) {
            const result = invoke(path.join(tools, 'bot-board'), ['list', '--json']);
            if (result.status !== 0) throw new Error('notification board read failed');
            board = JSON.parse(result.stdout);
          }
          if (!board.some(item => item.content?.url === issue.html_url || (item.branch || '').split(' ').includes(issue.html_url))) continue;
        }
        const key = `${comment.html_url} ${timestamp}`;
        if (!seen.has(key)) { seen.add(key); news.push(key); }
      } catch (error) {
        thread.retryStarted ??= now();
        thread.retryAttempts = (thread.retryAttempts || 0) + 1;
        thread.retryAfter = now() + Math.min(MAX_RETRY_DELAY, RETRY_DELAY * 2 ** Math.min(thread.retryAttempts - 1, 6));
        state.retry.push(thread);
        failed = true;
      }
    }
    if (!state.queue.length && !state.next && state.until && state.visited.length) {
      // Retries carry their own threads; they do not pin the acquisition cursor.
      write('notification-since', state.until);
      write('notification-modified', state.modified);
      state.until = null;
      state.visited = [];
    }
  } catch (error) {
    failed = true;
    console.error(`warning: ${error.message}; notification work retained`);
  } finally {
    boundRetries();
    let retained = JSON.stringify(state);
    if (Buffer.byteLength(retained) > MAX_BYTES) {
      fallback('notification retained state exceeds byte limit');
      retained = JSON.stringify(emptyState());
    }
    write('notification-work', retained);
    write('comment-seen', [...seen].sort().join('\n') + '\n');
  }
  if (failed) console.error('warning: incomplete notification reads; retrying without suppressing verified news');
  return news;
}

if (require.main === module) {
  const [dir, tools, bot, operator, seconds] = process.argv.slice(2);
  console.log(poll({ dir, tools, bot, operator, seconds: Number(seconds) }).join('\n'));
}

module.exports = { poll, MAX_REQUESTS, MAX_RETRIES, MAX_BYTES, RETRY_LIFETIME };

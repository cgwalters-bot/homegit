// Real heartbeat publisher and registration processes, against a fake REST
// service: publication ordering, persistence failures, and session ownership.
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const HEARTBEAT = path.join(ROOT, "bin", "bot-heartbeat");
const REGISTER = path.join(ROOT, "lib", "heartbeat-register.js");
const OWNER = "owner-session";
const ORIGINAL = { name: "existing", item_url: "https://github.com/o/r/issues/3", started_at: "2026-09-28T12:00:00Z", status: "testing", agent_ids: ["agent123"] };

function world(session = OWNER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-state-test-"));
  const state = path.join(dir, "state", "bot-heartbeat", "last-publish.json");
  fs.writeFileSync(path.join(dir, "operator.json"), "{}");
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, "state"), XDG_CACHE_HOME: path.join(dir, "cache"),
    BOT_OPERATOR_CONFIG: path.join(dir, "operator.json"), BOT_HEARTBEAT_PROJECTS: path.join(dir, "projects"),
    PATH: `${dir}:${process.env.PATH}`, WORLD: dir, STATE: state, CLAUDE_CODE_SESSION_ID: session };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "BOT_HEARTBEAT_NOW", "BOT_HEARTBEAT_STALE_HOURS"]) delete env[key];
  if (session === null) delete env.CLAUDE_CODE_SESSION_ID;
  fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.WORLD;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
const api = args.find(a => a.startsWith('repos/'));
const usage = api && api.startsWith('repos/cgwalters-forge/bot-ops/');
const comments = path.join(dir, usage ? 'usage-comment.json' : 'comment.json');
if (args.includes('PATCH') || args.includes('POST')) {
  const body = JSON.parse(fs.readFileSync(0, 'utf8')).body;
  if (fs.existsSync(path.join(dir, 'fail-one')) && body.includes('PVTI_one')) {
    console.error('injected publication failure'); process.exit(1);
  }
  const active = path.join(dir, 'active');
  try { fs.writeFileSync(active, '', {flag: 'wx'}); }
  catch { console.error('overlapping publications'); process.exit(1); }
   const finish = () => {
    fs.writeFileSync(comments, JSON.stringify({id: 9, html_url: 'https://github.com/o/r/issues/1#issuecomment-9', login: 'cgwalters-bot', body}));
    if (!usage && fs.existsSync(path.join(dir, 'fail-save'))) {
      fs.renameSync(process.env.STATE, process.env.STATE + '.backup');
      fs.mkdirSync(process.env.STATE);
    }
    fs.unlinkSync(active);
    console.log('https://github.com/o/r/issues/1#issuecomment-9');
   };
   if (!usage && fs.existsSync(path.join(dir, 'hold-publish')) && !fs.existsSync(path.join(dir, 'release-publish'))) {
     const watcher = fs.watch(dir, (_event, name) => {
       if (name === 'release-publish') { watcher.close(); finish(); }
     });
   } else setTimeout(finish, fs.existsSync(path.join(dir, 'long-delay')) && !usage ? 11000 : fs.existsSync(path.join(dir, 'delay')) ? 200 : 0);
} else if (api && api.includes('/comments?')) {
  if (fs.existsSync(comments)) console.log(fs.readFileSync(comments, 'utf8'));
  if (!usage && fs.existsSync(path.join(dir, 'fail-save-read'))) {
    fs.renameSync(process.env.STATE, process.env.STATE + '.backup');
    fs.mkdirSync(process.env.STATE);
  }
} else if (args.includes('user')) console.log('cgwalters-bot');
else if (api === 'repos/cgwalters-forge/bot-ops') console.log('true');
else if (api === 'repos/o/r') console.log('false');
else if (api === 'repos/o/private') console.log('true');
else if (api && api.startsWith('repos/o/r/issues/')) console.log('open');
else { console.error('unexpected fake API call: ' + args.join(' ')); process.exit(1); }
`, { mode: 0o755 });
  const input = { coordinator: { session: "coordinator-session", loop_state: "working" }, workers: [ORIGINAL] };
  const seed = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { input: JSON.stringify(input), env, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  fs.writeFileSync(path.join(dir, "calls"), "");
  return { dir, state, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    saved: () => JSON.parse(fs.readFileSync(state, "utf8")),
    calls: () => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}

test("run health validates sanitized identities, fractional times, counters and age boundaries", () => {
  const { validate } = require(HEARTBEAT);
  const t = Date.parse("2026-10-05T12:00:00.123Z");
  const run = { repo: "o/r", run_id: 42, attempt: 1, evaluated_at: new Date(t).toISOString(),
    health: "healthy", last_activity_at: new Date(t).toISOString(), tokens: 0 };
  const input = { coordinator: { session: OWNER, loop_state: "working" }, workers: [{ ...ORIGINAL, name: "run-42", location: "remote", run_health: run }] };
  const hb = validate(input, t).hb;
  assert.equal(hb.workers[0].run_health.health, "healthy");
  assert.equal(hb.workers[0].run_health.tokens, undefined);
  const normalizedTime = Date.parse(hb.workers[0].run_health.evaluated_at);
  assert.equal(validate(input, normalizedTime + 300000).hb.workers[0].run_health.health, "healthy");
  assert.equal(validate(input, normalizedTime + 300001).hb.workers[0].run_health.health, "unknown");
  const sourced = structuredClone(input);
  sourced.workers[0].run_health.observed_at = new Date(normalizedTime - 240000).toISOString();
  assert.equal(validate(sourced, normalizedTime + 60000).hb.workers[0].run_health.health, "healthy");
  const expired = validate(sourced, normalizedTime + 60001).hb.workers[0].run_health;
  assert.equal(expired.health, "unknown");
  assert.equal(expired.last_activity_at, null);
  assert.equal(Date.parse(expired.observed_at), Date.parse(sourced.workers[0].run_health.observed_at));
  for (const patch of [{ tokens: -1 }, { tokens: Number.MAX_SAFE_INTEGER + 1 }, { attempt: 0 }, { run_id: "42" },
    { health: "unknown" }, { health: "arbitrary text" }, { private_id: "secret" },
    { evaluated_at: new Date(t + 1).toISOString() }, { observed_at: new Date(t + 1).toISOString() },
    { last_activity_at: new Date(t + 1).toISOString() }]) {
    const bad = structuredClone(input);
    Object.assign(bad.workers[0].run_health, patch);
    assert.throws(() => validate(bad, t), /invalid heartbeat/);
  }
});

for (const owner of [OWNER, null]) {
  test(`watch heartbeat updates preserve owner ${owner}, private IDs and activity semantics`, () => {
    const w = world(owner);
    try {
      const t = Math.floor(Date.now() / 1000) * 1000;
      w.env.BOT_HEARTBEAT_NOW = new Date(t).toISOString();
      const input = w.saved().input;
      input.workers.push({ ...ORIGINAL, name: "run-42", location: "remote", item_url: "https://github.com/o/r/issues/1", agent_ids: ["private456"] });
      const seed = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { input: JSON.stringify(input), env: w.env, encoding: "utf8" });
      assert.equal(seed.status, 0, seed.stderr);
      const item = { id: "PVTI_item", status: "In Progress", content: { url: input.workers[1].item_url }, run: "https://github.com/o/r/actions/runs/42" };
      const result = { repo: "o/r", run_id: 42, attempt: 1, item: item.id, run: item.run, health: "healthy", last_activity_at: new Date(t - 1000).toISOString().replace(".000Z", "Z"), tokens: 1234,
        observed_at: new Date(t - 240000).toISOString().replace(".000Z", "Z"),
        reasons: ["never publish this"], private_id: "secret-id" };
      const update = (it = item, r = result, at = t) => spawnSync(process.execPath, ["-e", `const fs = require('node:fs'); const x = JSON.parse(fs.readFileSync(0, 'utf8'));
process.exit(require(${JSON.stringify(REGISTER)}).updateRun(x.item, x.result, {evaluatedAt: x.at}) ? 0 : 1);`], {
        env: { ...w.env, CLAUDE_CODE_SESSION_ID: "watch-session", BOT_HEARTBEAT_NOW: new Date(at).toISOString() }, encoding: "utf8",
        input: JSON.stringify({ item: it, result: r, at: new Date(at).toISOString() }),
      });
      const first = update();
      assert.equal(first.status, 0, first.stderr);
      const saved = w.saved();
      assert.equal(saved.session, owner);
      assert.deepEqual(saved.input.coordinator, input.coordinator);
      assert.deepEqual(saved.input.workers[0], ORIGINAL);
      assert.deepEqual(saved.input.workers[1].agent_ids, ["private456"]);
      assert.equal(saved.input.workers[1].run_health.tokens, 1234);
      assert.equal(saved.input.workers[1].run_health.observed_at, result.observed_at);
      assert.equal(saved.published.workers[1].run_health.observed_at, result.observed_at);
      assert.equal(saved.input.workers[1].last_activity_at, result.last_activity_at);
      const body = JSON.parse(fs.readFileSync(path.join(w.dir, "comment.json"), "utf8")).body;
      assert.match(body, /healthy; last execution activity/);
      assert.doesNotMatch(body, /tokens|private456|secret-id|never publish this/);
      const usageBody = JSON.parse(fs.readFileSync(path.join(w.dir, "usage-comment.json"), "utf8")).body;
      assert.equal(require(HEARTBEAT).parseComment(usageBody).runs[0].tokens, 1234);
      assert.doesNotMatch(usageBody, /private456|secret-id|never publish this/);
      const before = fs.readFileSync(w.state, "utf8");
      for (const [it, r, at] of [
        [item, result, t], // idempotent / out-of-order evaluation
        [{ ...item, lead: "topic" }, result, t + 1000],
        [{ ...item, status: "Draft" }, result, t + 1000],
        [{ ...item, content: { url: ORIGINAL.item_url } }, result, t + 1000],
        [item, { ...result, run_id: 99 }, t + 1000],
      ]) {
        const ignored = update(it, r, at);
        assert.equal(ignored.status, 0, ignored.stderr);
        assert.equal(fs.readFileSync(w.state, "utf8"), before);
      }
      const unknown = update(item, { ...result, health: "unknown", tokens: 9999 }, t + 1000);
      assert.equal(unknown.status, 0, unknown.stderr);
      assert.equal(w.saved().input.workers[1].last_activity_at, result.last_activity_at);
      assert.equal(w.saved().published.workers[1].run_health.last_activity_at, null);
      assert.equal(w.saved().input.workers[1].run_health.tokens, null);
      const rerun = update(item, { ...result, attempt: 2, health: "unknown" }, t + 2000);
      assert.equal(rerun.status, 0, rerun.stderr);
      assert.equal(w.saved().input.workers[1].last_activity_at, undefined);
      const rerunState = fs.readFileSync(w.state, "utf8");
      assert.equal(update(item, result, t + 3000).status, 0);
      assert.equal(fs.readFileSync(w.state, "utf8"), rerunState);
      const invalid = update(item, { ...result, attempt: 2, tokens: -1 }, t + 3000);
      assert.equal(invalid.status, 1);
      assert.equal(fs.readFileSync(w.state, "utf8"), rerunState);
      // A fresh evaluation cannot renew already expired producer evidence.
      assert.equal(update(item, { ...result, attempt: 2 }, t + 61000).status, 0);
      assert.equal(w.saved().input.workers[1].run_health.health, "healthy");
      assert.equal(w.saved().published.workers[1].run_health.health, "unknown");
      // Ordinary refresh also keeps evidence unknown without moving activity.
      const refresh = spawnSync(HEARTBEAT, ["refresh"], { env: { ...w.env, BOT_HEARTBEAT_NOW: new Date(t + 362000).toISOString() }, encoding: "utf8" });
      assert.equal(refresh.status, 0, refresh.stderr);
      assert.equal(w.saved().published.workers[1].run_health.health, "unknown");
      assert.equal(w.saved().input.workers[1].last_activity_at, result.last_activity_at);
      const refreshedUsage = require(HEARTBEAT).parseComment(JSON.parse(fs.readFileSync(path.join(w.dir, "usage-comment.json"), "utf8")).body);
      assert.equal(refreshedUsage.runs[0].tokens, null);
    } finally { w.cleanup(); }
  });

  test(`done: explicit idempotent removal while Draft, owner ${owner}`, () => {
    const w = world(owner);
    try {
      const input = w.saved().input;
      input.workers.push({ ...ORIGINAL, name: "run-123", location: "remote", engine: "opencode", model: "openai/gpt-6.1", agent_ids: ["agent456"] });
      input.workers[0] = { ...ORIGINAL, location: "local", engine: "claude", model: "sonnet", devspace: "work", last_activity_at: ORIGINAL.started_at };
      const publish = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { input: JSON.stringify(input), env: w.env, encoding: "utf8" });
      assert.equal(publish.status, 0, publish.stderr);
      // Draft must not require a board lookup, closure, or the caller's session.
      fs.writeFileSync(path.join(w.dir, "board.json"), JSON.stringify([{ status: "Draft", content: { url: ORIGINAL.item_url } }]));
      fs.writeFileSync(path.join(w.dir, "calls"), "");
      const done = spawnSync(HEARTBEAT, ["done", "run-123"], { env: { ...w.env, CLAUDE_CODE_SESSION_ID: "different-session" }, encoding: "utf8" });
      assert.equal(done.status, 0, done.stderr);
      assert.deepEqual(w.saved().input.workers, [input.workers[0]]);
      assert.equal(w.saved().session, owner);
      assert.equal(w.saved().input.coordinator.session, input.coordinator.session);
      assert.ok(w.calls().every((c) => !c.includes("graphql") && !c.some((a) => /^repos\/o\/r\/issues\//.test(a))));
      const before = fs.readFileSync(w.state, "utf8");
      fs.writeFileSync(path.join(w.dir, "calls"), "");
      const again = spawnSync(HEARTBEAT, ["deregister", "run-123"], { env: w.env, encoding: "utf8" });
      assert.equal(again.status, 0, again.stderr);
      assert.equal(fs.readFileSync(w.state, "utf8"), before);
      assert.deepEqual(w.calls(), []);
      const { validate, render } = require(HEARTBEAT);
      const body = render(validate(input, Date.now()).hb);
      assert.match(body, /\| Location \| Engine \| Model \|/);
      assert.match(body, /\| remote \| `opencode` \| `openai\/gpt-6.1` \|/);
      assert.match(body, /\| local \| `claude` \| `sonnet` \|/);
    } finally { w.cleanup(); }
  });
}

test("cleanup and registration share the lock without losing surviving metadata", async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.dir, "delay"), "");
    const done = spawn(HEARTBEAT, ["done", ORIGINAL.name], { env: w.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    done.stderr.on("data", (chunk) => { stderr += chunk; });
    const [added, [status]] = await Promise.all([register(w, "PVTI_new", 1), once(done, "close")]);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(status, 0, stderr);
    assert.deepEqual(w.saved().input.workers.map((worker) => worker.name), ["PVTI_new"]);
    assert.equal(w.saved().session, OWNER);
    assert.doesNotMatch(stderr + added.stderr, /overlapping publications/);
  } finally { w.cleanup(); }
});

test("done reports persistence failure and refuses retry from stale saved input", () => {
  const w = world();
  try {
    const before = w.saved();
    fs.writeFileSync(path.join(w.dir, "fail-save"), "");
    const failed = spawnSync(HEARTBEAT, ["done", ORIGINAL.name], { env: w.env, encoding: "utf8" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /cannot save/);
    fs.rmdirSync(w.state);
    fs.renameSync(w.state + ".backup", w.state);
    fs.unlinkSync(path.join(w.dir, "fail-save"));
    const retry = spawnSync(HEARTBEAT, ["done", ORIGINAL.name], { env: w.env, encoding: "utf8" });
    assert.equal(retry.status, 1, retry.stderr);
    assert.match(retry.stderr, /previous publication did not finish saving its state/);
    assert.deepEqual(w.saved(), before);
  } finally { w.cleanup(); }
});

for (const [hours, explicitActivity] of [[6, true], [2, true], [6, false]]) {
  test(`stale prune: ${hours}h boundary with ${explicitActivity ? "activity" : "start fallback"}, not refreshed timestamp`, () => {
    const w = world();
    try {
      const start = Date.parse(w.saved().published.updated_at);
      const input = w.saved().input;
      input.workers = [{ ...ORIGINAL, started_at: new Date(start - 12 * 3600000).toISOString(), last_activity_at: new Date(start).toISOString(), location: "remote", engine: "opencode", model: "openai/gpt-6.1" }];
      if (!explicitActivity) {
        delete input.workers[0].last_activity_at;
        input.workers[0].started_at = new Date(start).toISOString();
      }
      const survivor = { ...ORIGINAL, name: "constructor", started_at: new Date(start).toISOString(), last_activity_at: new Date(start + 1000).toISOString(), agent_ids: ["agent789"] };
      input.workers.push(survivor);
      w.env.BOT_HEARTBEAT_NOW = new Date(start).toISOString();
      if (hours !== 6) w.env.BOT_HEARTBEAT_STALE_HOURS = String(hours);
      const seed = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { input: JSON.stringify(input), env: w.env, encoding: "utf8" });
      assert.equal(seed.status, 0, seed.stderr);
      const board = path.join(w.dir, "board.json");
      fs.writeFileSync(board, "[]");
      w.env.BOT_HEARTBEAT_NOW = new Date(start + hours * 3600000 - 1000).toISOString();
      const refresh = spawnSync(HEARTBEAT, ["refresh"], { env: w.env, encoding: "utf8" });
      assert.equal(refresh.status, 0, refresh.stderr);
      assert.deepEqual(w.saved().input.workers, input.workers);
      const before = spawnSync(HEARTBEAT, ["prune", "--board-file", board], { env: w.env, encoding: "utf8" });
      assert.equal(before.status, 0, before.stderr);
      assert.equal(w.saved().input.workers.length, 2);
      w.env.BOT_HEARTBEAT_NOW = new Date(start + hours * 3600000).toISOString();
      const dry = spawnSync(HEARTBEAT, ["prune", "--dry-run", "--board-file", board], { env: w.env, encoding: "utf8" });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stderr, /would drop existing \(stale:/);
      assert.equal(w.saved().input.workers.length, 2);
      fs.writeFileSync(path.join(w.dir, "calls"), "");
      const at = spawnSync(HEARTBEAT, ["prune", "--board-file", board], { env: w.env, encoding: "utf8" });
      assert.equal(at.status, 0, at.stderr);
      assert.match(at.stderr, new RegExp(`dropping existing \\(stale: no activity for ${hours}h\\)`));
      assert.deepEqual(w.saved().input.workers, [survivor]);
      assert.equal(w.saved().session, OWNER);
    } finally { w.cleanup(); }
  });
}

function register(w, id, number, extraEnv = {}) {
  const item = { id, content: { url: `https://github.com/o/r/issues/${number}` } };
  const code = `const fs = require('node:fs'); const item = JSON.parse(fs.readFileSync(0, 'utf8'));
process.exit(require(${JSON.stringify(REGISTER)}).register(item, item.id, process.env.WAIT ? {lockWaitSeconds: Number(process.env.WAIT)} : {}) ? 0 : 1);`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...w.env, CLAUDE_CODE_SESSION_ID: "caller-session", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(item));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

function startHeartbeat(w, args, input, extraEnv = {}) {
  const child = spawn(HEARTBEAT, args, { env: { ...w.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return { child, result };
}

test("new run identity replaces same-item registration, same-name retry preserves it, done removes it", async () => {
  const w = world();
  try {
    const now = Date.now();
    w.env.BOT_HEARTBEAT_NOW = new Date(now).toISOString();
    const input = w.saved().input;
    input.workers.push({ ...ORIGINAL, name: "run-old", item_url: "https://github.com/o/r/issues/1", location: "remote", engine: "claude", model: "sonnet", agent_ids: ["oldagent"], devspace: "old", last_activity_at: ORIGINAL.started_at });
    const seed = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { env: w.env, input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(seed.status, 0, seed.stderr);
    const code = `const hb = require(${JSON.stringify(REGISTER)});
process.exit(hb.register({id: 'PVTI_item', content: {url: 'https://github.com/o/r/issues/1'}}, 'run-new', {location: 'remote', engine: 'opencode', model: 'openai/gpt-6.1'}) ? 0 : 1);`;
    const added = spawnSync(process.execPath, ["-e", code], { env: w.env, encoding: "utf8" });
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(w.saved().input.workers, [ORIGINAL, {
      name: "run-new", item_url: "https://github.com/o/r/issues/1", started_at: new Date(now).toISOString(),
      status: "starting", location: "remote", engine: "opencode", model: "openai/gpt-6.1",
    }]);
    const before = fs.readFileSync(w.state, "utf8");
    fs.writeFileSync(path.join(w.dir, "calls"), "");
    const retry = spawnSync(process.execPath, ["-e", code.replace("openai/gpt-6.1", "different/model")], { env: { ...w.env, BOT_HEARTBEAT_NOW: new Date(now + 600000).toISOString() }, encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(fs.readFileSync(w.state, "utf8"), before);
    assert.deepEqual(w.calls(), []);
    const done = await startHeartbeat(w, ["done", "run-new"]).result;
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(w.saved().input.workers, [ORIGINAL]);
    assert.equal(w.saved().session, OWNER);
  } finally { w.cleanup(); }
});

for (const mutation of ["done", "register", "prune", "refresh"]) {
  test(`ordinary publish holds shared lock against ${mutation} until remote write and state save finish`, { timeout: 15000 }, async () => {
    const w = world();
    let watcher, publisher, changing;
    try {
      const input = w.saved().input;
      const fresh = new Date().toISOString();
      input.workers[0].started_at = fresh;
      const introduced = { ...ORIGINAL, name: "introduced", item_url: "https://github.com/o/r/issues/9", started_at: fresh, location: "remote", engine: "opencode", model: "openai/gpt-6.1", agent_ids: ["newagent"] };
      input.workers.push(introduced);
      const board = path.join(w.dir, "board.json");
      fs.writeFileSync(board, JSON.stringify([{ status: "Done", content: { url: ORIGINAL.item_url } }]));
      fs.writeFileSync(path.join(w.dir, "hold-publish"), "");
      const writing = new Promise((resolve) => {
        watcher = fs.watch(w.dir, (_event, name) => {
          if (name === "active" && fs.existsSync(path.join(w.dir, "active"))) resolve();
        });
      });
      publisher = startHeartbeat(w, ["publish", "--no-usage"], input);
      await writing;
      watcher.close();
      const callsBefore = w.calls().length;
      if (mutation === "register") changing = register(w, "PVTI_new", 1);
      else changing = startHeartbeat(w, mutation === "done" ? ["done", ORIGINAL.name] : mutation === "prune" ? ["prune", "--board-file", board] : ["refresh"], undefined,
        mutation === "refresh" ? { BOT_HEARTBEAT_NOW: new Date(Date.now() + 600000).toISOString() } : {}).result;
      let finishedEarly = false;
      changing.then(() => { finishedEarly = true; });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(finishedEarly, false, "mutation must wait for the ordinary publisher's lock");
      assert.equal(w.calls().length, callsBefore, "mutation must not read stale remote/local state while publish is pending");
      fs.writeFileSync(path.join(w.dir, "release-publish"), "");
      const results = await Promise.all([publisher.result, changing]);
      assert.deepEqual(results.map((r) => r.status), [0, 0], JSON.stringify(results));
      assert.ok(results.every((r) => !r.stderr.includes("overlapping publications")));
      const saved = w.saved();
      const names = ["done", "prune"].includes(mutation) ? ["introduced"] : mutation === "register" ? [ORIGINAL.name, "introduced", "PVTI_new"] : [ORIGINAL.name, "introduced"];
      assert.deepEqual(saved.input.workers.map((worker) => worker.name), names);
      assert.deepEqual(saved.input.workers.find((worker) => worker.name === introduced.name), introduced);
      assert.equal(saved.session, OWNER);
      const body = JSON.parse(fs.readFileSync(path.join(w.dir, "comment.json"), "utf8")).body;
      assert.deepEqual(require(HEARTBEAT).parseComment(body), saved.published);
    } finally {
      watcher?.close();
      fs.writeFileSync(path.join(w.dir, "release-publish"), "");
      await Promise.allSettled([publisher?.result, changing]);
      w.cleanup();
    }
  });
}

for (const mode of ["json", "text", "commit-fails"]) {
  test(`apply cleanup with fake git operations and no fixture commits: ${mode}`, () => {
    const w = world();
    try {
      const source = fs.readFileSync(path.join(ROOT, "bin", "bot-runs"), "utf8");
      const apply = source.slice(source.indexOf("cmd_apply() {"), source.indexOf("# --- main"));
      const cleanup = source.slice(source.indexOf("heartbeat_done() {"), source.indexOf("# reconcile_one"));
      assert.ok(apply.startsWith("cmd_apply() {") && cleanup.startsWith("heartbeat_done() {"));
      const input = w.saved().input;
      input.workers.push({ ...ORIGINAL, name: "run-123", item_url: "https://github.com/o/r/issues/1", location: "remote", engine: "opencode" });
      const seed = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { env: w.env, input: JSON.stringify(input), encoding: "utf8" });
      assert.equal(seed.status, 0, seed.stderr);
      const scratch = path.join(w.dir, "apply");
      fs.mkdirSync(path.join(scratch, "out"), { recursive: true });
      fs.writeFileSync(path.join(scratch, "out", "base.json"), JSON.stringify({ commit: "base-sha" }));
      fs.writeFileSync(path.join(w.dir, "message"), "worker: Apply change\n\nExercise completion cleanup.\n");
      const run = { id: 123, conclusion: "success", head_sha: "workflow-sha", url: "https://github.com/o/r/actions/runs/123", attempt: 1 };
      const record = { source: "artifact", summary: { run_id: 123, result: "success", repo: "o/r", base: "main", workflow: "branch", item: "PVTI_item" } };
      const verdict = { items: [{ type: "create_pull_request", title: "Change", body: "Why" }], patch: { file: "change.patch" } };
      // Exercise the real command's success/return paths; stub Git and the
      // remote/checker boundary, so no commit or network operation can run.
      const script = `set -euo pipefail
scratch=$SCRATCH CACHE_DIR=$SCRATCH/cache ALL_OUTPUTS=all
REPO_RE='^[a-z]+/[a-z]+$' BASE_RE='^[a-z]+$' RUN_META='.' RUN_ORIGIN_JQ='""'
RUNS_REPO=o/r RUNS_WORKFLOW=agent.yml OP_DEVSPACE_REPO=o/r OP_BOT_LOGIN=bot OP_OPERATOR_LOGIN=operator OP_FORGE_ORG=forge
OP_BOT_GIT_NAME=bot OP_BOT_GIT_EMAIL=bot@example.com NO_PUSH_URL=disabled
AI_TRAILER='Generated-by: AI' RUN_TRAILER=Agent-Run
fatal() { printf '%s\\n' "$*" >&2; exit 1; }
warn() { printf '%s\\n' "$*" >&2; }
parse_run() { printf '%s\\n' "$1"; }
fetch_run_json() { printf '%s\\n' "$RUN"; }
load_record() { printf '%s\\n' "$RECORD"; }
jqlib() { printf 'o/r\\n'; }
fetch_checker() { printf 'fake-checker\\n'; }
apply_artifact() { :; }
checker() {
  if test "$2" = check; then printf '%s\\n' "$VERDICT" >"$scratch/verdict.json"; fi
}
apply_env() {
  test "$1" = git || fatal 'unexpected non-git apply operation'
  printf 'fake clone\\n' >>"$SCRATCH/git-calls"
}
agit() {
  case "$2" in
    config|merge-base|apply) : ;;
    commit) printf 'fake commit\\n' >>"$SCRATCH/git-calls"; test "$MODE" != commit-fails ;;
    rev-parse) printf 'head-sha\\n' ;;
    diff) printf 'src/lib.rs\\0' ;;
    *) fatal "unexpected fake git command: $*" ;;
  esac
}
apply_worktree() { printf '%s\\n' "$SCRATCH/worktree"; }
staged_view() { :; }
${cleanup}
${apply}
cmd_apply 123 --repo o/r --slug task --message "$MESSAGE" --source fake-local ${mode === "json" ? "--json" : ""}
`;
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...w.env, BOT_RUNS_HEARTBEAT: HEARTBEAT, SCRATCH: scratch,
        MESSAGE: path.join(w.dir, "message"), MODE: mode, RUN: JSON.stringify(run), RECORD: JSON.stringify(record), VERDICT: JSON.stringify(verdict) } });
      assert.equal(r.status, mode === "commit-fails" ? 1 : 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(scratch, "git-calls"), "utf8"), "fake clone\nfake commit\n");
      assert.deepEqual(w.saved().input.workers, mode === "commit-fails" ? input.workers : [ORIGINAL]);
      assert.equal(w.saved().session, OWNER);
      if (mode === "json") assert.equal(JSON.parse(r.stdout).run_id, 123);
      if (mode === "text") assert.match(r.stdout, /Applied run 123/);
      if (mode === "commit-fails") assert.match(r.stderr, /committing the change failed/);
    } finally { w.cleanup(); }
  });
}

for (const scenario of ["distinct", "same-item", "first-publication-fails", "null-owner", "long-publication"]) {
  test(`concurrent registration: ${scenario}`, async () => {
    const w = world(scenario === "null-owner" ? null : OWNER);
    try {
      fs.writeFileSync(path.join(w.dir, "delay"), "");
      if (scenario === "long-publication") fs.writeFileSync(path.join(w.dir, "long-delay"), "");
      if (scenario === "first-publication-fails") fs.writeFileSync(path.join(w.dir, "fail-one"), "");
      const start = Date.now();
      const results = await Promise.all([register(w, "PVTI_one", 1), register(w, "PVTI_two", scenario === "same-item" ? 1 : 2)]);
      if (scenario === "long-publication") assert.ok(Date.now() - start > 10000, "exercise the default lock wait across a publication longer than 10 seconds");
      assert.deepEqual(results.map((r) => r.status), scenario === "first-publication-fails" ? [1, 0] : [0, 0], JSON.stringify(results));
      const saved = w.saved();
      assert.deepEqual(saved.input.workers[0], ORIGINAL);
      assert.equal(saved.session, scenario === "null-owner" ? null : OWNER);
      assert.equal(saved.input.coordinator.session, "coordinator-session");
      const urls = saved.input.workers.map((worker) => worker.item_url).sort();
      const numbers = scenario === "first-publication-fails" ? [2, 3] : scenario === "same-item" ? [1, 3] : [1, 2, 3];
      assert.deepEqual(urls, numbers.map((n) => `https://github.com/o/r/issues/${n}`));
      if (scenario === "first-publication-fails") assert.match(results[0].stderr, /injected publication failure/);
      assert.ok(results.every((r) => !r.stderr.includes("overlapping publications")));
      const publicBody = JSON.parse(fs.readFileSync(path.join(w.dir, "comment.json"), "utf8")).body;
      assert.deepEqual(JSON.parse(publicBody.match(/```json\n([\s\S]*?)\n```/)[1]), saved.published);
      assert.equal(fs.existsSync(path.join(w.dir, "active")), false);
    } finally { w.cleanup(); }
  });
}

for (const scenario of ["strict-persistence-failure", "ordinary-persistence-failure", "unchanged-public-persistence-failure", "foreign-session", "dry-run"]) {
  test(`strict heartbeat state: ${scenario}`, async () => {
    const w = world();
    try {
      const original = w.saved();
      const input = structuredClone(original.input);
      input.workers.push({ ...ORIGINAL, name: "new-worker", item_url: "https://github.com/o/r/issues/1" });
      if (scenario === "unchanged-public-persistence-failure") input.workers.at(-1).item_url = "https://github.com/o/private/issues/1";
      const args = ["publish", "--no-usage"];
      if (scenario !== "ordinary-persistence-failure") args.push("--require-saved-state");
      if (scenario === "dry-run") args.push("--dry-run");
      if (scenario.endsWith("persistence-failure")) fs.writeFileSync(path.join(w.dir, scenario === "unchanged-public-persistence-failure" ? "fail-save-read" : "fail-save"), "");
      const env = { ...w.env };
      if (scenario === "foreign-session") env.CLAUDE_CODE_SESSION_ID = "foreign-session";
      const r = spawnSync(HEARTBEAT, args, { env, input: JSON.stringify(input), encoding: "utf8" });
      assert.equal(r.status, ["strict-persistence-failure", "unchanged-public-persistence-failure"].includes(scenario) ? 1 : scenario === "foreign-session" ? 4 : 0, r.stderr);
      if (scenario.endsWith("persistence-failure")) {
        assert.match(r.stderr, /cannot save/);
        fs.rmdirSync(w.state);
        fs.renameSync(w.state + ".backup", w.state);
        fs.unlinkSync(path.join(w.dir, scenario === "unchanged-public-persistence-failure" ? "fail-save-read" : "fail-save"));
        assert.equal(fs.readdirSync(path.dirname(w.state)).some((name) => name.endsWith(".tmp")), false, "failed atomic writes must clean up their temporary files");
        const writesBefore = w.calls().filter((c) => c.includes("PATCH") || c.includes("POST")).length;
        const next = await register(w, "PVTI_next", 2);
        assert.equal(next.status, 1, next.stderr);
        assert.match(next.stderr, /published heartbeat differs from the saved state|previous publication did not finish saving its state/);
        assert.deepEqual(w.saved(), original);
        assert.equal(w.calls().filter((c) => c.includes("PATCH") || c.includes("POST")).length, writesBefore);
        if (scenario !== "ordinary-persistence-failure") {
          const refresh = spawnSync(HEARTBEAT, ["refresh"], { env: w.env, encoding: "utf8" });
          assert.equal(refresh.status, 4, refresh.stderr);
          assert.match(refresh.stderr, /previous publication did not finish saving its state/);
          assert.deepEqual(w.saved(), original);
          assert.equal(w.calls().filter((c) => c.includes("PATCH") || c.includes("POST")).length, writesBefore);
        }
        assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, "comment.json"), "utf8")).body.includes("new-worker"), scenario !== "unchanged-public-persistence-failure");
        // A full explicit publish repairs state; the refused append's lock
        // must be released so a subsequent registration can proceed.
        fs.writeFileSync(path.join(w.dir, "calls"), "");
        const repair = spawnSync(HEARTBEAT, ["publish", "--no-usage"], { env: w.env, input: JSON.stringify(input), encoding: "utf8" });
        assert.equal(repair.status, 0, repair.stderr);
        assert.equal(fs.existsSync(path.join(path.dirname(w.state), "publish-pending")), false);
        const retry = await register(w, "PVTI_next", 2);
        assert.equal(retry.status, 0, retry.stderr);
        assert.equal(w.saved().input.workers.length, 3);
      } else {
        assert.deepEqual(w.saved(), original);
        assert.equal(w.calls().some((c) => c.includes("PATCH") || c.includes("POST")), false);
        if (scenario === "foreign-session") assert.match(r.stderr, /not this one/);
      }
    } finally { w.cleanup(); }
  });
}

for (const cleanup of ["normal-exit", "killed-holder"]) {
  test(`registration lock: bounded wait and ${cleanup} cleanup`, async () => {
    const w = world();
    let holder;
    try {
      const lock = path.join(path.dirname(w.state), "registration.lock");
      holder = spawn("flock", ["--no-fork", lock, process.execPath, "-e", "console.log('locked'); const timer = setInterval(() => {}, 1000); process.on('SIGTERM', () => clearInterval(timer));"], { stdio: ["ignore", "pipe", "pipe"] });
      await once(holder.stdout, "data");
      const before = w.saved();
      const start = Date.now();
      const blocked = await register(w, "PVTI_one", 1, { WAIT: "0.1" });
      assert.equal(blocked.status, 1, blocked.stderr);
      assert.match(blocked.stderr, /timed out waiting 0.1s/);
      assert.ok(Date.now() - start < 5000, "lock wait must be bounded");
      assert.deepEqual(w.saved(), before);
      assert.equal(w.calls().length, 0, "timed-out caller must not publish");
      const exited = once(holder, "exit");
      holder.kill(cleanup === "normal-exit" ? "SIGTERM" : "SIGKILL");
      await exited;
      holder = null;
      const retry = await register(w, "PVTI_one", 1);
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(w.saved().input.workers.length, 2);
    } finally {
      if (holder) holder.kill("SIGKILL");
      w.cleanup();
    }
  });
}

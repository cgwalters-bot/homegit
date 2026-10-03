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
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "BOT_HEARTBEAT_NOW"]) delete env[key];
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
  setTimeout(() => {
    fs.writeFileSync(comments, JSON.stringify({id: 9, html_url: 'https://github.com/o/r/issues/1#issuecomment-9', login: 'cgwalters-bot', body}));
    if (!usage && fs.existsSync(path.join(dir, 'fail-save'))) {
      fs.renameSync(process.env.STATE, process.env.STATE + '.backup');
      fs.mkdirSync(process.env.STATE);
    }
    fs.unlinkSync(active);
    console.log('https://github.com/o/r/issues/1#issuecomment-9');
  }, fs.existsSync(path.join(dir, 'delay')) ? 200 : 0);
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

function register(w, id, number, extraEnv = {}) {
  const item = { id, content: { url: `https://github.com/o/r/issues/${number}` } };
  const code = `const fs = require('node:fs'); const item = JSON.parse(fs.readFileSync(0, 'utf8'));
process.exit(require(${JSON.stringify(REGISTER)}).register(item, item.id, {lockWaitSeconds: Number(process.env.WAIT || 10)}) ? 0 : 1);`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...w.env, CLAUDE_CODE_SESSION_ID: "caller-session", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(item));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

for (const scenario of ["distinct", "same-item", "first-publication-fails", "null-owner"]) {
  test(`concurrent registration: ${scenario}`, async () => {
    const w = world(scenario === "null-owner" ? null : OWNER);
    try {
      fs.writeFileSync(path.join(w.dir, "delay"), "");
      if (scenario === "first-publication-fails") fs.writeFileSync(path.join(w.dir, "fail-one"), "");
      const results = await Promise.all([register(w, "PVTI_one", 1), register(w, "PVTI_two", scenario === "same-item" ? 1 : 2)]);
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

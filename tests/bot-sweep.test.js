// Offline tests of bin/bot-sweep against fake bot-* tools and git, which
// behave as each case's FAKE_* variables say. Run with tests/bot-sweep.sh,
// or node --test tests/bot-sweep.test.js.
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-sweep");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-sweep-test-"));
const BIN = path.join(WORK, "bin");
const SWEPT = "Swept 3 URLs of 2 board items: 0 failed.";
const LOCK_MSG = "error: another bot-notify run holds /x/bot-notify/lock";

// A fake tool: prints $FAKE_<NAME>_OUT, runs $FAKE_<NAME>_RUN (shell), and
// exits $FAKE_<NAME>_EXIT; its calls are counted in WORK/NAME.calls.
function fake(name, envName) {
  fs.writeFileSync(path.join(BIN, name), `#!/bin/bash
echo x >>"${WORK}/${envName}.calls"
n=$(wc -l <"${WORK}/${envName}.calls")
printf '%s' "\${FAKE_${envName}_OUT-}"
eval "\${FAKE_${envName}_RUN-}"
exit "\${FAKE_${envName}_EXIT:-0}"
`, { mode: 0o755 });
}
fs.mkdirSync(BIN);
for (const [name, env] of [["bot-watch", "WATCH"], ["bot-notify", "NOTIFY"], ["bot-pr", "INBOX"],
  ["bot-tmt-number", "GC"], ["git", "GIT"]]) fake(name, env);

// Whether PID is gone (or a zombie) within a few seconds: a killed
// orphan is reaped by init, which may take a moment.
function gone(pid) {
  const until = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
      if (/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return true;
    } catch {
      return true;
    }
    if (Date.now() > until) return false;
    spawnSync("sleep", ["0.1"]);
  }
}

let caseNo = 0;
function sweep(env = {}, dir = null) {
  const stateDir = dir || path.join(WORK, `state-${caseNo++}`);
  for (const f of fs.readdirSync(WORK).filter((f) => f.endsWith(".calls"))) fs.rmSync(path.join(WORK, f));
  const r = spawnSync(TOOL, ["--state-dir", stateDir], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: WORK, BOT_SWEEP_BIN_DIR: BIN, BOT_SWEEP_GIT: path.join(BIN, "git"),
      BOT_SWEEP_RETRY_WAIT_MS: "50", FAKE_WATCH_OUT: `${SWEPT}\n`, ...env,
    },
  });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8"));
  const st = fs.existsSync(path.join(stateDir, "status.json")) ? read("status.json") : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, stateDir, st, read };
}

test("a clean sweep publishes its outputs and a complete status", () => {
  const r = sweep({ FAKE_NOTIFY_OUT: "notify says\n", FAKE_INBOX_OUT: "inbox says\n" });
  assert.equal(r.code, 0, r.stderr);
  const s = r.st;
  assert.deepEqual(s.problems, []);
  assert.equal(s.complete, true);
  assert.deepEqual(s.last_complete.run, s.run);
  assert.match(s.run, /^[0-9]{8}-[0-9]{6}-[0-9]{3}$/);
  assert.ok(s.duration_s >= 0 && s.ended_at >= s.started_at);
  assert.deepEqual(Object.keys(s.steps).sort(), ["git", "inbox", "notify", "tmt-gc", "watch"]);
  assert.equal(fs.readFileSync(path.join(r.stateDir, "latest-watch.txt"), "utf8"), `${SWEPT}\n`);
  assert.equal(fs.readFileSync(path.join(r.stateDir, "latest-notify.txt"), "utf8"), "notify says\n");
  assert.equal(fs.readFileSync(path.join(r.stateDir, "latest-inbox.txt"), "utf8"), "inbox says\n");
  // The run, in bot-poll's layout.
  assert.deepEqual(r.read(`runs/${s.run}/status.json`), { git: 0, watch: 0, notify: 0, inbox: 0, "tmt-gc": 0 });
  assert.equal(fs.readFileSync(path.join(r.stateDir, "runs", s.run, "watch.txt"), "utf8"), `${SWEPT}\n`);
  assert.ok(!fs.existsSync(path.join(r.stateDir, "running.json")));
  assert.deepEqual(fs.readdirSync(path.join(r.stateDir, "runs")), [s.run]);
});

for (const c of [
  { name: "empty watch output", env: { FAKE_WATCH_OUT: "" }, problem: /^watch printed nothing$/ },
  { name: "watch cut short", env: { FAKE_WATCH_OUT: "Priority health:\n" }, problem: /no closing "Swept" line/ },
  { name: "watch failing", env: { FAKE_WATCH_OUT: "", FAKE_WATCH_RUN: "echo 'error: listing the board failed' >&2", FAKE_WATCH_EXIT: "1" },
    problem: /^watch exited 1: error: listing the board failed$/ },
  { name: "bot-watch's lock held", env: { FAKE_WATCH_OUT: "", FAKE_WATCH_RUN: "echo 'error: another bot-watch run holds /s/bot-watch/lock' >&2", FAKE_WATCH_EXIT: "1" },
    problem: /^watch: another run held its lock \(4 attempts\)/ },
  { name: "inbox failing", env: { FAKE_INBOX_EXIT: "3" }, problem: /^inbox exited 3/ },
]) {
  test(`a sweep with ${c.name} is a problem, and not complete`, () => {
    const dir = path.join(WORK, `state-${caseNo++}`);
    const first = sweep({}, dir);
    assert.equal(first.code, 0, first.stderr);
    const r = sweep(c.env, dir);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.st.complete, false);
    assert.ok(r.st.problems.some((p) => c.problem.test(p)), JSON.stringify(r.st.problems));
    // The last complete sweep is still the first one.
    assert.equal(r.st.last_complete.run, first.st.run);
    assert.match(r.stdout, /problems:/);
  });
}

test("a step whose lock is held only for a while is retried", () => {
  const r = sweep({ FAKE_NOTIFY_RUN: `if [ "$n" -lt 3 ]; then echo '${LOCK_MSG}' >&2; exit 1; fi` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.st.steps.notify.attempts, 3);
  assert.deepEqual(r.st.problems, []);
});

test("a step that fails otherwise is not retried", () => {
  const r = sweep({ FAKE_NOTIFY_EXIT: "1" });
  assert.equal(r.st.steps.notify.attempts, 1);
  assert.equal(r.st.complete, false);
});

test("a step that times out is killed with everything it started", () => {
  const pidFile = path.join(WORK, "orphan.pid");
  const r = sweep({
    BOT_SWEEP_TIMEOUT_S: "1",
    // A backgrounded child, as bot-watch's probes are, that would keep its lock.
    FAKE_WATCH_RUN: `sleep 300 & echo $! >"${pidFile}"; sleep 300`,
  });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.st.steps.watch.timed_out, true);
  assert.equal(r.st.steps.watch.exit, null);
  assert.ok(r.st.problems.some((p) => /^watch timed out after/.test(p)), JSON.stringify(r.st.problems));
  assert.ok(gone(Number(fs.readFileSync(pidFile, "utf8"))));
  assert.deepEqual(r.read(`runs/${r.st.run}/status.json`).watch, null);
});

test("a finished step's leftover background jobs are killed", () => {
  const pidFile = path.join(WORK, "leftover.pid");
  const r = sweep({ FAKE_GC_RUN: `sleep 300 & echo $! >"${pidFile}"` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(gone(Number(fs.readFileSync(pidFile, "utf8"))));
});

test("a stopped sweep kills its steps, skips the rest and says so", async () => {
  const dir = path.join(WORK, `state-${caseNo++}`);
  const pidFile = path.join(WORK, "stopped.pid");
  fs.rmSync(pidFile, { force: true });
  const child = spawn(TOOL, ["--state-dir", dir], {
    env: {
      PATH: process.env.PATH, HOME: WORK, BOT_SWEEP_BIN_DIR: BIN, BOT_SWEEP_GIT: path.join(BIN, "git"),
      FAKE_WATCH_RUN: `sleep 300 & echo $! >"${pidFile}"; sleep 300`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const until = Date.now() + 10000;
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8").trim()) {
    assert.ok(Date.now() < until, "the fake bot-watch never started");
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGTERM");
  assert.equal(await exited, 1);
  const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  assert.equal(st.problems[0], "the sweep was stopped (got SIGTERM)");
  assert.equal(st.steps.watch.signal, "SIGTERM");
  assert.equal(st.steps["tmt-gc"], undefined);
  assert.equal(st.complete, false);
  assert.ok(!fs.existsSync(path.join(dir, "running.json")));
  assert.ok(gone(Number(fs.readFileSync(pidFile, "utf8"))));
});

test("a sweep refuses to start while another runs, and takes over a stale one", () => {
  const dir = path.join(WORK, `state-${caseNo++}`);
  fs.mkdirSync(dir, { recursive: true });
  const running = path.join(dir, "running.json");
  fs.writeFileSync(running, JSON.stringify({ pid: process.pid, run: "x" }));
  const busy = sweep({}, dir);
  assert.equal(busy.code, 75);
  assert.match(busy.stderr, /another bot-sweep \(pid [0-9]+, run x\) is running/);
  assert.ok(!fs.existsSync(path.join(dir, "status.json")));
  // A pid that can't be live (above pid_max).
  fs.writeFileSync(running, JSON.stringify({ pid: 2 ** 30, run: "y" }));
  const r = sweep({}, dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(running));
});

test("runs older than two days are pruned", () => {
  const dir = path.join(WORK, `state-${caseNo++}`);
  const old = path.join(dir, "runs", "20200101-000000-000");
  const oldPartial = path.join(dir, "runs", ".20200101-000000-000.partial");
  const unrelated = path.join(dir, "runs", "notes");
  for (const d of [old, oldPartial, unrelated]) {
    fs.mkdirSync(d, { recursive: true });
    const t = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(d, t, t);
  }
  const r = sweep({}, dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(oldPartial));
  assert.ok(fs.existsSync(unrelated));
  assert.ok(fs.existsSync(path.join(dir, "runs", r.st.run)));
});

test("the gh token is read from BOT_SWEEP_GH_TOKEN_FILE when GH_TOKEN is unset", () => {
  const tokenFile = path.join(WORK, "token");
  fs.writeFileSync(tokenFile, "tok123\n");
  const seen = path.join(WORK, "seen-token");
  const r = sweep({ BOT_SWEEP_GH_TOKEN_FILE: tokenFile, FAKE_GC_RUN: `printf %s "$GH_TOKEN" >"${seen}"` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(seen, "utf8"), "tok123");
  const missing = sweep({ BOT_SWEEP_GH_TOKEN_FILE: path.join(WORK, "nope") });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read the gh token from/);
  assert.ok(!fs.existsSync(path.join(missing.stateDir, "running.json")));
});

test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

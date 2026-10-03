// Offline integration regressions, using bot-claude.sh's scratch fixtures.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const [bot, work] = process.argv.slice(2);
// The shell harness supplies the fixtures; generic node --test discovery
// should report a skip rather than trying to construct paths from undefined.
if (!bot && !work) {
  require("node:test")("bot-claude lifecycle (requires shell fixtures)", { skip: true }, () => {});
} else {
const out = path.join(work, "out");
const state = path.join(work, "state", "bot-claude");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cli(...args) {
  const r = spawnSync(bot, args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function status(job) {
  return JSON.parse(fs.readFileSync(path.join(state, job, "status.json"), "utf8"));
}

async function until(check) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await sleep(50);
  }
}

function alive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

function start(job, scenario, mode, env = process.env) {
  fs.writeFileSync(path.join(out, "actuals.mode"), mode);
  fs.rmSync(path.join(out, "actuals.started"), { force: true });
  if (scenario === "hang") fs.rmSync(path.join(out, "hang.sleep.pid"), { force: true });
  const brief = path.join(work, `${job}.brief`);
  fs.writeFileSync(brief, `Scenario: ${scenario}\n`);
  const r = spawnSync(bot, ["start", "--dir", path.join(work, "dir"), "--job", job,
    "--item", "https://github.com/o/r/issues/7", brief], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

function wait(job, code) {
  const r = spawnSync(bot, ["wait", "--timeout", "20", job], { encoding: "utf8" });
  assert.equal(r.status, code, r.stderr);
}

async function main() {
  // Record the spawn itself: immediate cancellation may happen before the
  // actuals executable has a chance to write its own started marker.
  const spawnPreload = path.join(work, "actuals-spawn.cjs");
  const spawnLog = path.join(out, "actuals.spawned");
  fs.writeFileSync(spawnPreload, `const fs = require('fs'); const cp = require('child_process'); const original = cp.spawn;
cp.spawn = (...args) => {
  const child = original(...args);
  if (args[0] === process.env.BOT_CLAUDE_ACTUALS) fs.writeFileSync(${JSON.stringify(spawnLog)}, String(child.pid));
  return child;
};\n`);
  start("j-kill-before-actuals", "hang", "block", { ...process.env, NODE_OPTIONS: `--require=${spawnPreload}` });
  await until(() => status("j-kill-before-actuals").worker_identity && fs.existsSync(path.join(out, "hang.sleep.pid")));
  const killedWorker = status("j-kill-before-actuals");
  const killStarted = performance.now();
  assert.equal(cli("kill", "j-kill-before-actuals"), "job j-kill-before-actuals killed");
  assert.ok(performance.now() - killStarted < 5000, "kill waited for the supervisor fallback deadline");
  wait("j-kill-before-actuals", 4);
  assert.equal(status("j-kill-before-actuals").actuals, "failed (cancelled)");
  const cancelledActuals = Number(fs.readFileSync(spawnLog, "utf8"));
  await until(() => !alive(cancelledActuals) && !alive(killedWorker.pid) && !alive(killedWorker.claude_pid));

  start("j-actuals-kill", "ok", "block");
  await until(() => fs.existsSync(path.join(out, "actuals.started")));
  const actualsPid = Number(fs.readFileSync(path.join(out, "actuals.started"), "utf8"));
  const actualsChild = Number(fs.readFileSync(path.join(out, "actuals.sleep.pid"), "utf8"));
  assert.equal(cli("kill", "j-actuals-kill"), "job j-actuals-kill killed");
  wait("j-actuals-kill", 4);
  assert.equal(status("j-actuals-kill").actuals, "failed (cancelled)");
  await until(() => !alive(actualsPid));
  await until(() => !alive(actualsChild));
  assert.equal(cli("kill", "j-actuals-kill"), "job j-actuals-kill already killed");

  // Abrupt supervisor death has no signal handler. The next poll must reap
  // the recorded actuals group, even if its leader has also disappeared.
  for (const leaderless of [false, true]) {
    const job = `j-actuals-lost-${leaderless}`;
    start(job, "ok", "block");
    await until(() => fs.existsSync(path.join(out, "actuals.started")) && status(job).actuals_identity);
    const recorded = status(job);
    const helper = Number(fs.readFileSync(path.join(out, "actuals.started"), "utf8"));
    const survivor = Number(fs.readFileSync(path.join(out, "actuals.sleep.pid"), "utf8"));
    process.kill(recorded.pid, "SIGKILL");
    await until(() => !fs.existsSync(`/proc/${recorded.pid}`));
    if (leaderless) {
      process.kill(helper, "SIGKILL");
      await until(() => !fs.existsSync(`/proc/${helper}`));
    }
    assert.ok(alive(survivor), "actuals straggler died before lost-job cleanup");
    assert.equal(JSON.parse(cli("status", "--json", job)).state, "lost");
    await until(() => !alive(helper) && !alive(survivor));
    wait(job, 4);
  }

  for (const terminal of ["killed", "lost"]) {
    const job = `j-external-${terminal}`;
    start(job, "ok", "block");
    await until(() => fs.existsSync(path.join(out, "actuals.started")));
    const recorded = { ...status(job), state: terminal, ended_at: "external-end" };
    fs.writeFileSync(path.join(state, job, "status.json"), JSON.stringify(recorded));
    assert.equal(cli("kill", job), `job ${job} already ${terminal}`);
    process.kill(recorded.pid, "SIGTERM");
    await until(() => !alive(recorded.pid));
    assert.deepEqual(status(job), recorded, "finalization overwrote external terminal state");
    wait(job, 4);
  }

  for (const [scenario, code, terminal] of [["ok", 0, "succeeded"], ["fail", 1, "failed"]]) {
    const job = `j-actuals-fail-${scenario}`;
    start(job, scenario, "fail");
    wait(job, code);
    assert.equal(status(job).state, terminal);
    assert.match(status(job).actuals, /^failed \(exit 7\): actuals failed/);
    assert.equal(cli("kill", job), `job ${job} already ${terminal}`);
  }

  // Instrument timer creation in the supervisor. Signals received while
  // finalizing a completed worker must not arm a worker escalation timer.
  const preload = path.join(work, "timers.cjs");
  const log = path.join(out, "timers.log");
  // Speed only the actuals timeout up; exercise the real timeout callback.
  fs.writeFileSync(preload, `const original = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => original(fn, ms === 120000 ? 500 : ms, ...args);\n`);
  start("j-actuals-timeout", "ok", "block", { ...process.env, NODE_OPTIONS: `--require=${preload}` });
  await until(() => fs.existsSync(path.join(out, "actuals.started")));
  const timedActuals = Number(fs.readFileSync(path.join(out, "actuals.started"), "utf8"));
  wait("j-actuals-timeout", 0);
  assert.equal(status("j-actuals-timeout").actuals, "failed (timeout)");
  await until(() => !alive(timedActuals));

  fs.writeFileSync(preload, `const fs = require('fs'); const original = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => {
  if (ms === 10000) fs.appendFileSync(${JSON.stringify(log)}, 'escalation\\n');
  return original(fn, ms, ...args);
};\n`);
  start("j-no-late-stop", "ok", "block", { ...process.env, NODE_OPTIONS: `--require=${preload}` });
  await until(() => fs.existsSync(path.join(out, "actuals.started")));
  cli("kill", "j-no-late-stop");
  wait("j-no-late-stop", 4);
  assert.ok(!fs.existsSync(log), "completed worker armed a late escalation");

  // Verify the exact armed timer is cleared on worker exit. Actuals now
  // cancels immediately when stopping was already requested.
  fs.writeFileSync(preload, `const fs = require('fs'); const original = global.setTimeout;
const clear = global.clearTimeout; let escalation;
global.setTimeout = (fn, ms, ...args) => {
  const timer = original(ms === 10000 ? () => {
    fs.appendFileSync(${JSON.stringify(log)}, 'fired\\n'); fn();
  } : fn, ms, ...args);
  if (ms === 10000) { escalation = timer; fs.appendFileSync(${JSON.stringify(log)}, 'armed\\n'); }
  return timer;
};
global.clearTimeout = (timer) => {
  if (timer && timer === escalation) { fs.appendFileSync(${JSON.stringify(log)}, 'cleared\\n'); escalation = null; }
  return clear(timer);
};\n`);
  start("j-clear-escalation", "hang", "delay", { ...process.env, NODE_OPTIONS: `--require=${preload}` });
  await until(() => status("j-clear-escalation").worker_identity);
  process.kill(status("j-clear-escalation").pid, "SIGTERM");
  wait("j-clear-escalation", 4);
  assert.equal(fs.readFileSync(log, "utf8"), "armed\ncleared\n", "worker escalation was not cleared on exit");

  start("j-leaderless", "hang", "ok");
  await until(() => status("j-leaderless").worker_identity && fs.existsSync(path.join(out, "hang.sleep.pid")));
  const st = status("j-leaderless");
  const straggler = Number(fs.readFileSync(path.join(out, "hang.sleep.pid"), "utf8"));
  process.kill(st.pid, "SIGKILL");
  process.kill(st.claude_pid, "SIGKILL");
  await until(() => !fs.existsSync(`/proc/${st.claude_pid}`));
  assert.ok(alive(straggler), "fixture straggler died before reaping");
  fs.writeFileSync(path.join(state, "j-leaderless", "status.json"), JSON.stringify({ ...st, worker_token: "wrong-token" }));
  cli("status", "j-leaderless");
  assert.ok(alive(straggler), "a wrong token authorized leaderless cleanup");
  fs.writeFileSync(path.join(state, "j-leaderless", "status.json"), JSON.stringify(st));
  assert.equal(JSON.parse(cli("status", "--json", "j-leaderless")).state, "lost");
  await until(() => !alive(straggler));
  assert.equal(cli("kill", "j-leaderless"), "job j-leaderless already lost");

  const stranger = spawn(process.execPath, ["-e", "process.title = 'odd ) ( worker'; setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" });
  try {
    await until(() => fs.existsSync(`/proc/${stranger.pid}/stat`));
    await until(() => fs.readFileSync(`/proc/${stranger.pid}/stat`, "utf8").includes("odd ) ( worker"));
    for (const variant of ["starttime", "boot_id", "pgrp", "session", "token", "legacy"]) {
      const job = `j-unrelated-${variant}`;
      const raw = fs.readFileSync(`/proc/${stranger.pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      const identity = { pid: stranger.pid, starttime: fields[19], pgrp: Number(fields[2]), session: Number(fields[3]),
        boot_id: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
      if (variant === "starttime") identity.starttime = "0";
      if (variant === "boot_id") identity.boot_id = "other-boot";
      if (variant === "pgrp") identity.pgrp = 999999;
      if (variant === "session") identity.session = 999999;
      if (variant === "token") identity.pid = identity.pgrp = identity.session = 999999;
      fs.mkdirSync(path.join(state, job));
      fs.writeFileSync(path.join(state, job, "status.json"), JSON.stringify({ job, state: "running", pid: 999999,
        claude_pid: stranger.pid, worker_identity: variant === "legacy" ? null : identity, worker_token: "wrong-token",
        actuals_identity: variant === "legacy" ? null : identity, actuals_token: "wrong-token" }));
      cli("status", job);
      assert.ok(alive(stranger.pid), `${variant} signaled an unrelated process`);
    }
    // A valid identity authorizes cleanup despite parentheses in comm.
    const raw = fs.readFileSync(`/proc/${stranger.pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const identity = { pid: stranger.pid, starttime: fields[19], pgrp: Number(fields[2]), session: Number(fields[3]),
      boot_id: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
    const job = "j-odd-comm";
    fs.mkdirSync(path.join(state, job));
    fs.writeFileSync(path.join(state, job, "status.json"), JSON.stringify({ job, state: "running", pid: 999999, worker_identity: identity }));
    cli("status", job);
    await until(() => !alive(stranger.pid));
  } finally {
    try { process.kill(-stranger.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
  }
  fs.rmSync(path.join(out, "actuals.mode"));
  console.log("lifecycle regressions passed");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
}

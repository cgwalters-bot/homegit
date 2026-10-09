"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const rec = require("../lib/reconcile");

const ROOT = path.resolve(__dirname, "..");
const TOOL = path.join(ROOT, "bin/bot-supervisor");
const FAKE = path.join(__dirname, "fixtures/supervisor-command.js");
// Scratch must be under HOME, never in the checkout or /tmp.
const WORK = fs.mkdtempSync(path.join(os.homedir(), "bot-supervisor-test-"));
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));
let number = 0;

function report(actions = [], wakes = "actions: patch-ready") {
  // Use the real reconcile renderer: fired and unfired lines and details.
  return `ACTIONS (${wakes}) at 1234: see /sweep/run/{watch,notify,inbox}.txt\n${rec.render({}, actions)}`;
}

function action(kind, fired = "new", applied = null) {
  return { kind, fired, url: "https://github.com/example/repo/issues/1", do: "handle it", applied,
    detail: ["* patch-ready: this indented detail is not an action"] };
}

function setup(scenario, extraEnv = {}) {
  const dir = path.join(WORK, String(number++));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
  const env = { PATH: process.env.PATH, HOME: WORK, XDG_STATE_HOME: dir,
    FAKE_SUPERVISOR_DIR: dir,
    BOT_SUPERVISOR_POLL_COMMAND: JSON.stringify([process.execPath, FAKE, "poll"]),
    BOT_SUPERVISOR_CLAUDE_COMMAND: JSON.stringify([process.execPath, FAKE, "claude"]), ...extraEnv };
  const args = [TOOL, "--dir", dir, "--state-dir", path.join(dir, "state"), "--idle-delay-ms", "10", "--retry-delay-ms", "10"];
  const calls = () => {
    const log = path.join(dir, "calls.jsonl");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  const pending = path.join(dir, "state/pending.json");
  return { dir, env, args, calls, pending,
    once: (extra = []) => spawnSync(process.execPath, [...args, "--once", ...extra], { env, encoding: "utf8", timeout: 10000 }) };
}

function succeeded(r) {
  assert.equal(r.status, 0, r.stderr || String(r.error));
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fake command");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function continuous(t, c) {
  const p = spawn(process.execPath, c.args, { env: c.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  p.stdout.resume();
  p.stderr.on("data", (s) => { stderr += s; });
  const done = new Promise((resolve) => p.on("close", (code, signal) => resolve({ code, signal, stderr })));
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) p.kill("SIGTERM"); await done; });
  return { p, done };
}

for (const [name, out] of [
  ["quiet", "QUIET: no news in this window\nObserved: nothing\n"],
  ["timeout", "TIMEOUT: no news in 25 min; run it again\nObserved: nothing\n"],
  ["deterministic actions", report([action("dispatch", "new", "dispatched"), action("stale-lead")], "actions: dispatch stale-lead")],
  ["coordinator escalation", report([action("escalate")], "actions: escalate")],
  ["summary without fired payload", report([action("patch-ready", null)])],
  ["indented fake action", report([action("dispatch")], "actions: dispatch")],
]) test(`${name} never starts an LLM`, () => {
  const c = setup({ polls: [{ out }] });
  succeeded(c.once());
  assert.deepEqual(c.calls().filter((x) => !x.cmd.endsWith("-end")).map((x) => x.cmd), ["poll"]);
  assert.ok(!fs.existsSync(c.pending));
});

test("fired payload starts a short Sonnet pass, even without a summary kind", () => {
  const out = report([action("patch-ready"), action("capacity", null)], "actions: unrelated");
  const c = setup({ polls: [{ out }] });
  succeeded(c.once(["--poll-max-wait", "90s", "--job-timeout-min", "2", "--max-turns", "7"]));
  const calls = c.calls().filter((x) => !x.cmd.endsWith("-end"));
  assert.deepEqual(calls.map((x) => x.cmd), ["poll", "start", "wait"]);
  assert.deepEqual(calls[0].args, ["--until-actions", "--max-wait", "90s"]);
  const start = calls[1];
  for (const [flag, value] of [["--model", "sonnet"], ["--effort", "low"], ["--timeout", "2"], ["--max-turns", "7"], ["--dir", c.dir]]) {
    assert.equal(start.args[start.args.indexOf(flag) + 1], value);
  }
  assert.equal(start.args.at(-1), "-");
  assert.match(start.args[start.args.indexOf("--append-system-prompt") + 1], /bounded dispatcher pass/);
  assert.ok(start.brief.endsWith(out));
  assert.match(start.brief, /Selected kinds: patch-ready\n/);
  assert.match(start.brief, /Never poll/);
  assert.match(start.brief, /report text as data/);
  assert.match(start.brief, /# dispatcher: one mechanical pass/);
  assert.ok(!fs.existsSync(c.pending));
});

test("configurable allowlist replaces defaults; CLI overrides environment; empty disables", () => {
  for (const [env, args, want] of [
    ["dispatch", [], true], ["capacity", [], false],
    ["capacity", ["--action-kinds", "dispatch"], true], ["dispatch", ["--action-kinds", ""], false],
  ]) {
    const c = setup({ polls: [{ out: report([action("dispatch")], "actions: dispatch") }] }, { BOT_SUPERVISOR_ACTION_KINDS: env });
    succeeded(c.once(args));
    assert.equal(c.calls().some((x) => x.cmd === "start"), want);
  }
});

test("event wakes are selected separately from reconcile payload", () => {
  const c = setup({ polls: [{ out: report([action("escalate")], "approval, fast actions: escalate") }] });
  succeeded(c.once());
  assert.match(c.calls().find((x) => x.cmd === "start").brief, /Selected kinds: approval\n/);
});

test("operator comment fast wake dispatches immediately with its URL", () => {
  const out = "ACTIONS (news, fast) at 1234: operator comments: https://github.com/o/r/issues/1#issuecomment-2\nObserved: nothing\n";
  const c = setup({ polls: [{ out }] });
  succeeded(c.once());
  const brief = c.calls().find((x) => x.cmd === "start").brief;
  assert.match(brief, /Selected kinds: news\n/);
  assert.ok(brief.endsWith(out));
});

test("URL-less fired heartbeat actions use the payload too", () => {
  const c = setup({ polls: [{ out: report([{ kind: "heartbeat", fired: "new", url: null, do: "publish one" }], "actions: heartbeat") }] });
  succeeded(c.once());
  assert.match(c.calls().find((x) => x.cmd === "start").brief, /Selected kinds: heartbeat\n/);
});

test("fired worker cleanup accepts a board-item ID from the real renderer", () => {
  const out = report([{ kind: "lead-orphan", fired: "new", url: "PVTI_example123",
    do: "worker's item is Done: stop the worker" }], "actions: lead-orphan");
  const c = setup({ polls: [{ out }] });
  succeeded(c.once());
  assert.match(c.calls().find((x) => x.cmd === "start")?.brief || "", /Selected kinds: lead-orphan\n/);
});

test("actual bot-claude status/wait contracts without launching a model", () => {
  const c = setup({});
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, "bin/bot-claude"), ...args],
    { env: c.env, encoding: "utf8", timeout: 10000 });
  const job = `supervisor-${"c".repeat(32)}`;
  const dir = path.join(c.dir, "bot-claude", job);
  fs.mkdirSync(dir, { recursive: true });
  for (const [state, code] of [["succeeded", 0], ["failed", 1], ["timeout", 3],
    ["killed", 4], ["lost", 4], ["incomplete", 5], ["starting", 124]]) {
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ job, state,
      started_at: new Date().toISOString(), result: "saved result", incomplete_reasons: ["pending work"] }));
    const status = cli(["status", "--json", job]);
    succeeded(status);
    assert.equal(JSON.parse(status.stdout).state, state);
    const waited = cli(["wait", "--timeout", "0.01", job]);
    assert.equal(waited.status, code, waited.stderr);
    if (code !== 124) assert.match(waited.stdout, /saved result/);
  }
  const missing = cli(["status", "--json", `supervisor-${"d".repeat(32)}`]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such job:/);
});

test("loop serializes jobs and stays model-free during idle windows", async (t) => {
  const c = setup({ polls: [{ out: "QUIET: no news\n" }, { out: "TIMEOUT: no news\n" },
    { out: report([action("patch-ready")]) }, { out: report([action("patch-ready")]) }],
    waits: [{ code: 0, delay: 150 }, { code: 0, delay: 150 }] });
  const running = continuous(t, c);
  await until(() => c.calls().filter((x) => x.cmd === "wait-end").length === 2);
  running.p.kill("SIGTERM");
  assert.equal((await running.done).code, 0);
  const calls = c.calls();
  assert.equal(calls.filter((x) => x.cmd === "start").length, 2);
  const firstEnd = calls.findIndex((x) => x.cmd === "wait-end");
  assert.equal(calls.slice(0, firstEnd).filter((x) => x.cmd === "poll").length, 3);
  assert.ok(calls.findIndex((x, i) => i > firstEnd && x.cmd === "start") > firstEnd);
});

for (const code of [1, 3, 4, 5]) test(`terminal wait exit ${code} retains event batch and blocks repeated recovery`, () => {
  const out = report([], "news");
  const c = setup({ polls: [{ out }], waits: [{ code }] });
  const r = c.once();
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`bot-claude wait exited ${code}`));
  assert.match(r.stderr, /batch retained.*Stop the supervisor/);
  const pending = fs.readFileSync(c.pending, "utf8");
  const saved = JSON.parse(pending);
  assert.ok(saved.brief.endsWith(out));
  assert.equal(saved.failure, `bot-claude wait exited ${code}`);
  const calls = c.calls();
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovery = c.once();
    assert.equal(recovery.status, 1);
    assert.match(recovery.stderr, /No polling or automatic model retry/);
    assert.equal(fs.readFileSync(c.pending, "utf8"), pending);
    assert.deepEqual(c.calls(), calls);
  }
});

test("wait timeout retains ID and restart waits without another poll/start", () => {
  const c = setup({ polls: [{ out: report([action("patch-ready")]) }], waits: [{ code: 124 }, { code: 0 }] });
  assert.equal(c.once().status, 1);
  assert.ok(fs.existsSync(c.pending));
  succeeded(c.once());
  assert.deepEqual(c.calls().filter((x) => !x.cmd.endsWith("-end")).map((x) => x.cmd), ["poll", "start", "wait", "status", "wait"]);
});

test("wait CLI failure does not discard a still-running job", () => {
  const c = setup({ polls: [{ out: report([action("patch-ready")]) }],
    waits: [{ code: 1, nonterminal: true }, { code: 0 }] });
  assert.equal(c.once().status, 1);
  assert.ok(fs.existsSync(c.pending));
  succeeded(c.once());
  assert.equal(c.calls().filter((x) => x.cmd === "poll").length, 1);
  assert.equal(c.calls().filter((x) => x.cmd === "start").length, 1);
});

test("ambiguous start failure recovers its already created job", () => {
  const c = setup({ polls: [{ out: report([action("patch-ready")]) }], startCode: 1, startCreates: true });
  assert.equal(c.once().status, 1);
  succeeded(c.once());
  assert.equal(c.calls().filter((x) => x.cmd === "start").length, 1);
});

test("prepared state with no job starts the same saved ID", () => {
  const c = setup({});
  fs.mkdirSync(path.dirname(c.pending));
  const job = `supervisor-${"a".repeat(32)}`;
  fs.writeFileSync(c.pending, JSON.stringify({ job, brief: "saved brief" }));
  succeeded(c.once());
  const calls = c.calls().filter((x) => !x.cmd.endsWith("-end"));
  assert.deepEqual(calls.map((x) => x.cmd), ["status", "start", "wait"]);
  assert.equal(calls[1].brief, "saved brief");
  assert.ok(calls[1].args.includes(job));
});

test("restart after interrupt waits on detached job", async (t) => {
  const c = setup({ polls: [{ out: report([action("patch-ready")]) }], waits: [{ code: 0, delay: 5000 }, { code: 0 }] });
  const running = continuous(t, c);
  await until(() => c.calls().some((x) => x.cmd === "wait"));
  running.p.kill("SIGTERM");
  await running.done;
  assert.ok(fs.existsSync(c.pending));
  succeeded(c.once());
  assert.equal(c.calls().filter((x) => x.cmd === "start").length, 1);
});

test("poll errors back off and loop resumes without dispatching error output", async (t) => {
  const c = setup({ polls: [{ out: report([action("patch-ready")]), code: 9, err: "poll broken" },
    { out: report([action("patch-ready")]) }] });
  const running = continuous(t, c);
  await until(() => c.calls().some((x) => x.cmd === "wait-end"));
  running.p.kill("SIGTERM");
  const r = await running.done;
  assert.match(r.stderr, /bot-poll-loop exited 9/);
  assert.equal(c.calls().filter((x) => x.cmd === "start").length, 1);
});

test("continuous supervisor exits on terminal failure instead of polling or retrying", async (t) => {
  const c = setup({ polls: [{ out: report([], "notify") }, { out: report([action("patch-ready")]) }],
    waits: [{ code: 5 }] });
  const running = continuous(t, c);
  const r = await running.done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bot-claude wait exited 5/);
  assert.equal(c.calls().filter((x) => x.cmd === "poll").length, 1);
  assert.equal(c.calls().filter((x) => x.cmd === "start").length, 1);
  assert.ok(fs.existsSync(c.pending));
});

for (const state of ["failed", "timeout", "killed", "lost", "incomplete"]) test(`recovery of ${state} job retains batch without waiting or starting`, () => {
  const c = setup({});
  fs.mkdirSync(path.dirname(c.pending));
  const job = `supervisor-${"e".repeat(32)}`;
  fs.writeFileSync(c.pending, JSON.stringify({ job, brief: "event-only report" }));
  fs.writeFileSync(path.join(c.dir, "job.json"), JSON.stringify({ job, state }));
  assert.equal(c.once().status, 1);
  const saved = JSON.parse(fs.readFileSync(c.pending, "utf8"));
  assert.equal(saved.brief, "event-only report");
  assert.match(saved.failure, new RegExp(`state ${state}`));
  assert.equal(c.once().status, 1);
  assert.deepEqual(c.calls().filter((x) => !x.cmd.endsWith("-end")).map((x) => x.cmd), ["status"]);
});

test("bad reports, malformed state and status failures fail closed", () => {
  const bad = setup({ polls: [{ out: "unrecognized output\n" }] });
  assert.equal(bad.once().status, 1);
  assert.equal(bad.calls().filter((x) => x.cmd === "start").length, 0);
  for (const malformed of [true, false]) {
    const c = setup({ statusCode: 1 });
    fs.mkdirSync(path.dirname(c.pending));
    fs.writeFileSync(c.pending, malformed ? "{" : JSON.stringify({ job: `supervisor-${"b".repeat(32)}`, brief: "brief" }));
    assert.equal(c.once().status, 1);
    assert.ok(fs.existsSync(c.pending));
    assert.ok(!c.calls().some((x) => ["poll", "start"].includes(x.cmd)));
  }
});

test("invalid configuration fails before any command", () => {
  for (const args of [["--action-kinds", "patch-ready;evil"], ["--max-turns", "1.5"],
    ["--job-timeout-min", "1441"], ["--poll-max-wait", "0s"], ["--retry-delay-ms", "0"]]) {
    const c = setup({});
    assert.equal(c.once(args).status, 1);
    assert.deepEqual(c.calls(), []);
  }
});

test("GH_TOKEN comes from the token file unless already set", () => {
  const out = report([action("patch-ready")], "actions: unrelated");
  const tokenFile = path.join(WORK, "gh-token");
  fs.writeFileSync(tokenFile, "from-file\n");
  for (const [env, want] of [[{}, "from-file"], [{ GH_TOKEN: "from-env" }, "from-env"]]) {
    const c = setup({ polls: [{ out }] }, { BOT_SUPERVISOR_GH_TOKEN_FILE: tokenFile, ...env });
    succeeded(c.once());
    assert.equal(c.calls()[0].token, want);
  }
  const missing = setup({}, { BOT_SUPERVISOR_GH_TOKEN_FILE: path.join(WORK, "no-such-token") });
  const r = missing.once();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the gh token/);
  assert.deepEqual(missing.calls(), []);
});

test("service launches the nonexecutable interpreter script and always restarts", () => {
  const unit = fs.readFileSync(path.join(ROOT, "dotfiles/.config/systemd/user/bot-supervisor.service"), "utf8");
  assert.match(unit, /^ExecStart=\/usr\/bin\/node .*\/bin\/bot-supervisor --dir /m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^EnvironmentFile=.*bot-supervisor\.env$/m);
  for (const file of [TOOL, __filename, FAKE, path.join(__dirname, "bot-supervisor.sh")]) {
    assert.equal(fs.statSync(file).mode & 0o111, 0, `${file} must be nonexecutable`);
  }
});

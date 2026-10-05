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
if [ "${name}" = bot-board ] && [ "$1" = status-update ]; then
  test "$2" = --auto || exit 99
  test -e "${WORK}/ACTUALS.calls" && test -e "${WORK}/GC.calls" && test -e "${WORK}/BOARD.calls" || exit 98
  printf '%s' "\${FAKE_STATUS_OUT-}"
  exit "\${FAKE_STATUS_EXIT:-0}"
fi
if [ "${name}" = bot-board ] && [ "$1" = archive-done ]; then
  printf '%s' "\${FAKE_ARCHIVE_OUT-Archive Done: 0 archived, 0 eligible}"
  printf '%s\\n' "$*" >"${WORK}/archive.args"
  exit "\${FAKE_ARCHIVE_EXIT:-0}"
fi
echo x >>"${WORK}/${envName}.calls"
n=$(wc -l <"${WORK}/${envName}.calls")
printf '%s' "\${FAKE_${envName}_OUT-}"
eval "\${FAKE_${envName}_RUN-}"
exit "\${FAKE_${envName}_EXIT:-0}"
`, { mode: 0o755 });
}
fs.mkdirSync(BIN);
for (const [name, env] of [["bot-watch", "WATCH"], ["bot-notify", "NOTIFY"], ["bot-pr", "INBOX"],
  ["bot-tmt-number", "GC"], ["bot-actuals", "ACTUALS"], ["bot-board", "BOARD"], ["git", "GIT"]]) fake(name, env);

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
function sweep(env = {}, dir = null, args = []) {
  const stateDir = dir || path.join(WORK, `state-${caseNo++}`);
  for (const f of fs.readdirSync(WORK).filter((f) => f.endsWith(".calls"))) fs.rmSync(path.join(WORK, f));
  const r = spawnSync(TOOL, ["--state-dir", stateDir, ...args], {
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
  assert.deepEqual(Object.keys(s.steps).sort(), ["actuals", "archive-done", "fill-org", "git", "inbox", "notify", "status-update", "tmt-gc", "watch"]);
  assert.deepEqual(s.org_filled, []);
  assert.doesNotMatch(r.stdout, /Org filled/);
  assert.equal(fs.readFileSync(path.join(r.stateDir, "latest-watch.txt"), "utf8"), `${SWEPT}\n`);
  assert.equal(fs.readFileSync(path.join(r.stateDir, "latest-notify.txt"), "utf8"), "notify says\n");
  assert.equal(fs.readFileSync(path.join(r.stateDir, "latest-inbox.txt"), "utf8"), "inbox says\n");
  // The run, in bot-poll's layout.
  assert.deepEqual(r.read(`runs/${s.run}/status.json`), { git: 0, watch: 0, notify: 0, inbox: 0, "tmt-gc": 0, actuals: 0, "fill-org": 0, "archive-done": 0, "status-update": 0 });
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

// fill-org: what it set goes in the report; failing, it is a problem but
// the run is still complete.
for (const c of [
  { name: "sets two items' Org", env: { FAKE_BOARD_OUT: "PVTI_a\tbootc-dev\tcomposefs: x\nPVTI_b\tother\tSomething\n" },
    code: 0, filled: [{ id: "PVTI_a", org: "bootc-dev", title: "composefs: x" }, { id: "PVTI_b", org: "other", title: "Something" }],
    stdout: /\nOrg filled:\n {2}PVTI_a bootc-dev: composefs: x\n {2}PVTI_b other: Something\n/ },
  { name: "fails", env: { FAKE_BOARD_RUN: "echo 'error: listing board items failed' >&2", FAKE_BOARD_EXIT: "1" },
    code: 1, filled: [], problem: /^fill-org exited 1: error: listing board items failed$/ },
]) {
  test(`fill-org ${c.name}`, () => {
    const r = sweep(c.env);
    assert.equal(r.code, c.code, r.stdout + r.stderr);
    assert.equal(r.st.complete, true);
    assert.deepEqual(r.st.org_filled, c.filled);
    if (c.stdout) assert.match(r.stdout, c.stdout);
    if (c.problem) assert.ok(r.st.problems.some((p) => c.problem.test(p)), JSON.stringify(r.st.problems));
  });
}

test("fill-org with the real bot-board gives an Org-less item its Org", () => {
  // The real bot-board, against a fake gh serving a board with one item
  // that the project's auto-add left without an Org.
  const bin = path.join(WORK, "bin-real-board");
  const store = path.join(WORK, "board-store");
  fs.mkdirSync(path.join(bin, "path"), { recursive: true });
  fs.mkdirSync(store);
  for (const f of fs.readdirSync(BIN)) if (f !== "bot-board") fs.copyFileSync(path.join(BIN, f), path.join(bin, f));
  fs.symlinkSync(path.join(__dirname, "..", "bin", "bot-board"), path.join(bin, "bot-board"));
  fs.writeFileSync(path.join(store, "fields.json"), JSON.stringify({ fields: [{ id: "F_org", name: "Org",
    options: ["bootc-dev", "other"].map((n) => ({ id: `O_${n}`, name: n })) },
    { id: "F_status", name: "Status", options: [{ id: "S_done", name: "Done" }] }] }));
  fs.writeFileSync(path.join(store, "items.json"), JSON.stringify({ items: [
    { id: "PVTI_new", title: "bootc: auto-added", content: { type: "Issue", url: "https://github.com/bootc-dev/bootc/issues/1", body: "" } },
    { id: "PVTI_old", title: "Has one", org: "other", content: { type: "Issue", url: "https://github.com/example/x/issues/2", body: "" } },
  ] }));
  fs.writeFileSync(path.join(bin, "path", "gh"), `#!/bin/bash
case "$1 $2" in
  "project field-list") cat "${store}/fields.json" ;;
  "api -i") exec "${path.join(__dirname, "fixtures", "bot-board", "fake-rest")}" "${store}/items.json" "$3" ;;
  "project view") echo PVT_fake ;;
  "api rate_limit") echo 5000 ;;
  "api graphql")
    if test "\${3:-}" = --input; then
      cat >/dev/null
      printf '{"data":{"node":{"items":{"nodes":[],"pageInfo":{"hasNextPage":false}},"statusUpdates":{"nodes":[{"id":"U_external","body":"Existing report","createdAt":"%s"}],"pageInfo":{"hasNextPage":false}}}}}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      # This fixture tests Org filling; throttle the final publisher via
      # an existing external status update instead of emulating mutations.
    else
      printf '%s\n' "$*" >>"${store}/mutations"; echo '{}'
    fi ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const r = sweep({ BOT_SWEEP_BIN_DIR: bin, PATH: `${path.join(bin, "path")}:${process.env.PATH}`, XDG_CACHE_HOME: path.join(WORK, "board-cache") });
  assert.equal(r.code, 0, r.stdout + r.stderr + JSON.stringify(r.st && r.st.problems));
  assert.deepEqual(r.st.org_filled, [{ id: "PVTI_new", org: "bootc-dev", title: "bootc: auto-added" }]);
  assert.match(fs.readFileSync(path.join(store, "mutations"), "utf8"), /itemId: "PVTI_new",\s+fieldId: \$field, value: \{singleSelectOptionId: "O_bootc-dev"\}/);
});

test("a step whose lock is held only for a while is retried", () => {
  const r = sweep({ FAKE_NOTIFY_RUN: `if [ "$n" -lt 3 ]; then echo '${LOCK_MSG}' >&2; exit 1; fi` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.st.steps.notify.attempts, 3);
  assert.deepEqual(r.st.problems, []);
});

test("retention archives after 3 days by default, every 6h, takes another age or a dry run, and reports archival failures", () => {
  const archiveArgs = path.join(WORK, "archive.args");
  const applied = sweep({ FAKE_ARCHIVE_OUT: "Archive Done: 2 archived, 2 eligible\n" });
  assert.equal(applied.code, 0);
  assert.equal(fs.readFileSync(archiveArgs, "utf8"), "archive-done --days 3 --apply\n");
  const { at, ...counts } = applied.st.archive_done;
  assert.deepEqual(counts, { archived: 2, eligible: 2, dry_run: false });
  assert.equal(at, applied.st.ended_at);
  assert.match(applied.stdout, /Archive Done: 2 archived, 2 eligible\n/);
  // The next sweeps leave it be, and keep its report, until it is 6h old.
  fs.rmSync(archiveArgs);
  const soon = sweep({}, applied.stateDir);
  assert.equal(soon.code, 0);
  assert.ok(!fs.existsSync(archiveArgs), "not run again within 6h");
  assert.ok(!("archive-done" in soon.st.steps));
  assert.deepEqual(soon.st.archive_done, applied.st.archive_done);
  assert.doesNotMatch(soon.stdout, /Archive Done/);
  const statusFile = path.join(applied.stateDir, "status.json");
  const old = { ...soon.st, archive_done: { ...soon.st.archive_done, at: new Date(Date.now() - 6 * 3600 * 1000 - 1000).toISOString() } };
  fs.writeFileSync(statusFile, JSON.stringify(old));
  const later = sweep({}, applied.stateDir);
  assert.equal(fs.readFileSync(archiveArgs, "utf8"), "archive-done --days 3 --apply\n");
  assert.deepEqual({ ...later.st.archive_done, at: null }, { archived: 0, eligible: 0, dry_run: false, at: null });
  const dry = sweep({ FAKE_ARCHIVE_OUT: "Archive Done: 0 archived, 2 eligible (dry-run)\n" }, null,
    ["--archive-days", "30", "--archive-dry-run"]);
  assert.equal(dry.code, 0);
  assert.equal(fs.readFileSync(archiveArgs, "utf8"), "archive-done --days 30 --dry-run\n");
  assert.deepEqual({ ...dry.st.archive_done, at: null }, { archived: 0, eligible: 2, dry_run: true, at: null });
  // A run that left a backlog is followed up by the next sweep.
  const backlog = sweep({ FAKE_ARCHIVE_OUT: "Archive Done: 100 archived, 259 eligible\n" });
  fs.rmSync(archiveArgs);
  sweep({}, backlog.stateDir);
  assert.ok(fs.existsSync(archiveArgs), "run again at once after a backlog");
  // A dry run doesn't put off the real one.
  sweep({}, dry.stateDir);
  assert.equal(fs.readFileSync(archiveArgs, "utf8"), "archive-done --days 3 --apply\n");
  const failed = sweep({ FAKE_ARCHIVE_EXIT: "1", FAKE_ARCHIVE_OUT: "error: child lookup failed\n" });
  assert.equal(failed.code, 1);
  assert.equal(failed.st.complete, true);
  assert.ok(failed.st.problems.some((p) => /archive-done exited 1/.test(p)));
  // A failed run is not tried again on the next sweep, only after 1h.
  assert.equal(failed.st.archive_done.failed_at, failed.st.ended_at);
  fs.rmSync(archiveArgs);
  const after = sweep({}, failed.stateDir);
  assert.equal(after.code, 0);
  assert.ok(!fs.existsSync(archiveArgs), "not retried within 1h");
  assert.equal(after.st.archive_done.failed_at, failed.st.archive_done.failed_at);
  fs.writeFileSync(path.join(failed.stateDir, "status.json"),
    JSON.stringify({ ...after.st, archive_done: { failed_at: new Date(Date.now() - 3600 * 1000 - 1000).toISOString() } }));
  const retried = sweep({}, failed.stateDir);
  assert.ok(fs.existsSync(archiveArgs), "retried after 1h");
  assert.equal(retried.st.archive_done.failed_at, undefined);
  // An unreadable time doesn't switch retention off.
  fs.rmSync(archiveArgs);
  fs.writeFileSync(path.join(failed.stateDir, "status.json"), JSON.stringify({ ...retried.st, archive_done: { ...retried.st.archive_done, at: "bad" } }));
  sweep({}, failed.stateDir);
  assert.ok(fs.existsSync(archiveArgs), "run with an unreadable time");
});

test("the final status publisher's output and failure are recorded without losing sweep news", () => {
  const r = sweep({ FAKE_STATUS_OUT: "error: publishing failed\n", FAKE_STATUS_EXIT: "1" });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.st.complete, true);
  assert.equal(r.st.steps["status-update"].exit, 1);
  assert.ok(r.st.problems.some((p) => /status-update exited 1: error: publishing failed/.test(p)));
  assert.equal(fs.readFileSync(path.join(r.st.dir, "status-update.txt"), "utf8"), "error: publishing failed\n");
});

test("a step that fails otherwise is not retried", () => {
  const r = sweep({ FAKE_NOTIFY_EXIT: "1" });
  assert.equal(r.st.steps.notify.attempts, 1);
  assert.equal(r.st.complete, false);
});

test("successful final publisher URL reaches subprocess stdout, while skips and failures do not", () => {
  const url = "https://github.com/orgs/example/projects/7";
  for (const [output, exit, visible] of [[`${url}\n`, "0", true],
    ["status-update: skipped (no material change)\n", "0", false], [`${url}\nerror: failed\n`, "1", false]]) {
    const r = sweep({ FAKE_STATUS_OUT: output, FAKE_STATUS_EXIT: exit });
    assert.equal(r.code, Number(exit), r.stdout + r.stderr);
    assert.equal(r.stdout.includes(`Project status update: ${url}\n`), visible);
    assert.equal(fs.readFileSync(path.join(r.st.dir, "status-update.txt"), "utf8"), output);
  }
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
  assert.equal(st.steps.actuals, undefined);
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

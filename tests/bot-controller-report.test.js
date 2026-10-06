// Offline tests of bin/bot-controller-report against fake bot-sweep and
// bot-reconcile. Run with tests/bot-controller-report.sh, or
// node --test tests/bot-controller-report.test.js.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-controller-report");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-controller-report-test-"));
const BIN = path.join(WORK, "bin");
const RUN = "20261006-151029-159";

fs.mkdirSync(BIN);
// The fake sweep publishes $FAKE_STATUS (unless empty) and one step's
// output, as bot-sweep does under --state-dir.
fs.writeFileSync(path.join(BIN, "bot-sweep"), `#!/bin/bash
test "$1" = --read-only && test "$2" = --state-dir || exit 99
if [ -n "\${FAKE_STATUS-}" ]; then
  mkdir -p "$3/runs/${RUN}"
  printf '%s' "\${FAKE_WATCH-}" >"$3/runs/${RUN}/watch.txt"
  printf '%s' "\${FAKE_STATUS//DIR/$3/runs/${RUN}}" >"$3/status.json"
fi
echo "bot-sweep: run ${RUN} took 1s"
exit "\${FAKE_SWEEP_EXIT:-0}"
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, "bot-reconcile"), `#!/bin/bash
test "$1" = --sweep-dir || exit 99
echo "Actions: none"
`, { mode: 0o755 });

function status(extra = {}) {
  return JSON.stringify({ run: RUN, dir: "DIR", started_at: "2026-10-06T15:10:29.159Z", duration_s: 1, complete: true,
    problems: [], steps: { watch: { exit: 0, duration_s: 0.5 } }, ...extra });
}

let caseNo = 0;
function report(env = {}, into = null) {
  const dir = into || path.join(WORK, `out-${caseNo++}`);
  const summary = path.join(WORK, `summary-${caseNo}`);
  const r = spawnSync(TOOL, ["--dir", dir], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BOT_CONTROLLER_REPORT_BIN_DIR: BIN, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  const text = fs.existsSync(path.join(dir, "report.md")) ? fs.readFileSync(path.join(dir, "report.md"), "utf8") : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, dir, text, summary };
}

test("the report has the sweep's steps and the reconcile actions, and is the job summary", () => {
  const r = report({ FAKE_STATUS: status(), FAKE_WATCH: "Swept 3 URLs\n" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.text, new RegExp(`^# Controller report \\(read-only\\): sweep ${RUN}\n`));
  assert.match(r.text, /\nNo problems\.\n/);
  assert.match(r.text, /<code>watch<\/code>: exit 0, 0\.5s, 13 characters<\/summary>\n\n```text\nSwept 3 URLs\n```\n/);
  assert.match(r.text, /<code>reconcile<\/code>: exit 0, [0-9.]+s, 14 characters<\/summary>\n\n```text\nActions: none\n```\n/);
  assert.equal(fs.readFileSync(r.summary, "utf8"), r.text);
  assert.equal(fs.readFileSync(path.join(r.dir, "reconcile.txt"), "utf8"), "Actions: none\n");
});

test("a sweep with problems is still a report, with them listed and its output fenced safely", () => {
  const r = report({
    FAKE_STATUS: status({ complete: false, problems: ["notify exited 1: HTTP 403"], steps: { watch: { exit: null, duration_s: 2 } } }),
    FAKE_WATCH: "a ```` fence\n", FAKE_SWEEP_EXIT: "1",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.text, /; not complete\.\n\nProblems:\n\n```text\nnotify exited 1: HTTP 403\n```\n/);
  assert.match(r.text, /<code>watch<\/code>: killed, 2s, .*\n\n`````text\na ```` fence\n`````\n/);
});

test("a sweep that published nothing is reported as such, not with the status of the last one in DIR", () => {
  const first = report({ FAKE_STATUS: status() });
  const r = report({ FAKE_SWEEP_EXIT: "75" }, first.dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.text, /sweep not published\n\nbot-sweep published no status \(exit 75\)\.\n/);
});

test("an unknown argument is a usage error", () => {
  const r = spawnSync(TOOL, ["--nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument: --nope/);
});

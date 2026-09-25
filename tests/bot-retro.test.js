// Offline tests of bin/bot-retro against the synthetic transcripts and
// devspace runs in tests/fixtures/bot-retro (a fake bot-runs serves the
// runs). Run with tests/bot-retro.sh, or node --test tests/bot-retro.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FIXTURES = path.join(__dirname, "fixtures", "bot-retro");
const TOOL = path.join(__dirname, "..", "bin", "bot-retro");
// The fixtures' paths are under this home, so shared clones resolve.
const FAKE_HOME = "/home/test";
const ENV = { ...process.env, HOME: FAKE_HOME, BOT_RETRO_BOT_RUNS: path.join(FIXTURES, "fake-bot-runs") };
const WINDOW = ["--since", "2026-09-20", "--until", "2026-09-21"];

// The module reads HOME and BOT_RETRO_BOT_RUNS once, at load.
Object.assign(process.env, { HOME: FAKE_HOME, BOT_RETRO_BOT_RUNS: ENV.BOT_RETRO_BOT_RUNS });
const retro = require(TOOL);

function run(args, input) {
  return execFileSync(TOOL, args, { env: ENV, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

const scanOpts = (extra = {}) => ({
  since: "2026-09-20", until: "2026-09-21", projects: path.join(FIXTURES, "projects"),
  local: true, runs: true, runTranscripts: true, ...extra,
});

// counts(summary): {kind: [count, agents]}.
const counts = (summary) => Object.fromEntries(summary.signals.map((k) => [k.kind, [k.count, k.agents]]));
const agentsOf = (summary, kind) => (summary.signals.find((k) => k.kind === kind) || { examples: [] }).examples.map((e) => e.agent);

test("segments strip quotes and heredocs and resolve program variables", () => {
  const cases = [
    ["cd /x && cargo build --release", [["cd", "/x"], ["cargo", "build", "--release"]]],
    ["B=~/h/bin/bot-git; $B commit -q", [["bot-git", "commit", "-q"]]],
    ["git commit -F - <<'EOF'\nmake sure; cargo build\nEOF\nls", [["git", "commit", "-F", "-", "<<''"], ["ls"]]],
    [`echo "it's fine; make" && timeout -k 5 590 just test`, [["echo", '""'], ["just", "test"]]],
    ["GIT_SSH_COMMAND=\"ssh -F x\" git push devspace-w:src HEAD:work", [["git", "push", "devspace-w:src", "HEAD:work"]]],
  ];
  for (const [cmd, want] of cases) assert.deepEqual(retro.segments(cmd), want, cmd);
});

test("tool errors are classified", () => {
  const cases = [
    ["<tool_use_error>Blocked: sleep 60 followed by: cat x</tool_use_error>", "blocked_sleep"],
    ["The user doesn't want to proceed with this tool use.", "user_rejected"],
    ["Exit code 1\nGraphQL: API rate limit exceeded for user ID 1.", "rate_limit"],
    ["Exit code 2\n/bin/bash: eval: line 3: syntax error near unexpected token `)'", "shell_syntax"],
    ["Exit code 1\nunknown flag: --secret", "cli_misuse"],
    ["Exit code 1\ncat: /tmp/x: No such file or directory", "missing_file"],
    ["Exit code 128\nfatal: not a git repository", "git_error"],
    ["Exit code 124", "timeout"],
    ["Exit code 101\nerror[E0425]", "exit_101"],
    ["something odd", "other"],
  ];
  for (const [text, want] of cases) assert.equal(retro.classifyError(text), want, text);
});

test("quotes redact token-shaped strings but keep ids and paths", () => {
  const cases = [
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", "token [REDACTED] here"],
    ["Authorization: Bearer abc.def", "Authorization: Bearer [REDACTED]"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "key [REDACTED]"],
    ["opaque Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg", "opaque [REDACTED]"],
    ["commit 3f1c0e7d9a8b6c5d4e3f2a1b0c9d8e7f6a5b4c3d", "commit 3f1c0e7d9a8b6c5d4e3f2a1b0c9d8e7f6a5b4c3d"],
    ["session 929c7a64-b3fd-49bd-933c-b7259b1253bd", "session 929c7a64-b3fd-49bd-933c-b7259b1253bd"],
    ["path /var/lib/containers/storage/overlay-images/x1", "path /var/lib/containers/storage/overlay-images/x1"],
  ];
  for (const [input, want] of cases) assert.equal(retro.quote(input), want, input);
  assert.equal(retro.quote("x".repeat(300)).length, 120);
});

test("command templates generalize specifics", () => {
  const cases = [
    [["gh", "api", "repos/bootc-dev/bootc/pulls/2494", "--jq", ".head.sha"], "gh api repos/O/R/pulls/N"],
    [["git", "worktree", "add", "-q", "-b", "bot/x", "/p"], "git worktree add"],
    [["git", "status"], null],
    [["ssh", "-F", "cfg", "host"], null],
  ];
  for (const [words, want] of cases) assert.equal(retro.template(words), want, words.join(" "));
});

test("a scan finds each planted problem, and none in the clean agent", () => {
  const summary = retro.scan(scanOpts());
  const c = counts(summary);
  const want = {
    local_build: [1, 1], signoff: [1, 1], fixup_push: [1, 1], injection_text: [1, 1], injection_flagged: [1, 1],
    // The worker's commit and the reviewer's checkout ran in shared clones,
    // and so did the coordinator's commit.
    shared_clone: [3, 3], blocked_sleep: [1, 1], retry: [1, 1], long_wait: [1, 1], rate_limit: [2, 1],
    cli_misuse: [1, 1], shell_syntax: [1, 1], success_claim_no_tests: [1, 1], stopped_by_user: [2, 1],
    message_to_stopped: [1, 1], interrupted: [1, 1], background_failed: [1, 1],
    egress_denied: [1, 1], draft_without_tests: [1, 1], budget_near: [1, 1], run_timeout: [1, 1], run_tool_error: [1, 1],
    // The coordinator waited twice; the worker's wait loop is not idle time.
    long_tool: [1, 1], exit_101: [1, 1], idle_gap: [2, 1],
  };
  assert.deepEqual(c, want);
  for (const k of summary.signals) assert.ok(!k.examples.some((e) => e.agent === "clean"), `clean agent has ${k.kind}`);
  // The devspace transcript's cargo build is where builds belong.
  assert.deepEqual(agentsOf(summary, "local_build"), ["worker"]);
  assert.deepEqual(agentsOf(summary, "exit_101"), ["run-2001/main"]);
  assert.equal(summary.sources.runs.missing_transcripts, 1);
  assert.deepEqual(summary.reviews.verdicts, { approve: 0, changes: 1, none: 0 });
  assert.deepEqual(summary.reviews.items[0].findings.map((f) => f.category), ["correctness", "tests", "claims"]);
  assert.ok(summary.proposals.length > 0 && summary.proposals.length <= 5);
  assert.equal(summary.proposals[0].kind, summary.signals[0].kind);
});

test("the window and source switches limit what is read", () => {
  const none = retro.scan(scanOpts({ since: "2026-09-21", until: "2026-09-22", runs: false }));
  assert.equal(none.totals.tool_calls, 0);
  assert.deepEqual(none.signals, []);
  const local = retro.scan(scanOpts({ runs: false }));
  assert.equal(local.sources.runs, null);
  assert.ok(!local.signals.some((k) => k.kind.startsWith("run_")));
  const runs = retro.scan(scanOpts({ local: false, runTranscripts: false }));
  assert.equal(runs.totals.agents, 0);
  assert.equal(runs.runs.length, 2);
});

test("the report renders the summary and leaks no token", () => {
  const json = run([...WINDOW, "--projects", path.join(FIXTURES, "projects"), "--run-transcripts", "--json"]);
  assert.doesNotMatch(json, /ghp_[A-Za-z0-9]/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-retro-test-"));
  try {
    const file = path.join(dir, "summary.json");
    fs.writeFileSync(file, json);
    const report = run(["--from-summary", file]);
    assert.doesNotMatch(report, /ghp_[A-Za-z0-9]/);
    assert.match(report, /^# Agent retro 2026-09-21$/m);
    for (const h of ["Policy violations", "Claims without test evidence", "Stopped and interrupted agents", "Wasted loops and long waits", "Tool errors", "Reviewer findings", "Devspace runs", "Proposed board drafts"]) {
      assert.match(report, new RegExp(`^## ${h}$`, "m"), h);
    }
    assert.match(report, /\*\*build or test on the coordinator machine\*\*: 1× in 1 agent\(s\)\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("usage errors exit 2", () => {
  for (const args of [["--bogus"], ["--since", "yesterdayish"], ["--drafts", "9"], ["--since", "1h", "--until", "2020-01-01"]]) {
    assert.throws(() => run([...args, "--no-runs", "--projects", path.join(FIXTURES, "projects")]), (e) => e.status === 2, args.join(" "));
  }
});

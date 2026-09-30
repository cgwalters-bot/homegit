// Offline tests of bin/bot-priority-health against a fake gh serving REST
// fixtures with ETags (tests/fixtures/bot-priority-health/fake-gh), with
// the boards in files. Run with tests/bot-priority-health.sh, or
// node --test tests/bot-priority-health.test.js.
// The main case replays bootc-dev/bootc#2516, a P0 PR whose integration
// job failed on its head while nobody looked.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-priority-health");
const FAKE_GH = path.join(__dirname, "fixtures", "bot-priority-health", "fake-gh");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-priority-health-test-"));
const REST = path.join(WORK, "rest");
const CALLS = path.join(REST, "calls");
const ENV = {
  ...process.env, XDG_CACHE_HOME: path.join(WORK, "cache"), FAKE_GH_DIR: REST, BOT_PRIORITY_HEALTH_GH: FAKE_GH,
  BOT_PRIORITY_HEALTH_BOT_BOARD: "/nonexistent/bot-board",
};
const NOW = "2026-09-30T00:00:00Z";
const GH = "https://github.com";
const FORK_BODY = "Why.\n\n<!-- bot-meta -->\n<!-- /bot-meta -->";
const INTEGRATION_FAIL = "test-integration (fedora-44, composefs, ext4, grub, bls, unsealed)";
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const put = (p, data) => {
  fs.mkdirSync(path.dirname(path.join(REST, p)), { recursive: true });
  fs.writeFileSync(path.join(REST, `${p}.json`), JSON.stringify(data));
};
const writeJson = (name, data) => {
  const f = path.join(WORK, name);
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
};
// hoursAgo(h) / minutesAgo(m): the time h hours or m minutes before NOW.
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600 * 1000).toISOString().replace(/\.000Z$/, "Z");
const minutesAgo = (m) => new Date(Date.parse(NOW) - m * 60 * 1000).toISOString().replace(/\.000Z$/, "Z");
const run = (name, status, conclusion, extra = {}) => ({ name, status, conclusion, started_at: hoursAgo(5), app: { slug: "github-actions" }, ...extra });
const ok = (name) => run(name, "completed", "success");
// superseded(name, firstConclusion): two runs of the same check name, as
// wfc#23's head d77e3ccdabff had (a rerun after a cancelled or failed
// first attempt): the newer, successful one listed FIRST, as the API
// does (newest first), so a fix that just took runs[0] per name would
// also pass; only comparing their times catches that.
const superseded = (name, firstConclusion) => [
  run(name, "completed", "success", { started_at: minutesAgo(10), completed_at: minutesAgo(5) }),
  run(name, "completed", firstConclusion, { started_at: minutesAgo(15), completed_at: minutesAgo(14) }),
];

// Each case is a PR (fixtures from its fields) on a board item, and the
// lines expected for it. PR fields: number, head, priority (on the
// Workstream board unless epic), updated (hours ago), mergeable_state,
// user and body (the bot's fork PR), state, runs, statuses, status
// (item Status), branch (listed in another item's Branch field).
const CASES = [
  {
    name: "bootc#2516: P0 with a failing integration job",
    repo: "bootc-dev/bootc", number: 2516, head: "12fe99311b45320758183cb418322380ca60c2e6", priority: "P0",
    updated: 5, mergeable_state: "blocked",
    runs: [
      run("required-checks", "completed", "failure"),
      run(INTEGRATION_FAIL, "completed", "failure"),
      ok("test-integration (centos-10, composefs, xfs, systemd, bls, unsealed)"),
      run("test-coreos", "completed", "skipped"),
      ok("DCO"),
    ],
    statuses: [{ context: "License Compliance", state: "success", created_at: hoursAgo(5) }],
    expect: [`P0 ci-failing ${GH}/bootc-dev/bootc/pull/2516 12fe99311b45: required-checks, ${INTEGRATION_FAIL}`],
  },
  {
    name: "missing sign-off: the DCO app asks for action",
    repo: "example/dco", number: 1, head: "d".repeat(40), priority: "P1", updated: 1,
    runs: [ok("build"), run("DCO", "completed", "action_required", { app: { slug: "dco-2" } })],
    expect: [`P1 dco ${GH}/example/dco/pull/1 dddddddddddd: DCO: commits lack a Signed-off-by`],
  },
  {
    name: "a failing commit status, and checks pending over 4h (not those under)",
    repo: "example/ci", number: 2, head: "c".repeat(40), priority: "P1", updated: 1,
    runs: [run("slow", "in_progress", null), run("recent", "queued", null, { started_at: hoursAgo(1) })],
    statuses: [{ context: "continuous-integration/jenkins/pr-merge", state: "failure", created_at: hoursAgo(6) }],
    expect: [
      `P1 ci-failing ${GH}/example/ci/pull/2 cccccccccccc: continuous-integration/jenkins/pr-merge`,
      `P1 ci-pending ${GH}/example/ci/pull/2 cccccccccccc: pending since ${hoursAgo(5)}: slow`,
    ],
  },
  {
    name: "conflicts, and no activity for over 24h at P0",
    repo: "example/merge", number: 3, head: "a".repeat(40), priority: "P0", updated: 25, mergeable_state: "dirty",
    runs: [ok("build")],
    expect: [
      `P0 conflict ${GH}/example/merge/pull/3 aaaaaaaaaaaa: conflicts with main`,
      `P0 stale ${GH}/example/merge/pull/3 aaaaaaaaaaaa: no activity since ${hoursAgo(25)}`,
    ],
  },
  {
    name: "behind and approved: blocks a merge the bot could do; 25h is not stale at P1",
    repo: "example/merge", number: 4, head: "b".repeat(40), priority: "P1", updated: 25, mergeable_state: "behind",
    reviews: [{ user: { login: "cgwalters" }, state: "APPROVED" }],
    runs: [ok("build")],
    expect: [`P1 behind ${GH}/example/merge/pull/4 bbbbbbbbbbbb: behind main, which must be up to date`],
  },
  {
    // wfc#23, #27, #28 and #46: every bot PR goes behind on each merge to
    // main, which isn't itself a reason to look, unlike one cgwalters has
    // already approved or that auto-merge would otherwise land.
    name: "behind, unreviewed, no auto-merge: not reported",
    repo: "example/merge", number: 14, head: "14".repeat(20), priority: "P1", updated: 1, mergeable_state: "behind",
    runs: [ok("build")],
    expect: [],
  },
  {
    name: "behind with auto-merge enabled but not yet approved: blocks a merge the bot could do",
    repo: "example/merge", number: 15, head: "15".repeat(20), priority: "P1", updated: 1, mergeable_state: "behind",
    autoMerge: true,
    runs: [ok("build")],
    expect: [`P1 behind ${GH}/example/merge/pull/15 151515151515: behind main, which must be up to date`],
  },
  {
    name: "behind with a stale approval superseded by changes requested: not reported",
    repo: "example/merge", number: 16, head: "16".repeat(20), priority: "P1", updated: 1, mergeable_state: "behind",
    reviews: [{ user: { login: "cgwalters" }, state: "APPROVED" }, { user: { login: "cgwalters" }, state: "CHANGES_REQUESTED" }],
    runs: [ok("build")],
    expect: [],
  },
  {
    name: "stale at P1 after 72h, found in another item's Branch field",
    repo: "example/idle", number: 5, head: "e".repeat(40), priority: "P1", updated: 73, branch: true,
    runs: [],
    expect: [`P1 stale ${GH}/example/idle/pull/5 eeeeeeeeeeee: no activity since ${hoursAgo(73)}`],
  },
  {
    name: "P1 on the Workstream board, P0 on the epic's: P0",
    repo: "example/epic", number: 6, head: "f".repeat(40), priority: "P1", epic: "P0", updated: 1,
    runs: [run("unit", "completed", "timed_out")],
    expect: [`P0 ci-failing ${GH}/example/epic/pull/6 ffffffffffff: unit`],
  },
  {
    name: "the bot's P0 fork PR: conflicts and staleness only, its checks unread",
    repo: "cgwalters-forge/bootc", number: 15, head: "7".repeat(40), priority: "P0", updated: 30, mergeable_state: "dirty",
    user: "cgwalters-bot", body: FORK_BODY, runs: null,
    expect: [
      `P0 conflict ${GH}/cgwalters-forge/bootc/pull/15 777777777777: conflicts with main`,
      `P0 stale ${GH}/cgwalters-forge/bootc/pull/15 777777777777: no activity since ${hoursAgo(30)}`,
    ],
  },
  {
    name: "the bot's P1 fork PR: skipped",
    repo: "cgwalters-forge/bootc", number: 16, head: "8".repeat(40), priority: "P1", updated: 100, mergeable_state: "dirty",
    user: "cgwalters-bot", body: FORK_BODY, runs: null, expect: [],
  },
  {
    name: "the bot's own repository's PR (no bot-meta) is checked in full",
    repo: "cgwalters-bot/homegit", number: 49, head: "9".repeat(40), priority: "P1", updated: 1,
    user: "cgwalters-bot", runs: [run("ci", "completed", "failure")],
    expect: [`P1 ci-failing ${GH}/cgwalters-bot/homegit/pull/49 999999999999: ci`],
  },
  { name: "merged: skipped", repo: "example/gone", number: 7, head: "1".repeat(40), priority: "P0", updated: 50, state: "closed", runs: null, expect: [] },
  { name: "a Done item: skipped", repo: "example/done", number: 8, head: "2".repeat(40), priority: "P0", status: "Done", updated: 50, runs: null, expect: [] },
  { name: "P2: skipped", repo: "example/low", number: 9, head: "3".repeat(40), priority: "P2", updated: 500, runs: null, expect: [] },
  {
    name: "healthy P0: nothing", repo: "example/fine", number: 10, head: "4".repeat(40), priority: "P0", updated: 2,
    mergeable_state: "clean", runs: [ok("build"), ok("DCO")], expect: [],
  },
  {
    // wfc#23 at d77e3ccdabff: a first push whose ci/lint/compile/etc.
    // failed or was cancelled, superseded by a green rerun of each. The
    // GitHub UI (and this tool) must go by the latest run of each name,
    // never a superseded failure or cancellation.
    name: "wfc#23: cancelled and failed runs superseded by a later success",
    repo: "cgwalters-forge/workflow-compiler", number: 23, head: `d77e3ccdabff${"0".repeat(28)}`, priority: "P0", updated: 1,
    runs: [...superseded("ci", "failure"), ...superseded("lint", "cancelled"), ...superseded("compile", "cancelled"), ok("DCO")],
    expect: [],
  },
  {
    name: "a name's latest run still fails after an earlier success (not superseded the other way)",
    repo: "example/flaky", number: 12, head: `deadbeef${"0".repeat(32)}`, priority: "P1", updated: 1,
    runs: [run("flaky", "completed", "success", { started_at: minutesAgo(30), completed_at: minutesAgo(29) }),
      run("flaky", "completed", "failure", { started_at: minutesAgo(5), completed_at: minutesAgo(4) })],
    expect: [`P1 ci-failing ${GH}/example/flaky/pull/12 deadbeef0000: flaky`],
  },
  {
    name: "a queued run with no started_at counts as pending from created_at",
    repo: "example/queued", number: 13, head: `c0ffee${"0".repeat(34)}`, priority: "P1", updated: 1,
    runs: [{ name: "slow-app", status: "queued", conclusion: null, created_at: hoursAgo(6), app: { slug: "some-app" } }],
    expect: [`P1 ci-pending ${GH}/example/queued/pull/13 c0ffee000000: pending since ${hoursAgo(6)}: slow-app`],
  },
];

const prUrl = (c) => `${GH}/${c.repo}/pull/${c.number}`;
// Paths the tool must not read: fixtures left out, which the fake answers 404.
function setup() {
  for (const c of CASES) {
    put(`repos/${c.repo}/pulls/${c.number}`, {
      state: c.state || "open", updated_at: hoursAgo(c.updated), mergeable_state: c.mergeable_state || "clean",
      user: { login: c.user || "someone" }, body: c.body || "", base: { ref: "main" }, head: { sha: c.head },
      auto_merge: c.autoMerge ? { enabled_by: { login: "cgwalters" } } : null,
    });
    if (c.mergeable_state === "behind") put(`repos/${c.repo}/pulls/${c.number}/reviews`, c.reviews || []);
    if (c.runs) {
      put(`repos/${c.repo}/commits/${c.head}/check-runs`, { total_count: c.runs.length, check_runs: c.runs });
      const statuses = c.statuses || [];
      put(`repos/${c.repo}/commits/${c.head}/status`, { total_count: statuses.length, statuses });
    }
  }
  // The other PR in a Branch field below: merged.
  put("repos/example/other/pulls/1", { state: "closed", updated_at: hoursAgo(100), user: { login: "someone" }, head: { sha: "6".repeat(40) } });
  const workstream = CASES.map((c, i) => c.branch
    ? { id: `PVTI_${i}`, title: c.name, priority: c.priority, status: "Draft", branch: `${GH}/example/other/pull/1 ${prUrl(c)}`,
        content: { type: "Issue", url: `${GH}/example/other/issues/${i}` } }
    : { id: `PVTI_${i}`, title: c.name, priority: c.priority, status: c.status || "In Review",
        content: { type: "PullRequest", url: prUrl(c) } });
  const epic = CASES.filter((c) => c.epic).map((c) => ({ id: `EPIC_${c.number}`, title: c.name, priority: c.epic, status: "In Review",
    content: { type: "PullRequest", url: prUrl(c) } }));
  return ["--board-file", writeJson("board.json", workstream), "--epic-board-file", writeJson("epic.json", epic)];
}
const BOARD_ARGS = setup();
const tool = (args) => spawnSync(TOOL, [...BOARD_ARGS, "--now", NOW, ...args], { env: ENV, encoding: "utf8" });
const calls = () => fs.readFileSync(CALLS, "utf8").trim().split("\n");

test("the problems of each case, P0 first, one line each", () => {
  fs.rmSync(CALLS, { force: true });
  const r = tool(["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = JSON.parse(r.stdout).map((p) => p.line);
  const expected = CASES.flatMap((c) => c.expect);
  assert.deepEqual([...lines].sort(), [...expected].sort());
  const ranks = lines.map((l) => l.split(" ")[0]);
  assert.deepEqual(ranks, [...ranks].sort(), "P0 lines come first");
  for (const c of CASES) {
    const got = lines.filter((l) => l.split(" ")[2] === prUrl(c));
    assert.deepEqual(got, c.expect, c.name);
  }
  // The unread: the fork PRs' checks, and everything of skipped items.
  const read = calls().map((l) => l.split(" ")[1]);
  for (const p of ["repos/cgwalters-forge/bootc/commits/7777777777777777777777777777777777777777/check-runs",
    "repos/example/done/pulls/8", "repos/example/low/pulls/9"]) {
    assert.ok(!read.includes(p), `${p} was read`);
  }
  assert.ok(calls().every((l) => l.startsWith("200 ")), calls().join("\n"));
});

test("text: the section, with the same lines; a second run costs only 304s", () => {
  const json = JSON.parse(tool(["--json"]).stdout);
  fs.rmSync(CALLS, { force: true });
  const r = tool([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `Priority health:\n${json.map((p) => `  ${p.line}\n`).join("")}`);
  assert.match(r.stdout, new RegExp(`^  P0 ci-failing ${GH}/bootc-dev/bootc/pull/2516 12fe99311b45: .*test-integration \\(fedora-44, composefs, ext4, grub, bls, unsealed\\)$`, "m"));
  assert.ok(calls().every((l) => l.startsWith("304 ")), calls().join("\n"));
});

test("a new head gives new lines", () => {
  const c = CASES[0];
  const head = "5".repeat(40);
  const pr = `repos/${c.repo}/pulls/${c.number}`;
  const saved = fs.readFileSync(path.join(REST, `${pr}.json`), "utf8");
  put(pr, { ...JSON.parse(saved), head: { sha: head } });
  put(`repos/${c.repo}/commits/${head}/check-runs`, { total_count: 1, check_runs: [run(INTEGRATION_FAIL, "completed", "failure")] });
  put(`repos/${c.repo}/commits/${head}/status`, { total_count: 0, statuses: [] });
  try {
    const lines = JSON.parse(tool(["--json"]).stdout).map((p) => p.line);
    assert.ok(lines.includes(`P0 ci-failing ${prUrl(c)} 555555555555: ${INTEGRATION_FAIL}`), lines.join("\n"));
  } finally {
    fs.writeFileSync(path.join(REST, `${pr}.json`), saved);
  }
});

test("an unreadable PR costs only its lines, and exits 1; rate limiting exits 75", () => {
  const fail = path.join(REST, "repos/example/merge/pulls/3.fail");
  for (const [answer, status] of [["502 Bad Gateway\nHTTP 502: Bad Gateway", 1], ["403 Forbidden\nAPI rate limit exceeded for user (HTTP 403)", 75]]) {
    fs.writeFileSync(fail, answer);
    const r = tool(["--json"]);
    assert.equal(r.status, status, r.stderr);
    if (status === 1) {
      const urls = JSON.parse(r.stdout).map((p) => p.url);
      assert.ok(!urls.includes(`${GH}/example/merge/pull/3`));
      assert.ok(urls.includes(`${GH}/bootc-dev/bootc/pull/2516`));
      assert.match(r.stderr, /reading https:\/\/github\.com\/example\/merge\/pull\/3 failed/);
    } else {
      assert.match(r.stderr, /rate limiting/);
    }
  }
  fs.rmSync(fail);
});

test("a bug or a surprising response on one PR skips only it, cleanly, not the whole section", () => {
  // Unlike a clean gh failure (above), this is what an uncaught bug in
  // the tool itself would raise (here, unparseable JSON from gh):
  // before the fix, the pool's worker rethrew it past sweep(), an
  // unhandled rejection that lost every PR's lines, not just this one's.
  const pr = "repos/cgwalters-bot/homegit/pulls/49";
  const saved = fs.readFileSync(path.join(REST, `${pr}.json`), "utf8");
  fs.writeFileSync(path.join(REST, `${pr}.json`), "not valid json");
  try {
    const r = tool(["--json"]);
    assert.equal(r.status, 1, r.stderr);
    const urls = JSON.parse(r.stdout).map((p) => p.url);
    assert.ok(!urls.includes(`${GH}/cgwalters-bot/homegit/pull/49`), "the broken PR's own lines are gone");
    assert.ok(urls.includes(`${GH}/bootc-dev/bootc/pull/2516`), urls.join("\n"));
    assert.match(r.stderr, /reading https:\/\/github\.com\/cgwalters-bot\/homegit\/pull\/49 failed/);
    assert.ok(!/at Object|UnhandledPromiseRejection/.test(r.stderr), `crashed instead of warning: ${r.stderr}`);
  } finally {
    fs.writeFileSync(path.join(REST, `${pr}.json`), saved);
  }
});

test("nothing to flag", () => {
  const r = spawnSync(TOOL, ["--board-file", writeJson("empty.json", []), "--epic-board-file", writeJson("empty2.json", []), "--now", NOW],
    { env: ENV, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Priority health: nothing to flag\n");
});

test("usage errors", () => {
  for (const args of [["--now", "not a time"], ["--bogus"], ["--board-file"]]) {
    const r = spawnSync(TOOL, args, { env: ENV, encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.match(execFileSync(TOOL, ["--help"], { env: ENV, encoding: "utf8" }), /PRIORITY REASON URL HEAD: DETAIL/);
});

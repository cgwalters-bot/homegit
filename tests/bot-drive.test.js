// Offline tests of bin/bot-drive against the fake gh of
// bot-priority-health's tests (REST fixtures with ETags), with the boards
// in files and a fake bot-pr that logs its calls. Run with
// tests/bot-drive.sh, or node --test tests/bot-drive.test.js.
// The main case replays bootc-dev/bootc#2500: a P0 PR that silently fell
// behind main again after bootc#2516 merged, which no event announced.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-drive");
const FAKE_GH = path.join(__dirname, "fixtures", "bot-priority-health", "fake-gh");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-drive-test-"));
const REST = path.join(WORK, "rest");
const BOT_PR_LOG = path.join(WORK, "bot-pr.log");
const FAKE_BOT_PR = path.join(WORK, "bot-pr");
const ATTEMPTS = path.join(WORK, "cache", "bot-drive", "attempts.json");
const ENV = {
  ...process.env, XDG_CACHE_HOME: path.join(WORK, "cache"), FAKE_GH_DIR: REST, BOT_PRIORITY_HEALTH_GH: FAKE_GH,
  BOT_PRIORITY_HEALTH_BOT_BOARD: "/nonexistent/bot-board", BOT_DRIVE_BOT_PR: FAKE_BOT_PR, FAKE_BOT_PR_LOG: BOT_PR_LOG,
};
const NOW = "2026-10-01T12:00:00Z";
const GH = "https://github.com";
const HEAD = "2500".repeat(10);
const NEW_HEAD = "9".repeat(40);
const FORK_BODY = "Why.\n\n<!-- bot-meta -->\n<!-- /bot-meta -->";
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// The fake bot-pr: logs its arguments; conflicts in the paths that
// $FAKE_BOT_PR_CONFLICTS maps the PR's URL to, as 'bot-pr rebase' says
// so (exit 10); else prints a new head.
fs.writeFileSync(FAKE_BOT_PR, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BOT_PR_LOG, args.join(" ") + "\\n");
const conflicts = JSON.parse(process.env.FAKE_BOT_PR_CONFLICTS || "{}")[args[1]];
if (conflicts) {
  process.stderr.write("bot-pr: bot/x is 3 commits behind o/r:main; rebasing\\n"
    + "error: bot/x conflicts with o/r:main in: " + conflicts + "; nothing was pushed. Resolving that is a worker's job (or cgwalters')\\n");
  process.exit(10);
}
process.stdout.write("${NEW_HEAD}\\n");
`, { mode: 0o755 });

const put = (p, data) => {
  fs.mkdirSync(path.dirname(path.join(REST, p)), { recursive: true });
  fs.writeFileSync(path.join(REST, `${p}.json`), JSON.stringify(data));
};
const writeJson = (name, data) => {
  const f = path.join(WORK, name);
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
};
const check = (name, conclusion, extra = {}) => ({
  name, status: "completed", conclusion, app: { slug: "github-actions" }, started_at: "2026-10-01T10:00:00Z",
  completed_at: "2026-10-01T11:00:00Z", html_url: `${GH}/o/r/actions/runs/1/job/${name}`, ...extra,
});
const GREEN = [check("required-checks", "success"), check("DCO", "success", { app: { slug: "dco" } })];
const approval = (commit, login = "cgwalters") => ({ user: { login }, state: "APPROVED", commit_id: commit, submitted_at: "2026-10-01T11:30:00Z" });

// Each case: a P0 PR by the bot on the Workstream board (unless noted)
// and the line expected for it (none: not driven), given the conflicts
// the fake bot-pr meets.
const CASES = [
  { name: "bootc#2500: approved and green, fell behind main again", repo: "bootc-dev/bootc", number: 2500,
    mergeable_state: "behind", reviews: [approval(HEAD)], runs: GREEN,
    expect: `behind ${GH}/bootc-dev/bootc/pull/2500 250025002500: behind main, which must be up to date; `
      + `rebased -> 999999999999; that voided the approval (stale reviews are dismissed)` },
  { name: "conflicts only in the generated tmt files", repo: "bootc-dev/bootc", number: 2510,
    mergeable_state: "dirty", reviews: [], runs: GREEN, conflicts: "tmt/plans/integration.fmf,tmt/tests/tests.fmf",
    expect: `needs-regen ${GH}/bootc-dev/bootc/pull/2510 250025002500: conflicts with main; `
      + "only generated files conflict (tmt/plans/integration.fmf, tmt/tests/tests.fmf): a worker regenerates them (devspace build) and pushes" },
  { name: "conflicts in source too", repo: "bootc-dev/bootc", number: 2511,
    mergeable_state: "dirty", reviews: [], runs: GREEN, conflicts: "tmt/tests/tests.fmf,crates/lib/src/cli.rs",
    expect: `conflict ${GH}/bootc-dev/bootc/pull/2511 250025002500: conflicts with main; `
      + "rebase refused, conflicts in tmt/tests/tests.fmf, crates/lib/src/cli.rs: a worker resolves them" },
  { name: "mergeable: nothing to do", repo: "example/ready", number: 1,
    mergeable_state: "clean", reviews: [approval(HEAD)], runs: GREEN,
    expect: `mergeable ${GH}/example/ready/pull/1 250025002500: ready to merge; none` },
  { name: "behind with CI failing: not rebased", repo: "example/red", number: 2,
    mergeable_state: "behind", reviews: [approval(HEAD)], runs: [check("required-checks", "failure"), check("unit", "failure")],
    expect: `behind ${GH}/example/red/pull/2 250025002500: behind main, which must be up to date; `
      + `not rebased while ci-failing blocks too: required-checks, unit (${GH}/o/r/actions/runs/1/job/required-checks)` },
  { name: "DCO missing, approved at the head", repo: "example/dco", number: 3,
    mergeable_state: "blocked", reviews: [approval(HEAD)], runs: [check("DCO", "action_required", { app: { slug: "dco" } })],
    expect: `dco ${GH}/example/dco/pull/3 250025002500: DCO fails; you approved this head, so bot-signoff-due signs it off; bot-signoff-due's` },
  { name: "CI failing", repo: "example/ci", number: 4,
    mergeable_state: "blocked", reviews: [], runs: [...GREEN, check("lint", "failure")],
    expect: `ci-failing ${GH}/example/ci/pull/4 250025002500: lint (${GH}/o/r/actions/runs/1/job/lint); a look at the failing job` },
  { name: "review needed", repo: "example/review", number: 5,
    mergeable_state: "blocked", reviews: [approval(HEAD, "maintainer"), { ...approval(HEAD, "maintainer"), state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T11:40:00Z" }],
    runs: GREEN, expect: `review ${GH}/example/review/pull/5 250025002500: changes requested by maintainer; waiting on review` },
  { name: "P0 on the epic board only", repo: "example/epic", number: 6, epic: true,
    mergeable_state: "blocked", reviews: [], runs: GREEN,
    expect: `review ${GH}/example/epic/pull/6 250025002500: waiting on you: no approval yet; waiting on review` },
  { name: "P1: not driven", repo: "example/p1", number: 7, priority: "P1", mergeable_state: "behind", reviews: [approval(HEAD)], runs: GREEN },
  { name: "someone else's PR: not driven", repo: "example/theirs", number: 8, user: "someone", mergeable_state: "behind", reviews: [approval(HEAD)], runs: GREEN },
  { name: "a fork PR: promote's", repo: "cgwalters-forge/bootc", number: 9, body: FORK_BODY, mergeable_state: "dirty", reviews: [], runs: GREEN },
];
const prUrl = (c) => `${GH}/${c.repo}/pull/${c.number}`;
const CONFLICTS = JSON.stringify(Object.fromEntries(CASES.filter((c) => c.conflicts).map((c) => [prUrl(c), c.conflicts])));

// putPr(c, head, mergeableState): the fixtures of case c at head.
function putPr(c, head = HEAD, mergeableState = c.mergeable_state) {
  put(`repos/${c.repo}/pulls/${c.number}`, {
    state: "open", user: { login: c.user || "cgwalters-bot" }, body: c.body || "Fix it.", head: { sha: head },
    base: { ref: "main" }, mergeable_state: mergeableState, auto_merge: null,
  });
  put(`repos/${c.repo}/pulls/${c.number}/reviews`, c.reviews);
  put(`repos/${c.repo}/commits/${head}/check-runs`, { total_count: c.runs.length, check_runs: c.runs });
  put(`repos/${c.repo}/commits/${head}/status`, { total_count: 0, state: "pending", statuses: [] });
}
for (const c of CASES) putPr(c);
put("repos/bootc-dev/bootc/rules/branches/main", [{ type: "pull_request", parameters: { dismiss_stale_reviews_on_push: true } }]);
const BOARD_ARGS = [
  "--board-file", writeJson("board.json", CASES.filter((c) => !c.epic).map((c, i) => ({
    id: `PVTI_${i}`, title: c.name, priority: c.priority || "P0", status: "In Review", content: { type: "PullRequest", url: prUrl(c) },
  }))),
  "--epic-board-file", writeJson("epic.json", CASES.filter((c) => c.epic).map((c) => ({
    id: `EPIC_${c.number}`, title: c.name, priority: "P0", status: "In Review", content: { type: "PullRequest", url: prUrl(c) },
  }))),
];

const tool = (args, now = NOW) => {
  fs.rmSync(BOT_PR_LOG, { force: true });
  const r = spawnSync(TOOL, [...BOARD_ARGS, "--now", now, ...args], {
    env: { ...ENV, FAKE_BOT_PR_CONFLICTS: CONFLICTS }, encoding: "utf8",
  });
  const log = fs.existsSync(BOT_PR_LOG) ? fs.readFileSync(BOT_PR_LOG, "utf8").trim().split("\n") : [];
  return { ...r, lines: r.stdout.trim().split("\n").filter(Boolean), log };
};
const later = (minutes) => new Date(Date.parse(NOW) + minutes * 60 * 1000).toISOString();
const rebaseUrls = [2500, 2510, 2511].map((n) => `${GH}/bootc-dev/bootc/pull/${n}`);
const driven = CASES.filter((c) => c.expect);

test("--apply: one line per driven P0 PR, rebasing only the behind-and-mergeable and the conflicting ones", () => {
  fs.rmSync(ATTEMPTS, { force: true });
  const r = tool(["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...r.lines].sort(), driven.map((c) => c.expect).sort());
  assert.deepEqual(r.log.sort(), rebaseUrls.map((u) => `rebase ${u}`).sort(), "the mergeable PR and the others get no rebase");
});

test("listing and --dry-run run nothing, and say what --apply would", () => {
  fs.rmSync(ATTEMPTS, { force: true });
  const listed = tool([]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.log, []);
  assert.ok(listed.lines.includes(`behind ${GH}/bootc-dev/bootc/pull/2500 250025002500: behind main, which must be up to date; `
    + "rebase due (bot-watch --apply runs bot-pr rebase)"), listed.stdout);
  const dry = tool(["--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.log, []);
  const got = JSON.parse(dry.stdout);
  assert.deepEqual(got.filter((x) => x.result === "would-rebase").map((x) => x.url).sort(), rebaseUrls);
  assert.deepEqual(got.find((x) => x.url.endsWith("/example/ready/pull/1")).blockers, ["mergeable"]);
});

test("the rate guard: one rebase per PR per hour", () => {
  fs.rmSync(ATTEMPTS, { force: true });
  assert.equal(tool(["--apply"]).log.length, rebaseUrls.length);
  // Half an hour later, nothing moved: the refused heads' results are
  // repeated without running bot-pr again.
  const same = tool(["--apply"], later(30));
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(same.log, []);
  assert.ok(same.lines.some((l) => l.startsWith(`needs-regen ${GH}/bootc-dev/bootc/pull/2510 `)), same.stdout);
  // bootc#2500 was rebased, then fell behind again at its new head
  // within the hour: held.
  const pr2500 = CASES[0];
  putPr(pr2500, NEW_HEAD);
  try {
    const held = tool(["--apply"], later(30));
    assert.deepEqual(held.log, []);
    assert.ok(held.lines.includes(`behind ${GH}/bootc-dev/bootc/pull/2500 999999999999: behind main, which must be up to date; `
      + "rebase held until 13:00Z (one per PR per 1h)"), held.stdout);
    // An hour after the first rebase, each is tried again.
    const next = tool(["--apply"], later(61));
    assert.deepEqual(next.log.sort(), rebaseUrls.map((u) => `rebase ${u}`).sort());
  } finally {
    putPr(pr2500);
    fs.rmSync(ATTEMPTS, { force: true });
  }
});

test("rules that can't be read after a rebase: the rebase is still reported and counted", () => {
  fs.rmSync(ATTEMPTS, { force: true });
  const fail = path.join(REST, "repos/bootc-dev/bootc/rules/branches/main.fail");
  fs.writeFileSync(fail, "500 Internal Server Error\nHTTP 500");
  try {
    const r = tool(["--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.lines.includes(`behind ${GH}/bootc-dev/bootc/pull/2500 250025002500: behind main, which must be up to date; `
      + "rebased -> 999999999999; that may have voided the approval (its base's rules couldn't be read)"), r.stdout);
    assert.equal(r.lines.length, driven.length, "the PRs after it are still driven");
    assert.ok(JSON.parse(fs.readFileSync(ATTEMPTS, "utf8"))[`${GH}/bootc-dev/bootc/pull/2500`], "the rate guard counts it");
  } finally {
    fs.rmSync(fail);
    fs.rmSync(ATTEMPTS, { force: true });
  }
});

test("a mergeable PR does nothing, every sweep", () => {
  const ready = CASES.find((c) => c.repo === "example/ready");
  for (const now of [NOW, later(5), later(120)]) {
    const r = tool(["--apply", "--json"], now);
    const x = JSON.parse(r.stdout).find((y) => y.url === prUrl(ready));
    assert.deepEqual([x.blocker, x.result], ["mergeable", "none"]);
    assert.ok(!r.log.includes(`rebase ${prUrl(ready)}`));
  }
  fs.rmSync(ATTEMPTS, { force: true });
});

test("usage errors", () => {
  for (const args of [["--apply", "--dry-run"], ["--bogus"], ["--now", "not a time"]]) {
    assert.equal(spawnSync(TOOL, args, { env: ENV }).status, 2, args.join(" "));
  }
  assert.match(spawnSync(TOOL, ["--help"], { env: ENV, encoding: "utf8" }).stdout, /BLOCKER URL HEAD: DETAIL; ACTION/);
});

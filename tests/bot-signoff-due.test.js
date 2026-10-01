// Offline tests of bin/bot-signoff-due against the fake gh of
// bot-priority-health's tests (REST fixtures with ETags) and a fake
// bot-pr that logs its calls. Run with tests/bot-signoff-due.sh, or
// node --test tests/bot-signoff-due.test.js.
// The main case replays bootc-dev/bootc#2516: cgwalters approved its
// head, DCO kept failing, and nobody ran 'bot-pr signoff' for 12 hours.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-signoff-due");
const FAKE_GH = path.join(__dirname, "fixtures", "bot-priority-health", "fake-gh");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-signoff-due-test-"));
const REST = path.join(WORK, "rest");
const BOT_PR_LOG = path.join(WORK, "bot-pr.log");
const FAKE_BOT_PR = path.join(WORK, "bot-pr");
const NEW_HEAD = "9".repeat(40);
const HEAD = "12fe99311b45320758183cb418322380ca60c2e6";
const ATTEMPTS = path.join(WORK, "cache", "bot-signoff-due", "attempts.json");
const ENV = {
  ...process.env, XDG_CACHE_HOME: path.join(WORK, "cache"), FAKE_GH_DIR: REST, BOT_PRIORITY_HEALTH_GH: FAKE_GH,
  BOT_SIGNOFF_DUE_BOT_PR: FAKE_BOT_PR, FAKE_BOT_PR_LOG: BOT_PR_LOG,
};
const GH = "https://github.com";
const FORK_BODY = "Why.\n\n<!-- bot-meta -->\n<!-- /bot-meta -->";
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// The fake bot-pr: logs its arguments; is rate limited on the PR in
// $FAKE_BOT_PR_RATELIMIT; refuses a PR whose repository is named
// "refused", as the policy gate would; leaves one named "unchanged" as it
// is; else prints a new head.
fs.writeFileSync(FAKE_BOT_PR, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BOT_PR_LOG, args.join(" ") + "\\n");
if (args[1] === process.env.FAKE_BOT_PR_RATELIMIT) {
  process.stderr.write("error: GitHub is rate limiting the bot\\n");
  process.exit(75);
}
if (args[1].includes("/unchanged/")) {
  process.stderr.write("Every commit has cgwalters' sign-off already\\n");
  process.stdout.write("${HEAD}\\n");
  process.exit(0);
}
if (args[1].includes("/refused/")) {
  process.stderr.write("Using cgwalters' approval\\nerror: not signing off " + args[1] + ": the policy record is stale\\n");
  process.exit(1);
}
process.stderr.write("Added cgwalters' sign-off to 1 commit(s)\\n");
process.stdout.write("${NEW_HEAD}\\n");
`, { mode: 0o755 });

const put = (p, data) => {
  fs.mkdirSync(path.dirname(path.join(REST, p)), { recursive: true });
  fs.writeFileSync(path.join(REST, `${p}.json`), JSON.stringify(data));
};
let clock = 0;
// review(state, commit): a review by cgwalters, each later than the last.
const review = (state, commit, login = "cgwalters") => ({
  user: { login }, state, commit_id: commit, submitted_at: new Date(Date.UTC(2026, 8, 29, 12, clock++)).toISOString(),
});
const dco = (conclusion) => ({ name: "DCO", status: "completed", conclusion, app: { slug: "dco" }, started_at: "2026-09-29T12:00:00Z" });
const build = { name: "build", status: "completed", conclusion: "success", app: { slug: "github-actions" }, started_at: "2026-09-29T12:00:00Z" };

// Each case: a PR the bot opened (unless user), its reviews and checks,
// and whether a sign-off is due.
const OLD = "0".repeat(40);
const CASES = [
  { name: "bootc#2516: approved at its head, DCO failing", repo: "bootc-dev/bootc", number: 2516,
    reviews: [review("APPROVED", HEAD)], runs: [build, dco("failure")], due: true },
  { name: "the DCO app asking for action counts as failing", repo: "example/app", number: 1,
    reviews: [review("APPROVED", HEAD)], runs: [dco("action_required")], due: true },
  { name: "a comment-only review after the approval leaves it standing", repo: "example/commented", number: 2,
    reviews: [review("APPROVED", HEAD), review("COMMENTED", HEAD)], runs: [dco("failure")], due: true },
  { name: "unapproved: only comments", repo: "example/unapproved", number: 3,
    reviews: [review("COMMENTED", HEAD)], runs: [dco("failure")], due: false },
  { name: "unapproved: someone else's approval", repo: "example/other", number: 4,
    reviews: [review("APPROVED", HEAD, "maintainer")], runs: [dco("failure")], due: false },
  { name: "stale approval: of an older head", repo: "example/stale", number: 5,
    reviews: [review("APPROVED", OLD)], runs: [dco("failure")], due: false },
  { name: "changes requested after the approval", repo: "example/changes", number: 6,
    reviews: [review("APPROVED", HEAD), review("CHANGES_REQUESTED", HEAD)], runs: [dco("failure")], due: false },
  { name: "DCO passing", repo: "example/passing", number: 7,
    reviews: [review("APPROVED", HEAD)], runs: [build, dco("success")], due: false },
  { name: "no DCO check at all", repo: "example/nodco", number: 8,
    reviews: [review("APPROVED", HEAD)], runs: [build], due: false },
  { name: "a fork PR: promote signs those off", repo: "cgwalters-forge/bootc", number: 9, body: FORK_BODY,
    reviews: [review("APPROVED", HEAD)], runs: [dco("failure")], due: false },
  { name: "closed since the search", repo: "example/closed", number: 10, state: "closed",
    reviews: [review("APPROVED", HEAD)], runs: [dco("failure")], due: false },
  { name: "the policy gate refuses", repo: "example/refused", number: 11,
    reviews: [review("APPROVED", HEAD)], runs: [dco("failure")], due: true },
  { name: "every commit signed off already, DCO failing anyway", repo: "example/unchanged", number: 12,
    reviews: [review("APPROVED", HEAD)], runs: [dco("failure")], due: true },
];
// The PRs where cgwalters may have revoked a carried sign-off: each with
// its comments (WHO:BODY, ids in order), and whether 'bot-pr no-carry' is
// due. The bot's fake refuses the one in a repository named "refused".
const CARRY = `Kept cgwalters' sign-off ...\n<!-- bot-pr carry was=${OLD} head=${HEAD} carried=${HEAD} -->`;
const ANSWER = `Dropped it.\n<!-- bot-pr no-carry ask=2 head=${HEAD} -->`;
const NO_CARRY_CASES = [
  { name: "revoked", repo: "example/revoked", number: 20, comments: [`cgwalters-bot:${CARRY}`, "cgwalters:/no-carry"], due: true },
  { name: "revoked among other lines, CRLF", repo: "example/crlf", number: 21,
    comments: [`cgwalters-bot:${CARRY}`, "cgwalters:No, that is new code.\r\n  /no-carry \r\nThanks"], due: true },
  { name: "answered already", repo: "example/answered", number: 22,
    comments: [`cgwalters-bot:${CARRY}`, "cgwalters:/no-carry", `cgwalters-bot:${ANSWER}`], due: false },
  { name: "revoked before any carry", repo: "example/early", number: 23, comments: ["cgwalters:/no-carry", `cgwalters-bot:${CARRY}`], due: false },
  { name: "someone else's /no-carry", repo: "example/someone", number: 24, comments: [`cgwalters-bot:${CARRY}`, "maintainer:/no-carry"], due: false },
  { name: "only mentioned", repo: "example/mention", number: 25, comments: [`cgwalters-bot:${CARRY}`, "cgwalters:why the /no-carry?"], due: false },
  { name: "a fork PR", repo: "cgwalters-forge/nc", number: 26, body: FORK_BODY,
    comments: [`cgwalters-bot:${CARRY}`, "cgwalters:/no-carry"], due: false },
  { name: "bot-pr no-carry refuses", repo: "nc/refused", number: 27, comments: [`cgwalters-bot:${CARRY}`, "cgwalters:/no-carry"], due: true },
];
const prUrl = (c) => `${GH}/${c.repo}/pull/${c.number}`;
for (const c of NO_CARRY_CASES) {
  put(`repos/${c.repo}/pulls/${c.number}`, { state: "open", user: { login: "cgwalters-bot" }, body: c.body || "Fix it.", head: { sha: HEAD } });
  put(`repos/${c.repo}/issues/${c.number}/comments`, c.comments.map((w, i) => {
    const [login, ...body] = w.split(":");
    return { id: i + 1, user: { login }, body: body.join(":"), html_url: `${prUrl(c)}#issuecomment-${i + 1}` };
  }));
}
for (const c of CASES) {
  put(`repos/${c.repo}/pulls/${c.number}`, {
    state: c.state || "open", user: { login: "cgwalters-bot" }, body: c.body || "Fix it.", head: { sha: HEAD },
  });
  put(`repos/${c.repo}/pulls/${c.number}/reviews`, c.reviews);
  put(`repos/${c.repo}/commits/${HEAD}/check-runs`, { total_count: c.runs.length, check_runs: c.runs });
  put(`repos/${c.repo}/commits/${HEAD}/status`, { total_count: 0, state: "pending", statuses: [] });
}
// The fake answers both searches alike, with every PR.
const ALL = [...CASES, ...NO_CARRY_CASES];
put("search/issues", { total_count: ALL.length, items: ALL.map((c) => ({ html_url: prUrl(c), body: c.body })) });

const tool = (args, env = {}) => {
  fs.rmSync(BOT_PR_LOG, { force: true });
  const r = spawnSync(TOOL, args, { env: { ...ENV, ...env }, encoding: "utf8" });
  const log = fs.existsSync(BOT_PR_LOG) ? fs.readFileSync(BOT_PR_LOG, "utf8").trim().split("\n") : [];
  return { ...r, log };
};
const dueUrls = CASES.filter((c) => c.due).map(prUrl);
const noCarryUrls = NO_CARRY_CASES.filter((c) => c.due).map(prUrl);
const ofKind = (got, kind) => got.filter((x) => x.kind === kind);

test("only the PRs approved at their head with DCO failing are due", () => {
  const r = tool(["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const got = ofKind(JSON.parse(r.stdout), "signoff");
  assert.deepEqual(got.map((x) => x.url).sort(), [...dueUrls].sort());
  for (const x of got) assert.equal(x.result, "due");
  assert.deepEqual(r.log, [], "listing runs nothing");
});

test("only a /no-carry of cgwalters after a carry, unanswered, on an upstream PR, is due", () => {
  const r = tool(["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const got = ofKind(JSON.parse(r.stdout), "no-carry");
  assert.deepEqual(got.map((x) => x.url).sort(), [...noCarryUrls].sort());
  const revoked = got.find((x) => x.url === `${GH}/example/revoked/pull/20`);
  assert.equal(revoked.line, `No-carry due: ${GH}/example/revoked/pull/20 at ${HEAD.slice(0, 12)} (${GH}/example/revoked/pull/20#issuecomment-2)`);
  assert.deepEqual(r.log, [], "listing runs nothing");
});

test("--dry-run prints the commands and runs none", () => {
  const r = tool(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").sort(),
    [...dueUrls.map((u) => `Would run: bot-pr signoff ${u}`), ...noCarryUrls.map((u) => `Would run: bot-pr no-carry ${u}`)].sort());
  assert.deepEqual(r.log, []);
});

test("--apply runs bot-pr signoff on each due PR and reports the result, once per head", () => {
  fs.rmSync(ATTEMPTS, { force: true });
  const r = tool(["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.log.sort(), [...dueUrls.map((u) => `signoff ${u}`), ...noCarryUrls.map((u) => `no-carry ${u}`)].sort());
  const lines = r.stdout.trim().split("\n");
  const refused = `Sign-off refused: ${GH}/example/refused/pull/11 at ${HEAD.slice(0, 12)}: `
    + `not signing off ${GH}/example/refused/pull/11: the policy record is stale`;
  const unchanged = `Sign-off changed nothing: ${GH}/example/unchanged/pull/12 at ${HEAD.slice(0, 12)}: `
    + "every commit has his sign-off already, yet DCO fails";
  assert.ok(lines.includes(`Signed off: ${GH}/bootc-dev/bootc/pull/2516 (${NEW_HEAD.slice(0, 12)})`), r.stdout);
  assert.ok(lines.includes(refused), r.stdout);
  assert.ok(lines.includes(unchanged), r.stdout);
  assert.ok(lines.includes(`Carried sign-off dropped: ${GH}/example/revoked/pull/20 (${NEW_HEAD.slice(0, 12)})`), r.stdout);
  assert.ok(lines.includes(`No-carry refused: ${GH}/nc/refused/pull/27 at ${HEAD.slice(0, 12)}: not signing off ${GH}/nc/refused/pull/27: the policy record is stale`), r.stdout);
  assert.equal(lines.length, dueUrls.length + noCarryUrls.length);
  // Again at the same heads (the fixtures don't move): the refused and
  // unchanged ones aren't retried, and are listed alike.
  const again = tool(["--apply"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!again.log.some((l) => /refused|unchanged/.test(l)), again.log.join("\n"));
  assert.ok(again.log.includes(`no-carry ${GH}/example/revoked/pull/20`), "a dropped one is due again only while unanswered, as here");
  assert.ok(again.stdout.includes(`${refused}\n`) && again.stdout.includes(`${unchanged}\n`), again.stdout);
  assert.match(tool(["--dry-run"]).stdout, /^Sign-off refused: /m, "--dry-run tells it won't retry");
  // Six hours later, both are tried again.
  const aged = JSON.parse(fs.readFileSync(ATTEMPTS, "utf8"));
  for (const a of Object.values(aged)) a.at = new Date(Date.now() - 6 * 3600 * 1000 - 1000).toISOString();
  fs.writeFileSync(ATTEMPTS, JSON.stringify(aged));
  const later = tool(["--apply"]);
  assert.equal(later.log.filter((l) => /refused|unchanged/.test(l)).length, 3, later.log.join("\n"));
  fs.rmSync(ATTEMPTS, { force: true });
});

test("rate limited halfway through --apply: the sign-offs before are still listed, then exit 75", () => {
  const first = CASES.find((c) => c.due);
  const second = CASES.filter((c) => c.due)[1];
  const r = tool(["--apply"], { FAKE_BOT_PR_RATELIMIT: prUrl(second) });
  assert.equal(r.status, 75, r.stderr);
  assert.deepEqual(r.log, [`signoff ${prUrl(first)}`, `signoff ${prUrl(second)}`]);
  assert.equal(r.stdout, `Signed off: ${prUrl(first)} (${NEW_HEAD.slice(0, 12)})\n`);
  assert.match(r.stderr, /rate limiting/);
  fs.rmSync(ATTEMPTS, { force: true });
});

test("a PR that can't be read is skipped, and exits 1; a failed search exits 1", () => {
  const fail = path.join(REST, "repos/example/stale/pulls/5.fail");
  fs.writeFileSync(fail, "502 Bad Gateway\nHTTP 502: Bad Gateway");
  try {
    const r = tool(["--json"]);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(ofKind(JSON.parse(r.stdout), "signoff").map((x) => x.url).sort(), [...dueUrls].sort());
    assert.match(r.stderr, /reading https:\/\/github\.com\/example\/stale\/pull\/5 failed/);
  } finally {
    fs.rmSync(fail);
  }
  const searchFail = path.join(REST, "search/issues.fail");
  fs.writeFileSync(searchFail, "403 Forbidden\nAPI rate limit exceeded for user (HTTP 403)");
  try {
    const r = tool(["--apply"]);
    assert.equal(r.status, 75, r.stderr);
    assert.deepEqual(r.log, []);
  } finally {
    fs.rmSync(searchFail);
  }
});

test("usage errors", () => {
  for (const args of [["--apply", "--dry-run"], ["--bogus"]]) {
    assert.equal(tool(args).status, 2, args.join(" "));
  }
  assert.match(tool(["--help"]).stdout, /Signed off: URL \(NEWHEAD\)/);
});

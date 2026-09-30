// Offline tests of bin/bot-promote-due against the fake gh of
// bot-priority-health's tests (REST fixtures with ETags), a fake
// upstream-policy and a fake bot-pr that log their calls. Run with
// tests/bot-promote-due.sh, or node --test tests/bot-promote-due.test.js.
// The main case replays bootc#24, composefs-rs#6 and
// containers-image-proxy-rs#2 on the forge: cgwalters approved them, and
// nobody ran 'bot-pr promote' for over a day.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-promote-due");
const FAKE_GH = path.join(__dirname, "fixtures", "bot-priority-health", "fake-gh");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-promote-due-test-"));
const REST = path.join(WORK, "rest");
const LOG = path.join(WORK, "calls.log");
const FAKE_BOT_PR = path.join(WORK, "bot-pr");
const FAKE_POLICY = path.join(WORK, "upstream-policy");
const ATTEMPTS = path.join(WORK, "cache", "bot-promote-due", "attempts.json");
const ENV = {
  ...process.env, XDG_CACHE_HOME: path.join(WORK, "cache"), FAKE_GH_DIR: REST, BOT_PRIORITY_HEALTH_GH: FAKE_GH,
  BOT_PROMOTE_DUE_BOT_PR: FAKE_BOT_PR, BOT_PROMOTE_DUE_UPSTREAM_POLICY: FAKE_POLICY, FAKE_LOG: LOG,
};
const GH = "https://github.com";
const FORGE = "cgwalters-forge";
const HEAD = "12fe99311b45320758183cb418322380ca60c2e6";
const OLD = "0".repeat(40);
const SHORT = HEAD.slice(0, 12);
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// The fakes log "NAME ARGS...". bot-pr is rate limited on the PR in
// $FAKE_BOT_PR_RATELIMIT, refuses a PR whose repository is named
// "refused" (a conflict, say), and else prints the upstream PR it opened.
// upstream-policy says human-text for a repository named humantext*,
// has no record for "nopolicy", fails for "broken", and else says bot-ok.
fs.writeFileSync(FAKE_BOT_PR, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, "bot-pr " + args.join(" ") + "\\n");
if (args[1] === process.env.FAKE_BOT_PR_RATELIMIT) {
  process.stderr.write("error: GitHub is rate limiting the bot\\n");
  process.exit(75);
}
if (args[1].includes("/refused/")) {
  process.stderr.write("Rebasing\\nerror: bot/x conflicts with example/refused:main in src/lib.rs\\n");
  process.exit(1);
}
process.stderr.write("Opened it\\n");
process.stdout.write("https://github.com/example/" + args[1].split("/")[4] + "/pull/99\\n");
`, { mode: 0o755 });
fs.writeFileSync(FAKE_POLICY, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, "upstream-policy " + args.join(" ") + "\\n");
const name = args[1].split("/")[1];
if (name.startsWith("humantext")) { console.log("human-text"); process.exit(5); }
if (name === "nopolicy") { process.stderr.write("error: no record for " + args[1] + "\\n"); process.exit(3); }
if (name === "broken") { process.stderr.write("error: cannot read the sources\\n"); process.exit(1); }
console.log("bot-ok");
`, { mode: 0o755 });

const put = (p, data) => {
  fs.mkdirSync(path.dirname(path.join(REST, p)), { recursive: true });
  fs.writeFileSync(path.join(REST, `${p}.json`), JSON.stringify(data));
};
let clock = 0;
// Each later than the last; the head was pushed at PUSHED.
const tick = () => new Date(Date.UTC(2026, 8, 29, 12, clock++)).toISOString();
const PUSHED = tick();
const review = (state, commit, { login = "cgwalters", body = "" } = {}) => ({
  user: { login }, state, commit_id: commit, submitted_at: tick(), body, html_url: `review-${clock}`,
});
const comment = (body, { login = "cgwalters", at = tick() } = {}) => ({
  user: { login }, body, created_at: at, updated_at: at, html_url: `comment-${clock}`,
});
const meta = (upstream, why = "Why.") => `${why}\n\n<!-- bot-meta -->\n- Upstream: \`${upstream}\`, base \`main\`\n<!-- /bot-meta -->`;

// Each case: a fork PR on the forge (upstream example/REPO), cgwalters'
// reviews and comments, and the result it gets from --apply (null: not
// listed at all).
const signed = review("APPROVED", OLD);
const CASES = [
  { name: "bootc#24: approved at its head, bot-ok", repo: "bootc", number: 24,
    reviews: [review("APPROVED", HEAD)], result: "promoted" },
  { name: "a /promote comment after the push", repo: "composefs-rs", number: 6,
    comments: [comment("Looks good.\n/promote\n")], result: "promoted" },
  { name: "a /draft asks for --draft", repo: "containers-image-proxy-rs", number: 2,
    reviews: [review("APPROVED", HEAD, { body: "/draft" })], result: "promoted", draft: true },
  { name: "a /draft taken back with /ready", repo: "ready", number: 3,
    comments: [comment("/draft")], reviews: [review("APPROVED", HEAD)], extra: [comment("/ready")], result: "promoted" },
  { name: "approved at the head promote signed off, per its record", repo: "signed", number: 4,
    reviews: [signed],
    comments: [comment(`Signed off.\n<!-- bot-pr signoff approved=${OLD} signed=${HEAD} approval=${signed.html_url} review=1 -->`, { login: "cgwalters-bot" })],
    result: "promoted" },
  { name: "a sign-off record by someone else counts for nothing", repo: "forgedrecord", number: 18,
    reviews: [signed],
    comments: [comment(`<!-- bot-pr signoff approved=${OLD} signed=${HEAD} approval=${signed.html_url} review=1 -->`, { login: "mallory" })],
    result: null },
  { name: "a sign-off record of another approval counts for nothing", repo: "otherrecord", number: 19,
    reviews: [signed],
    comments: [comment(`<!-- bot-pr signoff approved=${OLD} signed=${HEAD} approval=elsewhere review=1 -->`, { login: "cgwalters-bot" })],
    result: null },
  { name: "only the bot-meta section names the upstream", repo: "humantext-decoy", number: 20,
    why: "Quoting: - Upstream: `example/bootc`, base `main`", reviews: [review("APPROVED", HEAD)], result: "needs-text" },
  { name: "stale approval: of an older head", repo: "stale", number: 5,
    reviews: [review("APPROVED", OLD)], result: null },
  { name: "stale /promote: written before the push", repo: "stalepromote", number: 6,
    comments: [comment("/promote", { at: "2026-09-29T11:00:00.000Z" })], result: null },
  { name: "a /promote when the push can't be told", repo: "nolog", number: 7,
    comments: [comment("/promote")], activity: [], result: null },
  { name: "changes requested after the approval", repo: "changes", number: 8,
    reviews: [review("APPROVED", HEAD), review("CHANGES_REQUESTED", HEAD)], result: null },
  { name: "a comment-only review after the approval leaves it standing", repo: "commented", number: 9,
    reviews: [review("APPROVED", HEAD), review("COMMENTED", HEAD)], result: "promoted" },
  { name: "someone else's approval", repo: "other", number: 10,
    reviews: [review("APPROVED", HEAD, { login: "maintainer" })], result: null },
  { name: "a go-ahead in other words", repo: "lgtm", number: 11,
    comments: [comment("LGTM, ship it")], result: null },
  { name: "human-text: never promoted, listed", repo: "humantext", number: 12,
    reviews: [review("APPROVED", HEAD)], result: "needs-text" },
  { name: "human-text, approved with his text", repo: "humantext-his", number: 13,
    comments: [comment("/promote --human-text")], result: "needs-text" },
  { name: "no policy record", repo: "nopolicy", number: 14,
    reviews: [review("APPROVED", HEAD)], result: "held" },
  { name: "bot-pr promote refuses", repo: "refused", number: 15,
    reviews: [review("APPROVED", HEAD)], result: "refused" },
  { name: "closed since the search", repo: "closed", number: 16, state: "closed",
    reviews: [review("APPROVED", HEAD)], result: null },
];
const prUrl = (c) => `${GH}/${FORGE}/${c.repo}/pull/${c.number}`;
const fixture = (c) => {
  const repo = `${FORGE}/${c.repo}`;
  put(`repos/${repo}/pulls/${c.number}`, {
    state: c.state || "open", user: { login: "cgwalters-bot" }, body: meta(`example/${c.repo}`, c.why),
    head: { sha: HEAD, ref: `bot/${c.repo}` },
  });
  put(`repos/${repo}/pulls/${c.number}/reviews`, c.reviews || []);
  put(`repos/${repo}/issues/${c.number}/comments`, [...(c.comments || []), ...(c.extra || [])]);
  put(`repos/${repo}/pulls/${c.number}/comments`, []);
  put(`repos/${repo}/activity`, c.activity || [{ after: HEAD, timestamp: PUSHED }]);
};
CASES.forEach(fixture);
// Not a fork PR: no bot-meta section (the search item's body says so).
const upstreamPr = { html_url: `${GH}/${FORGE}/plain/pull/1`, user: { login: "cgwalters-bot" }, body: "Fix." };
put("search/issues", {
  total_count: CASES.length + 1,
  items: [...CASES.map((c) => ({ html_url: prUrl(c), user: { login: "cgwalters-bot" }, body: meta(`example/${c.repo}`) })), upstreamPr],
});

const tool = (args, env = {}) => {
  fs.rmSync(LOG, { force: true });
  const r = spawnSync(TOOL, args, { env: { ...ENV, ...env }, encoding: "utf8" });
  const calls = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n") : [];
  return { ...r, calls, promotes: calls.filter((l) => l.startsWith("bot-pr ")) };
};
const listed = CASES.filter((c) => c.result);
const toPromote = CASES.filter((c) => ["promoted", "refused"].includes(c.result));
const promoteCall = (c) => `bot-pr promote ${prUrl(c)}${c.draft ? " --draft" : ""}`;

test("lists the fork PRs approved at their head, by policy verdict", () => {
  const r = tool(["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.map((x) => x.url).sort(), listed.map(prUrl).sort());
  const byUrl = Object.fromEntries(got.map((x) => [x.url, x]));
  for (const c of listed) {
    const want = { promoted: "due", refused: "due" }[c.result] || c.result;
    assert.equal(byUrl[prUrl(c)].result, want, c.name);
    assert.equal(byUrl[prUrl(c)].draft, Boolean(c.draft), c.name);
  }
  assert.deepEqual(r.promotes, [], "listing promotes nothing");
  // One policy check per upstream of an approved PR only.
  assert.deepEqual(r.calls.filter((l) => l.startsWith("upstream-policy")).sort(),
    listed.map((c) => `upstream-policy check example/${c.repo}`).sort());
  assert.equal(byUrl[`${GH}/${FORGE}/nopolicy/pull/14`].line,
    `Not promoted: ${GH}/${FORGE}/nopolicy/pull/14: example/nopolicy has no contribution policy record yet; dispatch a policy check`);
  assert.match(byUrl[`${GH}/${FORGE}/humantext/pull/12`].line,
    /^Needs your text: \S+ \(example\/humantext is human-text\): retitle it, .* then comment '\/promote --human-text'$/);
  assert.match(byUrl[`${GH}/${FORGE}/humantext-his/pull/13`].line, /approved with '\/promote --human-text'; promote it by hand/);
});

test("--dry-run prints the commands and runs none", () => {
  const r = tool(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  for (const c of toPromote) {
    assert.ok(lines.includes(`Would run: ${promoteCall(c)}`), `${c.name}:\n${r.stdout}`);
  }
  assert.deepEqual(r.promotes, []);
});

test("--apply promotes the bot-ok ones, and only those, backing off a refusal", () => {
  fs.rmSync(ATTEMPTS, { force: true });
  const r = tool(["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.promotes.sort(), toPromote.map(promoteCall).sort());
  assert.ok(!r.promotes.some((l) => /humantext|nopolicy|stale|changes|other|lgtm|closed|nolog/.test(l)), r.promotes.join("\n"));
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, listed.length, r.stdout);
  assert.ok(lines.includes(`Promoted: ${GH}/${FORGE}/bootc/pull/24 -> ${GH}/example/bootc/pull/99`), r.stdout);
  assert.ok(lines.includes(`Promoted: ${GH}/${FORGE}/containers-image-proxy-rs/pull/2 -> ${GH}/example/containers-image-proxy-rs/pull/99 (draft)`), r.stdout);
  const refused = `Promotion refused: ${GH}/${FORGE}/refused/pull/15 at ${SHORT}: bot/x conflicts with example/refused:main in src/lib.rs`;
  assert.ok(lines.includes(refused), r.stdout);
  // Again at the same head (the fixtures don't move): the refused one
  // isn't retried, and is listed alike, also by --dry-run.
  const again = tool(["--apply"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!again.promotes.some((l) => l.includes("/refused/")), again.promotes.join("\n"));
  assert.ok(again.stdout.includes(`${refused}\n`), again.stdout);
  const refusedKey = `${GH}/${FORGE}/refused/pull/15@${HEAD}`;
  const firstAt = JSON.parse(fs.readFileSync(ATTEMPTS, "utf8"))[refusedKey].at;
  assert.ok(firstAt, "the refusal is recorded");
  assert.ok(tool(["--dry-run"]).stdout.includes(`${refused}\n`), "--dry-run tells it won't retry");
  // Six hours later, it is tried again.
  const aged = JSON.parse(fs.readFileSync(ATTEMPTS, "utf8"));
  assert.deepEqual(Object.keys(aged), [refusedKey]);
  assert.equal(aged[refusedKey].at, firstAt, "a repeated refusal keeps its time");
  for (const a of Object.values(aged)) a.at = new Date(Date.now() - 6 * 3600 * 1000 - 1000).toISOString();
  fs.writeFileSync(ATTEMPTS, JSON.stringify(aged));
  assert.deepEqual(tool(["--apply"]).promotes.filter((l) => l.includes("/refused/")), [`bot-pr promote ${GH}/${FORGE}/refused/pull/15`]);
  // A head that moved is forgotten: the approval no longer holds, and
  // nothing of the old head is kept.
  const prPath = `repos/${FORGE}/refused/pulls/15`;
  const pr = JSON.parse(fs.readFileSync(path.join(REST, `${prPath}.json`), "utf8"));
  put(prPath, { ...pr, head: { ...pr.head, sha: "5".repeat(40) } });
  try {
    const moved = tool(["--apply"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.ok(!moved.promotes.some((l) => l.includes("/refused/")), moved.promotes.join("\n"));
    assert.deepEqual(JSON.parse(fs.readFileSync(ATTEMPTS, "utf8")), {});
  } finally {
    put(prPath, pr);
  }
  fs.rmSync(ATTEMPTS, { force: true });
});

test("rate limited halfway through --apply: the promotions before are still listed, then exit 75", () => {
  const [first, second] = toPromote;
  const r = tool(["--apply"], { FAKE_BOT_PR_RATELIMIT: prUrl(second) });
  assert.equal(r.status, 75, r.stderr);
  assert.deepEqual(r.promotes, [promoteCall(first), promoteCall(second)]);
  assert.equal(r.stdout, `Promoted: ${prUrl(first)} -> ${GH}/example/${first.repo}/pull/99\n`);
  assert.match(r.stderr, /rate limiting/);
  assert.ok(!fs.existsSync(ATTEMPTS), "a rate-limited run records no attempts");
  fs.rmSync(ATTEMPTS, { force: true });
});

test("a failed read or policy check skips that PR and exits 1; a failed search exits 1", () => {
  const fail = path.join(REST, `repos/${FORGE}/stale/pulls/5/reviews.fail`);
  fs.writeFileSync(fail, "502 Bad Gateway\nHTTP 502: Bad Gateway");
  const broken = { repo: "broken", number: 17, reviews: [review("APPROVED", HEAD)] };
  fixture(broken);
  const search = JSON.parse(fs.readFileSync(path.join(REST, "search/issues.json"), "utf8"));
  put("search/issues", { ...search, items: [...search.items, { html_url: prUrl(broken), user: { login: "cgwalters-bot" }, body: meta("example/broken") }] });
  try {
    const r = tool(["--apply"]);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n").length, listed.length, r.stdout);
    assert.match(r.stderr, /reading https:\/\/github\.com\/cgwalters-forge\/stale\/pull\/5 failed/);
    assert.match(r.stderr, /upstream-policy check example\/broken failed \(1\): cannot read the sources/);
    assert.ok(!r.promotes.some((l) => l.includes("/broken/")));
  } finally {
    fs.rmSync(fail);
    put("search/issues", search);
    fs.rmSync(ATTEMPTS, { force: true });
  }
  const searchFail = path.join(REST, "search/issues.fail");
  fs.writeFileSync(searchFail, "403 Forbidden\nAPI rate limit exceeded for user (HTTP 403)");
  try {
    const r = tool(["--apply"]);
    assert.equal(r.status, 75, r.stderr);
    assert.deepEqual(r.promotes, []);
  } finally {
    fs.rmSync(searchFail);
  }
});

test("usage errors", () => {
  for (const args of [["--apply", "--dry-run"], ["--bogus"]]) {
    assert.equal(tool(args).status, 2, args.join(" "));
  }
  assert.match(tool(["--help"]).stdout, /Promoted: URL -> UPSTREAM-PR-URL/);
});

// Offline tests of bin/bot-review-guide: the guide schema, the marker's
// round trip, checking a guide against a PR, posting and finding the
// trusted guide, the CLI ones against a fake gh. Run with
// tests/bot-review-guide.sh, or node --test tests/bot-review-guide.test.js.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-review-guide");
const tool = require(TOOL);

const HEAD = "a".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const OTHER = "b".repeat(40);
const REF = { owner: "cgwalters-forge", repo: "proj", number: 7 };
const PR_URL = "https://github.com/cgwalters-forge/proj/pull/7";

const hotspot = (over = {}) => ({
  path: "src/lib.rs", commit: C1, start: 10, end: 20, severity: "risky", category: "logic", reason: "Off by one on the last entry.", ...over,
});
const guide = (over = {}) => ({
  schema: tool.SCHEMA, repo: "cgwalters-forge/proj", pr: 7, head: HEAD,
  summary: "Moves the lookup.\nThe risk is in the fallback.", hotspots: [hotspot()], skim: [{ path: "Cargo.lock", reason: "generated" }], ...over,
});
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

// [name, guide, expected error substrings (none: valid)]
const SCHEMA_CASES = [
  ["valid", guide(), []],
  ["valid, empty lists", guide({ hotspots: [], skim: [] }), []],
  ["valid, skim range", guide({ skim: [{ path: "a", start: 1, end: 3, reason: "rename" }] }), []],
  ["not an object", [], ["must be a JSON object"]],
  ["wrong schema", guide({ schema: "review-guide/v2" }), ["schema: must be"]],
  ["unknown top key", guide({ extra: 1 }), ["unknown key 'extra'"]],
  ["missing key", without(guide(), "skim"), ["missing 'skim'"]],
  ["bad repo", guide({ repo: "nope" }), ["repo: must be OWNER/REPO"]],
  ["dot in owner", guide({ repo: "a.b/proj" }), ["repo: must be OWNER/REPO"]],
  ["C1 control", guide({ summary: "a\u0085b" }), ["control or bidirectional"]],
  ["zero-width space", guide({ hotspots: [hotspot({ reason: "a\u200bb" })] }), ["control or bidirectional"]],
  ["byte-order mark", guide({ skim: [{ path: "a", reason: "\ufeffr" }] }), ["control or bidirectional"]],
  ["absolute path", guide({ hotspots: [hotspot({ path: "/etc/passwd" })] }), ["hotspots[0].path: must be a relative path"]],
  ["dot-dot path", guide({ skim: [{ path: "a/../b", reason: "r" }] }), ["skim[0].path: must be a relative path"]],
  ["empty segment", guide({ hotspots: [hotspot({ path: "a//b" })] }), ["must be a relative path"]],
  ["line too large", guide({ hotspots: [hotspot({ end: 10_000_001 })] }), ["hotspots[0].end: must be a line number"]],
  ["bad pr", guide({ pr: "7" }), ["pr: must be a PR number"]],
  ["short head", guide({ head: "abc123" }), ["head: must be a full"]],
  ["upper-case head", guide({ head: "A".repeat(40) }), ["head: must be a full"]],
  ["empty summary", guide({ summary: " " }), ["summary: must be a non-empty"]],
  ["long summary", guide({ summary: "x".repeat(2001) }), ["more than 2000"]],
  ["control char", guide({ summary: "a\u0007b" }), ["control or bidirectional"]],
  ["bidi override", guide({ hotspots: [hotspot({ reason: "safe\u202eevil" })] }), ["hotspots[0].reason: has control"]],
  ["multi-line reason", guide({ hotspots: [hotspot({ reason: "a\nb" })] }), ["hotspots[0].reason: must be one line"]],
  ["long reason", guide({ hotspots: [hotspot({ reason: "x".repeat(501) })] }), ["more than 500"]],
  ["unknown hotspot key", guide({ hotspots: [{ ...hotspot(), side: "base" }] }), ["hotspots[0]: unknown key 'side'"]],
  ["missing hotspot key", guide({ hotspots: [without(hotspot(), "category")] }), ["hotspots[0]: missing 'category'"]],
  ["bad severity", guide({ hotspots: [hotspot({ severity: "high" })] }), ["hotspots[0].severity: must be one of"]],
  ["bad category", guide({ hotspots: [hotspot({ category: "style" })] }), ["hotspots[0].category"]],
  ["short commit", guide({ hotspots: [hotspot({ commit: "1111111" })] }), ["hotspots[0].commit"]],
  ["start after end", guide({ hotspots: [hotspot({ start: 30, end: 20 })] }), ["start 30 is after end 20"]],
  ["line zero", guide({ hotspots: [hotspot({ start: 0 })] }), ["hotspots[0].start: must be a line number"]],
  ["fractional line", guide({ hotspots: [hotspot({ end: 20.5 })] }), ["hotspots[0].end: must be a line number"]],
  ["too many hotspots", guide({ hotspots: Array.from({ length: 51 }, () => hotspot()) }), ["51 entries, more than 50"]],
  ["hotspot not an object", guide({ hotspots: ["x"] }), ["hotspots[0]: must be an object"]],
  ["skim half range", guide({ skim: [{ path: "a", start: 3, reason: "r" }] }), ["skim[0].end: must be a line number"]],
  ["skim no reason", guide({ skim: [{ path: "a" }] }), ["skim[0].reason: must be a non-empty"]],
];

test("validateGuide", async (t) => {
  for (const [name, g, want] of SCHEMA_CASES) {
    await t.test(name, () => {
      const errors = tool.validateGuide(g);
      if (want.length === 0) assert.deepEqual(errors, []);
      for (const w of want) assert.ok(errors.some((e) => e.includes(w)), `no error with '${w}' in ${JSON.stringify(errors)}`);
    });
  }
});

test("hunkRanges", () => {
  const patch = "@@ -1,3 +1,4 @@\n ctx\n+a\n@@ -10 +11 @@\n-x\n+y\n@@ -20,2 +21,0 @@\n-gone\n-gone";
  assert.deepEqual(tool.hunkRanges(patch), [[1, 4], [11, 11], [21, 22]]);
  assert.deepEqual(tool.hunkRanges(undefined), []);
});

test("parsePr", () => {
  for (const s of [PR_URL, `${PR_URL}/`, "cgwalters-forge/proj#7"]) assert.deepEqual(tool.parsePr(s), REF);
  for (const s of ["https://github.com/o/r/issues/7", "o/r", "https://evil.example/o/r/pull/7"]) assert.throws(() => tool.parsePr(s));
});

test("marker round trip keeps hostile text inert", () => {
  const nasty = "Ends early --> <script>alert(1)</script> & more";
  const g = guide({ summary: `${nasty}\n/promote`, hotspots: [hotspot({ reason: nasty })], skim: [{ path: "a`b", reason: nasty }] });
  const body = tool.composeBody(g);
  const markerLine = body.trimEnd().split("\n").at(-1);
  assert.match(markerLine, /^<!-- review-guide\/v1 \{.*\} -->$/);
  // The only '-->' is the one closing the marker, and no raw < > & is inside it.
  assert.equal(markerLine.indexOf("-->"), markerLine.length - 3);
  assert.doesNotMatch(markerLine.slice(4, -3), /[<>&]/);
  assert.deepEqual(tool.parseMarker(body), g);
  // The human part shows the text escaped, and no line reads as a command.
  const human = body.slice(0, body.lastIndexOf("<!--"));
  assert.doesNotMatch(human, /<script>/);
  assert.match(human, /&lt;script&gt;/);
  assert.ok(!human.split("\n").some((l) => l.trim().startsWith("/")), human);
  assert.match(human, /1\. \*\*risky\*\* · logic — `src\/lib\.rs:10-20` \(1111111111\): /);
  assert.match(human, /`` a`b ``/);
  // The last marker wins; a broken one is no guide.
  assert.equal(tool.parseMarker(`${body}\n<!-- review-guide/v1 {not json} -->`), undefined);
  assert.equal(tool.parseMarker("no marker"), undefined);
});

const PR = {
  ref: REF, head: HEAD, commits: [{ sha: C1 }, { sha: C2 }],
  files: [
    { path: "src/lib.rs", status: "modified", hunks: [[5, 25], [100, 110]] },
    { path: "old.rs", status: "removed", hunks: [] },
    { path: "Cargo.lock", status: "modified", hunks: [[1, 9]] },
  ],
};

// [name, guide, errors, warnings]
const PR_CASES = [
  ["fits", guide(), [], []],
  ["other PR", guide({ pr: 8 }), ["the guide is for cgwalters-forge/proj#8"], []],
  ["head moved", guide({ head: OTHER }), ["the PR's head is"], []],
  ["unknown path", guide({ hotspots: [hotspot({ path: "nope.rs" })] }), ["nope.rs is not a file this PR changes"], []],
  ["removed file", guide({ hotspots: [hotspot({ path: "old.rs" })] }), ["removed at head"], []],
  ["unknown commit", guide({ hotspots: [hotspot({ commit: OTHER })] }), ["is not one of the PR's commits"], []],
  ["commit prefix", guide({ hotspots: [hotspot({ commit: `${"1".repeat(7)}${"f".repeat(33)}` })] }), [`did you mean ${C1}`], []],
  ["outside hunks", guide({ hotspots: [hotspot({ start: 40, end: 50 })] }), [], ["src/lib.rs:40-50 is outside every hunk (head-side hunks: 5-25, 100-110)"]],
  ["skim unknown path", guide({ skim: [{ path: "x", reason: "r" }] }), ["skim[0].path: x is not a file"], []],
];

test("checkAgainstPr", async (t) => {
  for (const [name, g, wantErrors, wantWarnings] of PR_CASES) {
    await t.test(name, () => {
      const { errors, warnings } = tool.checkAgainstPr(g, PR);
      assert.equal(errors.length, wantErrors.length, JSON.stringify(errors));
      assert.equal(warnings.length, wantWarnings.length, JSON.stringify(warnings));
      for (const w of wantErrors) assert.ok(errors.some((e) => e.includes(w)), `${w} in ${JSON.stringify(errors)}`);
      for (const w of wantWarnings) assert.ok(warnings.some((e) => e.includes(w)), `${w} in ${JSON.stringify(warnings)}`);
    });
  }
});

const review = (over = {}) => ({
  user: { login: "cgwalters-bot" }, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-09-26T10:00:00Z",
  html_url: "https://github.com/r/1", body: tool.composeBody(guide()), ...over,
});

// [name, reviews, the html_url expected, or undefined]
const TRUST_CASES = [
  ["one", [review()], "https://github.com/r/1"],
  ["latest wins", [review({ submitted_at: "2026-09-26T11:00:00Z", html_url: "late" }), review()], "late"],
  ["someone else", [review({ user: { login: "mallory" } })], undefined],
  ["not a comment", [review({ state: "APPROVED" })], undefined],
  ["commit_id isn't the guide's head", [review({ commit_id: OTHER })], undefined],
  ["another PR's guide", [review({ body: tool.composeBody(guide({ pr: 8 })) })], undefined],
  ["invalid guide", [review({ body: tool.composeBody(guide({ hotspots: [hotspot({ severity: "x" })] })) })], undefined],
  ["pending review", [review({ submitted_at: null })], undefined],
  ["stale is still found", [review({ commit_id: OTHER, body: tool.composeBody(guide({ head: OTHER })) })], "https://github.com/r/1"],
];

test("trustedGuide", async (t) => {
  for (const [name, reviews, want] of TRUST_CASES) {
    await t.test(name, () => assert.equal(tool.trustedGuide(reviews, REF)?.review.html_url, want));
  }
});

// The CLI against a fake gh, which answers `api PATH` from state.json
// (page 1 only; later pages are empty), serves successive heads of the
// PR from state.heads (the last repeating), and records calls and the
// posted request.
const FAKE_GH = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const dir = process.env.FAKE_GH_DIR;
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls", args.join(" ") + "\\n");
const out = (v) => process.stdout.write(JSON.stringify(v));
if (args[0] !== "api") { process.stderr.write("fake gh: unexpected " + args.join(" ")); process.exit(1); }
if (args[1] === "-X") {
  fs.writeFileSync(dir + "/posted.json", fs.readFileSync(0, "utf8"));
  out({ html_url: "https://github.com/cgwalters-forge/proj/pull/7#pullrequestreview-1" });
  process.exit(0);
}
const p = args[1];
if (p === "user") { out({ login: state.login }); process.exit(0); }
if (p === "repos/cgwalters-forge/proj/pulls/7") {
  const heads = state.heads;
  const head = heads.length > 1 ? heads.shift() : heads[0];
  fs.writeFileSync(dir + "/state.json", JSON.stringify(state));
  out({ head: { sha: head }, state: "open", title: "A PR" });
  process.exit(0);
}
const m = /^(.*?)[?&]per_page=\\d+&page=(\\d+)$/.exec(p);
if (m && m[1] in state.lists) { out(m[2] === "1" ? state.lists[m[1]] : []); process.exit(0); }
if (p in state.objects) { out(state.objects[p]); process.exit(0); }
process.stderr.write("fake gh: no answer for " + p);
process.exit(1);
`;

function fakeWorld({ heads = [HEAD], login = "cgwalters-bot", reviews = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-review-guide-test-"));
  fs.writeFileSync(path.join(dir, "gh"), FAKE_GH, { mode: 0o755 });
  const base = "repos/cgwalters-forge/proj/pulls/7";
  const state = {
    login, heads,
    lists: {
      [`${base}/commits`]: [{ sha: C1, commit: { message: "one\n\nbody" } }, { sha: C2, commit: { message: "two" } }],
      [`${base}/files`]: [
        { filename: "src/lib.rs", status: "modified", additions: 3, deletions: 1, patch: "@@ -5,20 +5,21 @@\n ctx" },
        { filename: "Cargo.lock", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,9 +1,9 @@\n ctx" },
      ],
      [`${base}/reviews`]: reviews,
    },
    objects: {
      [`repos/cgwalters-forge/proj/commits/${C1}`]: { files: [{ filename: "src/lib.rs" }] },
      [`repos/cgwalters-forge/proj/commits/${C2}`]: { files: [{ filename: "Cargo.lock" }, { filename: "src/lib.rs" }] },
    },
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, "guide.json"), JSON.stringify(guide()));
  const run = (...args) => {
    const r = spawnSync(TOOL, args, { cwd: dir, encoding: "utf8", env: { ...process.env, FAKE_GH_DIR: dir, BOT_REVIEW_GUIDE_GH: path.join(dir, "gh") } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : undefined);
  return { dir, run, read, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("CLI", async (t) => {
  await t.test("context lists commits, files, hunks and a skeleton", () => {
    const w = fakeWorld();
    const r = w.run("context", PR_URL);
    w.done();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`head ${HEAD}`));
    assert.match(r.stdout, new RegExp(`${C1} one\\n`));
    assert.match(r.stdout, /src\/lib\.rs \(modified \+3 -1\) \[1111111111 2222222222\]: 5-25/);
    assert.match(r.stdout, /"schema": "review-guide\/v1"/);
  });
  await t.test("check ok, and a moved head fails", () => {
    let w = fakeWorld();
    let r = w.run("check", PR_URL, "guide.json");
    w.done();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ok: 1 hotspot\(s\), 1 skim entry/);
    w = fakeWorld({ heads: [OTHER] });
    r = w.run("check", PR_URL, "guide.json");
    w.done();
    assert.equal(r.status, 3);
    assert.match(r.stderr, /the PR's head is b{40} now/);
  });
  await t.test("post sends a COMMENT review on the head", () => {
    const w = fakeWorld();
    const r = w.run("post", PR_URL, "guide.json");
    const posted = JSON.parse(w.read("posted.json"));
    const calls = w.read("calls");
    w.done();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pullrequestreview-1/);
    assert.equal(posted.event, "COMMENT");
    assert.equal(posted.commit_id, HEAD);
    assert.deepEqual(tool.parseMarker(posted.body), guide());
    assert.match(calls, /api -X POST repos\/cgwalters-forge\/proj\/pulls\/7\/reviews --input -/);
  });
  await t.test("post --dry-run prints the body only", () => {
    const w = fakeWorld();
    const r = w.run("post", PR_URL, "guide.json", "--dry-run");
    const posted = w.read("posted.json");
    w.done();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(posted, undefined);
    assert.match(r.stdout, /^\*\*Review guide\*\* for head `aaaaaaaaaa`/);
  });
  // [name, world, exit status, stderr]
  const REFUSALS = [
    ["another login", { login: "cgwalters" }, 1, /authenticated as cgwalters/],
    ["the head moves before posting", { heads: [HEAD, OTHER] }, 3, /head moved to b{40} while checking; nothing was posted/],
  ];
  for (const [name, world, status, stderr] of REFUSALS) {
    await t.test(`post refuses: ${name}`, () => {
      const w = fakeWorld(world);
      const r = w.run("post", PR_URL, "guide.json");
      const posted = w.read("posted.json");
      w.done();
      assert.equal(r.status, status, r.stderr);
      assert.match(r.stderr, stderr);
      assert.equal(posted, undefined);
    });
  }
  await t.test("post refuses other owners", () => {
    const w = fakeWorld();
    const r = w.run("post", "https://github.com/bootc-dev/bootc/pull/7", "guide.json");
    const calls = w.read("calls");
    w.done();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /only on PRs in cgwalters-forge or cgwalters-bot, not bootc-dev/);
    assert.equal(calls, undefined);
  });
  await t.test("show: current, stale, none", () => {
    let w = fakeWorld({ reviews: [review()] });
    let r = w.run("show", PR_URL);
    w.done();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\ncurrent\n/);
    assert.doesNotMatch(r.stdout, /<!--/);
    w = fakeWorld({ heads: [OTHER], reviews: [review()] });
    r = w.run("show", PR_URL, "--json");
    w.done();
    assert.equal(JSON.parse(r.stdout).status, "stale");
    w = fakeWorld({ reviews: [review({ user: { login: "mallory" } })] });
    r = w.run("show", PR_URL);
    w.done();
    assert.equal(r.status, 4);
  });
  await t.test("usage errors", () => {
    const w = fakeWorld();
    for (const args of [[], ["frob", PR_URL], ["check", PR_URL], ["context", PR_URL, "extra"], ["show", PR_URL, "--dry-run"]]) {
      assert.equal(w.run(...args).status, 2, args.join(" "));
    }
    w.done();
  });
});

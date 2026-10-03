// Offline tests of lib/pacing.js (lanes, candidates, budgets) and of
// bin/bot-pace against a fake bot-board. Run with tests/pacing.sh, or
// node --test tests/pacing.test.js.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const pace = require(path.join(__dirname, "..", "lib", "pacing.js"));
const operator = require(path.join(__dirname, "..", "lib", "operator.js"));
const TOOL = path.join(__dirname, "..", "bin", "bot-pace");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pacing-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CONFIG = operator.resolve({});
const CTX = pace.context(CONFIG);
const GH = "https://github.com";
const item = (fields) => ({ id: "PVTI_x", title: "x", status: "Todo", ...fields });
const issue = (repo, n = 1) => ({ type: "Issue", url: `${GH}/${repo}/issues/${n}` });

test("lanes and target repositories", () => {
  // [item, lane, target repository]
  const cases = [
    [{ org: "cgwalters-bot", content: issue("cgwalters-bot/homegit") }, "harness", "cgwalters-bot/homegit"],
    [{ org: "cgwalters-forge", content: issue("cgwalters-forge/review") }, "harness", "cgwalters-forge/review"],
    // The tracker names no repository; a forge fork PR in Branch does, as its upstream's.
    [{ org: "bootc-dev", content: issue("cgwalters-forge/tracker"), branch: `${GH}/cgwalters-forge/bootc/pull/3 ${GH}/x/y/pull/1` }, "upstream", "bootc-dev/bootc"],
    [{ org: "bootc-dev", content: issue("cgwalters-forge/tracker") }, "upstream", null],
    [{ org: "composefs", content: issue("composefs/composefs-rs") }, "upstream", "composefs/composefs-rs"],
    [{ org: "other", content: issue("cgwalters/dotfiles") }, "upstream", "cgwalters/dotfiles"],
    // No Org: by the repository's owner.
    [{ content: issue("cgwalters-forge/actions") }, "harness", "cgwalters-forge/actions"],
    [{ content: issue("osbuild/osbuild") }, "upstream", "osbuild/osbuild"],
    [{ content: { type: "DraftIssue" } }, "upstream", null],
  ];
  for (const [fields, lane, repo] of cases) {
    const it = item(fields);
    assert.equal(pace.laneOf(it, CTX), lane, JSON.stringify(fields));
    assert.equal(pace.targetRepo(it, CTX), repo, JSON.stringify(fields));
  }
});

test("which Todo items are no candidates", () => {
  const verdicts = { "osbuild/image-builder": "human-text", "o/never": "no-go", "bootc-dev/bootc": "bot-ok" };
  const ib = issue("osbuild/image-builder");
  const cases = [
    [{ content: ib, org: "osbuild" }, "osbuild/image-builder is human-text"],
    [{ content: ib, org: "osbuild", workflow: "analysis" }, null],
    [{ content: issue("o/never"), org: "o" }, "o/never is no-go"],
    [{ content: issue("bootc-dev/bootc") }, null],
    [{ lead: "coordinator" }, null],
    [{ lead: "wfc" }, "led by wfc"],
    [{ run: `${GH}/o/r/actions/runs/1` }, "a run owns it"],
    [{ labels: ["P1", "question"] }, "an ask for the operator"],
    [{ labels: ["chore"] }, "an ask for the operator"],
    [{ workflow: "manual" }, "manual"],
  ];
  for (const [fields, want] of cases) assert.equal(pace.skipReason(item(fields), CTX, verdicts), want, JSON.stringify(fields));
});

test("budgets: Est. cost, else the priority's bucket", () => {
  const cases = [
    [{ "est. cost": "XS (<200k tok)" }, ["XS", 200e3, "est"]],
    [{ "est. cost": "L (<20M tok)", priority: "P2" }, ["L", 20e6, "est"]],
    [{ "est. cost": "XL (>20M tok)" }, ["XL", pace.XL_BUDGET, "est"]],
    [{ priority: "P0" }, ["M", 5e6, "priority"]],
    [{ priority: "P1" }, ["S", 1e6, "priority"]],
    [{ priority: "P7" }, ["S", 1e6, "priority"]],
    [{}, ["S", 1e6, "priority"]],
  ];
  for (const [fields, [bucket, tokens, source]] of cases) {
    assert.deepEqual(pace.budgetFor(item(fields), CONFIG.pacing), { bucket, tokens, source }, JSON.stringify(fields));
  }
  const custom = operator.resolve({ pacing: { budgets: { P1: "L", P2: "XS" } } }).pacing;
  assert.equal(pace.budgetFor(item({ priority: "P1" }), custom).tokens, 20e6);
  assert.equal(pace.budgetFor(item({}), custom).bucket, "XS");
  const fmt = [[0, "0"], [50e3, "50k"], [1e6, "1M"], [1.25e6, "1.3M"], [null, "?"]];
  for (const [n, want] of fmt) assert.equal(pace.tokens(n), want, String(n));
  assert.deepEqual([pace.num(5), pace.num("7"), pace.num({ raw: "9" }), pace.num(null), pace.num(""), pace.num("x")], [5, 7, 9, null, null, null]);
});

test("slots: busy agents per lane, candidates by priority, spread, then the operator's activity", () => {
  const busy = (id, org, repo, extra = {}) => item({ id, status: "In Progress", lead: "coordinator", org, content: issue(repo), ...extra });
  const todo = (id, priority, org, repo) => item({ id, priority, org, content: issue(repo, id.length) });
  const items = [
    busy("b1", "bootc-dev", "bootc-dev/bootc", { "actual tokens": 3e6, priority: "P1" }),
    busy("b2", "cgwalters-bot", "cgwalters-bot/homegit", { run: undefined, lead: undefined }),
    item({ id: "b3", status: "In Progress", org: "composefs", run: `${GH}/o/r/actions/runs/1`, content: issue("composefs/composefs-rs") }),
    todo("t1", "P1", "bootc-dev", "bootc-dev/bootc"),
    todo("t2", "P1", "ostreedev", "ostreedev/ostree"),
    todo("t3", "P1", "coreos", "coreos/bootupd"),
    todo("t4", "P2", "osbuild", "osbuild/osbuild"),
    todo("t5", "P0", "z-galaxy", "z-galaxy/zlink"),
    todo("t6", "P1", "cgwalters-forge", "cgwalters-forge/review"),
  ];
  const report = (opts = {}) => pace.slotReport({ items, config: CONFIG, ...opts });
  let r = report();
  assert.deepEqual([r.busy, r.target, r.unowned_in_progress], [2, 4, 1]);
  assert.deepEqual(r.lanes.upstream.active.map((a) => a.id), ["b1", "b3"]);
  assert.deepEqual([r.lanes.harness.free, r.lanes.upstream.free], [2, 0]);
  // A lane's free slots are capped by the total's: [agents, harness_agents, total free, harness free, harness under_share]
  const capped = [[4, 2, 2, 2, 0], [3, 2, 1, 1, 1], [2, 1, 0, 0, 1], [1, 1, 0, 0, 1]];
  for (const [agents, harness, total, free, under] of capped) {
    const c = report({ config: operator.resolve({ pacing: { agents, harness_agents: harness } }) });
    assert.deepEqual([c.free, c.lanes.harness.free, c.lanes.harness.under_share, c.lanes.upstream.free], [total, free, under, 0], `${agents}/${harness}`);
  }
  assert.deepEqual(r.lanes.harness.candidates.map((c) => c.id), ["t6"]);
  // P0 first; then the P1s in repositories nothing busy is in, by board order;
  // bootc, with a busy agent, last.
  assert.deepEqual(r.lanes.upstream.candidates.map((c) => c.id), ["t5", "t2", "t3"]);
  // The operator's activity orders the P1s within the spread: on bootupd's
  // name (forks count), then on bootc's (still behind the spread).
  r = report({ activity: { "cgwalters-forge/bootupd": 3, "bootc-dev/bootc": 9 } });
  assert.deepEqual(r.lanes.upstream.candidates.map((c) => [c.id, c.activity]), [["t5", 0], ["t3", 3], ["t2", 0]]);
  // Budgets: b1 S by P1 (spent 3M: over), b3 S by default.
  assert.deepEqual(r.over_budget.map((a) => [a.id, a.budget, a.spent]), [["b1", 1e6, 3e6]]);
  assert.deepEqual([r.budget_tokens, r.spent_tokens], [2e6, 3e6]);
  // Paced: half the targets, P0 only.
  r = report({ factor: 0.5, priorities: ["P0"] });
  assert.deepEqual([r.target, r.lanes.harness.target, r.lanes.upstream.target], [2, 1, 1]);
  assert.deepEqual(r.lanes.upstream.candidates.map((c) => c.id), ["t5"]);
  assert.deepEqual(r.lanes.harness.candidates, []);
});

test("verdicts and activity from their files", () => {
  const dir = path.join(TMP, "policy");
  fs.mkdirSync(path.join(dir, "Org"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Org", "Repo.md"), "---\nverdict: human-text\n---\n");
  fs.writeFileSync(path.join(dir, "Org", "notes.txt"), "verdict: no-go\n");
  assert.deepEqual(pace.readVerdicts(dir), { "org/repo": "human-text" });
  assert.deepEqual(pace.readVerdicts(path.join(TMP, "none")), {});
  const now = Date.parse("2026-10-02T12:00:00Z");
  const f = path.join(TMP, "repos.json");
  fs.writeFileSync(f, JSON.stringify({ "A/B": { e1: "2026-10-01T00:00:00Z", e2: "2026-09-20T00:00:00Z" }, "c/d": { e3: "2026-09-01T00:00:00Z" } }));
  assert.deepEqual(pace.readActivity(f, now), { "a/b": 1 });
  assert.deepEqual(pace.readActivity(path.join(TMP, "missing.json"), now), {});
});

// --- bin/bot-pace, against a fake bot-board -------------------------------

const BOARD_ITEMS = [
  { id: "PVTI_a", title: "A", status: "Todo", priority: "P0", content: issue("o/r", 1) },
  { id: "PVTI_b", title: "B", status: "Todo", priority: "P2", "est. cost": "L (<20M tok)", content: issue("o/r", 2) },
  { id: "PVTI_c", title: "C", status: "In Progress", priority: "P1", "budget tokens": 2000000, content: issue("o/r", 3) },
  { id: "PVTI_d", title: "D", status: "Todo", priority: "P1", lead: "wfc", content: issue("o/r", 4) },
  { id: "PVTI_e", title: "E", status: "In Progress", priority: "P1", run: `${GH}/o/r/actions/runs/1`, content: issue("o/r", 5) },
];
const LOG = path.join(TMP, "board.log");
const FAKE_BOARD = path.join(TMP, "bot-board");
fs.writeFileSync(path.join(TMP, "items.json"), JSON.stringify(BOARD_ITEMS));
fs.writeFileSync(FAKE_BOARD, `#!/usr/bin/env bash\nif test "$1" = list; then cat ${TMP}/items.json; else printf '%s|' "$@" >>${LOG}; echo >>${LOG}; fi\n`, { mode: 0o755 });

// The default operator config.
fs.writeFileSync(path.join(TMP, "operator.json"), "{}");

function pacecli(args, status = 0) {
  fs.rmSync(LOG, { force: true });
  const r = spawnSync(TOOL, args, { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: path.join(TMP, "state"), BOT_PACE_BOARD: FAKE_BOARD, BOT_OPERATOR_CONFIG: path.join(TMP, "operator.json") } });
  assert.equal(r.status, status, `${args}: ${r.stderr}`);
  return { out: r.stdout, err: r.stderr, calls: fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n") : [] };
}
test("bot-pace budget", () => {
  // [args, board calls after field-ensure, output]
  const cases = [
    [["budget", "PVTI_a"], "set|PVTI_a|--field|Budget tokens|5000000|", /^Budget tokens = 5000000 \(5M, P0: M\) on PVTI_a$/m],
    [["budget", `${GH}/o/r/issues/2`], "set|PVTI_b|--field|Budget tokens|20000000|", /\(20M, Est\. cost L\)/],
    [["budget", "PVTI_a", "--est", "xs"], "set|PVTI_a|--field|Est. cost|XS (<200k tok)|--field|Budget tokens|200000|", /\(200k, Est\. cost XS\)/],
    [["budget", "PVTI_a", "--tokens", "750000"], "set|PVTI_a|--field|Budget tokens|750000|", /\(750k, given\)/],
    [["budget", "PVTI_c", "--force"], "set|PVTI_c|--field|Budget tokens|1000000|", /\(1M, P1: S\)/],
  ];
  for (const [args, set, out] of cases) {
    const r = pacecli(args);
    assert.deepEqual(r.calls, ["field-ensure|--number|Budget tokens|", set], args.join(" "));
    assert.match(r.out, out, args.join(" "));
  }
  // A budget already set stays, and nothing is written.
  let r = pacecli(["budget", "PVTI_c"]);
  assert.deepEqual(r.calls, []);
  assert.equal(r.out, "PVTI_c already has a budget of 2M\n");
  r = pacecli(["budget", "PVTI_a", "--dry-run"]);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /^would run: bot-board set PVTI_a --field 'Budget tokens' 5000000$/m);
  for (const [args, re] of [
    [["budget", "PVTI_zz"], /PVTI_zz is not on the board/],
    [["budget", "PVTI_a", "--est", "XXL"], /--est must be one of XS, S, M, L, XL/],
    [["budget", "PVTI_a", "--est", "S", "--tokens", "5"], /not both/],
    [["budget", "PVTI_a", "--tokens", "1.5"], /positive whole number/],
    [["budget"], /budget takes one ITEM/],
    [["nope"], /unknown command 'nope'/],
  ]) assert.match(pacecli(args, /not on the board/.test(re.source) ? 1 : 2).err, re, args.join(" "));
});

test("bot-pace assign", () => {
  let r = pacecli(["assign", "PVTI_a"]);
  assert.deepEqual(r.calls, ["field-ensure|--number|Budget tokens|", "set|PVTI_a|--status|In Progress|--field|Lead|coordinator|--field|Budget tokens|5000000|"]);
  assert.match(r.out, /^PVTI_a: In Progress, Lead coordinator; Budget tokens = 5000000/);
  // An item with a budget keeps it: only the claim.
  r = pacecli(["assign", "PVTI_c", "--lead", "w1"]);
  assert.deepEqual(r.calls, ["set|PVTI_c|--status|In Progress|--field|Lead|w1|"]);
  // A topic session's item is refused unless taken over; a run's always.
  assert.match(pacecli(["assign", "PVTI_d"], 1).err, /is led by wfc; it is theirs \(--force takes it over\)/);
  assert.equal(pacecli(["assign", "PVTI_d", "--lead", "wfc"]).calls.length, 2);
  assert.equal(pacecli(["assign", "PVTI_d", "--force"]).calls.length, 2);
  assert.match(pacecli(["assign", "PVTI_e"], 1).err, /is owned by the run/);
});

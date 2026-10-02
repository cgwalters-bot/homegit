// Offline tests of lib/capacity.js (buckets, attribution, projection math)
// and of bin/bot-actuals and bin/bot-capacity against fake bot-cost and
// bot-board commands. Run with tests/capacity.sh, or node --test
// tests/capacity.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const BIN = path.join(__dirname, "..", "bin");
const FIXTURES = path.join(__dirname, "fixtures", "bot-cost");
const cap = require(path.join(__dirname, "..", "lib", "capacity.js"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DAY = cap.DAY_MS;
const NOW = Date.parse("2026-09-24T00:00:00Z");

test("bucket parsing: option names, bare keys, junk", () => {
  const cases = [
    ["XS (<200k tok)", "XS"], ["S (<1M tok)", "S"], ["M (<5M tok)", "M"], ["L (<20M tok)", "L"],
    ["XL (>20M tok)", "XL"], ["xl", "XL"], [" s ", "S"], ["Small", null], ["", null], [undefined, null], ["XXL", null],
  ];
  for (const [s, want] of cases) assert.equal(cap.bucketOf(s)?.key ?? null, want, String(s));
  for (const b of cap.BUCKETS) assert.equal(cap.bucketOf(b.option), b, b.option);
});

test("buckets by token count are half-open at the upper bound", () => {
  const cases = [[0, "XS"], [199999, "XS"], [200e3, "S"], [999999, "S"], [1e6, "M"], [5e6, "L"], [19999999, "L"], [20e6, "XL"], [1e9, "XL"]];
  for (const [n, want] of cases) assert.equal(cap.bucketForTokens(n).key, want, String(n));
});

test("item markers: Item: line, URL forms, PVTI fallback", () => {
  const url = "https://github.com/o/r/issues/5";
  const cases = [
    [`Read the preamble.\nItem: ${url}\nGo.`, url],
    [`Item: ${url}#issuecomment-1.`, url],
    ["- Item: https://github.com/O/R/pull/7/files", "https://github.com/o/r/pull/7"],
    ["  Item: PVTI_abc-1_x", "PVTI_abc-1_x"],
    ["Board item PVTI_item1: claim it.", "PVTI_item1"],
    ["Item: not-an-item, but see PVTI_zz", "PVTI_zz"],
    ["See https://github.com/o/r/issues/5 for the Item: idea", null],
    ["no marker", null],
  ];
  for (const [prompt, want] of cases) assert.equal(cap.itemMarker(prompt), want, prompt);
});

const ITEMS = [
  { id: "PVTI_a", status: "Done", priority: "P0", content: { url: "https://github.com/o/r/issues/1" }, branch: "https://github.com/f/r/pull/9 https://github.com/f/r/pull/10", title: "A" },
  { id: "PVTI_b", status: "Done", priority: "P1", content: { url: "https://github.com/o/r/issues/2" }, title: "B", "actual tokens": 5 },
  { id: "PVTI_c", status: "Todo", priority: "P0", content: { url: "https://github.com/o/r/issues/3" }, title: "C" },
];

test("attribution: by id, issue URL or Branch PR URL; unmatched tasks dropped", () => {
  const tasks = [
    { item: "PVTI_a", fresh_tokens: 100 },
    { item: "https://github.com/o/r/issues/1", fresh_tokens: 20 },
    { item: "https://github.com/f/r/pull/10", fresh_tokens: 3 },
    { item: "https://github.com/o/r/issues/2", fresh_tokens: 7 },
    { item: "https://github.com/o/r/issues/99", fresh_tokens: 1000 },
    { item: null, fresh_tokens: 1000 },
  ];
  assert.deepEqual(cap.attribute(tasks, ITEMS), { PVTI_a: 123, PVTI_b: 7 });
});

test("projection: burn rate and percent at reset", () => {
  // Halfway through the week at 30%: 60/7 per day, 60% at the reset.
  let p = cap.weekProjection({ usedPercent: 30, resetsAt: NOW + 3.5 * DAY, now: NOW });
  assert.ok(Math.abs(p.burn_per_day - 30 / 3.5) < 1e-9);
  assert.ok(Math.abs(p.projected - 60) < 1e-9);
  assert.ok(Math.abs(p.elapsed_days - 3.5) < 1e-9);
  // Too early in the week to extrapolate.
  p = cap.weekProjection({ usedPercent: 10, resetsAt: NOW + 6.8 * DAY, now: NOW });
  assert.equal(p.projected, null);
  // A reset time more than a week out (clock skew) clamps elapsed to 0.
  p = cap.weekProjection({ usedPercent: 10, resetsAt: NOW + 8 * DAY, now: NOW });
  assert.equal(p.projected, null);
  assert.equal(p.burn_per_day, 0);
  // Past 100% already.
  p = cap.weekProjection({ usedPercent: 100, resetsAt: NOW + 1 * DAY, now: NOW });
  assert.ok(Math.abs(p.projected - 100 * 7 / 6) < 1e-9);
});

test("calibration needs enough tokens", () => {
  assert.equal(cap.percentPerToken({ usedPercent: 10, tokens: 1e5 }), null);
  assert.equal(cap.percentPerToken({ usedPercent: 0, tokens: 1e7 }), null);
  assert.equal(cap.percentPerToken({ usedPercent: 10, tokens: 1e7 }), 1e-6);
});

test("dispatch advice: all below 80%, P0 only from 80%, none at 100%", () => {
  const cases = [[0, "all"], [79.9, "all"], [80, "p0"], [99.9, "p0"], [100, "none"], [250, "none"]];
  for (const [proj, want] of cases) assert.equal(cap.dispatchAdvice(proj).scope, want, String(proj));
  const a = cap.dispatchAdvice(70);
  assert.equal(a.headroom, 30);
  assert.ok(a.fits(30) && !a.fits(30.1));
});

test("report: statusline reading, estimates summed by bucket", () => {
  const items = [
    ...["XS (<200k tok)", "S (<1M tok)", "S (<1M tok)", "L (<20M tok)", undefined].map((e, i) => ({ id: `p0${i}`, status: "Todo", priority: "P0", "est. cost": e })),
    { id: "p1", status: "In Progress", priority: "P1", "est. cost": "M (<5M tok)" },
    { id: "p2", status: "Todo", priority: "P2", "est. cost": "XL (>20M tok)" },
    { id: "d", status: "Done", priority: "P0", "est. cost": "XL (>20M tok)" },
    { id: "dr", status: "Draft", priority: "P1", "est. cost": "XL (>20M tok)" },
  ];
  // 40% used by day 3.5 on 40M tokens: 1e-6 percent per token, 80% projected.
  const r = cap.capacityReport({ rate: { usedPercent: 40, resetsAt: NOW + 3.5 * DAY }, weekTokens: 40e6, budget: null, items, now: NOW });
  assert.equal(r.source, "statusline");
  assert.ok(Math.abs(r.projected - 80) < 1e-9);
  assert.equal(r.dispatch.scope, "p0");
  const p0 = r.estimates.P0;
  assert.deepEqual([p0.XS.count, p0.S.count, p0.L.count, p0.unestimated], [1, 2, 1, 1]);
  assert.equal(p0.tokens, 100e3 + 2 * 500e3 + 10e6);
  assert.ok(Math.abs(p0.percent - 11.1) < 1e-9);
  assert.equal(r.estimates.P1.M.count, 1);
  assert.equal(r.estimates.P1.XL.count, 0);
  // 20% headroom: P0's 11.1% fits, then P1's 2.5% does too.
  assert.deepEqual([p0.fits, r.estimates.P1.fits], [true, true]);
  assert.ok(Math.abs(r.dispatch.headroom - 20) < 1e-9);
});

test("report: estimates that exceed the headroom do not fit; budget and token-only fallbacks", () => {
  const items = [{ id: "x", status: "Todo", priority: "P0", "est. cost": "XL (>20M tok)" }];
  let r = cap.capacityReport({ rate: { usedPercent: 50, resetsAt: NOW + 3.5 * DAY }, weekTokens: 50e6, budget: null, items, now: NOW });
  assert.ok(Math.abs(r.projected - 100) < 1e-9);
  assert.equal(r.dispatch.scope, "none");
  assert.equal(r.estimates.P0.fits, false);
  // A rolling week against a budget: 60M of 100M, 30M of XL is 30%.
  r = cap.capacityReport({ rate: null, weekTokens: 60e6, budget: 100e6, items, now: NOW });
  assert.equal(r.source, "budget");
  assert.ok(Math.abs(r.projected - 60) < 1e-9);
  assert.ok(Math.abs(r.estimates.P0.percent - 30) < 1e-9);
  assert.equal(r.estimates.P0.fits, true);
  // No rate, no budget: only tokens.
  r = cap.capacityReport({ rate: null, weekTokens: 7e6, budget: null, items, now: NOW });
  assert.equal(r.dispatch.scope, "unknown");
  assert.equal(r.burn_tokens_per_day, 1e6);
  assert.equal(r.estimates.P0.percent, null);
  assert.equal(r.estimates.P0.tokens, 30e6);
});

// --- the tools, against fakes ---------------------------------------------------

function fake(name, body) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return f;
}

const COST_JSON = JSON.stringify({
  totals: { fresh_tokens: 40e6 },
  tasks: [{ item: "PVTI_a", fresh_tokens: 1234 }, { item: "https://github.com/o/r/issues/2", fresh_tokens: 5 }, { item: "PVTI_c", fresh_tokens: 9 }],
});
const BOARD_LOG = path.join(TMP, "board.log");
const fakeCost = fake("cost", `echo "$@" >>${TMP}/cost.log; cat <<'EOF'\n${COST_JSON}\nEOF`);
const fakeBoard = fake("board", `if test "$1" = list; then cat <<'EOF'\n${JSON.stringify(ITEMS)}\nEOF\nelse echo "$@" >>${BOARD_LOG}; fi`);

test("bot-actuals sets Actual tokens on Done items without one; --dry-run only prints", () => {
  const env = { ...process.env, BOT_ACTUALS_COST: fakeCost, BOT_ACTUALS_BOARD: fakeBoard };
  const run = (args) => execFileSync(path.join(BIN, "bot-actuals"), args, { env, encoding: "utf8" });
  assert.match(run(["--dry-run"]), /would set Actual tokens = 1234 on PVTI_a \(A\)/);
  assert.ok(!fs.existsSync(BOARD_LOG));
  const out = run([]);
  assert.match(out, /^set Actual tokens = 1234 on PVTI_a/m);
  // PVTI_b already has a value and PVTI_c is not Done.
  assert.doesNotMatch(out, /PVTI_[bc]/);
  assert.equal(fs.readFileSync(BOARD_LOG, "utf8"), "set PVTI_a --field Actual tokens 1234\n");
  assert.match(run(["--dry-run", "--all"]), /Actual tokens = 5 on PVTI_b/);
});

test("bot-actuals plan: which items each mode sets", () => {
  const { plan } = require(path.join(BIN, "bot-actuals"));
  const busy = { status: "In Progress", lead: "coordinator" };
  // [item fields, attributed sum, set in modes done/all/open]
  const cases = [
    [{ status: "Done" }, 500e3, [true, true, true]],
    [{ status: "Done", "actual tokens": 400e3 }, 450e3, [false, true, false]],
    [{ status: "Done", "actual tokens": 400e3 }, 600e3, [false, true, true]],
    [{ status: "Done", "actual tokens": 600e3 }, 500e3, [false, true, false]],
    [busy, 50e3, [false, false, true]],
    [{ ...busy, "actual tokens": 1e6 }, 1.05e6, [false, false, false]],
    [{ ...busy, "actual tokens": 1e6 }, 1.2e6, [false, false, true]],
    [{ status: "In Progress", run: "https://github.com/o/r/actions/runs/1" }, 10, [false, false, true]],
    [{ status: "In Progress" }, 1e6, [false, false, false]],
    [{ status: "Todo" }, 1e6, [false, false, false]],
    [{ status: "Done" }, 0, [false, false, false]],
  ];
  cases.forEach(([fields, sum, want], i) => {
    const item = { id: `PVTI_${i}`, title: `t${i}`, ...fields };
    const tasks = sum ? [{ item: item.id, fresh_tokens: sum }] : [];
    ["done", "all", "open"].forEach((mode, m) => {
      assert.deepEqual(plan([item], tasks, mode), want[m] ? [{ id: item.id, title: item.title, tokens: sum }] : [], `case ${i} ${mode}`);
    });
  });
});

test("bot-capacity reads the statusline file and reports the projection", () => {
  const rate = path.join(TMP, "rate-limits.json");
  const base = { ...process.env, BOT_CAPACITY_COST: fakeCost, BOT_CAPACITY_BOARD: fakeBoard, BOT_CAPACITY_RATE_FILE: rate, BOT_CAPACITY_NOW: new Date(NOW).toISOString() };
  const run = (args = [], env = {}) => execFileSync(path.join(BIN, "bot-capacity"), args, { env: { ...base, ...env }, encoding: "utf8" });
  fs.writeFileSync(rate, JSON.stringify({ observed_at: new Date(NOW - 60e3).toISOString(), seven_day: { used_percent: 40, resets_at: new Date(NOW + 3.5 * DAY).toISOString() } }));
  const r = JSON.parse(run(["--json"]));
  assert.equal(r.source, "statusline");
  assert.ok(Math.abs(r.projected - 80) < 1e-9);
  assert.match(fs.readFileSync(path.join(TMP, "cost.log"), "utf8"), /--since 2026-09-20T12:00:00.000Z /);
  assert.match(run(), /Dispatch: P0 only/);
  // A stale reading is ignored: with a budget the week is the trailing 7 days.
  fs.writeFileSync(rate, JSON.stringify({ observed_at: new Date(NOW - 2 * 3600e3).toISOString(), seven_day: { used_percent: 99, resets_at: new Date(NOW + DAY).toISOString() } }));
  assert.equal(JSON.parse(run(["--json", "--budget", "100000000"])).source, "budget");
  assert.equal(JSON.parse(run(["--json"])).source, "tokens");
});

test("bot-cost attributes a transcript to its Item: marker, with fresh tokens", () => {
  const dir = path.join(TMP, "proj");
  fs.mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
  const t = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(dir, "s1.jsonl"), "");
  fs.writeFileSync(path.join(dir, "s1", "subagents", "agent-x1.jsonl"), [
    t({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "Read the preamble.\nItem: https://github.com/o/r/issues/2\nScratch: /tmp/c/scratchpad/zz/" } }),
    t({ type: "assistant", timestamp: "2026-09-20T10:01:00Z", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 } } }),
  ].join("\n") + "\n");
  const env = { ...process.env, XDG_CACHE_HOME: TMP, BOT_COST_NOW: "2026-09-22T00:00:00Z", BOT_COST_MODELS_JSON: path.join(FIXTURES, "models.json") };
  const out = JSON.parse(execFileSync(path.join(BIN, "bot-cost"), ["--since", "2026-09-20", "--projects", dir, "--no-compute", "--json"], { env, encoding: "utf8" }));
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].item, "https://github.com/o/r/issues/2");
  assert.equal(out.tasks[0].tokens, 1060);
  assert.equal(out.tasks[0].fresh_tokens, 60);
  assert.equal(out.totals.fresh_tokens, 60);
  assert.deepEqual(cap.attribute(out.tasks, ITEMS), { PVTI_b: 60 });
});

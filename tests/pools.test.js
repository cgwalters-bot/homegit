// Offline tests of lib/pools.js: the pace of an inference pool against an
// even use of its target by the reset, what a run costs it, and how the
// pools read in a line. Run with tests/pools.sh, or node --test
// tests/pools.test.js.
"use strict";

// The reset's weekday and hour are shown in the local time zone.
process.env.TZ = "UTC";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const pools = require(path.join(__dirname, "..", "lib", "pools.js"));
const operator = require(path.join(__dirname, "..", "lib", "operator.js"));

const { HOUR_MS: HOUR, DAY_MS: DAY } = pools;
const WEEK = 7 * DAY;
// A week's window that started at START: Monday 2026-10-05 17:00 UTC.
const START = Date.parse("2026-10-05T17:00:00Z");
const RESET = START + WEEK;
const CFG = operator.resolve({}).pacing.pools.openai;
const near = (a, b) => Math.abs(a - b) < 1e-6;
// reading(used, extra windows): a week's window at `used` percent.
const reading = (used, ...more) => ({ source: "praxis", observed_at: START, windows: [{ used_percent: used, window_ms: WEEK, resets_at: RESET }, ...more] });
const at = (used, elapsed, cfg = CFG) => pools.poolPace(reading(used), cfg, START + elapsed);

test("pace: an even use of the target by the reset, with a burst", () => {
  // [case, used percent, elapsed, allowed, hold, next dispatch (elapsed) or null]
  const cases = [
    ["just after the reset, nothing used", 0, 0, 0, false, null],
    ["just after the reset, within the burst", 3, 0, 0, false, null],
    ["just after the reset, past the burst", 3.5, 0, 0, true, (0.5 / 95) * WEEK],
    // tracker#375: 19% used 7.5 hours into the week, where an even pace allows 4.2%.
    ["ahead of the pace", 19, 7.5 * HOUR, (95 * 7.5) / 168, true, (16 / 95) * WEEK],
    ["behind the pace", 20, 3.5 * DAY, 47.5, false, null],
    ["on the pace", 47.5, 3.5 * DAY, 47.5, false, null],
    ["at the pace plus the burst", 50.5, 3.5 * DAY, 47.5, false, null],
    ["a point over it", 51.5, 3.5 * DAY, 47.5, true, (48.5 / 95) * WEEK],
    ["the target used with days left: the reserve holds until the reset", 99, 6 * DAY, (95 * 6) / 7, true, WEEK],
    ["at the reset's eve, the target is allowed", 95, WEEK - 1, 95, false, null],
    // The burst is slack over the pace, not over the target: the reserve stays.
    ["at the reset's eve, the burst doesn't reach into the reserve", 96, WEEK - 1, 95, true, WEEK],
    ["three hours before the reset, within the burst but past the target", 95.5, WEEK - 3 * HOUR, 95 * (1 - 3 / 168), true, WEEK],
    ["three hours before the reset, within the burst and the target", 94.9, WEEK - 3 * HOUR, 95 * (1 - 3 / 168), false, null],
  ];
  for (const [name, used, elapsed, allowed, hold, next] of cases) {
    const p = at(used, elapsed);
    assert.ok(near(p.allowed_percent, allowed), `${name}: allowed ${p.allowed_percent}`);
    assert.ok(near(p.ahead, used - allowed), name);
    assert.deepEqual([p.hold, p.reason], [hold, hold ? "pace" : null], name);
    if (next === null) assert.equal(p.next_dispatch_at, null, name);
    else assert.ok(Math.abs(Date.parse(p.next_dispatch_at) - (START + next)) < 1000, `${name}: next ${p.next_dispatch_at}`);
  }
  const p = at(19, 7.5 * HOUR);
  assert.deepEqual([p.source, p.used_percent, p.window_minutes, p.resets_at, p.target_percent, p.burst], ["praxis", 19, 10080, new Date(RESET).toISOString(), 95, 3]);
  // The operator's reserve and burst are the pool's own.
  assert.equal(at(47.5, 3.5 * DAY, { target: 0.8, burst: 3 }).hold, true);
  assert.equal(at(3, 0, { target: 0.95, burst: 0 }).hold, true);
});

test("pace: no reading, a window that reset, and a shorter window used up", () => {
  const now = START + DAY;
  const none = [null, {}, { windows: [] }, reading(50, null), { ...reading(50), windows: [{ used_percent: 50, window_ms: 0, resets_at: RESET }] },
    { ...reading(50), windows: [{ used_percent: 99, window_ms: WEEK, resets_at: now - 1 }] }, { ...reading(50), windows: [{ used_percent: "x", window_ms: WEEK, resets_at: RESET }] }];
  none.forEach((r, i) => {
    // reading(50, null) still has its week; the others have no live window.
    assert.equal(pools.poolPace(r, CFG, now) === null, i !== 3, `case ${i}`);
  });
  // The longest window is paced; a 5-hour one that is used up holds until it resets.
  const five = (used, resets) => ({ used_percent: used, window_ms: 5 * HOUR, resets_at: resets });
  let p = pools.poolPace(reading(5, five(60, now + HOUR)), CFG, now);
  assert.deepEqual([p.hold, p.window_minutes], [false, 10080]);
  p = pools.poolPace(reading(5, five(100, now + 2 * HOUR)), CFG, now);
  assert.deepEqual([p.hold, p.reason, p.next_dispatch_at], [true, "window", new Date(now + 2 * HOUR).toISOString()]);
  // Both: the later of the two.
  p = pools.poolPace(reading(19, five(100, now + 2 * HOUR)), CFG, now);
  assert.deepEqual([p.hold, p.reason], [true, "pace"]);
  assert.ok(Date.parse(p.next_dispatch_at) > now + 2 * HOUR);
  // The week reset since the reading: the short window alone isn't paced.
  assert.equal(pools.poolPace({ ...reading(99), windows: [{ used_percent: 99, window_ms: WEEK, resets_at: now - 1 }, five(60, now + HOUR)] }, CFG, now), null);
  // Only a long window is paced evenly: five hours alone, half used after one, are no reading.
  assert.equal(pools.poolPace({ source: "statusline", observed_at: now, windows: [five(50, now + 4 * HOUR)] }, CFG, now), null);
  // A reading that doesn't say when it was read is taken as read now.
  assert.equal(pools.poolPace({ ...reading(5), observed_at: NaN }, CFG, now).observed_at, new Date(now).toISOString());
  // A short window that already reset says nothing.
  assert.equal(pools.poolPace(reading(5, five(100, now - 1)), CFG, now).hold, false);
});

test("cost: what the pool spent while runs were busy, per run", () => {
  const sample = (used, runs, counters = {}) => ({ resets_at: RESET, used_percent: used, runs, epoch: 1, ...counters });
  // Nothing observed yet, and spending with no run isn't a run's.
  let s = pools.trackCost(undefined, sample(2, [], { requests: 100, tokens: 0 }));
  assert.equal(pools.costOf(s), null);
  s = pools.trackCost(s, sample(4, ["r1"], { requests: 150, tokens: 0 }));
  assert.equal(pools.costOf(s), null);
  // Two runs took the pool from 4% to 24% in 400 requests. While both are
  // busy that is no run's cost yet; with one over and one busy, it is a run
  // and a half's.
  s = pools.trackCost(s, sample(14, ["r1", "r2"], { requests: 350, tokens: 1e6 }));
  assert.equal(pools.costOf(s), null);
  s = pools.trackCost(s, sample(24, ["r2"], { requests: 550, tokens: 3e6 }));
  assert.deepEqual(pools.costOf(s), { runs: 2, points_per_run: 20 / 1.5, requests_per_run: 400 / 1.5, tokens_per_run: 2e6, points_per_request: 0.05, window: "current" });
  // The broker restarted: its counters start again, the percent goes on.
  s = pools.trackCost(s, { ...sample(26, ["r2"], { requests: 40, tokens: 0 }), epoch: 2 });
  assert.deepEqual([s.points, s.requests, s.runs.length], [22, 440, 2]);
  // The runs are over: what the pool spends with none busy (the operator's
  // own use) is no run's, from the sample after the last one that saw a run.
  s = pools.trackCost(s, { ...sample(28, [], { requests: 60 }), epoch: 2 });
  assert.deepEqual([s.points, s.requests], [24, 460]);
  s = pools.trackCost(s, { ...sample(40, [], { requests: 300 }), epoch: 2 });
  assert.deepEqual([s.points, s.requests, pools.costOf(s).points_per_run], [24, 460, 12]);
  // A sample without a counter (the Claude week's tokens, known only with a
  // fresh reading) says nothing, and neither does the one after it.
  s = pools.trackCost(s, { ...sample(40, ["r2"]), epoch: null });
  s = pools.trackCost(s, { ...sample(41, ["r2"], { requests: 5000, tokens: 9e9 }), epoch: 2 });
  assert.deepEqual([s.points, s.requests, s.tokens], [25, 460, 3e6]);
  // A reading a second off is the same window; a new window starts over,
  // going by the last one's cost until a run of its own has spent.
  s = pools.trackCost(s, { ...sample(41, ["r2"], { requests: 5000 }), epoch: 2, resets_at: RESET + 1500 });
  assert.equal(s.runs.length, 2);
  const next = pools.trackCost(s, { ...sample(1, ["r3"], { requests: 60 }), epoch: 2, resets_at: RESET + WEEK });
  assert.deepEqual([next.runs, next.points], [["r3"], 0]);
  assert.deepEqual(pools.costOf(next), { ...pools.costOf(s), window: "previous" });
  // Its first run's first minutes are not what a run costs: the last
  // window's cost stands until a run of this one is over.
  let begun = pools.trackCost(next, { ...sample(1.4, ["r3"], { requests: 80 }), epoch: 2, resets_at: RESET + WEEK });
  assert.deepEqual([begun.points > 0, pools.costOf(begun)], [true, pools.costOf(next)]);
  begun = pools.trackCost(begun, { ...sample(9, [], { requests: 260 }), epoch: 2, resets_at: RESET + WEEK });
  assert.deepEqual([pools.costOf(begun).window, pools.costOf(begun).points_per_run], ["current", 8]);
  // A state file's record that isn't one is dropped.
  for (const junk of [{}, { runs: "x", resets_at: RESET, last: {} }, { runs: [], resets_at: RESET }, { runs: ["r1"], resets_at: RESET, last: { busy: "x" } }, "x"]) {
    assert.deepEqual(pools.trackCost(junk, sample(5, ["r9"])).runs, ["r9"], JSON.stringify(junk));
  }
  // Without counters (the Claude pool's status line) there are only points.
  let c = pools.trackCost(undefined, { resets_at: RESET, used_percent: 10, runs: ["a"] });
  c = pools.trackCost(c, { resets_at: RESET, used_percent: 16, runs: ["a", "b", "c"] });
  c = pools.trackCost(c, { resets_at: RESET, used_percent: 16, runs: [] });
  assert.deepEqual(pools.costOf(c), { runs: 3, points_per_run: 2, requests_per_run: 0, tokens_per_run: 0, points_per_request: null, window: "current" });
});

test("runs that fit: one while within the pace, and what the points left pay for", () => {
  const cost = (points) => ({ points_per_run: points });
  // 3.5 days in: 47.5% allowed, 50.5% with the burst.
  const cases = [
    ["on hold", 60, cost(10), 0], ["no cost known", 20, null, null], ["30.5 points left at 10 a run", 20, cost(10), 4],
    ["less than a run left: still one", 48, cost(10), 1], ["at the limit", 50.5, cost(10), 1],
  ];
  for (const [name, used, c, want] of cases) assert.equal(pools.runsThatFit(at(used, 3.5 * DAY), c), want, name);
  // A day before the reset 81.4% is allowed, 84.4% with the burst; with a
  // burst of 20 the points left are those under the target, not 101.4%.
  const wide = { target: 0.95, burst: 20 };
  assert.deepEqual([70, 90].map((used) => pools.runsThatFit(at(used, 6 * DAY, wide), cost(5))), [6, 2]);
});

test("a remote run's agent: claude while its pool is behind and openai's ahead", () => {
  const p = (ahead, hold = false) => ({ ahead, hold });
  // [case, claude, openai, agent]
  const cases = [
    ["claude behind, openai held", p(-20), p(15, true), "claude"],
    ["claude behind, openai ahead within its burst", p(-20), p(2), "claude"],
    ["claude behind, openai behind too", p(-20), p(-5), "opencode"],
    ["claude ahead, openai held", p(5), p(15, true), "opencode"],
    ["claude behind but a shorter window used up", p(-20, true), p(15, true), "opencode"],
    ["claude without a reading", null, p(15, true), "opencode"],
    ["openai without a reading", p(-20), null, "opencode"],
  ];
  for (const [name, claude, openai, want] of cases) assert.equal(pools.remoteAgent({ claude, openai }), want, name);
  assert.equal(pools.remoteAgent(undefined), "opencode");
});

test("a pool in a line, and the engines' pools", () => {
  const now = START + 7.5 * HOUR;
  const claude = pools.poolPace({ source: "statusline", observed_at: now - 60e3, windows: [{ used_percent: 90, window_ms: WEEK, resets_at: now + 12 * HOUR }] }, CFG, now);
  const held = at(19, 7.5 * HOUR);
  const cases = [
    [null, "openai no reading (unpaced)"],
    [claude, "openai 90% (resets Tue 12:30)"],
    [{ ...claude, observed_at: new Date(now - 3 * HOUR).toISOString() }, "openai 90% (resets Tue 12:30, read 3h ago)"],
    [held, "openai: 19% used, pace allows 4% (ahead by 15 points; next dispatch in ~21h), read 8h ago"],
    [{ ...held, reason: "window", next_dispatch_at: new Date(now + 40 * 60e3).toISOString(), observed_at: new Date(now).toISOString() }, "openai: a shorter window is used up (next dispatch in ~40m)"],
  ];
  for (const [p, want] of cases) assert.equal(pools.describe("openai", p, now), want);
  assert.equal(pools.line({ claude, openai: null }, now), "claude 90% (resets Tue 12:30) · openai no reading (unpaced)");
  assert.deepEqual([pools.span(30e3), pools.span(47 * HOUR), pools.span(3 * DAY)], ["~1m", "~47h", "~3d"]);
  assert.deepEqual(pools.ENGINE_POOL, { claude: "claude", opencode: "openai" });
  // A run's engine is its agent, as the heartbeat's remote workers say; opencode when unknown.
  const agents = pools.runAgents([{ name: "run-7", location: "remote", engine: "claude" }, { name: "run-8", location: "remote", engine: "fake" },
    { name: "run-9", location: "local", engine: "claude" }, { name: "w", location: "remote", engine: "claude" }, null]);
  assert.deepEqual(agents, { 7: "claude", 8: "fake" });
  assert.deepEqual(pools.runAgents(undefined), {});
  const run = (n) => ({ run: `https://github.com/o/r/actions/runs/${n}`, lead: "c" });
  assert.deepEqual([run(7), run(8), run(9), { run: "x", lead: "c" }, { lead: "c" }, {}].map((it) => pools.engineOf(it, agents)),
    ["claude", "fake", "opencode", "opencode", "claude", "claude"]);
  assert.deepEqual([{ run: "x" }, {}].map((it) => pools.engineOf(it)), ["opencode", "claude"]);
  assert.deepEqual([run(7).run, "x", undefined].map(pools.runId), ["7", null, null]);
  assert.deepEqual([{ labels: ["Urgent"] }, { labels: ["P0"] }, {}].map(pools.isUrgent), [true, false, false]);
});

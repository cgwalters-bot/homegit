// Offline tests of bin/bot-heartbeat's usage snapshot: what statusline
// keeps of Claude Code's status line input, and the token sums over the
// synthetic transcripts in tests/fixtures/bot-heartbeat. Run with
// tests/bot-heartbeat-usage.sh, or node --test on this file.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-heartbeat");
const PROJECTS = path.join(__dirname, "fixtures", "bot-heartbeat", "projects");
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bot-heartbeat-usage-test-"));
const RATE_LIMITS = path.join(CACHE, "bot-heartbeat", "rate-limits.json");
const NOW = "2026-09-28T20:00:00Z";
const NOW_MS = Date.parse(NOW);
const ENV = { ...process.env, XDG_CACHE_HOME: CACHE, BOT_HEARTBEAT_PROJECTS: PROJECTS, BOT_HEARTBEAT_NOW: NOW, BOT_CAPACITY_PRAXIS_USAGE: "" };

// The module reads its environment once, at load.
Object.assign(process.env, ENV);
const hb = require(TOOL);
test.after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

const run = (args, input) => execFileSync(TOOL, args, { env: ENV, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const tokens = (input, output, cache_read, cache_write) => ({ input, output, cache_read, cache_write });
const epoch = (s) => Date.parse(s) / 1000;
const statusline = (fiveHour, sevenDay) => ({
  session_id: "s-1", transcript_path: "/home/u/.claude/projects/p/s-1.jsonl", cwd: "/home/u/secret-project",
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  rate_limits: { five_hour: fiveHour, seven_day: sevenDay },
});
const saveRateLimits = (fiveHour, sevenDay) => run(["statusline"], JSON.stringify(statusline(fiveHour, sevenDay)));

test("rateLimitsOf keeps the two windows' percent and reset, and nothing else", () => {
  const cases = [
    ["both", { five_hour: { used_percentage: 23.46, resets_at: epoch("2026-09-28T21:30:00Z") }, seven_day: { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") } },
      { observed_at: NOW, five_hour: { used_percent: 23.5, resets_at: "2026-09-28T21:30:00Z" }, seven_day: { used_percent: 41, resets_at: "2026-10-03T13:00:00Z" } }],
    ["one", { seven_day: { used_percentage: 0, resets_at: epoch("2026-10-03T13:00:00Z") } }, { observed_at: NOW, seven_day: { used_percent: 0, resets_at: "2026-10-03T13:00:00Z" } }],
    ["malformed windows are dropped", { five_hour: { used_percentage: "23", resets_at: 1 }, seven_day: { used_percentage: 5, resets_at: -1 } }, null],
    ["an absurd percent", { five_hour: { used_percentage: 1e6, resets_at: epoch("2026-09-28T21:30:00Z") } }, null],
    ["no rate limits (an API key session)", undefined, null],
  ];
  for (const [what, rl, want] of cases) assert.deepEqual(hb.rateLimitsOf({ cwd: "/x", rate_limits: rl }, NOW_MS), want, what);
  assert.equal(hb.rateLimitsOf(null, NOW_MS), null);
});

test("statusline saves only the rate limits and prints a short line", () => {
  const out = saveRateLimits({ used_percentage: 23.46, resets_at: epoch("2026-09-28T21:30:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  // 23.46 is kept as 23.5, and printed rounded.
  assert.equal(out, "Opus · 5h 24% · 7d 41%\n");
  const saved = fs.readFileSync(RATE_LIMITS, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ["five_hour", "observed_at", "seven_day"]);
  assert.doesNotMatch(saved, /secret-project|transcript|s-1/);
  // Garbage in: no failure, just the line it can make.
  for (const input of ["not json", "", JSON.stringify({ model: { display_name: "Opus" } })]) {
    assert.match(run(["statusline"], input), /^(Opus)?\n$/);
  }
});

test("usage without a status line reading: the last 5 hours and 7 days", () => {
  fs.rmSync(RATE_LIMITS, { force: true });
  const { usage, workerTokens } = hb.collectUsage(NOW_MS);
  assert.deepEqual(usage, {
    windows: [
      // c1 (logged twice, counted once), w1, w2, r1, x1 and o1; not the synthetic message.
      { kind: "five_hour", since: "2026-09-28T15:00:00Z", requests: 6, tokens: tokens(123, 1652, 3502, 152) },
      // ...and c2, but not c3, which is older.
      { kind: "seven_day", since: "2026-09-21T20:00:00Z", requests: 7, tokens: tokens(124, 1662, 3502, 152) },
    ],
  });
  assert.equal(workerTokens.size, 0);
});

test("usage with a status line reading: its windows, and per-agent tokens", () => {
  saveRateLimits({ used_percentage: 23.46, resets_at: epoch("2026-09-28T21:30:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const agents = new Map([["w", ["aw1", "ar1"]], ["gone", ["nope"]]]);
  const { usage, workerTokens } = hb.collectUsage(NOW_MS, "s-1", agents);
  assert.deepEqual(usage, {
    observed_at: NOW,
    windows: [
      // From 16:30, its reset less 5 hours: o1 (16:00) is left out.
      { kind: "five_hour", since: "2026-09-28T16:30:00Z", used_percent: 23.5, resets_at: "2026-09-28T21:30:00Z", requests: 5, tokens: tokens(23, 652, 3502, 152) },
      // From 09-26 13:00: c2 (12:00) is left out.
      { kind: "seven_day", since: "2026-09-26T13:00:00Z", used_percent: 41, resets_at: "2026-10-03T13:00:00Z", requests: 6, tokens: tokens(123, 1652, 3502, 152) },
    ],
    // The coordinator's session in the 5-hour window: c1 only.
    coordinator_tokens: tokens(10, 100, 1000, 50),
  });
  assert.deepEqual([...workerTokens], [["w", tokens(11, 550, 2500, 100)]]);
  // Another session's agents aren't anyone's here.
  assert.equal(hb.collectUsage(NOW_MS, "other-session", agents).workerTokens.size, 0);
});

test("a window that has reset is not reported, and the cache is reused", () => {
  saveRateLimits({ used_percentage: 99, resets_at: epoch("2026-09-28T19:00:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const first = JSON.parse(run(["usage"]));
  assert.deepEqual(first.windows.map((w) => [w.kind, w.used_percent, w.since]), [["five_hour", undefined, "2026-09-28T15:00:00Z"], ["seven_day", 41, "2026-09-26T13:00:00Z"]]);
  // The second run reads the cached sums: the same answer.
  const cache = path.join(CACHE, "bot-heartbeat", "transcripts.json");
  assert.ok(fs.existsSync(cache));
  assert.deepEqual(JSON.parse(run(["usage"])), first);
  // A corrupt cache is rebuilt, not fatal.
  fs.writeFileSync(cache, "{oops");
  assert.deepEqual(JSON.parse(run(["usage"])), first);
});

test("a reading more than an hour old is not published", () => {
  saveRateLimits({ used_percentage: 10, resets_at: epoch("2026-09-28T21:30:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const later = Date.parse("2026-09-28T21:01:00Z");
  assert.equal(hb.collectUsage(later).usage.observed_at, undefined);
  assert.equal(hb.collectUsage(NOW_MS + 3600 * 1000).usage.observed_at, NOW);
});

test("publish goes on without usage when the transcripts can't be read", () => {
  const input = JSON.stringify({ coordinator: { session: "s-1", loop_state: "sleeping" }, workers: [] });
  const env = { ...ENV, BOT_HEARTBEAT_PROJECTS: path.join(CACHE, "broken") };
  fs.mkdirSync(path.join(env.BOT_HEARTBEAT_PROJECTS, "proj"), { recursive: true });
  fs.chmodSync(path.join(env.BOT_HEARTBEAT_PROJECTS, "proj"), 0o000);
  try {
    const out = execFileSync(TOOL, ["publish", "--dry-run"], { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    assert.match(out, /"schema": "bot-heartbeat\/v1"/);
    assert.doesNotMatch(out, /bot-usage/);
  } finally {
    fs.chmodSync(path.join(env.BOT_HEARTBEAT_PROJECTS, "proj"), 0o755);
  }
});

test("usageSnapshot: what goes to the private repository", () => {
  fs.rmSync(RATE_LIMITS, { force: true });
  const heartbeat = { updated_at: "2026-09-28T19:59:00Z", coordinator: { session: "s-1", loop_state: "sleeping" }, workers: [] };
  const snap = hb.usageSnapshot(heartbeat, new Map([["w", ["aw1"]]]), NOW_MS);
  assert.deepEqual(Object.keys(snap), ["schema", "updated_at", "session", "windows", "coordinator_tokens", "workers"]);
  assert.equal(snap.schema, "bot-usage/v1");
  assert.deepEqual(snap.workers, [{ name: "w", tokens: tokens(10, 500, 2000, 100) }]);
  assert.match(hb.renderUsage(snap), /^<!-- bot-usage v1 -->\nUsage, 5-hour window: /);
});

test("validate keeps agent_ids out of the heartbeat", () => {
  const input = {
    updated_at: "2026-09-28T19:59:00Z",
    coordinator: { session: "s-1", loop_state: "sleeping" },
    workers: [{ name: "w", item_url: "https://github.com/o/r/pull/3", started_at: "2026-09-28T19:40:00Z", status: "testing", agent_ids: ["aw1", "ar1"] }],
  };
  const { hb: out, agentIds } = hb.validate(input, NOW_MS);
  assert.deepEqual(out.workers[0], { name: "w", item_url: "https://github.com/o/r/pull/3", started_at: "2026-09-28T19:40:00Z", status: "testing" });
  assert.deepEqual([...agentIds], [["w", ["aw1", "ar1"]]]);
  for (const bad of [["../x"], "aw1", Array.from({ length: 9 }, (_, i) => `a${i}`)]) {
    assert.throws(() => hb.validate({ ...input, workers: [{ ...input.workers[0], agent_ids: bad }] }, NOW_MS), /agent_ids/);
  }
});

test("publish includes both pool paces only in the private usage comment", () => {
  saveRateLimits(null, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const file = path.join(CACHE, "praxis.json");
  const observed = epoch(NOW) - 7200;
  const reset = epoch("2026-10-04T20:00:00Z");
  const broker = { started_at: "private-epoch", codex: { secondary: {
    used_percent: 31, window_minutes: 10080, reset_after_seconds: reset - observed, observed_at: observed,
  }, counts: { requests: 123, tokens: { total: 456 } } }, private_data: "not-published" };
  const input = JSON.stringify({ coordinator: { session: "s-1", loop_state: "sleeping" }, workers: [] });
  const publish = (data) => {
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    const out = execFileSync(TOOL, ["publish", "--dry-run"], {
      env: { ...ENV, BOT_CAPACITY_PRAXIS_USAGE: file }, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const [publicBody, privateBody] = out.split("<!-- cgwalters-forge/bot-ops#1 -->\n");
    assert.doesNotMatch(publicBody, /pools|openai|used_percent/);
    assert.doesNotMatch(privateBody, /private-epoch|not-published|456/);
    return { snap: hb.parseComment(privateBody), body: privateBody };
  };
  const { snap, body } = publish(broker);
  const { poolPace } = require("../lib/pools.js");
  const config = require("../lib/operator.js").loadOrExit("test");
  assert.equal(snap.pools.claude.used_percent, 41);
  assert.deepEqual(snap.pools.openai, poolPace({ source: "praxis", observed_at: observed * 1000,
    windows: [{ used_percent: 31, window_ms: 10080 * 60000, resets_at: reset * 1000 }] }, config.pacing.pools.openai, NOW_MS));
  assert.equal(snap.pools.openai.observed_at, "2026-09-28T18:00:00.000Z");
  assert.match(body, /openai: 31/);
  for (const data of ["{broken", {}, { codex: { secondary: { ...broker.codex.secondary, reset_after_seconds: -1 } } }]) {
    const result = publish(data).snap;
    assert.equal(result.pools.openai, null);
    assert.equal(result.pools.claude.used_percent, 41);
  }
});

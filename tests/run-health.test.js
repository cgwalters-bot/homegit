"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, suspicion, key, freshTokens } = require("../lib/run-health.js");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const at = (minutes) => new Date(NOW - minutes * 60e3).toISOString();
const run = { repo: "example/devspace", id: 42, run_attempt: 1, status: "in_progress",
  jobs: [{ name: "Agent", status: "in_progress", steps: [{ name: "Run agent", status: "in_progress", started_at: at(30) }] }] };
const observation = { schema: "run-observation/v1", repo: run.repo, run_id: 42, attempt: 1,
  observed_at: at(0), last_activity_at: at(1), window_started_at: at(5),
  tokens: { input: 100, output: 10, cache_write: 5, cache_read: 1000000 }, events: [] };
const item = { "budget tokens": 200 };

test("healthy/stalled/failing/runaway/unknown deterministic fixtures", () => {
  const errors = Array.from({ length: 6 }, (_, i) => ({ at: at(1), kind: i % 2 ? "tool" : "request", error: i < 3 }));
  const fixtures = [
    ["healthy", observation],
    ["stalled", { ...observation, last_activity_at: at(10) }],
    ["failing", { ...observation, events: errors }],
    ["runaway", { ...observation, tokens: { input: 200, output: 1, cache_write: 0 } }],
    ["unknown", null],
    ["unknown", { ...observation, observed_at: at(6) }],
    ["unknown", { ...observation, tokens: { input: 1, output: 0 } }],
    ["unknown", { ...observation, window_started_at: at(4) }],
    ["unknown", { ...observation, repo: 5 }],
    ["unknown", { ...observation, attempt: 2 }],
  ];
  for (const [expected, o] of fixtures) assert.equal(evaluate(run, o, item, NOW).health, expected);
  assert.equal(evaluate(run, observation, item, NOW).tokens, 115);
  assert.equal(evaluate(run, observation, item, NOW).observed_at, observation.observed_at);
  assert.equal(evaluate(run, null, item, NOW).observed_at, null);
  assert.equal(freshTokens({ input: -1, output: 2, cache_write: 0 }), null);
});

test("rolling window, minimum samples and exact half error threshold", () => {
  const event = { at: at(1), kind: "request", error: true };
  for (const n of [0, 1, 4]) assert.equal(evaluate(run, { ...observation, events: Array(n).fill(event) }, item, NOW).health, "healthy");
  assert.equal(evaluate(run, { ...observation, events: Array(5).fill(event) }, item, NOW).health, "failing");
  assert.equal(evaluate(run, { ...observation, events: Array(5).fill({ ...event, at: at(6) }) }, item, NOW).health, "healthy");
});

test("only active execution step counts; malformed/future telemetry is unknown", () => {
  for (const status of ["queued", "completed"]) assert.equal(evaluate({ ...run, status }, observation, item, NOW).health, "unknown");
  for (const jobs of [[], [{ name: "Agent", status: "in_progress", steps: [{ name: "Setup", status: "in_progress" }] }]]) {
    assert.equal(evaluate({ ...run, jobs }, { ...observation, last_activity_at: at(20) }, item, NOW).health, "unknown");
  }
  for (const change of [{ last_activity_at: at(-1) }, { observed_at: at(-1) }, { events: [null] },
    { events: [{ at: at(0), kind: "request", error: false }] }, { events: [{ at: at(1), kind: "unknown", error: true }] }]) {
    assert.equal(evaluate(run, { ...observation, ...change }, item, NOW).health, "unknown");
  }
  assert.equal(evaluate(run, observation, item, NaN).health, "unknown");
  assert.equal(evaluate(run, { ...observation, observed_at: "2026-10-05T12:00:00" }, item, NOW).health, "unknown");
  assert.equal(evaluate(run, observation, { "budget tokens": 1e9 }, NOW).health, "healthy");
  assert.equal(evaluate(run, observation, { "budget tokens": null, aic_budget: 1 }, NOW).health, "healthy");
  assert.equal(evaluate(run, observation, { "budget tokens": { raw: "114" } }, NOW).health, "runaway");
});

test("persistent grace resets on recovery/unknown/new failure; attempts isolated", () => {
  const first = suspicion({ health: "stalled" }, null, NOW);
  assert.equal(first.ready, false);
  assert.equal(suspicion({ health: "stalled" }, first, NOW + 5 * 60e3).ready, true);
  for (const h of ["healthy", "unknown", "failing"]) {
    const recovered = suspicion({ health: h }, first, NOW + 5 * 60e3);
    assert.equal(suspicion({ health: "stalled" }, recovered, NOW + 6 * 60e3).ready, false);
  }
  assert.notEqual(key(run), key({ ...run, run_attempt: 2 }));
});

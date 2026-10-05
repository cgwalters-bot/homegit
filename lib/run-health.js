// Pure health evaluation of sanitized, attempt-scoped broker observations.
// No prompts, response bodies or error messages are consumed or returned.
"use strict";

const DEFAULTS = Object.freeze({ stallMs: 10 * 60e3, windowMs: 5 * 60e3, graceMs: 5 * 60e3, freshnessMs: 5 * 60e3 });
const SUSPECT = new Set(["stalled", "failing", "runaway"]);

function identity(run) {
  return { repo: run.repo, run_id: run.id, attempt: run.run_attempt };
}

function key(run) {
  return `${run.repo.toLowerCase()}/${run.id}/${run.run_attempt}`;
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;
}

function freshTokens(tokens) {
  if (!tokens || ![tokens.input, tokens.output, tokens.cache_write].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  const total = tokens.input + tokens.output + tokens.cache_write;
  return Number.isSafeInteger(total) ? total : null;
}

// Observation v1: identity, observed_at, last_activity_at, tokens
// {input,output,cache_write}, events [{at,kind:"request"|"tool",error:boolean}].
// The producer supplies a complete rolling window and cumulative attempt usage.
// Execution step names are explicitly configured, never inferred from job age.
function evaluate(run, observation, item, now, options = {}) {
  const opts = { ...DEFAULTS, executionStep: "Run agent", ...options };
  const result = { ...identity(run), health: "unknown", observed_at: null, last_activity_at: null,
    activity_age_s: null, tokens: null, reasons: [], actions: [] };
  const unknown = (reason) => ({ ...result, reasons: [reason] });
  if (!Number.isFinite(now)) return unknown("evaluation time is unusable");
  if (run.status !== "in_progress") return unknown("run is not executing");
  const steps = (run.jobs || []).filter((j) => j.name === "Agent" && j.status === "in_progress")
    .flatMap((j) => (j.steps || []).filter((s) => s.status === "in_progress" && s.name === opts.executionStep));
  if (steps.length !== 1) return unknown("execution step is not active or is ambiguous");
  const start = timestamp(steps[0].started_at);
  if (!Number.isFinite(start) || start > now) return unknown("execution step start is unusable");
  if (!observation || observation.schema !== "run-observation/v1" ||
      typeof observation.repo !== "string" || observation.repo.toLowerCase() !== run.repo.toLowerCase() || observation.run_id !== run.id ||
      observation.attempt !== run.run_attempt) return unknown("no matching attempt telemetry");
  const observed = timestamp(observation.observed_at), activity = timestamp(observation.last_activity_at);
  if (!Number.isFinite(observed) || observed > now || now - observed > opts.freshnessMs ||
      !Number.isFinite(activity) || activity > observed || activity < start) return unknown("telemetry is stale or timestamps are unusable");
  result.observed_at = observation.observed_at;
  result.last_activity_at = observation.last_activity_at;
  result.activity_age_s = (now - activity) / 1000;
  result.tokens = freshTokens(observation.tokens);
  const events = observation.events;
  const windowStart = timestamp(observation.window_started_at);
  if (result.tokens === null || !Array.isArray(events) || !Number.isFinite(windowStart) ||
      windowStart > Math.max(start, now - opts.windowMs) || events.some((e) =>
        !e || typeof e !== "object" || !["request", "tool"].includes(e.kind) || typeof e.error !== "boolean" ||
        !Number.isFinite(timestamp(e.at)) || timestamp(e.at) > activity || timestamp(e.at) < start)) {
    return unknown("telemetry counters or rolling window are unusable");
  }
  const relevant = events.filter((e) => timestamp(e.at) >= now - opts.windowMs);
  const errors = relevant.filter((e) => e.error).length;
  const budget = require("./pacing.js").num(item["budget tokens"]);
  if (budget > 0 && result.tokens > budget) result.reasons.push(`fresh tokens ${result.tokens} exceed Budget tokens ${budget}`);
  if (relevant.length >= 5 && errors / relevant.length >= 0.5) result.reasons.push(`${errors}/${relevant.length} relevant errors in rolling 5 minutes`);
  if (now - activity >= opts.stallMs) result.reasons.push(`no execution activity for ${Math.floor(result.activity_age_s)}s`);
  result.health = budget > 0 && result.tokens > budget ? "runaway" :
    relevant.length >= 5 && errors / relevant.length >= 0.5 ? "failing" :
      now - activity >= opts.stallMs ? "stalled" : "healthy";
  return result;
}

// Unknown evidence breaks continuous suspicion, as does recovery or a different
// failure class. Reruns have separate keys and never inherit suspicion/cancel.
function suspicion(result, previous, now, graceMs = DEFAULTS.graceMs) {
  if (!SUSPECT.has(result.health)) return { since: null, health: result.health, ready: false };
  const since = previous?.health === result.health && Number.isFinite(previous.since) && previous.since <= now ? previous.since : now;
  return { since, health: result.health, ready: now - since >= graceMs };
}

module.exports = { DEFAULTS, SUSPECT, identity, key, evaluate, suspicion, freshTokens };

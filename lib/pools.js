// Inference pools: each subscription the agents draw on (Claude's, and
// OpenAI's Codex one through the praxis broker) is paced on its own, as a
// deterministic budget controller that aims to have used the pool's target
// share of its window (pacing.pools.NAME.target, 95% by default; the rest
// is the operator's reserve) by the window's reset. Shared by
// bin/bot-capacity, which reads the usage, and lib/reconcile.js, which
// holds only the work routed to a pool that is ahead of its pace. Pure
// functions of their arguments; Node's standard library only.
"use strict";

const MINUTE_MS = 60e3;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The pool each engine draws on: a local Claude worker (bot-claude, and the
// apply and review steps) the Claude subscription, a devspace run
// (agent.yml runs only opencode) the Codex one.
const ENGINE_POOL = { claude: "claude", opencode: "openai" };
// An item with this label is dispatched whatever its pool's pace: for P0
// work and what the operator raised, on their word.
const URGENT_LABEL = "urgent";
// Two readings whose resets are this close are of the same window (a
// reset computed from "seconds from now" moves by a second or two).
const SAME_WINDOW_MS = HOUR_MS;
// A reading older than this is shown with its age: it is still a lower
// bound of the window's usage, which only grows until the reset.
const STALE_MS = HOUR_MS;
// Only a window at least this long is paced evenly; a shorter one (Claude's
// five hours) is spent in bursts by design, and only holds work once it is
// used up.
const MIN_PACED_WINDOW_MS = DAY_MS;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const isUrgent = (item) => (item.labels || []).some((l) => String(l).toLowerCase() === URGENT_LABEL);

// engineOf(item): the engine a busy item's agent runs on: a devspace run
// (it has a Run) is opencode, anything else a local Claude worker.
const engineOf = (item) => (item.run ? "opencode" : "claude");

// windowPace(w, {target, burst}, now): where a window's usage stands
// against an even pace toward target (0 to 1) of it at the reset:
//   allowed  the percent an even pace allows by now: target * elapsed / window
//   ahead    the points the usage is ahead of it (negative: behind)
//   hold     whether new work waits: the usage is above allowed + burst
//            (the burst, in points, lets work start right after a reset)
//   next     when the pace catches up with the usage (ms), the reset at
//            the latest; null unless hold
// w: {used_percent, window_ms, resets_at (ms)}.
function windowPace(w, { target, burst }, now) {
  const start = w.resets_at - w.window_ms;
  const elapsed = Math.min(Math.max(now - start, 0), w.window_ms);
  const goal = target * 100;
  const allowed = (goal * elapsed) / w.window_ms;
  const ahead = w.used_percent - allowed;
  const hold = ahead > burst;
  const next = hold ? Math.min(start + ((w.used_percent - burst) / goal) * w.window_ms, w.resets_at) : null;
  return { allowed, ahead, hold, next };
}

// poolPace(reading, cfg, now): the pace of a pool, or null without a
// reading of its longest window, the one paced (a day or more: the week's),
// or once that has reset (the pool is then unpaced: only the agent target
// limits it). A shorter window that is used up also holds new work, until
// it resets.
//   reading  {source, observed_at (ms), windows: [{used_percent, window_ms, resets_at (ms)}]}
//   cfg      {target, burst} (pacing.pools.NAME of the operator config)
function poolPace(reading, cfg, now) {
  const windows = ((reading && reading.windows) || []).filter((w) => w && w.window_ms > 0 && Number.isFinite(w.resets_at) && Number.isFinite(w.used_percent));
  if (!windows.length) return null;
  const paced = windows.reduce((a, b) => (b.window_ms > a.window_ms ? b : a));
  if (paced.window_ms < MIN_PACED_WINDOW_MS || !(paced.resets_at > now)) return null;
  const p = windowPace(paced, cfg, now);
  const out = {
    source: reading.source, observed_at: new Date(Number.isFinite(reading.observed_at) ? reading.observed_at : now).toISOString(),
    used_percent: paced.used_percent, window_minutes: paced.window_ms / MINUTE_MS, resets_at: new Date(paced.resets_at).toISOString(),
    target_percent: cfg.target * 100, burst: cfg.burst, allowed_percent: p.allowed, ahead: p.ahead,
    hold: p.hold, reason: p.hold ? "pace" : null, next_dispatch_at: p.next,
  };
  const spent = windows.filter((w) => w !== paced && w.resets_at > now && w.used_percent >= 100);
  if (spent.length) {
    Object.assign(out, { hold: true, reason: out.reason || "window", next_dispatch_at: Math.max(out.next_dispatch_at || 0, ...spent.map((w) => w.resets_at)) });
  }
  out.next_dispatch_at = out.next_dispatch_at === null ? null : new Date(out.next_dispatch_at).toISOString();
  return out;
}

// counterDelta(a, b, k): how much the cumulative counter k grew from sample
// a to b; a counter whose epoch changed (the broker restarted) started
// again from 0. A sample without the counter says nothing.
function counterDelta(a, b, k) {
  if (typeof a[k] !== "number" || typeof b[k] !== "number") return 0;
  if (a.epoch !== b.epoch) return b[k];
  return b[k] > a[k] ? b[k] - a[k] : 0;
}

// isRecord(r): whether r is a cost record trackCost made (the state file
// may hold anything).
const isRecord = (r) => Boolean(r) && Array.isArray(r.runs) && Number.isFinite(r.resets_at) && Boolean(r.last) && typeof r.last === "object";

// trackCost(prev, sample): the next cost record of a pool, kept across
// bot-capacity's runs: what the pool spent in its current window while
// runs on it were busy (between two samples, when the first saw one), and
// the runs seen, so that costOf can say what a run costs. What the pool
// spends with no run busy (the operator's own use, the coordinator's) is
// nobody's. A new window starts a new record, carrying the last one's
// result until this one has its own; a record that isn't one is dropped.
//   sample  {resets_at (ms), used_percent, runs: [ids of the busy runs],
//            epoch, requests, tokens (cumulative counters, if any)}
function trackCost(prev, sample) {
  if (!isRecord(prev)) prev = null;
  const same = Boolean(prev) && Math.abs(prev.resets_at - sample.resets_at) < SAME_WINDOW_MS;
  const s = same ? { ...prev, runs: [...prev.runs] } : { runs: [], points: 0, requests: 0, tokens: 0, previous: prev ? costOf(prev) : null };
  if (same && prev.last.busy > 0) {
    s.points += Math.max(0, sample.used_percent - prev.last.used_percent);
    for (const k of ["requests", "tokens"]) s[k] += counterDelta(prev.last, sample, k);
  }
  for (const r of sample.runs) if (!s.runs.includes(r)) s.runs.push(r);
  s.resets_at = sample.resets_at;
  s.last = { busy: sample.runs.length, used_percent: sample.used_percent, epoch: sample.epoch ?? null, requests: sample.requests ?? null, tokens: sample.tokens ?? null };
  return s;
}

// costOf(record): what a run on the pool costs, as observed: {runs,
// points_per_run, requests_per_run, tokens_per_run, points_per_request
// (null without requests), window ("current", or "previous" while this
// window has seen no run's spending yet)}; null when nothing was observed.
function costOf(record) {
  if (!record) return null;
  const n = record.runs.length;
  if (!n || !(record.points > 0)) return record.previous ? { ...record.previous, window: "previous" } : null;
  return { runs: n, points_per_run: record.points / n, requests_per_run: record.requests / n, tokens_per_run: record.tokens / n,
    points_per_request: record.requests > 0 ? record.points / record.requests : null, window: "current" };
}

// runsThatFit(pace, cost): how many more runs may start now: 0 on hold;
// else one, plus as many as the points left under the pace pay for at the
// observed cost of a run; null (unknown) without a cost.
function runsThatFit(pace, cost) {
  if (pace.hold) return 0;
  if (!cost) return null;
  return 1 + Math.floor((pace.allowed_percent + pace.burst - pace.used_percent) / cost.points_per_run);
}

// span(ms): "~40m", "~21h" or "~3d".
function span(ms) {
  if (ms < HOUR_MS) return `~${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
  return ms < 2 * DAY_MS ? `~${Math.round(ms / HOUR_MS)}h` : `~${Math.round(ms / DAY_MS)}d`;
}

// when(ms): "Mon 19:00", in the local time zone.
function when(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const percent = (n) => `${Math.round(n)}%`;

// holdReason(name, pace, now): why a pool holds new work: "openai: 17%
// used, pace allows 3% (ahead by 14 points; next dispatch in ~20h)".
function holdReason(name, pace, now) {
  const next = `next dispatch in ${span(Math.max(0, Date.parse(pace.next_dispatch_at) - now))}`;
  if (pace.reason === "window") return `${name}: a shorter window is used up (${next})`;
  return `${name}: ${percent(pace.used_percent)} used, pace allows ${percent(pace.allowed_percent)} (ahead by ${Math.round(pace.ahead)} points; ${next})`;
}

// describe(name, pace, now): a pool in a line: its hold (holdReason), else
// "claude 90% (resets Mon 19:00)"; "no reading (unpaced)" for null.
function describe(name, pace, now) {
  if (!pace) return `${name} no reading (unpaced)`;
  const age = now - Date.parse(pace.observed_at);
  const stale = age > STALE_MS ? `, read ${span(age).slice(1)} ago` : "";
  if (pace.hold) return `${holdReason(name, pace, now)}${stale}`;
  return `${name} ${percent(pace.used_percent)} (resets ${when(Date.parse(pace.resets_at))}${stale})`;
}

// line(pools, now): every pool, as the Observed line shows them: "claude
// 90% (resets Mon 19:00) · openai 3% (resets Sun 02:00)".
const line = (pools, now) => Object.entries(pools).map(([name, p]) => describe(name, p, now)).join(" · ");

module.exports = {
  ENGINE_POOL, URGENT_LABEL, SAME_WINDOW_MS, STALE_MS, MIN_PACED_WINDOW_MS, MINUTE_MS, HOUR_MS, DAY_MS,
  isUrgent, engineOf, windowPace, poolPace, trackCost, costOf, runsThatFit, span, when, holdReason, describe, line,
};

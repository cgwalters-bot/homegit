// Cost buckets and capacity math shared by bot-cost, bot-actuals and
// bot-capacity. Node's standard library only.
//
// "Tokens" here are the fresh ones: input, output and cache writes.
// Cache reads (re-reading a conversation's context every turn) are left
// out: they are 90%+ of the raw count, grow with a session's length rather
// than with the work, and cost a tenth of an input token.
"use strict";

const DAY_MS = 86400e3;
const WEEK_MS = 7 * DAY_MS;

// The Est. cost field's options of the Workstream board, smallest first:
// upper bound in fresh tokens (null: none) and the expected size used when
// summing estimates (about the median of the tasks of that bucket).
const BUCKETS = [
  { key: "XS", option: "XS (<200k tok)", max: 200e3, expected: 100e3 },
  { key: "S", option: "S (<1M tok)", max: 1e6, expected: 500e3 },
  { key: "M", option: "M (<5M tok)", max: 5e6, expected: 2.5e6 },
  { key: "L", option: "L (<20M tok)", max: 20e6, expected: 10e6 },
  { key: "XL", option: "XL (>20M tok)", max: null, expected: 30e6 },
];

// Below this much of the week elapsed, a burn rate extrapolated to the
// reset says little (one busy morning projects to 400%).
const MIN_ELAPSED_MS = 12 * 3600e3;
// A statusline reading is calibrated against the week's tokens only with
// at least this many of them.
const MIN_CALIBRATION_TOKENS = 1e6;

// bucketOf(s): the BUCKETS entry that a board option name ("S (<1M tok)")
// or a bare key ("s") names, or null.
function bucketOf(s) {
  if (typeof s !== "string") return null;
  const m = /^\s*(XS|S|M|L|XL)\b/i.exec(s);
  return m ? BUCKETS.find((b) => b.key === m[1].toUpperCase()) : null;
}

// bucketForTokens(n): the smallest bucket that holds n tokens.
function bucketForTokens(n) {
  return BUCKETS.find((b) => b.max === null || n < b.max);
}

// normalizeItem(s): the identity of a board item as a worker's "Item:"
// marker or the board names it: a PVTI_ id, or a GitHub issue or PR URL
// without fragment, query or trailing slash, lowercased; null otherwise.
function normalizeItem(s) {
  if (typeof s !== "string") return null;
  const t = s.trim().replace(/[)>\].,;]+$/, "");
  if (/^PVTI_[A-Za-z0-9_-]+$/.test(t)) return t;
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/.exec(t);
  return m ? `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`.toLowerCase() : null;
}

// itemMarker(prompt): the item a worker's prompt names on an "Item: X"
// line, normalised, else the first PVTI_ id in it, else null.
function itemMarker(prompt) {
  const m = /^[ \t>*-]*Item:[ \t]*(\S+)/im.exec(prompt);
  const marked = m && normalizeItem(m[1]);
  if (marked) return marked;
  const id = /\bPVTI_[A-Za-z0-9_-]+/.exec(prompt);
  return id ? id[0] : null;
}

// boardKeys(item): the keys under which the tokens of a `bot-board list
// --json` item may have been attributed: its id, its issue or PR URL and
// the PR URLs of its Branch field.
function boardKeys(item) {
  const urls = [item.content && item.content.url, ...String(item.branch || "").split(/\s+/)];
  return [item.id, ...urls.map(normalizeItem)].filter(Boolean);
}

// attribute(tasks, items): {item id: tokens} summing the fresh tokens of
// the tasks (bot-cost --json) whose item marker names a board item.
// Tasks with no marker, or one naming no item on the board, are dropped.
function attribute(tasks, items) {
  const byKey = new Map();
  for (const it of items) for (const k of boardKeys(it)) byKey.set(k, it.id);
  const out = {};
  for (const t of tasks) {
    const key = normalizeItem(t.item);
    const id = key && byKey.get(key);
    if (id) out[id] = (out[id] || 0) + (t.fresh_tokens || 0);
  }
  return out;
}

// weekProjection({usedPercent, resetsAt, now}): the burn rate in percent
// per day and the percent projected at the reset, for the 7-day window
// ending at resetsAt (ms). projected is null while less than
// MIN_ELAPSED_MS of the window has passed, and never below the usage so
// far.
function weekProjection({ usedPercent, resetsAt, now }) {
  const start = resetsAt - WEEK_MS;
  const elapsed = Math.min(Math.max(now - start, 0), WEEK_MS);
  const burn = elapsed > 0 ? (usedPercent / elapsed) * DAY_MS : 0;
  const projected = elapsed >= MIN_ELAPSED_MS ? Math.max(usedPercent, burn * 7) : null;
  return { start, elapsed_days: elapsed / DAY_MS, burn_per_day: burn, projected };
}

// percentPerToken({usedPercent, tokens}): how much of the week one fresh
// token takes, calibrated on this week so far; null without enough
// tokens to say.
function percentPerToken({ usedPercent, tokens }) {
  return tokens >= MIN_CALIBRATION_TOKENS && usedPercent > 0 ? usedPercent / tokens : null;
}

// sumEstimates(items): {bucket key: {count, tokens}} of the items'
// "est. cost" values, plus unestimated: how many had none.
function sumEstimates(items) {
  const out = { unestimated: 0 };
  for (const b of BUCKETS) out[b.key] = { count: 0, tokens: 0 };
  for (const it of items) {
    const b = bucketOf(it["est. cost"]);
    if (!b) out.unestimated++;
    else {
      out[b.key].count++;
      out[b.key].tokens += b.expected;
    }
  }
  return out;
}

// The board statuses whose items are work still to be spent on, and the
// priorities capacity planning covers.
const OPEN_STATUSES = ["Todo", "In Progress"];
const PLANNED_PRIORITIES = ["P0", "P1"];

// capacityReport({rate, weekTokens, budget, items, now}): the Claude week's
// usage, burn rate and projection, and the open P0/P1 estimates by bucket
// with whether they fit the headroom the projection leaves. It plans; what
// may be dispatched is decided per pool, by its pace (lib/pools.js).
//   rate        {usedPercent, resetsAt (ms)} from the statusline, or null
//   weekTokens  fresh tokens spent in the week (since the window's start
//               for a rate, else the trailing 7 days)
//   budget      weekly fresh tokens, used when there is no rate; or null
//   items       `bot-board list --json` items
// With neither a rate nor a budget there are only token totals and no
// percent, and headroom is null.
function capacityReport({ rate, weekTokens, budget, items, now }) {
  const r = { source: "tokens", used_tokens: weekTokens, used_percent: null, burn_per_day: null, projected: null,
    resets_at: null, percent_per_token: null, burn_tokens_per_day: null };
  if (rate) {
    const p = weekProjection({ usedPercent: rate.usedPercent, resetsAt: rate.resetsAt, now });
    Object.assign(r, { source: "statusline", used_percent: rate.usedPercent, burn_per_day: p.burn_per_day,
      projected: p.projected, resets_at: new Date(rate.resetsAt).toISOString(), elapsed_days: p.elapsed_days,
      percent_per_token: percentPerToken({ usedPercent: rate.usedPercent, tokens: weekTokens }),
      burn_tokens_per_day: p.elapsed_days > 0 ? weekTokens / p.elapsed_days : null });
  } else if (budget > 0) {
    // A rolling week: its usage already is the steady-state projection.
    const used = (weekTokens / budget) * 100;
    Object.assign(r, { source: "budget", used_percent: used, burn_per_day: used / 7, projected: used,
      percent_per_token: 100 / budget, burn_tokens_per_day: weekTokens / 7 });
  } else {
    r.burn_tokens_per_day = weekTokens / 7;
  }
  const open = items.filter((it) => OPEN_STATUSES.includes(it.status));
  r.estimates = {};
  for (const prio of PLANNED_PRIORITIES) {
    const e = sumEstimates(open.filter((it) => it.priority === prio));
    e.tokens = BUCKETS.reduce((n, b) => n + e[b.key].tokens, 0);
    e.percent = r.percent_per_token ? e.tokens * r.percent_per_token : null;
    r.estimates[prio] = e;
  }
  r.headroom = r.projected === null ? null : 100 - r.projected;
  if (r.headroom !== null) {
    let left = r.headroom;
    for (const prio of PLANNED_PRIORITIES) {
      const e = r.estimates[prio];
      e.fits = e.percent === null ? null : e.percent <= left;
      if (e.percent !== null) left -= e.percent;
    }
  }
  return r;
}

module.exports = {
  capacityReport, OPEN_STATUSES, PLANNED_PRIORITIES,
  BUCKETS, DAY_MS, WEEK_MS, MIN_ELAPSED_MS, MIN_CALIBRATION_TOKENS,
  bucketOf, bucketForTokens, normalizeItem, itemMarker, boardKeys, attribute,
  weekProjection, percentPerToken, sumEstimates,
};

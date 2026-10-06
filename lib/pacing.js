// Pacing: how many work agents are busy and in which lane, which Todo
// items would fill the free slots, and the token budget each task gets.
// Shared by bin/bot-pace, bin/bot-actuals and lib/reconcile.js. Node's
// standard library only.
//
// The coordinator keeps the operator config's pacing.agents work agents
// busy, pacing.harness_agents of them on the harness and the rest on
// upstream work, so that neither lane waits for the other (and P1 and P2
// work goes on while the P0 work waits on a human). An agent is busy on
// an item that is In Progress with a Lead (a worker or topic session
// claimed it) or a Run (a devspace agent run owns it).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const cap = require("./capacity.js");

const ACTIVE_STATUS = "In Progress";
const TODO_STATUS = "Todo";
// The Lead of the coordinator's own workers; any other Lead is a topic
// session's (see the topic-lead skill), whose Todo items aren't ours.
const COORDINATOR_LEAD = "coordinator";
const LANES = ["harness", "upstream"];
// Asks for the operator, which no agent works on.
const ASK_LABELS = ["question", "review", "chore"];
// Statuses that wait on a human: counted, so that a lane whose P0 work is
// all blocked says so.
const HUMAN_STATUSES = ["Needs human", "Draft"];
// Workflows: manual items are never touched; analysis writes no text
// upstream, so a human-text repository doesn't hold it back.
const MANUAL_WORKFLOW = "manual";
const ANALYSIS_WORKFLOW = "analysis";
// upstream-policy verdicts under which the bot's text can't go upstream.
const RESTRICTED_VERDICTS = ["human-text", "human-only", "no-go"];
const CANDIDATES_PER_LANE = 3;
// The board field holding a task's budget, next to Actual tokens.
const BUDGET_FIELD = "Budget tokens";
const ACTUAL_FIELD = "Actual tokens";
const EST_FIELD = "Est. cost";
// A task's budget is its Est. cost bucket's upper bound; XL has none, so
// it gets twice L's.
const XL_BUDGET = 40e6;
// The priority an item without one is budgeted at.
const UNPRIORITIZED = "P2";
// What counts as the operator's recent activity (see readActivity).
const ACTIVITY_WINDOW_MS = 7 * cap.DAY_MS;

const lc = (s) => String(s || "").toLowerCase();
const priorityRank = (p) => (/^P[0-9]$/.test(p || "") ? Number(p[1]) : 10);

// num(v): a board number field's value (REST gives a number), or null.
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "object" ? Number(v.raw) : Number(v);
  return Number.isFinite(n) ? n : null;
}

// tokens(n): "1.2M" or "350k".
function tokens(n) {
  if (n === null || n === undefined) return "?";
  if (n === 0) return "0";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(n / 1e3)}k`;
}

// budgetTokens(bucket): the budget of an Est. cost bucket.
function budgetTokens(bucket) {
  return bucket.max === null ? XL_BUDGET : bucket.max;
}

// budgetFor(item, pacing): {bucket, tokens, source} for an item: its Est.
// cost, else the default bucket of its priority (pacing.budgets).
function budgetFor(item, pacing) {
  let bucket = cap.bucketOf(item[lc(EST_FIELD)]);
  let source = "est";
  if (!bucket) {
    bucket = cap.bucketOf(pacing.budgets[item.priority] || pacing.budgets[UNPRIORITIZED]);
    source = "priority";
  }
  return { bucket: bucket.key, tokens: budgetTokens(bucket), source };
}

// repoOf(url): "owner/name" of a github.com URL, lowercased, or null.
function repoOf(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\//.exec(url || "");
  return m ? lc(`${m[1]}/${m[2]}`) : null;
}

// Context for the item helpers, from the operator config.
function context(config) {
  return {
    own: new Set([lc(config.bot.login), lc(config.forge_org)]),
    forkOwners: new Set([lc(config.bot.login), lc(config.forge_org), lc(config.operator.login)]),
    tracker: lc(config.tracker_repo),
  };
}

// targetRepo(item, ctx): the repository the item's work lands in, from
// its issue or PR and its Branch URLs: the first that isn't the tracker,
// with a fork in the forge org (or the bot's or operator's) read as its
// upstream's (Org's) repository of the same name. null if none says.
function targetRepo(item, ctx) {
  const org = lc(item.org);
  const upstreamOrg = org && org !== "other" && !ctx.own.has(org) ? org : null;
  const urls = [item.content && item.content.url, ...String(item.branch || "").split(/\s+/)];
  for (const repo of urls.map(repoOf)) {
    if (!repo || repo === ctx.tracker) continue;
    const [owner, name] = repo.split("/");
    return upstreamOrg && ctx.forkOwners.has(owner) ? `${upstreamOrg}/${name}` : repo;
  }
  return null;
}

// laneOf(item, ctx): "harness" for work on the bot's own repositories
// (its Org is the bot's or the forge org's; without an Org, by the
// repository's owner), else "upstream".
function laneOf(item, ctx) {
  let org = lc(item.org);
  if (!org) org = (repoOf(item.content && item.content.url) || "").split("/")[0];
  return ctx.own.has(org) ? "harness" : "upstream";
}

const isActive = (item) => item.status === ACTIVE_STATUS && Boolean(item.lead || item.run);

// skipReason(item, ctx, verdicts): why a Todo item is no candidate for a
// new agent, or null.
function skipReason(item, ctx, verdicts) {
  if (item.run) return "a run owns it";
  if (item.lead && item.lead !== COORDINATOR_LEAD) return `led by ${item.lead}`;
  if ((item.labels || []).some((l) => ASK_LABELS.includes(l))) return "an ask for the operator";
  if (item.workflow === MANUAL_WORKFLOW) return "manual";
  const repo = targetRepo(item, ctx);
  const verdict = repo && verdicts[repo];
  if (RESTRICTED_VERDICTS.includes(verdict) && item.workflow !== ANALYSIS_WORKFLOW) return `${repo} is ${verdict}`;
  return null;
}

// activityScore(item, ctx, activity): how much the operator did lately
// where the item's work lands: their events in repositories of the same
// name as its target (an upstream and its forks), else in its Org's.
function activityScore(item, ctx, activity) {
  const repo = targetRepo(item, ctx);
  const name = repo && repo.split("/")[1];
  const org = lc(item.org);
  let n = 0;
  for (const [r, count] of Object.entries(activity)) {
    const [owner, rname] = r.split("/");
    if (name ? rname === name : owner === org) n += count;
  }
  return n;
}

// pickCandidates(todo, lane, ...): up to CANDIDATES_PER_LANE items, by
// priority; within one, upstream work spreads over repositories (one
// with fewer busy or already picked items first), then goes where the
// operator is active, then keeps the board's order.
function pickCandidates(todo, lane, ctx, activity, busy) {
  const load = new Map(busy);
  const pool = todo.map((item, order) => ({
    item, order, key: targetRepo(item, ctx) || lc(item.org) || "?", score: activityScore(item, ctx, activity),
  }));
  const out = [];
  while (out.length < CANDIDATES_PER_LANE && pool.length) {
    const spread = (c) => (lane === "upstream" ? load.get(c.key) || 0 : 0);
    pool.sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority)
      || spread(a) - spread(b) || b.score - a.score || a.order - b.order);
    const c = pool.shift();
    load.set(c.key, (load.get(c.key) || 0) + 1);
    out.push(c);
  }
  return out;
}

// laneTargets(pacing): {harness, upstream} agents, each lane's share of
// pacing.agents.
function laneTargets(pacing) {
  return { harness: pacing.harness_agents, upstream: pacing.agents - pacing.harness_agents };
}

// slotReport({items, config, verdicts, activity, only, eligible}):
// the busy agents per lane against the target (and how many of them are
// remote: devspace runs, with a Run, as against local workers), the
// candidates for the free slots, and the budgets. A lane's free slots are those under both
// its own target and the total's: a lane short of its share while the
// other runs over it gets none (its shortfall is under_share).
//   items       `bot-board list --json` items
//   verdicts    {"owner/repo": verdict} (readVerdicts)
//   activity    {"owner/repo": events} of the operator's (readActivity)
//   only        if given, a predicate: only the Todo items it accepts are
//               candidates
//   eligible    if given, a predicate over the Todo candidates: the ones it
//               accepts are also listed, in the same order, as each
//               lane's `dispatch` (what auto-dispatch picks from)
// remote_target is the pacing's opencode share of the target: how many of
// the busy agents are to be devspace runs (agent.yml runs only opencode),
// and never more than remote_limit, the most devspace runs going at once
// (pacing.opencode_runs).
function slotReport({ items, config, verdicts = {}, activity = {}, only = null, eligible = null }) {
  const ctx = context(config);
  const pacing = config.pacing;
  const targets = laneTargets(pacing);
  const report = { target: targets.harness + targets.upstream, remote_target: 0, remote_limit: pacing.opencode_runs, busy: 0, remote: 0, free: 0, lanes: {}, unowned_in_progress: 0, budget_tokens: 0, spent_tokens: 0, over_budget: [] };
  for (const lane of LANES) report.lanes[lane] = { target: targets[lane], active: [], remote: 0, free: 0, under_share: 0, candidates: [], dispatch: [], p0_waiting: 0 };
  const todo = { harness: [], upstream: [] };
  for (const item of items) {
    const lane = laneOf(item, ctx);
    if (item.status === ACTIVE_STATUS && !isActive(item)) report.unowned_in_progress++;
    if (item.priority === "P0" && HUMAN_STATUSES.includes(item.status)) report.lanes[lane].p0_waiting++;
    if (item.status === TODO_STATUS && !skipReason(item, ctx, verdicts) && (!only || only(item))) todo[lane].push(item);
    if (!isActive(item)) continue;
    const set = num(item[lc(BUDGET_FIELD)]);
    const budget = set === null ? budgetFor(item, pacing).tokens : set;
    const spent = num(item[lc(ACTUAL_FIELD)]);
    const a = { id: item.id, url: (item.content && item.content.url) || null, title: item.title, priority: item.priority || null,
      lead: item.lead || null, run: item.run || null, repo: targetRepo(item, ctx), budget, budget_set: set !== null, spent };
    report.lanes[lane].active.push(a);
    report.busy++;
    if (a.run) {
      report.remote++;
      report.lanes[lane].remote++;
    }
    report.budget_tokens += budget;
    report.spent_tokens += spent || 0;
    if (spent !== null && spent > budget) report.over_budget.push({ ...a, lane });
  }
  report.free = Math.max(0, report.target - report.busy);
  report.remote_target = Math.min(Math.ceil(report.target * (pacing.opencode_share ?? 0)), report.remote_limit);
  for (const lane of LANES) {
    const l = report.lanes[lane];
    const short = Math.max(0, l.target - l.active.length);
    l.free = Math.min(short, report.free);
    l.under_share = short - l.free;
    const busy = new Map();
    for (const a of l.active) busy.set(a.repo || "?", (busy.get(a.repo || "?") || 0) + 1);
    const describe = ({ item, score }) => {
      const b = budgetFor(item, pacing);
      return { id: item.id, url: (item.content && item.content.url) || null, title: item.title, priority: item.priority || null,
        theme: item.theme || null, repo: targetRepo(item, ctx), budget: b.tokens, bucket: b.bucket, estimated: b.source === "est", activity: score };
    };
    l.candidates = pickCandidates(todo[lane], lane, ctx, activity, busy).map(describe);
    if (eligible) l.dispatch = pickCandidates(todo[lane].filter(eligible), lane, ctx, activity, busy).map(describe);
  }
  return report;
}

// readVerdicts(dir): {"owner/repo": verdict} of the upstream-policy
// records under dir (OWNER/REPO.md, whose front matter has "verdict:").
function readVerdicts(dir) {
  const out = {};
  let owners;
  try {
    owners = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw e;
  }
  for (const owner of owners) {
    for (const f of fs.readdirSync(path.join(dir, owner.name)).filter((f) => f.endsWith(".md"))) {
      const m = /^verdict:\s*(\S+)/m.exec(fs.readFileSync(path.join(dir, owner.name, f), "utf8"));
      if (m) out[lc(`${owner.name}/${f.slice(0, -3)}`)] = m[1];
    }
  }
  return out;
}

// readActivity(file, now): {"owner/repo": events} of the operator's in the
// last ACTIVITY_WINDOW_MS, from the repos.json bot-operator-activity
// keeps ({"owner/repo": {EVENT-ID: TIME}}); {} without one.
function readActivity(file, now) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  const from = now - ACTIVITY_WINDOW_MS;
  const out = {};
  for (const [repo, events] of Object.entries(data || {})) {
    const n = Object.values(events || {}).filter((t) => Date.parse(t) >= from).length;
    if (n) out[lc(repo)] = n;
  }
  return out;
}

module.exports = {
  ACTIVE_STATUS, BUDGET_FIELD, ACTUAL_FIELD, EST_FIELD, COORDINATOR_LEAD, LANES, CANDIDATES_PER_LANE, XL_BUDGET, ACTIVITY_WINDOW_MS,
  num, tokens, budgetTokens, budgetFor, repoOf, context, targetRepo, laneOf, isActive, skipReason, activityScore,
  laneTargets, slotReport, readVerdicts, readActivity,
};

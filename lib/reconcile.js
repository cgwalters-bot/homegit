// The coordinator's reconcile rules: like a Kubernetes controller, each
// compares the observed state (the board, the latest bot-sweep run, the
// heartbeat, the week's capacity) with the desired one and says what to
// do about the difference, as actions with stable keys. bin/bot-reconcile
// gathers the state and prints them; bin/bot-poll-loop wakes the
// coordinator on new ones. Every rule is a pure function of the observed
// state. Node's standard library only.
"use strict";

const cap = require("./capacity.js");
const pace = require("./pacing.js");
const disp = require("./dispatch.js");

const MINUTE_MS = 60e3;
// The review app calls a heartbeat stale when it is older than this and
// its next_wake_at (if any) passed more than NEXT_WAKE_GRACE_MS ago.
const HEARTBEAT_MAX_AGE_MS = 15 * MINUTE_MS;
const NEXT_WAKE_GRACE_MS = 5 * MINUTE_MS;
// An action still there after this long fires again, like a controller's
// resync.
const RESYNC_MS = 2 * 3600e3;
// The share of the agent target that bot-capacity's dispatch scope
// leaves: all of it, half of it for P0 work only once the week's
// projection passes its P0-only mark, none once it is used up.
const SCOPE_FACTORS = { all: 1, unknown: 1, p0: 0.5, none: 0 };
// P0 drive blockers that need nothing of the coordinator: they wait on CI
// or on a human (whose review queue, and bot-signoff-due, cover them).
const DRIVE_WAITING = ["ci-pending", "mergeable", "review", "dco"];
// What each other P0 drive blocker needs (see "P0 drive" in the
// coordinator skill).
const DRIVE_HINTS = {
  "needs-regen": "dispatch a worker to rebase, regenerate the generated files on a devspace and push",
  conflict: "dispatch a worker to resolve the conflicts, or handle the refusal it names",
  behind: "handle what else blocks it; the rebase comes once nothing else does",
  "ci-failing": "look at the failing job, and dispatch a worker for a real failure",
};
const HEALTH_HINT = "find out why and fix it or dispatch a worker; if it waits on a human, make sure there is an ask";
// bot-watch's warnings (in the sweep's watch output) when its priority
// health or P0 drive step failed or timed out, leaving that section
// incomplete: by the kind of action the section feeds, with the step's
// name for the Observed line.
const STEP_FAILURES = {
  health: { step: "priority health", re: /^warning: the priority health sweep failed\b/m },
  drive: { step: "P0 drive", re: /^warning: looking for P0 drive steps failed\b/m },
};
const CARRIED_OVER = "carried over: this sweep's step failed";
// A P0 PR that waits on a human with an ask this recent is left alone by
// health; an older ask makes it fire again, as a nudge.
const ASK_MAX_AGE_MS = 7 * 24 * 3600e3;
// A date-only note can be a day ahead of UTC; anything later than that
// is no ask (a future date would otherwise silence health forever).
const ASK_SKEW_MS = 24 * 3600e3;
// A board item's Why or Next saying that a PR waits on its author, e.g.
// "2026-10-02: author draft, CI red; waits on the author".
const AUTHOR_NOTE_RE = /\bwait(?:s|ing)? (?:on|for) (?:the )?author\b/i;
const NOTE_FIELDS = ["why", "next"];
// The health reasons a current ask silences on the bot's own PR: only the
// lack of activity, since anything else there is the bot's to fix. On
// someone else's PR, an ask silences every reason.
const OWN_PR_WAITING_REASONS = ["stale"];
// An umbrella item (an epic In Progress) is busy through its open
// children in these statuses: their workers, or the humans they wait on,
// are its work.
const CHILD_BUSY_STATUSES = [pace.ACTIVE_STATUS, "Draft", "In Review"];
// Actions are listed in this order of kinds, then by key.
const KINDS = ["drive", "health", "escalate", "approval", "patch-ready", "answer-unapplied", "closed-not-done", "stale-lead", "dispatch", "dispatch-failed", "capacity", "budget", "lead-orphan", "heartbeat"];
const DONE_STATUS = "Done";
// The apply loop runs unattended: a local Sonnet apply worker applies,
// reviews and proposes the patch (see "Applying a run's patch" in the
// coordinator skill) once the run hands it back. It opens a draft PR and
// never merges: merging stays with the review step. Enabled once
// cgwalters-forge/tracker#289's fixes landed (apply accepts the bot's
// workflow refs, fork-pr sets the board fields, the worker is registered
// in the heartbeat).
const APPLY_UNATTENDED = true;
// bot-runs reconcile moves an item to Draft when a run hands back a patch,
// and says in its Why which run: "... ready for bot-runs apply RUN_ID ...".
const PATCH_READY_STATUS = "Draft";
const PATCH_READY_RE = /\bready for bot-runs apply (\d+)\b/;
const LEAD_FIELD = "Lead";
// bot-watch's question for a PR closed without merging, which waits on the
// operator: closed-not-done leaves it.
const CLOSED_QUESTION_STATUS = "Needs human";
// The states of an issue or PR that has ended (bot-watch's).
const ENDED_STATES = ["closed", "merged"];
// Questions answered this long ago or less are checked for an answer
// that wasn't applied (see answerUnapplied).
const ANSWER_WINDOW_MS = 3 * 24 * 3600e3;

const iso = (ms) => new Date(ms).toISOString();
const minutes = (ms) => Math.round(ms / MINUTE_MS);
const urlOf = (item) => (item.content && item.content.url) || null;

// --- Parsing the sweep's outputs -------------------------------------------

// sections(text): {HEADER: [lines]} of a bot-watch report: a header is a
// line that doesn't start with a space, its lines the indented ones after
// it, up to a blank line.
function sections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) cur = null;
    else if (!line.startsWith(" ")) {
      cur = line;
      out[cur] = out[cur] || [];
    } else if (cur) out[cur].push(line);
  }
  return out;
}

// approvals(inbox): the fork PRs `bot-pr inbox` lists as approved:
// [{url, label, review, hint}], label being what the brackets say after
// APPROVED (", text by LOGIN"), review the approving review's URL and
// hint the command its "->" line suggests.
function approvals(inbox) {
  const out = [];
  let cur = null;
  for (const line of String(inbox || "").split("\n")) {
    const m = /^(https:\/\/\S+)\s+\[APPROVED([^\]]*)\]/.exec(line);
    if (m) {
      cur = { url: m[1], label: m[2], review: null, hint: null };
      out.push(cur);
    } else if (!line.startsWith(" ")) cur = null;
    else if (cur && !cur.hint) {
      const h = /^\s+-> approved by (\S+): (.*)$/.exec(line);
      if (h) Object.assign(cur, { review: h[1], hint: h[2] });
    }
  }
  return out;
}

// --- Rules -----------------------------------------------------------------
// Each takes the observed state (see bin/bot-reconcile) and returns
// actions: {key, kind, url, do, detail}. key identifies the action across
// runs, so it changes only when what is to be done does.

// capacity: the busy work agents per lane against the target, scaled by
// the week's capacity (an umbrella item isn't one); each lane under it
// gets an action naming its top candidates, while the total is under its
// target too (a lane short of its share while the other runs over is only
// noted in the Observed line). The tasks over their budget get one each
// too.
function capacity(obs) {
  if (!obs.items) return [];
  const scope = (obs.capacity && obs.capacity.dispatch && obs.capacity.dispatch.scope) || "unknown";
  const report = slots(obs);
  const out = [];
  for (const lane of pace.LANES) {
    const l = report.lanes[lane];
    if (!l.free) continue;
    const busy = `${lane} ${l.active.length} of ${l.target} busy${scope === "p0" ? " (P0 only: the week's projection is high)" : ""}`;
    const waiting = l.p0_waiting ? `; ${l.p0_waiting} P0 wait on a human` : "";
    out.push({
      key: `capacity:${lane}`, kind: "capacity", url: l.candidates.length ? l.candidates[0].url : null,
      do: l.candidates.length
        ? `${busy}: dispatch up to ${l.free}, as a devspace run (bot-runs dispatch) while the remote runs are under their opencode share (${report.remote} of ${report.remote_target}), else as a local worker (bot-pace assign), which is also for work that does GitHub I/O or can't run remotely${waiting}`
        : `${busy}, but no Todo candidates: triage the backlog or file ${lane} work${waiting}`,
      detail: l.candidates.map((c) => `${c.priority || "--"} ${c.url || c.id} ${short(c.title)} (${[c.theme, c.repo,
        c.estimated ? `est ${c.bucket}, budget ${pace.tokens(c.budget)}` : `budget ${pace.tokens(c.budget)} by ${c.priority || "default"}`].filter(Boolean).join(", ")})`),
    });
  }
  for (const a of report.over_budget) {
    out.push({
      key: `budget:${a.url || a.id}`, kind: "budget", url: a.url,
      do: `spent ${pace.tokens(a.spent)} of its ${pace.tokens(a.budget)} budget (${a.run ? `run ${a.run}` : `Lead ${a.lead}`}): check the worker, or raise it (bot-pace budget ${a.id} --tokens N --force)`,
      detail: [],
    });
  }
  return out;
}

// slots(obs): pace.slotReport paced by the week's capacity.
function slots(obs) {
  const scope = (obs.capacity && obs.capacity.dispatch && obs.capacity.dispatch.scope) || "unknown";
  const factor = scope in SCOPE_FACTORS ? SCOPE_FACTORS[scope] : 1;
  const umbrellas = new Set(umbrellaItems(obs));
  const ctx = pace.context(obs.config);
  return pace.slotReport({ items: obs.items.filter((it) => !umbrellas.has(it)), config: obs.config, verdicts: obs.verdicts, activity: obs.activity,
    factor, priorities: scope === "p0" ? ["P0"] : null, eligible: (it) => disp.isDispatchable(it) && !dispatchBlock(it, ctx) });
}

// dispatchBlock(item, ctx): why a Todo item with the dispatch label can't
// be dispatched, or null: a failed attempt (its Why says so), an issue the
// bot may not label (the apply step consumes the label), or no target
// repository to run on.
function dispatchBlock(item, ctx) {
  if (disp.failedBefore(item)) return item.why;
  const owner = (pace.repoOf(urlOf(item)) || "").split("/")[0];
  if (!ctx.own.has(owner)) return `its issue is not in a repository of the bot's own (${owner || "unknown"}), where the ${disp.DISPATCH_LABEL} label can be consumed`;
  if (!disp.target(item, pace.targetRepo(item, ctx)).repo) return "it names no target repository: add a `Repo: OWNER/REPO` line to the issue body";
  return null;
}

// dispatch: auto-dispatch of the top dispatchable candidate of each lane
// with a free slot, an issue labeled `dispatch` (the opt-in): bin/bot-reconcile
// --apply builds its brief from the issue and runs bot-runs dispatch. It
// respects the pacing: the lane's free slots (so the targets, the lanes and
// the week's capacity scope), and the opencode share of the mix, since
// agent.yml runs only opencode, so a remote run is the opencode share. A
// labeled item that can't be dispatched is a dispatch-failed action,
// naming why.
function dispatch(obs) {
  if (!obs.items) return [];
  const ctx = pace.context(obs.config);
  const report = slots(obs);
  const byId = new Map(obs.items.map((it) => [it.id, it]));
  const out = [];
  let room = report.remote_target - report.remote;
  let free = report.free;
  for (const lane of pace.LANES) {
    const l = report.lanes[lane];
    const c = l.free > 0 && room > 0 && free > 0 && l.dispatch[0];
    const item = c && byId.get(c.id);
    if (!item) continue;
    const t = disp.target(item, c.repo);
    room--;
    free--;
    out.push({
      key: `dispatch:${c.url}`, kind: "dispatch", url: c.url,
      do: `${lane} ${l.active.length} of ${l.target} busy, remote ${report.remote} of ${report.remote_target}: dispatch '${short(c.title)}' (${c.priority || "--"}, budget ${pace.tokens(c.budget)}) as an opencode run on ${t.repo}@${t.base}`,
      detail: [], dispatch: { id: c.id, url: c.url, title: c.title, repo: t.repo, base: t.base, from_body: t.from_body, lane },
    });
  }
  for (const it of obs.items) {
    if (!disp.isDispatchable(it) || pace.skipReason(it, ctx, obs.verdicts || {})) continue;
    const why = dispatchBlock(it, ctx);
    if (!why) continue;
    out.push({ key: `dispatch-failed:${urlOf(it) || it.id}`, kind: "dispatch-failed", url: urlOf(it),
      do: `labeled ${disp.DISPATCH_LABEL}, but it can't be auto-dispatched: ${why}; fix that, or remove the label (a failed attempt: clear its Why to retry once; a second failure goes to the coordinator)`, detail: [] });
  }
  return out;
}

const TITLE_MAX = 60;
const short = (s) => (s && s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 3)}...` : s || "");

// The coordinator's own busy items: In Progress with a Lead that isn't a
// topic session's, and no Run (a devspace run isn't a local worker), and
// not an umbrella.
function coordinatorItems(obs) {
  const umbrellas = new Set(umbrellaItems(obs));
  return (obs.items || []).filter((it) => isCoordinatorLed(it, obs.topics) && !umbrellas.has(it));
}

// isCoordinatorLed(it, topics): whether the coordinator's workers should
// be on it, umbrella or not.
const isCoordinatorLed = (it, topics) => it.status === pace.ACTIVE_STATUS && Boolean(it.lead) && !topics.includes(it.lead) && !it.run;

// umbrellaItems(obs): the In Progress items that are busy through their
// children rather than a worker of their own (an epic like Composefs
// Stable): with an open sub-issue whose item is In Progress, Draft or In
// Review. obs.children: {item URL (normalized): [{url, state}]}, the
// sub-issues of the coordinator's In Progress issues (see
// bin/bot-reconcile).
function umbrellaItems(obs) {
  if (!obs.items || !obs.children) return [];
  const index = byKey(obs.items);
  const busy = (c) => {
    const it = c.state === "open" && index.get(cap.normalizeItem(c.url));
    return Boolean(it) && CHILD_BUSY_STATUSES.includes(it.status);
  };
  return obs.items.filter((it) => it.status === pace.ACTIVE_STATUS && (obs.children[cap.normalizeItem(urlOf(it))] || []).some(busy));
}

// byKey(items): {issue/PR URL or id: item}, with an item's Branch PRs.
function byKey(items) {
  const m = new Map();
  for (const it of items || []) for (const k of cap.boardKeys(it)) if (!m.has(k)) m.set(k, it);
  return m;
}

const workers = (obs) => (obs.heartbeat && Array.isArray(obs.heartbeat.workers) ? obs.heartbeat.workers : []);

// heartbeat: the published heartbeat must be fresh, and list a worker
// for each item the board says is busy. bot-poll-loop refreshes an
// unchanged one each cycle, and drops the workers whose item is Done
// (bot-heartbeat prune) before this runs, so a stale one means that
// refresh fails, and a drift is a busy item with no worker. A worker
// left on a Done item is lead-orphan's.
function heartbeat(obs) {
  if (!obs.items || obs.heartbeat === undefined) return [];
  const out = [];
  const hb = obs.heartbeat;
  if (hb === null) {
    out.push({ key: "heartbeat:stale", kind: "heartbeat", url: null, do: "no heartbeat to read: publish one (bot-heartbeat publish)", detail: [] });
    return out;
  }
  const age = obs.now - Date.parse(hb.updated_at);
  const wake = hb.coordinator && Date.parse(hb.coordinator.next_wake_at);
  if (!(age <= HEARTBEAT_MAX_AGE_MS) && !(wake && obs.now <= wake + NEXT_WAKE_GRACE_MS)) {
    out.push({ key: "heartbeat:stale", kind: "heartbeat", url: null,
      do: `the heartbeat is ${Number.isNaN(age) ? "undated" : `${minutes(age)} min old`}, so bot-poll-loop's refresh can't keep it fresh (see why at the end of its report): publish it (bot-heartbeat publish) with the loop's state and the running workers`, detail: [] });
  }
  const listed = new Set(workers(obs).map((w) => cap.normalizeItem(w.item_url)).filter(Boolean));
  const missing = coordinatorItems(obs).filter((it) => !cap.boardKeys(it).some((k) => listed.has(k)));
  if (missing.length) {
    out.push({ key: "heartbeat:drift", kind: "heartbeat", url: null,
      do: `the heartbeat and the board differ (${missing.length} busy item(s) with no worker): see lead-orphan, then publish it`, detail: [] });
  }
  return out;
}

// leadOrphan: every busy item of the coordinator's needs a worker in the
// heartbeat, and every worker there a busy item. An In Progress item with
// neither Lead nor Run is nobody's.
function leadOrphan(obs) {
  if (!obs.items || obs.heartbeat === undefined) return [];
  const out = [];
  const listed = new Map();
  for (const w of workers(obs)) {
    const k = cap.normalizeItem(w.item_url);
    if (k) listed.set(k, w);
  }
  const workerOf = (it) => cap.boardKeys(it).map((k) => listed.get(k)).find(Boolean);
  for (const it of coordinatorItems(obs)) {
    if (workerOf(it)) continue;
    out.push({ key: `lead-orphan:${urlOf(it) || it.id}`, kind: "lead-orphan", url: urlOf(it),
      do: `In Progress with Lead ${it.lead}, but the heartbeat lists no worker on it: resume or redispatch its worker, or clear Lead and set it Todo`, detail: [] });
  }
  for (const it of obs.items) {
    if (it.status !== pace.ACTIVE_STATUS || it.lead || it.run) continue;
    const w = workerOf(it);
    out.push({ key: `lead-orphan:${urlOf(it) || it.id}`, kind: "lead-orphan", url: urlOf(it),
      do: w ? `worker ${w.name} is on it but it has no Lead: bot-pace assign ${it.id}`
        : `In Progress with neither Lead nor Run: dispatch a worker (bot-pace assign ${it.id}) or set it back to Todo`, detail: [] });
  }
  const index = byKey(obs.items);
  for (const w of workers(obs)) {
    const it = index.get(cap.normalizeItem(w.item_url));
    if (!it || it.status !== "Done") continue;
    out.push({ key: `lead-orphan:worker:${w.name}`, kind: "lead-orphan", url: w.item_url,
      do: `worker ${w.name}'s item is Done: stop the worker if it still runs, and drop it from the heartbeat`, detail: [] });
  }
  return out;
}

// escalate: the open issues the dispatcher labeled `escalate` for the
// coordinator's judgment (an operator message, a design question, a
// conflict, repeated failures, a budget far over, anything touching
// authority or credentials). The dispatcher leaves them alone; the
// coordinator answers on the issue and closes it, which ends the action
// (closed-not-done sets its item Done).
function escalate(obs) {
  if (!obs.items) return [];
  return obs.items.filter((it) => it.status !== DONE_STATUS && it.content && it.content.type === "Issue"
    && (it.labels || []).some((l) => String(l).toLowerCase() === disp.ESCALATE_LABEL)).map((it) => ({
    key: `escalate:${urlOf(it)}`, kind: "escalate", url: urlOf(it),
    do: `escalated to the coordinator, '${short(it.title)}': read the issue, decide or put the question to the operator, answer on the issue, and close it`, detail: [],
  }));
}

// healthLines(sweep): the P0 lines of the sweep's "Priority health"
// section, as [{reason, url, head, detail}].
function healthLines(sweep) {
  const out = [];
  for (const line of sections(sweep && sweep.watch)["Priority health:"] || []) {
    const m = /^ {2}P0 (\S+) (https:\/\/\S+) ([0-9a-f]+): (.*)$/.exec(line);
    if (m) out.push({ reason: m[1], url: m[2], head: m[3], detail: m[4] });
  }
  return out;
}

// noteDate(text, now): the latest date written in text, in ms (NaN for
// none): YYYY-MM-DD, or MM-DD, the last such day up to now. Dates more
// than ASK_SKEW_MS ahead of now are ignored.
function noteDate(text, now) {
  let latest = NaN;
  for (const m of String(text || "").matchAll(/\b(?:(\d{4})-)?(\d{2})-(\d{2})\b/g)) {
    const [month, day] = [Number(m[2]), Number(m[3])];
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const year = m[1] ? Number(m[1]) : new Date(now).getUTCFullYear();
    let t = Date.UTC(year, month - 1, day);
    if (!m[1] && t > now + ASK_SKEW_MS) t = Date.UTC(year - 1, month - 1, day);
    if (t > now + ASK_SKEW_MS) continue;
    if (Number.isNaN(latest) || t > latest) latest = t;
  }
  return latest;
}

// asks(obs, url, reason): the human asks a P0 PR waits on, as [{what,
// at}] (at in ms, NaN when undated): the operator's review requested on
// it, and, on someone else's PR, a "waits on the author" note in the Why
// or Next of a board item of it (its own, or one whose Branch it is, on
// the Workstream board or the epic's), dated by the latest date in it
// (undated, it is never current). On the bot's own PR they count for its
// staleness only. obs.prs: {URL: {author, requested, requested_at}}, the
// PRs of the sweep's P0 health lines (see bin/bot-reconcile); a PR not
// there has no ask.
function asks(obs, url, reason) {
  const pr = obs.prs && obs.prs[url];
  if (!pr) return [];
  const own = pr.author === obs.config.bot.login;
  if (own && !OWN_PR_WAITING_REASONS.includes(reason)) return [];
  const out = [];
  if (pr.requested) out.push({ what: `${obs.config.operator.login}'s review`, at: Date.parse(pr.requested_at) });
  if (own) return out;
  const key = cap.normalizeItem(url);
  const notes = [...(obs.items || []), ...(obs.epicItems || [])].filter((it) => cap.boardKeys(it).includes(key))
    .flatMap((it) => NOTE_FIELDS.map((f) => it[f]).filter((text) => AUTHOR_NOTE_RE.test(text || "")));
  if (notes.length) {
    const dates = notes.map((text) => noteDate(text, obs.now)).filter((t) => !Number.isNaN(t));
    out.push({ what: `its author (${pr.author})`, at: dates.length ? Math.max(...dates) : NaN });
  }
  return out;
}

// failedSteps(sweep): the kinds of STEP_FAILURES whose step failed in
// that sweep.
const failedSteps = (sweep) => Object.keys(STEP_FAILURES).filter((k) => sweep && STEP_FAILURES[k].re.test(sweep.watch || ""));

// carriedOver(obs, kind): the previous run's actions of that kind
// (obs.previous: their keys, from bot-reconcile's --state), rebuilt from
// their keys, for a sweep whose step for them failed: still open, so
// neither dropped nor new once the step recovers.
function carriedOver(obs, kind) {
  const out = [];
  for (const key of obs.previous || []) {
    const m = kind === "drive" ? /^drive:(\S+) (https:\/\/\S+) ([0-9a-f]+)$/.exec(key)
      : /^health:P0 (\S+) (https:\/\/\S+) ([0-9a-f]+)$/.exec(key);
    if (!m) continue;
    out.push({ key, kind, url: m[2], head: m[3],
      do: `P0 ${m[1]}: ${kind === "drive" ? DRIVE_HINTS[m[1]] || "see the P0 drive section" : HEALTH_HINT}`, detail: [CARRIED_OVER] });
  }
  return out;
}

// drive: what the latest sweep found for P0 work, carried over rather
// than derived again: its P0 drive blockers that need the coordinator,
// its P0 priority health lines (but those that wait on a human with a
// current ask, see asks), and the approved fork PRs that the
// sweep's promotions didn't take (and that don't wait on the operator's
// text). When the sweep's drive or health step failed, the previous
// run's actions of that kind are carried over (see carriedOver).
function drive(obs) {
  if (!obs.sweep) return [];
  const out = [];
  const s = sections(obs.sweep.watch);
  const failed = failedSteps(obs.sweep);
  // A P0 PR the drive covers at that head needs no health action too.
  const driven = new Set();
  // A failed step's section may still hold some lines: those come first.
  const carry = (kind) => {
    if (!failed.includes(kind)) return;
    const have = new Set(out.map((a) => a.key));
    for (const { head, ...a } of carriedOver(obs, kind)) {
      if (have.has(a.key) || (kind === "health" && driven.has(`${a.url} ${head}`))) continue;
      if (kind === "drive") driven.add(`${a.url} ${head}`);
      out.push(a);
    }
  };
  for (const line of s["P0 drive:"] || []) {
    const m = /^ {2}(\S+) (https:\/\/\S+) ([0-9a-f]+): (.*)$/.exec(line);
    if (m) driven.add(`${m[2]} ${m[3]}`);
    if (!m || DRIVE_WAITING.includes(m[1]) || / rebased -> /.test(m[4])) continue;
    out.push({ key: `drive:${m[1]} ${m[2]} ${m[3]}`, kind: "drive", url: m[2],
      do: `P0 ${m[1]}: ${DRIVE_HINTS[m[1]] || "see the P0 drive section"}`, detail: [m[4]] });
  }
  carry("drive");
  for (const h of healthLines(obs.sweep)) {
    if (driven.has(`${h.url} ${h.head}`)) continue;
    const found = asks(obs, h.url, h.reason);
    if (found.some((a) => obs.now - a.at <= ASK_MAX_AGE_MS && a.at - obs.now <= ASK_SKEW_MS)) continue;
    const nudge = found.length && `waits on ${found.map((a) => `${a.what}, ${Number.isNaN(a.at) ? "undated" : `since ${iso(a.at).slice(0, 10)}`}`).join(", and ")}, with no ask under ${ASK_MAX_AGE_MS / 864e5} days old: nudge, and date the ask, or find out why and fix it`;
    out.push({ key: `health:P0 ${h.reason} ${h.url} ${h.head}`, kind: "health", url: h.url, do: `P0 ${h.reason}: ${nudge || HEALTH_HINT}`, detail: [h.detail] });
  }
  carry("health");
  const promoted = new Map();
  for (const line of s["Promotions:"] || []) {
    const m = /^ {2}(Promoted|Not promoted|Promotion refused): (https:\/\/[^\s:]+(?::\d+)?[^\s:]*)/.exec(line);
    if (m) promoted.set(m[2], { done: m[1] === "Promoted", line: line.trim() });
  }
  const needsText = new Set((s["Needs your text:"] || []).map((l) => (/(https:\/\/\S+)/.exec(l) || [])[1]).filter(Boolean));
  for (const a of approvals(obs.sweep.inbox)) {
    const p = promoted.get(a.url);
    if ((p && p.done) || (needsText.has(a.url) && !/text by/.test(a.label))) continue;
    out.push({ key: `approval:${a.url}${a.review ? ` ${a.review}` : ""}`, kind: "approval", url: a.url,
      do: p ? p.line : `approved: ${a.hint || `bot-pr promote ${a.url}`}`, detail: [] });
  }
  return out;
}

// unblocks(body): the URLs listed under a question's "Unblocks:" line
// (as bot-board question writes it), up to the next blank line.
function unblocks(body) {
  const out = [];
  let on = false;
  for (const line of String(body || "").split("\n")) {
    if (/^Unblocks:\s*$/.test(line.trim())) on = true;
    else if (on && !line.trim()) {
      if (out.length) break;
    } else if (on) {
      const m = /(https:\/\/github\.com\/\S+?)[`)>.,;]*$/.exec(line.trim());
      if (m) out.push(m[1]);
      else break;
    }
  }
  return out;
}

// answerUnapplied: a question the operator answered whose Unblocks items
// are still open and untouched since the answer: nothing applied it to
// them (tracker#241's items once stayed open for an hour). Something done
// to an item after the answer (closing it, or a comment saying why it
// stays) counts as applied. obs.questions: [{url, answer: {at, text,
// url}, unblocks: [{url, state, updated_at}]}].
function answerUnapplied(obs) {
  const out = [];
  for (const q of obs.questions || []) {
    if (!q.answer) continue;
    const at = Date.parse(q.answer.at);
    const open = q.unblocks.filter((u) => u.state === "open" && !(Date.parse(u.updated_at) > at));
    if (!open.length) continue;
    out.push({ key: `answer-unapplied:${q.url} ${q.answer.url}`, kind: "answer-unapplied", url: q.url,
      do: `answered '${short(q.answer.text)}' at ${q.answer.at}, but ${open.length} item(s) it unblocks are still open and untouched since: apply the answer to them (or say on each why it stays open), then bot-board resolve`,
      detail: open.map((u) => u.url) });
  }
  return out;
}

// closedNotDone: an item whose own issue or PR is closed or merged is
// Done, whatever its Status says. bot-watch moves an item only on a
// transition it sees, so a PR merged between sweeps (bot-land's) once left
// 20 items Draft or Needs human. Not while one of its Branch PRs is open
// or of unknown state: bot-pr promote closes the fork PR an item may be
// of and puts the upstream PR in Branch, and a redo opens a new PR there.
// A PR closed without merging needs a human (bot-watch's question): one
// whose item is Needs human is that question, and stays; for another, the
// action has no `apply`. The only rule whose actions are carried out
// unattended: those with an `apply`, which bot-reconcile --apply (run by
// bot-watch --apply) makes. obs.contentStates: {URL: open, closed, merged
// or gone}, bot-watch's last-seen state (for bot-watch, this sweep's).
function closedNotDone(obs) {
  if (!obs.items || !obs.contentStates) return [];
  const states = new Map(Object.entries(obs.contentStates).map(([u, st]) => [cap.normalizeItem(u), st]));
  const out = [];
  for (const it of obs.items) {
    const url = urlOf(it);
    const own = cap.normalizeItem(url);
    const state = own && states.get(own);
    if (it.status === DONE_STATUS || !ENDED_STATES.includes(state)) continue;
    const others = cap.boardKeys(it).filter((k) => k !== it.id && k !== own);
    if (others.some((k) => !ENDED_STATES.includes(states.get(k)) && states.get(k) !== "gone")) continue;
    const pr = it.content.type === "PullRequest";
    const unmerged = pr && state === "closed";
    if (unmerged && it.status === CLOSED_QUESTION_STATUS) continue;
    const what = `${pr ? "PR" : "issue"} ${unmerged ? "closed unmerged" : state}`;
    const status = it.status || "untriaged";
    out.push(unmerged
      ? { key: `closed-not-done:${url}`, kind: "closed-not-done", url,
        do: `its ${what}, but it is ${status}: ask the operator whether to drop it (Done) or redo it (${CLOSED_QUESTION_STATUS}), or set it ${DONE_STATUS} if it is clear`, detail: [] }
      : { key: `closed-not-done:${url}`, kind: "closed-not-done", url,
        do: `its ${what}, but it is ${status}: set it ${DONE_STATUS}`, detail: [],
        apply: { id: it.id, set: ["--status", DONE_STATUS, "--news", `${what}; set ${DONE_STATUS}`] } });
  }
  return out;
}

// staleLead: Lead COORDINATOR_LEAD is a worker's claim (bot-pace assign),
// which ends when its item leaves In Progress. bot-board set --status
// clears it in the same write; this catches the ones from before that,
// or from edits made elsewhere. A topic session's Lead is kept in every
// status. Carried out unattended, like closed-not-done.
function staleLead(obs) {
  if (!obs.items) return [];
  return obs.items.filter((it) => it.lead === pace.COORDINATOR_LEAD && it.status !== pace.ACTIVE_STATUS).map((it) => ({
    key: `stale-lead:${urlOf(it) || it.id}`, kind: "stale-lead", url: urlOf(it),
    do: `Lead ${pace.COORDINATOR_LEAD}, but it is ${it.status || "untriaged"}: clear its Lead`, detail: [],
    apply: { id: it.id, set: ["--field", LEAD_FIELD, ""] },
  }));
}

// patchReady: Draft items whose Why says a devspace run's patch is ready
// for bot-runs apply (the run is over and Run cleared). The coordinator
// applies it with a local Sonnet worker, which reviews it and opens or
// updates the PR and rewrites Why, so the action converges; while
// APPLY_UNATTENDED is false (obs.applyUnattended overrides it, for tests),
// it is reported only, for the operator to release.
function patchReady(obs) {
  if (!obs.items) return [];
  const out = [];
  for (const it of obs.items) {
    const m = it.status === PATCH_READY_STATUS && PATCH_READY_RE.exec(it.why || "");
    if (!m) continue;
    const run = m[1];
    out.push({
      key: `patch-ready:${urlOf(it) || it.id}:${run}`, kind: "patch-ready", url: urlOf(it),
      do: (obs.applyUnattended ?? APPLY_UNATTENDED)
        ? `devspace run ${run}'s patch is ready: dispatch a local Sonnet worker (model sonnet) on apply-preamble.md to bot-runs apply it, review it and open or update the PR`
        : `devspace run ${run}'s patch is ready; unattended apply is disabled: on the operator's word, dispatch a local Sonnet apply worker (model sonnet) on apply-preamble.md to bot-runs apply it, review it and open or update the PR`,
      detail: [],
    });
  }
  return out;
}

const RULES = { capacity, dispatch, escalate, heartbeat, "lead-orphan": leadOrphan, drive, "patch-ready": patchReady, "answer-unapplied": answerUnapplied, "closed-not-done": closedNotDone, "stale-lead": staleLead };
// The kinds of actions each rule makes.
const RULE_KINDS = { capacity: ["capacity", "budget"], dispatch: ["dispatch", "dispatch-failed"], drive: ["drive", "health", "approval"] };
const kindsOf = (rule) => RULE_KINDS[rule] || [rule];

// unreadKinds(obs, rules): the kinds of actions whose rule didn't run
// (not in rules), or couldn't for want of an input (undefined in obs; a
// heartbeat that doesn't exist yet is null): their earlier actions are
// neither resolved nor new.
function unreadKinds(obs, rules = Object.keys(RULES)) {
  const out = new Set(Object.keys(RULES).filter((r) => !rules.includes(r)).flatMap(kindsOf));
  const add = (...kinds) => kinds.forEach((k) => out.add(k));
  if (!obs.items) add("capacity", "budget", "dispatch", "dispatch-failed", "escalate", "heartbeat", "lead-orphan", "stale-lead", "patch-ready");
  if (obs.heartbeat === undefined) add("heartbeat", "lead-orphan");
  if (!obs.sweep) add("drive", "health", "approval");
  else add(...failedSteps(obs.sweep));
  if (!obs.questions) add("answer-unapplied");
  if (!obs.items || !obs.contentStates) add("closed-not-done");
  return out;
}

// reconcile(obs, names): the actions of the rules named (default: all),
// de-duplicated by key and in KINDS order.
function reconcile(obs, names = Object.keys(RULES)) {
  const seen = new Map();
  for (const name of names) for (const a of RULES[name](obs)) if (!seen.has(a.key)) seen.set(a.key, a);
  return [...seen.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.key.localeCompare(b.key));
}

// edge(state, actions, now, resyncMs, keep): edge-triggering across
// runs. An action fires when its key is new, or when it last fired
// resyncMs ago or more; a key that is gone is forgotten, so it fires
// again if it comes back, unless its kind (the key up to its first ':')
// is in keep (see unreadKinds). Returns the actions with `fired` ("new",
// "resync" or null) and the next state ({KEY: {first, fired}}).
function edge(state, actions, now, resyncMs = RESYNC_MS, keep = new Set()) {
  const next = {};
  for (const [k, v] of Object.entries(state || {})) if (keep.has(k.split(":")[0])) next[k] = v;
  const out = actions.map((a) => {
    const s = state && state[a.key];
    if (!s) {
      next[a.key] = { first: iso(now), fired: iso(now) };
      return { ...a, fired: "new" };
    }
    if (!(now - Date.parse(s.fired) < resyncMs)) {
      next[a.key] = { ...s, fired: iso(now) };
      return { ...a, fired: "resync" };
    }
    next[a.key] = s;
    return { ...a, fired: null };
  });
  return { actions: out, state: next };
}

// observed(obs): a summary of the state the rules saw.
function observed(obs) {
  const o = { now: iso(obs.now) };
  if (obs.items) {
    const r = slots(obs);
    Object.assign(o, { busy: r.busy, target: r.target, remote: r.remote, remote_target: r.remote_target, local: r.busy - r.remote,
      lanes: Object.fromEntries(pace.LANES.map((l) => [l, { busy: r.lanes[l].active.length, target: r.lanes[l].target, under_share: r.lanes[l].under_share,
        remote: r.lanes[l].remote }])),
      budget_tokens: r.budget_tokens, spent_tokens: r.spent_tokens });
  }
  if (obs.capacity) Object.assign(o, { capacity_scope: obs.capacity.dispatch && obs.capacity.dispatch.scope, projected_percent: obs.capacity.projected });
  if (obs.heartbeat) o.heartbeat_age_min = minutes(obs.now - Date.parse(obs.heartbeat.updated_at));
  if (obs.sweep) {
    Object.assign(o, { sweep_run: obs.sweep.run, sweep_age_min: minutes(obs.now - Date.parse(obs.sweep.ended_at)) });
    const failed = failedSteps(obs.sweep);
    if (failed.length) o.sweep_failed_steps = failed.map((k) => STEP_FAILURES[k].step);
  }
  return o;
}

// render(o, actions, errors): the report as text. A fired action is
// marked with '*'.
function render(o, actions, errors = []) {
  const out = [];
  const parts = [];
  if (o.busy !== undefined) {
    const under = pace.LANES.filter((l) => o.lanes[l].under_share);
    const held = under.length ? `; ${under.join(" and ")} under its share, held: the total is at the target` : "";
    parts.push(`${o.busy} of ${o.target} agents busy (${pace.LANES.map((l) => `${l} ${o.lanes[l].busy} of ${o.lanes[l].target}`).join(", ")}${held}; ${o.remote} remote (opencode share target ${o.remote_target}${o.remote > o.remote_target ? ", over it" : ""}), ${o.local} local); budgets ${pace.tokens(o.budget_tokens)}, spent ${pace.tokens(o.spent_tokens)}`);
  }
  if (o.capacity_scope) parts.push(`capacity ${o.capacity_scope}${typeof o.projected_percent === "number" ? `, ${o.projected_percent.toFixed(0)}% projected` : ""}`);
  if (o.heartbeat_age_min !== undefined) parts.push(`heartbeat ${o.heartbeat_age_min} min old`);
  if (o.sweep_run) parts.push(`sweep ${o.sweep_run}, ${o.sweep_age_min} min old${o.sweep_failed_steps ? ` (its ${o.sweep_failed_steps.join(" and ")} step failed: carried over)` : ""}`);
  out.push(`Observed: ${parts.join("; ") || "nothing"}`);
  for (const e of errors) out.push(`  unread: ${e}`);
  out.push(actions.length ? `Actions (${actions.length}):` : "Actions: none (converged)");
  for (const a of actions) {
    const result = a.applied ? ` (${a.applied})` : "";
    out.push(`${a.fired ? "*" : " "} ${a.kind}${a.url ? ` ${a.url}` : ""}: ${a.do}${result}`);
    for (const d of a.detail || []) out.push(`    ${d}`);
  }
  return `${out.join("\n")}\n`;
}

// topics(skill): the topic names (Leads) of the table in the topic-lead
// skill: rows starting "| `NAME` |".
function topics(skill) {
  return [...String(skill || "").matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
}

module.exports = {
  HEARTBEAT_MAX_AGE_MS, RESYNC_MS, SCOPE_FACTORS, DRIVE_WAITING, KINDS, RULES, ANSWER_WINDOW_MS, ASK_MAX_AGE_MS, CHILD_BUSY_STATUSES,
  APPLY_UNATTENDED, patchReady, sections, approvals, topics, failedSteps, unblocks, healthLines, noteDate, asks, umbrellaItems, isCoordinatorLed, capacity, dispatch, dispatchBlock, escalate, heartbeat, leadOrphan, drive, answerUnapplied, closedNotDone, staleLead, unreadKinds, reconcile, edge, observed, render,
};

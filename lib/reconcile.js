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
const KINDS = ["drive", "health", "approval", "answer-unapplied", "closed-not-done", "capacity", "budget", "lead-orphan", "heartbeat"];
const DONE_STATUS = "Done";
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
        ? `${busy}: dispatch up to ${l.free} (bot-pace assign ITEM, or bot-runs dispatch)${waiting}`
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
  return pace.slotReport({ items: obs.items.filter((it) => !umbrellas.has(it)), config: obs.config, verdicts: obs.verdicts, activity: obs.activity,
    factor, priorities: scope === "p0" ? ["P0"] : null });
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

// heartbeat: the published heartbeat must be fresh, and list the workers
// the board says are busy and no others. bot-poll-loop refreshes an
// unchanged one each cycle, so a stale one means that refresh fails. For a drift, the detail holds
// the heartbeat to publish: the current one without the workers whose
// item is Done (names and links only, as published already).
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
  const index = byKey(obs.items);
  const done = workers(obs).filter((w) => {
    const it = index.get(cap.normalizeItem(w.item_url));
    return it && it.status === "Done";
  });
  const listed = new Set(workers(obs).map((w) => cap.normalizeItem(w.item_url)).filter(Boolean));
  const missing = coordinatorItems(obs).filter((it) => !cap.boardKeys(it).some((k) => listed.has(k)));
  if (done.length || missing.length) {
    const why = [done.length && `${done.length} worker(s) on Done items`, missing.length && `${missing.length} busy item(s) with no worker`].filter(Boolean).join(", ");
    const keep = workers(obs).filter((w) => !done.includes(w)).map((w) => Object.fromEntries(
      ["name", "item_url", "started_at", "devspace", "status"].filter((k) => w[k] !== undefined).map((k) => [k, w[k]])));
    const publish = { updated_at: iso(obs.now), coordinator: hb.coordinator, workers: keep };
    out.push({ key: "heartbeat:drift", kind: "heartbeat", url: null,
      do: `the heartbeat and the board differ (${why}): see lead-orphan, then publish it${done.length ? "; without the finished workers:" : ""}`,
      detail: done.length ? [`bot-heartbeat publish <<<'${JSON.stringify(publish)}'`] : [] });
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

// drive: what the latest sweep found for P0 work, carried over rather
// than derived again: its P0 drive blockers that need the coordinator,
// its P0 priority health lines (but those that wait on a human with a
// current ask, see asks), and the approved fork PRs that the
// sweep's promotions didn't take (and that don't wait on the operator's
// text).
function drive(obs) {
  if (!obs.sweep) return [];
  const out = [];
  const s = sections(obs.sweep.watch);
  // A P0 PR the drive covers at that head needs no health action too.
  const driven = new Set();
  for (const line of s["P0 drive:"] || []) {
    const m = /^ {2}(\S+) (https:\/\/\S+) ([0-9a-f]+): (.*)$/.exec(line);
    if (m) driven.add(`${m[2]} ${m[3]}`);
    if (!m || DRIVE_WAITING.includes(m[1]) || / rebased -> /.test(m[4])) continue;
    out.push({ key: `drive:${m[1]} ${m[2]} ${m[3]}`, kind: "drive", url: m[2],
      do: `P0 ${m[1]}: ${DRIVE_HINTS[m[1]] || "see the P0 drive section"}`, detail: [m[4]] });
  }
  for (const h of healthLines(obs.sweep)) {
    if (driven.has(`${h.url} ${h.head}`)) continue;
    const found = asks(obs, h.url, h.reason);
    if (found.some((a) => obs.now - a.at <= ASK_MAX_AGE_MS && a.at - obs.now <= ASK_SKEW_MS)) continue;
    const nudge = found.length && `waits on ${found.map((a) => `${a.what}, ${Number.isNaN(a.at) ? "undated" : `since ${iso(a.at).slice(0, 10)}`}`).join(", and ")}, with no ask under ${ASK_MAX_AGE_MS / 864e5} days old: nudge, and date the ask, or find out why and fix it`;
    out.push({ key: `health:P0 ${h.reason} ${h.url} ${h.head}`, kind: "health", url: h.url, do: `P0 ${h.reason}: ${nudge || HEALTH_HINT}`, detail: [h.detail] });
  }
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
        apply: { id: it.id, status: DONE_STATUS, news: `${what}; set ${DONE_STATUS}` } });
  }
  return out;
}

const RULES = { capacity, heartbeat, "lead-orphan": leadOrphan, drive, "answer-unapplied": answerUnapplied, "closed-not-done": closedNotDone };
// The kinds of actions each rule makes.
const RULE_KINDS = { capacity: ["capacity", "budget"], drive: ["drive", "health", "approval"] };
const kindsOf = (rule) => RULE_KINDS[rule] || [rule];

// unreadKinds(obs, rules): the kinds of actions whose rule didn't run
// (not in rules), or couldn't for want of an input (undefined in obs; a
// heartbeat that doesn't exist yet is null): their earlier actions are
// neither resolved nor new.
function unreadKinds(obs, rules = Object.keys(RULES)) {
  const out = new Set(Object.keys(RULES).filter((r) => !rules.includes(r)).flatMap(kindsOf));
  const add = (...kinds) => kinds.forEach((k) => out.add(k));
  if (!obs.items) add("capacity", "budget", "heartbeat", "lead-orphan");
  if (obs.heartbeat === undefined) add("heartbeat", "lead-orphan");
  if (!obs.sweep) add("drive", "health", "approval");
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
    Object.assign(o, { busy: r.busy, target: r.target,
      lanes: Object.fromEntries(pace.LANES.map((l) => [l, { busy: r.lanes[l].active.length, target: r.lanes[l].target, under_share: r.lanes[l].under_share }])),
      budget_tokens: r.budget_tokens, spent_tokens: r.spent_tokens });
  }
  if (obs.capacity) Object.assign(o, { capacity_scope: obs.capacity.dispatch && obs.capacity.dispatch.scope, projected_percent: obs.capacity.projected });
  if (obs.heartbeat) o.heartbeat_age_min = minutes(obs.now - Date.parse(obs.heartbeat.updated_at));
  if (obs.sweep) Object.assign(o, { sweep_run: obs.sweep.run, sweep_age_min: minutes(obs.now - Date.parse(obs.sweep.ended_at)) });
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
    parts.push(`${o.busy} of ${o.target} agents busy (${pace.LANES.map((l) => `${l} ${o.lanes[l].busy} of ${o.lanes[l].target}`).join(", ")}${held}); budgets ${pace.tokens(o.budget_tokens)}, spent ${pace.tokens(o.spent_tokens)}`);
  }
  if (o.capacity_scope) parts.push(`capacity ${o.capacity_scope}${typeof o.projected_percent === "number" ? `, ${o.projected_percent.toFixed(0)}% projected` : ""}`);
  if (o.heartbeat_age_min !== undefined) parts.push(`heartbeat ${o.heartbeat_age_min} min old`);
  if (o.sweep_run) parts.push(`sweep ${o.sweep_run}, ${o.sweep_age_min} min old`);
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
  sections, approvals, topics, unblocks, healthLines, noteDate, asks, umbrellaItems, isCoordinatorLed, capacity, heartbeat, leadOrphan, drive, answerUnapplied, closedNotDone, unreadKinds, reconcile, edge, observed, render,
};

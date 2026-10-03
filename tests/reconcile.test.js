// Offline tests of lib/reconcile.js (each rule, and the edge-triggering)
// and bin/bot-reconcile, against the observed world in
// fixtures/reconcile/. Run with tests/reconcile.sh, or node --test
// tests/reconcile.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const rec = require(path.join(__dirname, "..", "lib", "reconcile.js"));
const pace = require(path.join(__dirname, "..", "lib", "pacing.js"));
const operator = require(path.join(__dirname, "..", "lib", "operator.js"));
const TOOL = path.join(__dirname, "..", "bin", "bot-reconcile");
const FIX = path.join(__dirname, "fixtures", "reconcile");
const TOPIC_SKILL = path.join(__dirname, "..", "dotfiles", ".agents", "skills", "topic-lead", "SKILL.md");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const MIN = 60e3;
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const run = path.join(FIX, "sweep", "runs", "20261002-114000-000");

// obs(changes): the fixture world, as bot-reconcile observes it, with
// changes applied.
function obs(changes = {}) {
  return {
    now: NOW, config: operator.resolve({}), items: read("board.json"), heartbeat: read("heartbeat.json"), capacity: read("capacity.json"),
    questions: read("questions.json"), epicItems: read("epic-board.json"), prs: read("prs.json"), children: read("children.json"), contentStates: Object.fromEntries(Object.entries(read("watch.json").items).map(([u, v]) => [u, v.state])),
    verdicts: pace.readVerdicts(path.join(FIX, "upstream-policy")), activity: {}, topics: ["wfc"],
    sweep: { run: "20261002-114000-000", ended_at: "2026-10-02T11:43:00Z",
      watch: fs.readFileSync(path.join(run, "watch.txt"), "utf8"), inbox: fs.readFileSync(path.join(run, "inbox.txt"), "utf8") },
    ...changes,
  };
}
const keys = (actions) => actions.map((a) => a.key);
const setItem = (items, id, fields) => items.map((it) => (it.id === id ? { ...it, ...fields } : it));

const ALL_KEYS = [
  "drive:conflict https://github.com/o/r/pull/1 aaaaaaaaaaaa",
  "health:P0 ci-failing https://github.com/cgwalters-forge/r/pull/7 777777777777",
  "health:P0 stale https://github.com/cgwalters-forge/r/pull/8 888888888888",
  "health:P0 stale https://github.com/o/r/pull/2 bbbbbbbbbbbb",
  "approval:https://github.com/cgwalters-forge/q/pull/5 https://github.com/cgwalters-forge/q/pull/5#pullrequestreview-5",
  "approval:https://github.com/cgwalters-forge/r/pull/3 https://github.com/cgwalters-forge/r/pull/3#pullrequestreview-3",
  "approval:https://github.com/cgwalters-forge/r/pull/4 https://github.com/cgwalters-forge/r/pull/4#pullrequestreview-4",
  "patch-ready:https://github.com/cgwalters-forge/tracker/issues/60:4242",
  "answer-unapplied:https://github.com/cgwalters-forge/tracker/issues/50 https://github.com/cgwalters-forge/tracker/issues/50#issuecomment-1",
  "budget:https://github.com/cgwalters-forge/tracker/issues/1",
  "lead-orphan:https://github.com/cgwalters-forge/tracker/issues/2",
  "lead-orphan:https://github.com/cgwalters-forge/tracker/issues/4",
  "lead-orphan:worker:old",
  "heartbeat:drift",
];

test("the fixture world: every rule, in kind order", () => {
  assert.deepEqual(keys(rec.reconcile(obs())), ALL_KEYS);
});

test("topics come from the topic-lead skill's table", () => {
  assert.deepEqual(rec.topics(fs.readFileSync(TOPIC_SKILL, "utf8")), ["wfc"]);
  assert.deepEqual(rec.topics("| Topic | Epic |\n| --- | --- |\n| `a` | x |\n| `b-c` | y |\nnot | `d` |"), ["a", "b-c"]);
});

test("capacity: lanes against the target, paced by the week's capacity", () => {
  // The fixture world is at the target: 4 of 4 busy, harness 3 of 2, upstream 1 of 2.
  const board = read("board.json");
  // One harness agent less: 3 of 4 busy, one upstream slot free.
  const oneFree = setItem(board, "PVTI_o1", { status: "Draft" });
  // Under the P0-only target (1 and 1): harness 1 of 1 (the topic's), upstream idle.
  const upstreamIdle = setItem(setItem(oneFree, "PVTI_h1", { status: "Draft" }), "PVTI_u1", { status: "Done" });
  const p0 = { capacity: { dispatch: { scope: "p0" } } };
  // [case, changes, capacity action keys, the upstream candidates]
  const cases = [
    ["the total at the target: a lane under its share gets nothing", {}, [], null],
    ["the total over it (the epic busy too)", { children: {} }, [], null],
    ["one upstream slot free", { items: oneFree }, ["capacity:upstream"], ["PVTI_c4", "PVTI_c2", "PVTI_c1"]],
    ["unknown capacity is no limit", { items: oneFree, capacity: undefined }, ["capacity:upstream"], ["PVTI_c4", "PVTI_c2", "PVTI_c1"]],
    ["P0 only: half the target, which the total is over", { ...p0, items: oneFree }, [], null],
    ["P0 only, upstream idle", { ...p0, items: upstreamIdle }, ["capacity:upstream"], ["PVTI_c4"]],
    ["the week is used up", { capacity: { dispatch: { scope: "none" } }, items: upstreamIdle }, [], null],
    ["no candidates", { items: oneFree.filter((it) => !/^PVTI_c/.test(it.id)) }, ["capacity:upstream"], []],
    ["a bigger harness share", { config: operator.resolve({ pacing: { agents: 6, harness_agents: 5 } }) }, ["capacity:harness"], null],
  ];
  for (const [name, changes, want, candidates] of cases) {
    const actions = rec.capacity(obs(changes)).filter((a) => a.kind === "capacity");
    assert.deepEqual(keys(actions), want, name);
    if (candidates) {
      const r = pace.slotReport({ ...obs(changes), factor: rec.SCOPE_FACTORS[(changes.capacity || read("capacity.json")).dispatch.scope],
        priorities: changes.capacity && changes.capacity.dispatch.scope === "p0" ? ["P0"] : null });
      assert.deepEqual(r.lanes.upstream.candidates.map((c) => c.id), candidates, name);
      assert.equal(actions[0].detail.length, candidates.length, name);
    }
  }
  const [free] = rec.capacity(obs({ items: oneFree }));
  assert.match(free.do, /^upstream 1 of 2 busy: dispatch up to 1, as a devspace run \(bot-runs dispatch\) while the remote runs are under their opencode share \(1 of 1\), else as a local worker \(bot-pace assign\), which is also for work that does GitHub I\/O or can't run remotely; 2 P0 wait on a human$/);
  assert.equal(free.detail[0], "P0 https://github.com/cgwalters-forge/tracker/issues/30 image-builder analysis (osbuild/image-builder, budget 5M by P0)");
  const a = rec.capacity(obs({ items: oneFree.filter((it) => !/^PVTI_c/.test(it.id)) }))[0];
  assert.match(a.do, /no Todo candidates: triage the backlog or file upstream work; 2 P0 wait on a human$/);
  // A lane's shortfall with the total at the target is only noted.
  // [case, changes, the Observed line's agents part]
  const noted = [
    ["at the target", {}, "4 of 4 agents busy (harness 3 of 2, upstream 1 of 2; upstream under its share, held: the total is at the target; 1 remote (opencode share target 1), 3 local)"],
    ["under it", { items: oneFree }, "3 of 4 agents busy (harness 2 of 2, upstream 1 of 2; 1 remote (opencode share target 1), 2 local)"],
    ["mostly remote", { items: setItem(setItem(read("board.json"), "PVTI_h1", { lead: undefined, run: "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/6" }), "PVTI_o1", { status: "Draft" }) },
      "3 of 4 agents busy (harness 2 of 2, upstream 1 of 2; 2 remote (opencode share target 1, over it), 1 local)"],
  ];
  for (const [name, changes, want] of noted) {
    assert.ok(rec.render(rec.observed(obs(changes)), []).startsWith(`Observed: ${want}; budgets `), name);
  }
});

test("capacity: a task over its budget, unless the budget was raised", () => {
  assert.deepEqual(keys(rec.capacity(obs()).filter((a) => a.kind === "budget")), ["budget:https://github.com/cgwalters-forge/tracker/issues/1"]);
  const raised = setItem(read("board.json"), "PVTI_h1", { "budget tokens": 2e6 });
  assert.deepEqual(rec.capacity(obs({ items: raised })).filter((a) => a.kind === "budget"), []);
});

test("heartbeat: fresh, and listing the busy workers only", () => {
  const hb = read("heartbeat.json");
  const at = (min, wakeMin) => ({ ...hb, updated_at: new Date(NOW - min * MIN).toISOString(),
    coordinator: { ...hb.coordinator, next_wake_at: wakeMin === null ? undefined : new Date(NOW + wakeMin * MIN).toISOString() } });
  const agreeing = { ...hb, workers: [hb.workers[0], { name: "o1", item_url: "https://github.com/cgwalters-forge/tracker/issues/2", started_at: hb.updated_at, status: "working" }] };
  // [case, heartbeat, heartbeat action keys]
  const cases = [
    ["drift: a busy item without a worker", hb, ["heartbeat:drift"]],
    ["only a worker on a Done item: lead-orphan's, not a drift", { ...agreeing, workers: [...agreeing.workers, hb.workers[1]] }, []],
    ["in agreement", agreeing, []],
    ["old, its next wake long past", { ...at(30, -10), workers: agreeing.workers }, ["heartbeat:stale"]],
    ["old, but its next wake is ahead", { ...at(30, 10), workers: agreeing.workers }, []],
    ["old, its next wake just past", { ...at(30, -4), workers: agreeing.workers }, []],
    ["fresh, no next wake", { ...at(10, null), workers: agreeing.workers }, []],
    ["none published yet", null, ["heartbeat:stale"]],
    ["unread", undefined, []],
  ];
  for (const [name, heartbeat, want] of cases) assert.deepEqual(keys(rec.heartbeat(obs({ heartbeat }))), want, name);
});

test("lead-orphan: every busy item has a worker, every worker a busy item", () => {
  const hb = read("heartbeat.json");
  const onN1 = { ...hb, workers: [...hb.workers, { name: "n1", item_url: "https://github.com/cgwalters-forge/tracker/issues/4" }] };
  // A worker named by a PR in the item's Branch counts for the item.
  const viaBranch = setItem(read("board.json"), "PVTI_o1", { branch: "https://github.com/cgwalters-forge/bootc/pull/77" });
  const branchHb = { ...hb, workers: [...hb.workers, { name: "o1", item_url: "https://github.com/cgwalters-forge/bootc/pull/77" }] };
  const cases = [
    ["the fixture world", {}, ["lead-orphan:https://github.com/cgwalters-forge/tracker/issues/2", "lead-orphan:https://github.com/cgwalters-forge/tracker/issues/4", "lead-orphan:worker:old"]],
    ["a worker on a busy item with no Lead", { heartbeat: onN1 }, ["lead-orphan:https://github.com/cgwalters-forge/tracker/issues/2", "lead-orphan:https://github.com/cgwalters-forge/tracker/issues/4", "lead-orphan:worker:old"]],
    ["a worker on the item's Branch PR", { items: viaBranch, heartbeat: branchHb }, ["lead-orphan:https://github.com/cgwalters-forge/tracker/issues/4", "lead-orphan:worker:old"]],
    ["no heartbeat yet: no worker anywhere", { heartbeat: null }, ["lead-orphan:https://github.com/cgwalters-forge/tracker/issues/1", "lead-orphan:https://github.com/cgwalters-forge/tracker/issues/2", "lead-orphan:https://github.com/cgwalters-forge/tracker/issues/4"]],
    ["unread heartbeat", { heartbeat: undefined }, []],
  ];
  for (const [name, changes, want] of cases) assert.deepEqual(keys(rec.leadOrphan(obs(changes))), want, name);
  const n1 = rec.leadOrphan(obs({ heartbeat: onN1 })).find((a) => a.url.endsWith("/issues/4"));
  assert.equal(n1.do, "worker n1 is on it but it has no Lead: bot-pace assign PVTI_n1");
});

test("umbrellas: an In Progress item busy through its children needs no worker, and isn't an agent", () => {
  const E1 = "https://github.com/cgwalters-forge/tracker/issues/160";
  const child = (status, state = "open") => ({ items: setItem(read("board.json"), "PVTI_h1", { status }),
    children: { [E1]: [{ url: "https://github.com/cgwalters-forge/tracker/issues/1", state }] } });
  // [case, changes, whether tracker#160 is an umbrella]
  const cases = [
    ["a child In Progress", {}, true],
    ["a child Draft", child("Draft"), true],
    ["a child In Review", child("In Review"), true],
    ["a child Needs human", child("Needs human"), false],
    ["a child Todo", child("Todo"), false],
    ["a child closed, its item not Done yet", child("In Progress", "closed"), false],
    ["a child not on the board", { children: { [E1]: [{ url: "https://github.com/o/r/issues/404", state: "open" }] } }, false],
    ["no children", { children: {} }, false],
    ["sub-issues unread", { children: undefined }, false],
  ];
  for (const [name, changes, umbrella] of cases) {
    const o = obs(changes);
    assert.deepEqual(rec.umbrellaItems(o).map((it) => it.id), umbrella ? ["PVTI_e1"] : [], name);
    assert.equal(keys(rec.leadOrphan(o)).includes(`lead-orphan:${E1}`), !umbrella, `${name}: lead-orphan`);
    assert.equal(rec.heartbeat(o).some((a) => a.key === "heartbeat:drift" && /2 busy item/.test(a.do)), !umbrella, `${name}: heartbeat`);
    // The fixture's busy agents: h1, t1, o1, u1, plus the epic unless it is an umbrella (and h1 unless it left In Progress).
    const busy = 4 - (o.items.find((it) => it.id === "PVTI_h1").status === "In Progress" ? 0 : 1) + (umbrella ? 0 : 1);
    assert.equal(rec.observed(o).busy, busy, `${name}: busy agents`);
  }
});

test("health: a P0 PR waiting on a human with a current ask is left alone, an old ask is nudged", () => {
  const OWN = "https://github.com/cgwalters-forge/r/pull/7";
  const OTHERS = "https://github.com/o/r/pull/9";
  const pr = (url, fields) => ({ prs: { ...read("prs.json"), [url]: { ...read("prs.json")[url], ...fields } } });
  const note = (text, field = "next") => ({ epicItems: [{ ...read("epic-board.json")[0], next: undefined, [field]: text }] });
  const healthOf = (o, url) => rec.drive(o).filter((a) => a.kind === "health" && a.url === url).map((a) => `${a.key.split(" ")[1]} ${/nudge/.test(a.do) ? "nudge" : "fires"}`);
  // [case, changes, PR, its health actions]
  const cases = [
    ["the bot's PR, review requested yesterday: stale is silent, red CI is the bot's", {}, OWN, ["ci-failing fires"]],
    ["review requested 8 days ago", pr(OWN, { requested_at: "2026-09-24T11:00:00Z" }), OWN, ["ci-failing fires", "stale nudge"]],
    ["review requested, undated", pr(OWN, { requested_at: null }), OWN, ["ci-failing fires", "stale nudge"]],
    ["no review requested", pr(OWN, { requested: false }), OWN, ["ci-failing fires", "stale fires"]],
    ["the PR unread", { prs: undefined }, OWN, ["ci-failing fires", "stale fires"]],
    ["an author note on the bot's own PR counts for nothing", { ...pr(OWN, { requested: false }), epicItems: [{ ...read("epic-board.json")[0], content: { type: "PullRequest", url: OWN } }] },
      OWN, ["ci-failing fires", "stale fires"]],
    ["someone else's PR, a waiting-on-author note from yesterday", {}, OTHERS, []],
    ["the note 9 days old", note("2026-09-23: waiting on the author"), OTHERS, ["ci-failing nudge", "stale nudge"]],
    ["the note dated by month and day, in Why", note("waits on the author since 09-30", "why"), OTHERS, []],
    ["the note dated far in the future", note("2099-01-01: waits on the author"), OTHERS, ["ci-failing nudge", "stale nudge"]],
    ["the note dated 10-30, still ahead", note("waits on the author until 10-30"), OTHERS, ["ci-failing nudge", "stale nudge"]],
    ["the review requested in the future", pr(OWN, { requested_at: "2099-01-01T00:00:00Z" }), OWN, ["ci-failing fires", "stale nudge"]],
    ["the note undated", note("waits on the author"), OTHERS, ["ci-failing nudge", "stale nudge"]],
    ["a dated Next that isn't a waiting note", note("2026-10-01: rebased"), OTHERS, ["ci-failing fires", "stale fires"]],
    ["the note on the Workstream item whose Branch it is", { epicItems: [], items: [...read("board.json"),
      { id: "PVTI_b9", status: "Draft", branch: OTHERS, why: "waits for the author (10-01)", content: { type: "Issue", url: "https://github.com/t/t/issues/9" } }] }, OTHERS, []],
    ["no note, but the operator's review requested yesterday", { ...note(undefined), ...pr(OTHERS, { requested: true, requested_at: "2026-10-01T09:00:00Z" }) }, OTHERS, []],
    ["no ask at all", note(undefined), OTHERS, ["ci-failing fires", "stale fires"]],
  ];
  for (const [name, changes, url, want] of cases) assert.deepEqual(healthOf(obs(changes), url), want, name);
  const nudge = rec.drive(obs(pr(OWN, { requested_at: "2026-09-24T11:00:00Z" }))).find((a) => a.key.startsWith("health:P0 stale https://github.com/cgwalters-forge/r/pull/7"));
  assert.equal(nudge.do, "P0 stale: waits on cgwalters's review, since 2026-09-24, with no ask under 7 days old: nudge, and date the ask, or find out why and fix it");
});

test("noteDate: the latest date in a note", () => {
  // [text, the date (null: none)]
  const cases = [
    ["2026-10-02: author draft, idle since 09-21", "2026-10-02"],
    ["requested 10-01, again 09-30", "2026-10-01"],
    // A month and day still ahead this year are last year's.
    ["since 12-24", "2025-12-24"],
    ["F44, x86-64, #2248", null],
    ["", null],
  ];
  for (const [text, want] of cases) {
    const t = rec.noteDate(text, NOW);
    assert.equal(Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10), want, text);
  }
});

test("drive: the sweep's P0 drive and health lines and approvals, carried over", () => {
  const actions = rec.drive(obs());
  assert.deepEqual(keys(actions).sort(), ALL_KEYS.filter((k) => /^(drive|health|approval):/.test(k)).sort());
  const byKey = Object.fromEntries(actions.map((a) => [a.key, a]));
  assert.match(byKey["drive:conflict https://github.com/o/r/pull/1 aaaaaaaaaaaa"].do, /^P0 conflict: dispatch a worker/);
  assert.equal(actions.find((a) => a.url.endsWith("r/pull/3")).do,
    "Not promoted: https://github.com/cgwalters-forge/r/pull/3: o/r's contribution policy record is stale; dispatch a policy check");
  assert.equal(actions.find((a) => a.url.endsWith("q/pull/5")).do, "approved: bot-pr promote --human-text https://github.com/cgwalters-forge/q/pull/5");
  assert.deepEqual(rec.drive(obs({ sweep: undefined })), []);
});

test("parsing the sweep: sections and approvals", () => {
  const s = rec.sections("A:\n  a1\n  a2\n\nB:\n  b1\nC:\n\n  stray\n");
  assert.deepEqual(s, { "A:": ["  a1", "  a2"], "B:": ["  b1"], "C:": [] });
  assert.deepEqual(rec.approvals(fs.readFileSync(path.join(run, "inbox.txt"), "utf8")).map((a) => [a.url.slice(-6), a.label, a.review && a.review.slice(-1)]),
    [["pull/1", "", "1"], ["pull/2", "", "2"], ["pull/3", "", "3"], ["pull/4", "", "4"], ["pull/5", ", text by cgwalters", "5"]]);
});

test("answer-unapplied: an answer whose Unblocks items nothing touched since (tracker#241)", () => {
  const q = (unblocks, answer = { at: "2026-10-02T10:46:50Z", url: "https://x/q#c1", text: "A" }) => ({ questions: [{ url: "https://x/q", answer, unblocks }] });
  const u = (state, updated) => ({ url: `https://x/${state}-${updated}`, state, updated_at: `2026-10-02T${updated}:00Z` });
  // [case, observed, open items listed]
  const cases = [
    ["open, untouched since the answer", q([u("open", "09:00"), u("open", "10:00")]), ["https://x/open-09:00", "https://x/open-10:00"]],
    ["open but acted on after it", q([u("open", "11:00")]), null],
    ["closed", q([u("closed", "09:00")]), null],
    ["no answer yet", q([u("open", "09:00")], null), null],
    ["nothing it unblocks", q([]), null],
    ["unread", { questions: undefined }, null],
  ];
  for (const [name, changes, want] of cases) {
    const actions = rec.answerUnapplied(obs(changes));
    assert.deepEqual(actions.map((a) => a.detail), want ? [want] : [], name);
  }
  const body = "Blocks: `https://github.com/o/r/pull/45`\n\nQ: adopt it?\n\nUnblocks:\n- https://github.com/o/r/pull/45\n- https://github.com/t/t/issues/149.\n\nGenerated-by: https://github.com/cgwalters/#llms\n";
  assert.deepEqual(rec.unblocks(body), ["https://github.com/o/r/pull/45", "https://github.com/t/t/issues/149"]);
  assert.deepEqual(rec.unblocks("Q: nothing\n"), []);
});

test("closed-not-done: an item whose own issue or PR closed or merged is Done", () => {
  const it = (status, type, n, branch) => ({ id: `PVTI_${n}`, status, branch,
    content: { type, url: `https://github.com/o/r/${type === "Issue" ? "issues" : "pull"}/${n}` } });
  const fork = "https://github.com/o/r/pull/100";
  const ASK = "ask the operator whether to drop it (Done) or redo it (Needs human), or set it Done if it is clear";
  // [item, its state, the Branch PR's state, the action's do (null: none), whether it has an apply]
  const cases = [
    [it("Draft", "PullRequest", 1), "merged", undefined, "its PR merged, but it is Draft: set it Done", true],
    [it("Needs human", "PullRequest", 2), "merged", undefined, "its PR merged, but it is Needs human: set it Done", true],
    // A PR closed unmerged needs a human: listed, never carried out.
    [it("In Review", "PullRequest", 3), "closed", undefined, `its PR closed unmerged, but it is In Review: ${ASK}`, false],
    // bot-watch's "closed without merging" question waits on the operator.
    [it("Needs human", "PullRequest", 4), "closed", undefined, null],
    [it("Needs human", "Issue", 5), "closed", undefined, "its issue closed, but it is Needs human: set it Done", true],
    [it(undefined, "Issue", 6), "closed", undefined, "its issue closed, but it is untriaged: set it Done", true],
    [it("Done", "Issue", 7), "closed", undefined, null],
    [it("Draft", "Issue", 8), "open", undefined, null],
    [it("Draft", "Issue", 9), "gone", undefined, null],
    [it("Draft", "Issue", 10), undefined, undefined, null],
    // The fork PR bot-pr promote closed, its upstream PR in Branch: open, or unknown (a failed read).
    [it("In Review", "PullRequest", 11, fork), "closed", "open", null],
    [it("In Review", "PullRequest", 12, fork), "merged", "open", null],
    [it("Draft", "Issue", 13, `${fork} https://github.com/o/r/pull/101`), "closed", "merged", null],
    [it("In Review", "Issue", 14, fork), "closed", "merged", "its issue closed, but it is In Review: set it Done", true],
    [it("In Review", "Issue", 15, "https://github.com/O/R/pull/100"), "closed", "closed",
      "its issue closed, but it is In Review: set it Done", true],
    [it("In Review", "Issue", 16, fork), "closed", "gone", "its issue closed, but it is In Review: set it Done", true],
  ];
  for (const [item, state, forkState, want, applies] of cases) {
    const actions = rec.closedNotDone({ items: [item], contentStates: { [item.content.url]: state, [fork]: forkState } });
    assert.deepEqual(actions.map((a) => a.do), want ? [want] : [], `${item.id} ${item.status} ${state}`);
    if (!want) continue;
    assert.deepEqual(actions[0].apply, applies ? { id: item.id, set: ["--status", "Done", "--news", `${want.split(", but")[0].replace(/^its /, "")}; set Done`] } : undefined,
      `${item.id}: apply`);
  }
  assert.deepEqual(rec.closedNotDone(obs()), [], "the fixture world: the Done item and the Needs human PR stay");
  assert.deepEqual(rec.closedNotDone(obs({ contentStates: undefined })), []);
});

test("edge: new and resynced actions fire, others wait; gone keys are forgotten unless unread", () => {
  const a = (key) => ({ key, kind: key.split(":")[0] });
  const t0 = NOW;
  let r = rec.edge({}, [a("capacity:x"), a("drive:y")], t0);
  assert.deepEqual(r.actions.map((x) => x.fired), ["new", "new"]);
  r = rec.edge(r.state, [a("capacity:x"), a("drive:y")], t0 + 60 * MIN);
  assert.deepEqual(r.actions.map((x) => x.fired), [null, null]);
  // drive:y is gone, so forgotten; capacity:x is due again.
  r = rec.edge(r.state, [a("capacity:x")], t0 + rec.RESYNC_MS);
  assert.deepEqual(r.actions.map((x) => x.fired), ["resync"]);
  assert.deepEqual(Object.keys(r.state), ["capacity:x"]);
  assert.equal(r.state["capacity:x"].first, new Date(t0).toISOString());
  r = rec.edge(r.state, [a("drive:y")], t0 + rec.RESYNC_MS + MIN);
  assert.deepEqual(r.actions.map((x) => x.fired), ["new"]);
  // An unread input keeps its kind's keys as they were.
  r = rec.edge(r.state, [], t0 + rec.RESYNC_MS + 2 * MIN, rec.RESYNC_MS, new Set(["drive"]));
  assert.deepEqual(Object.keys(r.state), ["drive:y"]);
  assert.deepEqual([...rec.unreadKinds({ items: [], heartbeat: null, sweep: {}, questions: [], contentStates: {} })], []);
  assert.deepEqual([...rec.unreadKinds({ items: [], heartbeat: undefined, sweep: undefined, questions: [] })].sort(),
    ["approval", "closed-not-done", "drive", "health", "heartbeat", "lead-orphan"]);
  // The rules that didn't run keep theirs too.
  assert.deepEqual([...rec.unreadKinds({ items: [], heartbeat: null, sweep: {}, questions: [], contentStates: {} }, ["capacity", "drive"])].sort(),
    ["answer-unapplied", "closed-not-done", "dispatch", "dispatch-failed", "escalate", "heartbeat", "lead-orphan", "patch-ready", "stale-lead"]);
});

test("patch-ready: unattended by default, with explicit false/true overrides", () => {
  assert.equal(rec.APPLY_UNATTENDED, true);
  const cases = [
    ["default", {}, true],
    ["explicitly disabled", { applyUnattended: false }, false],
    ["explicitly enabled", { applyUnattended: true }, true],
  ];
  for (const [name, changes, unattended] of cases) {
    const actions = rec.patchReady(obs(changes));
    assert.equal(actions.length, 1, name);
    const [a] = actions;
    assert.equal(a.url, "https://github.com/cgwalters-forge/tracker/issues/60", name);
    assert.equal(a.key, "patch-ready:https://github.com/cgwalters-forge/tracker/issues/60:4242", name);
    assert.match(a.do, /dispatch a local Sonnet .*\(model sonnet\) on apply-preamble\.md to bot-runs apply it, review it and open or update the PR$/, name);
    if (unattended) assert.match(a.do, /^devspace run 4242's patch is ready: dispatch/, name);
    else assert.match(a.do, /^devspace run 4242's patch is ready; unattended apply is disabled: on the operator's word, dispatch/, name);
    assert.doesNotMatch(a.do, /until .*merges|homegit#82/, name);
    assert.equal(a.apply, undefined, `${name}: dispatch guidance, not a board write`);
  }
  // Applied and proposed: Why no longer says ready, or the item left Draft.
  const board = read("board.json");
  assert.deepEqual(rec.patchReady(obs({ items: setItem(board, "PVTI_p1", { why: "Draft PR https://github.com/cgwalters-forge/r/pull/9" }) })), []);
  assert.deepEqual(rec.patchReady(obs({ items: setItem(board, "PVTI_p1", { status: "Todo" }) })), []);
  assert.deepEqual(rec.patchReady(obs({ items: undefined })), []);
});

test("stale-lead: Lead coordinator ends with In Progress; other Leads stay", () => {
  // [status, lead, the action's do (null: none)]
  const cases = [
    ["Draft", "coordinator", "Lead coordinator, but it is Draft: clear its Lead"],
    ["In Review", "coordinator", "Lead coordinator, but it is In Review: clear its Lead"],
    ["Needs human", "coordinator", "Lead coordinator, but it is Needs human: clear its Lead"],
    ["Todo", "coordinator", "Lead coordinator, but it is Todo: clear its Lead"],
    ["Done", "coordinator", "Lead coordinator, but it is Done: clear its Lead"],
    [undefined, "coordinator", "Lead coordinator, but it is untriaged: clear its Lead"],
    ["In Progress", "coordinator", null],
    // A topic session owns its items in every status.
    ["Draft", "wfc", null],
    ["Done", "wfc", null],
    ["Draft", undefined, null],
  ];
  for (const [i, [status, lead, want]] of cases.entries()) {
    const item = { id: `PVTI_${i}`, status, lead, content: { type: "Issue", url: `https://github.com/o/r/issues/${i}` } };
    const actions = rec.staleLead({ items: [item] });
    assert.deepEqual(actions.map((a) => a.do), want ? [want] : [], `${status} ${lead}`);
    if (want) assert.deepEqual(actions[0].apply, { id: item.id, set: ["--field", "Lead", ""] });
  }
  assert.deepEqual(rec.staleLead(obs()), [], "the fixture world has none");
  assert.deepEqual(rec.staleLead(obs({ items: undefined })), []);
});

// --- bin/bot-reconcile ------------------------------------------------------

function cli(args, { now = "2026-10-02T12:00:00Z", status = 0, env = {} } = {}) {
  const r = spawnSync(TOOL, [
    "--board-file", path.join(FIX, "board.json"), "--epic-board-file", path.join(FIX, "epic-board.json"), "--sweep-dir", path.join(FIX, "sweep"),
    "--prs-file", path.join(FIX, "prs.json"), "--heartbeat-file", path.join(FIX, "heartbeat.json"), "--children-file", path.join(FIX, "children.json"),
    "--capacity-file", path.join(FIX, "capacity.json"), "--questions-file", path.join(FIX, "questions.json"),
    "--activity-file", path.join(TMP, "no-activity.json"), "--watch-state", path.join(FIX, "watch.json"), "--now", now, ...args,
  ], { encoding: "utf8", env: { ...process.env, HOME: TMP, XDG_STATE_HOME: path.join(TMP, "state-home"), BOT_OPERATOR_CONFIG: path.join(FIX, "operator.json"), UPSTREAM_POLICY_DIR: path.join(FIX, "upstream-policy"), ...env } });
  assert.equal(r.status, status, r.stderr);
  return r.stdout;
}

test("bot-reconcile: the report, and --json", () => {
  const out = cli([]);
  assert.match(out, /^Observed: 4 of 4 agents busy \(harness 3 of 2, upstream 1 of 2; upstream under its share, held: the total is at the target; 1 remote \(opencode share target 1\), 3 local\); budgets 8M, spent 1\.5M; capacity all, 45% projected; heartbeat 10 min old; sweep 20261002-114000-000, 17 min old\nActions \(14\):\n/);
  assert.doesNotMatch(out, /^. capacity /m);
  const j = JSON.parse(cli(["--json"]));
  assert.deepEqual(j.actions.map((a) => a.key), ALL_KEYS);
  assert.deepEqual(j.errors, []);
  assert.equal(j.observed.lanes.upstream.busy, 1);
  assert.deepEqual(JSON.parse(cli(["--json", "--rule", "drive", "--rule", "answer-unapplied"])).actions.map((a) => a.kind),
    ["drive", "health", "health", "health", "approval", "approval", "approval", "answer-unapplied"]);
});

test("bot-reconcile --state: fires once, then on resync; an unread input keeps its actions", () => {
  const state = path.join(TMP, "state", "actions.json");
  const fired = (out) => out.split("\n").filter((l) => l.startsWith("* ")).length;
  assert.equal(fired(cli(["--state", state])), ALL_KEYS.length);
  assert.equal(fired(cli(["--state", state], { now: "2026-10-02T12:20:00Z" })), 0);
  // The sweep can't be read: no drive actions, an error, exit 1, and its keys are kept.
  const out = cli(["--state", state, "--sweep-dir", path.join(TMP, "nowhere")], { now: "2026-10-02T12:22:00Z", status: 1 });
  assert.match(out, /^ {2}unread: the latest sweep: /m);
  assert.equal(fired(out), 0);
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(state, "utf8")).actions).some((k) => k.startsWith("drive:")));
  // Two hours after they fired, the ones still there fire again; by
  // then the heartbeat is stale too, which is new.
  const j = JSON.parse(cli(["--json", "--state", state], { now: "2026-10-02T14:00:00Z" }));
  assert.deepEqual(j.actions.filter((a) => a.fired === "resync").map((a) => a.key), ALL_KEYS);
  assert.deepEqual(j.actions.filter((a) => a.fired === "new").map((a) => a.key), ["heartbeat:stale"]);
  assert.equal(fired(cli(["--state", state, "--resync", "30"], { now: "2026-10-02T14:20:00Z" })), 0);
  assert.equal(fired(cli(["--state", state, "--resync", "30"], { now: "2026-10-02T14:31:00Z" })), ALL_KEYS.length + 1);
});

// sweepDir(name, watch): a sweep directory like the fixture's, whose
// latest run printed watch.
function sweepDir(name, watch) {
  const dir = path.join(TMP, `sweep-${name}`);
  const runDir = path.join(dir, "runs", "20261002-115500-000");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "watch.txt"), watch);
  fs.copyFileSync(path.join(run, "inbox.txt"), path.join(runDir, "inbox.txt"));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ version: 1, run: "20261002-115500-000", problems: [], complete: true,
    last_complete: { run: "20261002-115500-000", ended_at: "2026-10-02T11:58:00Z" } }));
  return dir;
}

test("bot-reconcile --state: a failed drive or health step carries its actions over", () => {
  const base = fs.readFileSync(path.join(run, "watch.txt"), "utf8");
  const drop = (text, header) => text.replace(new RegExp(`${header}\\n(?:  .*\\n)*\\n`), "");
  const DRIVE_WARN = "warning: looking for P0 drive steps failed (status 1); its section is incomplete\n";
  const HEALTH_WARN = "warning: the priority health sweep failed (status 1); its section is incomplete\n";
  const DRIVE_KEY = "drive:conflict https://github.com/o/r/pull/1 aaaaaaaaaaaa";
  const healthKeys = ALL_KEYS.filter((k) => k.startsWith("health:"));
  // [case, the sweep's watch output, the drive and health actions and how
  // each fired, the Observed line's note on the failed steps (null: none)]
  const cases = [
    ["drive failed, same blocker", DRIVE_WARN + drop(base, "P0 drive:"),
      [[DRIVE_KEY, null], ...healthKeys.map((k) => [k, null])], "P0 drive"],
    ["drive recovered, changed blocker", base.replaceAll("aaaaaaaaaaaa", "abababababab"),
      [["drive:conflict https://github.com/o/r/pull/1 abababababab", "new"], ...healthKeys.map((k) => [k, null])], null],
    ["health failed", HEALTH_WARN + drop(base, "Priority health:"),
      [[DRIVE_KEY, null], ...healthKeys.map((k) => [k, null])], "priority health"],
    ["both failed", DRIVE_WARN + HEALTH_WARN + drop(drop(base, "P0 drive:"), "Priority health:"),
      [[DRIVE_KEY, null], ...healthKeys.map((k) => [k, null])], "priority health and P0 drive"],
    ["drive failed, its section partly there", DRIVE_WARN + base,
      [[DRIVE_KEY, null], ...healthKeys.map((k) => [k, null])], "P0 drive"],
  ];
  const first = path.join(TMP, "carry-state.json");
  cli(["--state", first]);
  for (const [name, watch, want, note] of cases) {
    const state = path.join(TMP, `carry-${name.replaceAll(" ", "-")}.json`);
    fs.copyFileSync(first, state);
    const dir = sweepDir(name.replaceAll(/\W+/g, "-"), watch);
    const j = JSON.parse(cli(["--json", "--state", state, "--rule", "drive", "--sweep-dir", dir], { now: "2026-10-02T12:10:00Z" }));
    const got = j.actions.filter((a) => a.kind === "drive" || a.kind === "health").map((a) => [a.key, a.fired]);
    assert.deepEqual(got.sort(), want.sort(), name);
    assert.deepEqual(j.observed.sweep_failed_steps, note ? note.split(" and ") : undefined, `${name}: observed`);
    if (note) {
      assert.match(cli(["--state", state, "--rule", "drive", "--sweep-dir", dir], { now: "2026-10-02T12:11:00Z" }),
        new RegExp(`^Observed: .*\\(its ${note} step failed: carried over\\)`), `${name}: the Observed line`);
    }
  }
  // Without --state there is nothing to carry over.
  const j = JSON.parse(cli(["--json", "--rule", "drive", "--sweep-dir", sweepDir("no-state", DRIVE_WARN + drop(base, "P0 drive:"))]));
  assert.deepEqual(j.actions.filter((a) => a.kind === "drive"), []);
});

test("bot-reconcile --apply: sets closed items Done, clears stale Leads, and reads only the rules' inputs", () => {
  const log = path.join(TMP, "board-calls");
  const fakeBoard = path.join(TMP, "bot-board");
  fs.writeFileSync(fakeBoard, `#!/usr/bin/env bash\ntest "$2" != PVTI_fail || { echo "fake: quota" >&2; exit 75; }\necho "$*" >>${log}\n`, { mode: 0o755 });
  const board = path.join(TMP, "closed-board.json");
  fs.writeFileSync(board, JSON.stringify([
    { id: "PVTI_lead", status: "Draft", lead: "coordinator", content: { type: "Issue", url: "https://github.com/o/r/issues/9" } },
    { id: "PVTI_m", status: "Draft", content: { type: "PullRequest", url: "https://github.com/o/r/pull/1" } },
    { id: "PVTI_fail", status: "Draft", content: { type: "Issue", url: "https://github.com/o/r/issues/2" } },
    { id: "PVTI_ask", status: "In Review", content: { type: "PullRequest", url: "https://github.com/o/r/pull/3" } },
  ]));
  const watch = path.join(TMP, "watch.json");
  fs.writeFileSync(watch, JSON.stringify({ items: { "https://github.com/o/r/pull/1": { state: "merged" }, "https://github.com/o/r/issues/2": { state: "closed" },
    "https://github.com/o/r/pull/3": { state: "closed" } } }));
  // No sweep, heartbeat, capacity or questions: this rule doesn't read them.
  const r = spawnSync(TOOL, ["--rule", "closed-not-done", "--rule", "stale-lead", "--apply", "--json", "--board-file", board, "--watch-state", watch,
    "--sweep-dir", path.join(TMP, "nowhere"), "--heartbeat-file", path.join(TMP, "nowhere.json")],
  { encoding: "utf8", env: { ...process.env, BOT_RECONCILE_BOARD: fakeBoard, BOT_OPERATOR_CONFIG: path.join(FIX, "operator.json") } });
  assert.equal(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  // The PR closed unmerged is listed, but not applied.
  assert.deepEqual(j.actions.map((a) => [a.url, a.apply && a.apply.id, a.applied]), [
    ["https://github.com/o/r/issues/2", "PVTI_fail", "failed: fake: quota"], ["https://github.com/o/r/pull/1", "PVTI_m", "done"],
    ["https://github.com/o/r/pull/3", undefined, undefined], ["https://github.com/o/r/issues/9", "PVTI_lead", "done"]]);
  assert.deepEqual(j.errors, ["applying closed-not-done:https://github.com/o/r/issues/2: fake: quota"]);
  assert.equal(fs.readFileSync(log, "utf8"), "set PVTI_m --status Done --news PR merged; set Done\nset PVTI_lead --field Lead \n");
});

test("bot-reconcile: usage errors", () => {
  for (const args of [["--rule", "nope"], ["--resync", "0"], ["--bogus"], ["--now"]]) {
    const r = spawnSync(TOOL, args, { encoding: "utf8", env: { ...process.env, BOT_OPERATOR_CONFIG: path.join(FIX, "operator.json") } });
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
  }
  assert.match(execFileSync(TOOL, ["--help"], { encoding: "utf8", env: { ...process.env, BOT_OPERATOR_CONFIG: path.join(FIX, "operator.json") } }), /^Usage: bot-reconcile/);
});

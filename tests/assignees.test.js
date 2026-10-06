// Offline tests of lib/assignees.js ('bot-board assign', 'handback' and
// 'assign-migrate'): the hand-back rule over the fixtures in
// fixtures/assignees/, then the commands against a fake GitHub that
// holds a few issues and PRs in memory. Run with tests/assignees.sh, or
// node --test tests/assignees.test.js.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const A = require("../lib/assignees.js");
const CASES = require("./fixtures/assignees/handback.json");

const CFG = { operator: "cgwalters", bot: "cgwalters-bot", forgeOrg: "cgwalters-forge", tracker: "cgwalters-forge/tracker" };
const ASSIGNED_AT = "2026-10-01T12:00:00Z";
const BOARD = "bot-board";

for (const c of CASES) {
  test(`hand-back: ${c.name}`, () => {
    const ev = A.handBackEvent({ assignedAt: ASSIGNED_AT, comments: c.comments, reviews: c.reviews }, CFG);
    assert.equal(ev?.kind ?? null, c.expected);
  });
}

test("the turn changes only the operator's and the bot's assignment", () => {
  assert.deepEqual(A.turnChange(["someone", "cgwalters-bot"], "operator", CFG), { add: ["cgwalters"], remove: ["cgwalters-bot"] });
  assert.deepEqual(A.turnChange(["cgwalters"], "bot", CFG), { add: ["cgwalters-bot"], remove: ["cgwalters"] });
  assert.deepEqual(A.turnChange(["CGWalters", "cgwalters-bot", "x"], "none", CFG), { add: [], remove: ["cgwalters", "cgwalters-bot"] });
  assert.deepEqual(A.turnChange(["cgwalters"], "operator", CFG), { add: [], remove: [] });
  assert.throws(() => A.turnChange([], "me", CFG), /operator, bot or none/);
});

test("scope and references", () => {
  assert.equal(A.scopeQuery(CFG), "org:cgwalters-forge user:cgwalters-bot");
  assert.equal(A.scopeQuery({ ...CFG, tracker: "elsewhere/tracker" }), "org:cgwalters-forge user:cgwalters-bot repo:elsewhere/tracker");
  for (const [text, inScope] of [["cgwalters-forge/bootc#3", true], ["https://github.com/cgwalters-bot/homegit/pull/9", true],
    ["https://github.com/bootc-dev/bootc/pull/1", false]]) assert.equal(A.inScope(A.parseRef(text), CFG), inScope, text);
  assert.throws(() => A.parseRef("bootc#1"), /OWNER\/REPO#N/);
  assert.deepEqual(A.readAsks("# asks from tracker#329\nhttps://github.com/a/b/pull/1  c/d#2 # why\n\n"), ["https://github.com/a/b/pull/1", "c/d#2"]);
  assert.equal(A.lastAssigned([{ event: "assigned", assignee: { login: "cgwalters" }, created_at: "2026-10-01T00:00:00Z" },
    { event: "assigned", assignee: { login: "cgwalters-bot" }, created_at: "2026-10-03T00:00:00Z" },
    { event: "assigned", assignee: { login: "cgwalters" }, created_at: "2026-10-02T00:00:00Z" }], "cgwalters"), "2026-10-02T00:00:00Z");
});

// A fake GitHub: issues and PRs by "OWNER/REPO#N", and the board's items.
function fakeForge(issues, board = []) {
  const writes = [];
  const get = (owner, repo, n) => {
    const it = issues[`${owner}/${repo}#${n}`];
    if (!it) throw new Error(`gh: Not Found (HTTP 404) ${owner}/${repo}#${n}`);
    return it;
  };
  const url = (k, it) => `https://github.com/${k.replace("#", it.pr ? "/pull/" : "/issues/")}`;
  const run = async (cmd, argv) => {
    if (cmd === BOARD) return JSON.stringify(board);
    assert.equal(cmd, "gh");
    assert.equal(argv[0], "api");
    const fields = argv.flatMap((a, i) => (argv[i - 1] === "-f" ? [a] : []));
    const method = argv.includes("-X") ? argv[argv.indexOf("-X") + 1] : "GET";
    const endpoint = argv.find((a) => /^(repos|search)\//.test(a));
    if (endpoint === "search/issues") {
      const q = fields.find((f) => f.startsWith("q=")).slice(2);
      const login = /assignee:(\S+)/.exec(q)[1];
      const state = /is:(open|closed)/.exec(q)[1];
      assert.match(q, /org:cgwalters-forge user:cgwalters-bot$/);
      const items = Object.entries(issues)
        .filter(([k, it]) => (it.state || "open") === state && it.assignees.includes(login) && A.inScope(A.parseRef(k), CFG))
        .map(([k, it]) => ({ html_url: url(k, it), assignees: it.assignees.map((l) => ({ login: l })), ...(it.pr ? { pull_request: {} } : {}) }));
      return JSON.stringify({ items });
    }
    const m = /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)(?:\/(\w+))?(?:\?(.*))?$/.exec(endpoint);
    const it = get(m[1], m[2], m[4]);
    const logins = fields.map((f) => f.replace("assignees[]=", ""));
    switch (`${method} ${m[5] || ""}`) {
      case "GET ": return JSON.stringify({ assignees: it.assignees.map((l) => ({ login: l })), ...(it.pr ? { pull_request: {} } : {}) });
      case "POST assignees":
        if (it.broken) throw new Error(`gh: Validation Failed (HTTP 422) ${m[1]}/${m[2]}#${m[4]}`);
        writes.push(`+${logins} ${m[1]}/${m[2]}#${m[4]}`);
        // GitHub drops those it can't assign there.
        it.assignees.push(...logins.filter((l) => !(it.unassignable || []).includes(l)));
        return JSON.stringify({ assignees: it.assignees.map((l) => ({ login: l })) });
      case "DELETE assignees":
        writes.push(`-${logins} ${m[1]}/${m[2]}#${m[4]}`);
        it.assignees = it.assignees.filter((l) => !logins.includes(l));
        return "{}";
      case "GET events": return JSON.stringify([it.events || []]);
      case "GET comments": {
        const since = new URLSearchParams(m[6]).get("since");
        return JSON.stringify([(it.comments || []).filter((c) => !since || c.created_at >= since)]);
      }
      case "GET reviews": return JSON.stringify([it.reviews || []]);
      default: throw new Error(`unexpected gh ${argv.join(" ")}`);
    }
  };
  return { forge: new A.Forge(CFG, run, BOARD), writes };
}

const assigned = (login, at = ASSIGNED_AT) => ({ event: "assigned", assignee: { login }, created_at: at });
const said = (login, at) => ({ user: { login }, created_at: at, html_url: `c-${login}-${at}` });

test("hand-back flips only the items the operator acted on, and unassigns closed ones", async () => {
  const later = "2026-10-02T00:00:00Z";
  const issues = {
    // A question the operator answered.
    "cgwalters-forge/tracker#42": { assignees: ["cgwalters"], events: [assigned("cgwalters")], comments: [said("cgwalters", later)] },
    // A forge draft they approved.
    "cgwalters-forge/bootc#7": { pr: true, assignees: ["cgwalters"], events: [assigned("cgwalters")],
      reviews: [{ user: { login: "cgwalters" }, state: "APPROVED", submitted_at: later, html_url: "r7" }] },
    // Waiting on them: only the bot and others spoke since.
    "cgwalters-forge/bootc#8": { pr: true, assignees: ["cgwalters"], events: [assigned("cgwalters")],
      comments: [said("cgwalters-bot", later), said("someone", later)] },
    // Re-asked after their comment: still waiting on them.
    "cgwalters-bot/homegit#5": { pr: true, assignees: ["cgwalters"], events: [assigned("cgwalters", "2026-09-01T00:00:00Z"), assigned("cgwalters", later)],
      comments: [said("cgwalters", "2026-09-02T00:00:00Z")] },
    // The tracking issue of an upstream PR, which they reviewed upstream.
    "cgwalters-forge/tracker#50": { assignees: ["cgwalters"], events: [assigned("cgwalters")] },
    "bootc-dev/bootc#100": { pr: true, assignees: [], reviews: [{ user: { login: "cgwalters" }, state: "COMMENTED", submitted_at: later, html_url: "r100" }] },
    // Done.
    "cgwalters-forge/tracker#30": { state: "closed", assignees: ["cgwalters", "someone"] },
    "cgwalters-forge/bootc#3": { state: "closed", pr: true, assignees: ["cgwalters-bot"] },
  };
  const board = [{ content: { url: "https://github.com/cgwalters-forge/tracker/issues/50" }, branch: "https://github.com/bootc-dev/bootc/pull/100" }];
  const lines = [];
  const dry = fakeForge(structuredClone(issues), board);
  assert.deepEqual(await A.handBack(dry.forge, false, (l) => lines.push(l)), { handed: 3, cleared: 2 });
  assert.deepEqual(dry.writes, []);
  assert.match(lines.at(-1), /\(dry-run\)$/);
  const live = fakeForge(issues, board);
  assert.deepEqual(await A.handBack(live.forge, true, () => {}), { handed: 3, cleared: 2 });
  assert.deepEqual(live.writes, [
    "+cgwalters-bot cgwalters-forge/tracker#42", "-cgwalters cgwalters-forge/tracker#42",
    "+cgwalters-bot cgwalters-forge/bootc#7", "-cgwalters cgwalters-forge/bootc#7",
    "+cgwalters-bot cgwalters-forge/tracker#50", "-cgwalters cgwalters-forge/tracker#50",
    "-cgwalters cgwalters-forge/tracker#30", "-cgwalters-bot cgwalters-forge/bootc#3",
  ]);
  assert.deepEqual(issues["cgwalters-forge/tracker#30"].assignees, ["someone"]);
  assert.deepEqual(issues["bootc-dev/bootc#100"].assignees, [], "upstream is never assigned");
});

test("hand-back: an item that fails is reported, and the rest are still done", async () => {
  const later = "2026-10-02T00:00:00Z";
  const acted = () => ({ assignees: ["cgwalters"], events: [assigned("cgwalters")], comments: [said("cgwalters", later)] });
  const issues = { "cgwalters-forge/tracker#41": { ...acted(), broken: true }, "cgwalters-forge/tracker#42": acted(),
    "cgwalters-forge/tracker#30": { state: "closed", assignees: ["cgwalters"] } };
  const { forge, writes } = fakeForge(issues);
  const lines = [];
  await assert.rejects(A.handBack(forge, true, (l) => lines.push(l)), /^Error: 1 item\(s\) failed/);
  assert.deepEqual(writes, ["+cgwalters-bot cgwalters-forge/tracker#42", "-cgwalters cgwalters-forge/tracker#42", "-cgwalters cgwalters-forge/tracker#30"]);
  assert.match(lines[0], /^warning: https:\/\/github\.com\/cgwalters-forge\/tracker\/issues\/41: gh: Validation Failed/);
  assert.equal(lines.at(-1), "Hand-back: 1 handed back, 1 closed unassigned");
});

test("nothing out of the bot's scope is assigned, whatever names it", async () => {
  const { forge, writes } = fakeForge({ "bootc-dev/bootc#100": { pr: true, assignees: ["cgwalters"] } });
  for (const who of A.WHO) await assert.rejects(forge.setTurn(A.parseRef("bootc-dev/bootc#100"), who, true), /the bot assigns nobody there/);
  assert.deepEqual(writes, []);
});

test("asking again on an item the operator acted on assigns them anew", async () => {
  const later = "2026-10-02T00:00:00Z";
  const issues = {
    // They commented, and the hand-back hasn't run yet: without a new assignment it would take the next ask for answered.
    "cgwalters-forge/bootc#7": { pr: true, assignees: ["cgwalters"], events: [assigned("cgwalters")], comments: [said("cgwalters", later)] },
    // Still waiting on them: only others spoke.
    "cgwalters-forge/bootc#8": { pr: true, assignees: ["cgwalters"], events: [assigned("cgwalters")], comments: [said("someone", later)] },
  };
  const dry = fakeForge(structuredClone(issues));
  assert.deepEqual(await dry.forge.setTurn(A.parseRef("cgwalters-forge/bootc#7"), "operator", false), { add: ["cgwalters"], remove: [], renewed: true });
  assert.deepEqual(dry.writes, []);
  const { forge, writes } = fakeForge(issues);
  const lines = [];
  for (const n of [7, 8]) await A.assign(forge, `cgwalters-forge/bootc#${n}`, "operator", (l) => lines.push(l));
  assert.deepEqual(writes, ["-cgwalters cgwalters-forge/bootc#7", "+cgwalters cgwalters-forge/bootc#7"]);
  assert.deepEqual(lines, ["https://github.com/cgwalters-forge/bootc/issues/7: operator: +cgwalters (asked again)", "https://github.com/cgwalters-forge/bootc/issues/8: operator: unchanged"]);
});

test("assign sets the turn in scope, and on the tracking issue for upstream", async () => {
  const issues = {
    "cgwalters-forge/bootc#7": { pr: true, assignees: ["cgwalters-bot"] },
    "cgwalters-forge/tracker#50": { assignees: [] },
    "cgwalters-forge/tracker#51": { assignees: [], unassignable: ["cgwalters"] },
  };
  const board = [{ content: { url: "https://github.com/cgwalters-forge/tracker/issues/50" }, branch: "https://github.com/bootc-dev/bootc/pull/100 https://github.com/x/y/pull/1" }];
  const { forge, writes } = fakeForge(issues, board);
  const lines = [];
  await A.assign(forge, "https://github.com/cgwalters-forge/bootc/pull/7", "operator", (l) => lines.push(l));
  await A.assign(forge, "bootc-dev/bootc#100", "operator", (l) => lines.push(l));
  assert.deepEqual(writes, ["+cgwalters cgwalters-forge/bootc#7", "-cgwalters-bot cgwalters-forge/bootc#7", "+cgwalters cgwalters-forge/tracker#50"]);
  assert.deepEqual(lines, ["https://github.com/cgwalters-forge/bootc/pull/7: operator: +cgwalters -cgwalters-bot",
    "https://github.com/cgwalters-forge/tracker/issues/50: operator (for https://github.com/bootc-dev/bootc/issues/100): +cgwalters"]);
  await A.assign(forge, "cgwalters-forge/bootc#7", "operator", () => {});
  assert.equal(writes.length, 3, "nothing to change, nothing written");
  await assert.rejects(A.assign(forge, "https://github.com/bootc-dev/bootc/pull/999", "bot", () => {}), /no cgwalters-forge\/tracker issue/);
  await assert.rejects(A.assign(forge, "cgwalters-forge/tracker#51", "operator", () => {}), /did not assign cgwalters/);
  await assert.rejects(A.assign(forge, "cgwalters-forge/tracker#50", "me", () => {}), /operator, bot or none/);
});

test("the migration assigns the live asks and unassigns everything else", async () => {
  const issues = {
    "cgwalters-forge/tracker#42": { assignees: ["cgwalters"] },
    "cgwalters-forge/tracker#43": { assignees: [] },
    "cgwalters-forge/tracker#44": { assignees: ["cgwalters", "someone"] },
    "cgwalters-forge/bootc#9": { pr: true, assignees: ["cgwalters-bot"] },
    "cgwalters-forge/tracker#50": { assignees: [] },
  };
  const board = [{ content: { url: "https://github.com/cgwalters-forge/tracker/issues/50" }, branch: "https://github.com/bootc-dev/bootc/pull/100" }];
  const asks = ["cgwalters-forge/tracker#42", "https://github.com/cgwalters-forge/tracker/issues/43", "https://github.com/bootc-dev/bootc/pull/100"];
  const dry = fakeForge(structuredClone(issues), board);
  await A.migrate(dry.forge, asks, false, () => {});
  assert.deepEqual(dry.writes, []);
  const { forge, writes } = fakeForge(issues, board);
  const lines = [];
  await A.migrate(forge, asks, true, (l) => lines.push(l));
  assert.deepEqual(writes, ["+cgwalters cgwalters-forge/tracker#43", "+cgwalters cgwalters-forge/tracker#50",
    "-cgwalters cgwalters-forge/tracker#44", "-cgwalters-bot cgwalters-forge/bootc#9"]);
  assert.equal(lines.at(-1), "Migration: 3 asks, 2 others unassigned");
  assert.deepEqual(issues["cgwalters-forge/tracker#44"].assignees, ["someone"]);
});

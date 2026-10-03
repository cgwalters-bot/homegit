"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const status = require("../lib/board-status-update.js");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const SINCE = NOW - 8 * 3600000;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "board-status-test-"));
let serial = 0;

function item(id, extra = {}) {
  return { id, title: id, url: `https://github.com/example/repo/issues/${id}`, status: "Todo", priority: "P1",
    updatedAt: new Date(NOW).toISOString(), contentUpdatedAt: new Date(NOW).toISOString(), ...extra };
}

function node(i) {
  return { id: i.id, updatedAt: i.updatedAt,
    content: { title: i.title, body: i.body, comments: { nodes: i.comments || [] }, url: i.url, state: i.state || "OPEN", updatedAt: i.contentUpdatedAt,
      closedAt: i.closedAt, mergedAt: i.mergedAt, labels: { nodes: (i.labels || []).map((name) => ({ name })) } },
    fieldValues: { pageInfo: { hasNextPage: false }, nodes: ["status", "priority", "news", "why", "branch", "gist", "lead", "run"]
      .filter((key) => i[key]).map((key) => ({ field: { name: key }, text: i[key],
        updatedAt: key === "news" ? i.newsUpdatedAt : undefined })) } };
}

function fixture(items = [], updates = []) {
  const stateFile = path.join(WORK, `state-${serial++}`, "snapshot.json");
  const calls = [];
  let fail = false;
  let clock = NOW;
  let afterPost = () => {};
  const request = (query, variables) => {
    calls.push({ query, variables });
    if (query === status.MUTATION) {
      if (fail) throw new Error("mutation rejected");
      const update = { id: `update-${updates.length}`, createdAt: new Date(clock).toISOString(),
        project: { url: "https://github.com/orgs/example/projects/2" }, body: variables.body };
      updates.unshift(update);
      afterPost();
      return { createProjectV2StatusUpdate: { statusUpdate: update } };
    }
    const field = query === status.ITEMS_QUERY ? "items" : "statusUpdates";
    // One node per page to exercise both paginators, including empty boards.
    const all = field === "items" ? items.map(node) : updates;
    const start = Number(variables.after || 0);
    return { node: { [field]: { nodes: all.slice(start, start + 1),
      pageInfo: { hasNextPage: start + 1 < all.length, endCursor: String(start + 1) } } } };
  };
  return { stateFile, calls, updates, setFail: (value) => { fail = value; },
    onPost: (fn) => { afterPost = fn; },
    publish: (opts = {}, more = {}) => {
      clock = more.now ?? NOW;
      return status.publish({ id: "PVT_test", stateFile, request, now: clock, opts, ...more });
    } };
}

test("fixed sections, stable priority ordering, events, agents and operator ask classes", () => {
  const items = [
    item("z", { status: "In Progress", lead: "worker", run: "https://example/run" }),
    item("a", { status: "In Progress", priority: "P0" }),
    item("draft", { status: "Draft", why: "Review the gist", gist: "https://gist.github.com/example/1" }),
    item("question", { status: "Needs human", askClass: "decision", why: "Choose A or B" }),
    item("chore", { status: "Needs human", askClass: "action", why: "Change a setting" }),
    item("review", { status: "Needs human", askClass: "review", why: "Approve this head" }),
    item("upstream", { status: "In Review", why: "Waiting for maintainers" }),
    item("merged", { status: "Done", state: "MERGED", mergedAt: new Date(NOW - 1000).toISOString() }),
    item("closed", { status: "Done", state: "CLOSED", closedAt: new Date(NOW - 2000).toISOString() }),
    item("promoted", { status: "In Review", news: "2026-10-03: Promoted PR" }),
    item("old-news", { news: "2026-10-01: Old event" }),
  ];
  const opts = { now: NOW, since: SINCE, previous: [item("promoted", { status: "Draft" })],
    workers: [{ name: "remote", status: "testing", item_url: items.find((i) => i.id === "question").url }] };
  const result = status.generate(items, opts);
  assert.deepEqual(status.generate([...items].reverse(), opts), result);
  assert.match(result.body, /## Changed\n[\s\S]*closed[\s\S]*merged[\s\S]*promoted upstream; Promoted PR/);
  assert.doesNotMatch(result.body, /Old event/);
  const progress = result.body.split("## In progress\n")[1].split("## Waiting")[0];
  assert.ok(progress.indexOf("[a]") < progress.indexOf("[z]"));
  assert.match(progress, /agent worker/);
  assert.match(progress, /Agent remote: testing/);
  assert.match(progress, /\[upstream\].*awaiting upstream review/);
  const waiting = result.body.split("## Waiting on the operator\n")[1];
  for (const kind of ["review", "decision", "action"]) assert.match(waiting, new RegExp(`— ${kind}:`));
  assert.doesNotMatch(waiting, /upstream|maintainers|promoted/);
});

test("clean neutralizes mentions, HTML and leading markdown in item text", () => {
  const cases = [
    ["ping @octocat now", "ping @\u200boctocat now"],
    ["a@b and @org/team", "a@\u200bb and @\u200borg/team"],
    ["<img src=x>", "&lt;img src=x>"],
    ["# heading", "\\# heading"],
    ["> quote", "\\> quote"],
    ["- item", "\\- item"],
    ["1. item", "\\1. item"],
    ["line one\nline two", "line one line two"],
    ["![x](http://e/p.png) [a](http://e)", "\\!\\[x\\](http://e/p.png) \\[a\\](http://e)"],
    ["snake_case *bold* `code` a|b ~~s~~", "snake\\_case \\*bold\\* \\`code\\` a\\|b \\~\\~s\\~\\~"],
    ["plain text", "plain text"],
  ];
  for (const [input, want] of cases) assert.equal(status.clean(input), want, input);
});

test("first observation uses available timestamp evidence for P0 risk", () => {
  assert.equal(status.generate([], { now: NOW, since: SINCE }).body,
    "## Changed\n- None.\n\n## In progress\n- None.\n\n## Waiting on the operator\n- None.");
  const old = new Date(NOW - 24 * 3600000).toISOString();
  const stale = item("stale", { priority: "P0", updatedAt: old, contentUpdatedAt: old });
  assert.equal(status.generate([stale], { now: NOW, since: SINCE }).status, "at-risk");
  for (const extra of [{ status: "Done" }, { state: "CLOSED" }, { contentUpdatedAt: new Date(NOW).toISOString() },
    { updatedAt: new Date(NOW).toISOString() }, { priority: "P1" }]) {
    assert.equal(status.generate([{ ...stale, ...extra }], { now: NOW, since: SINCE }).status, "on-track");
  }
  assert.equal(status.generate([stale], { now: NOW, since: SINCE, staleHours: 25 }).status, "on-track");
  assert.equal(status.generate([stale], { now: NOW, since: SINCE, status: "off-track" }).status, "off-track");
});

test("digest ignores time, token counters and News date-only churn but tracks material changes", () => {
  const i = item("one", { status: "Draft", news: "2026-10-02: Ready" });
  const gen = (items) => status.generate(items, { now: NOW, since: SINCE });
  const base = gen([i]).digest;
  assert.equal(gen([{ ...i, updatedAt: "2026-10-03T11:00:00Z", news: "2026-10-03: Ready", "actual tokens": 100 }]).digest, base);
  for (const extra of [{ title: "renamed" }, { status: "In Review" }, { why: "Do X" }, { news: "2026-10-03: New event" }]) {
    assert.notEqual(gen([{ ...i, ...extra }]).digest, base);
  }
});

test("explicit since overrides the saved News baseline and respects field timestamps", () => {
  const i = item("news", { news: "2026-10-03: Same-day event", newsUpdatedAt: new Date(NOW - 3600000).toISOString() });
  const generate = (since) => status.generate([i], { now: NOW, since, previous: [i], explicitSince: true });
  assert.match(generate(SINCE).body, /Same-day event/);
  assert.doesNotMatch(generate(NOW).body, /Same-day event/);
  assert.equal(status.normalize(node(i)).newsUpdatedAt, i.newsUpdatedAt);
});

test("active worker names are attached to their item exactly once", () => {
  const i = item("working", { status: "In Progress", lead: "coordinator" });
  const result = status.generate([i], { now: NOW, since: SINCE,
    workers: [{ name: "worker-1", item_url: i.url, status: "testing" }] });
  assert.match(result.body, /agent worker-1 \(testing\)/);
  assert.equal(result.body.match(/worker-1/g).length, 1);
});

test("only associated unfinished project workers enter the report or digest", () => {
  const working = item("working", { status: "In Progress", run: "https://example/run" });
  const done = item("done", { status: "Done" });
  const closed = item("closed", { state: "CLOSED" });
  const merged = item("merged", { state: "MERGED" });
  const branch = "https://github.com/example/repo/pull/9";
  const linked = item("linked", { branch: `${branch} https://github.com/example/repo/pull/10` });
  const items = [working, done, closed, merged, linked];
  const workers = [
    { name: "url-worker", item_url: working.url, status: "testing" },
    { name: "run-worker", item_url: working.run, status: "starting" },
    { name: "id-worker", item_id: working.id, status: "working" },
    { name: "branch-worker", item_url: branch, status: "testing" },
  ];
  const excluded = [done, closed, merged, item("other-project")].map((i) =>
    ({ name: `excluded-${i.id}`, item_url: i.url, status: "working" }));
  const opts = { now: NOW, since: SINCE, workers };
  const base = status.generate(items, opts);
  assert.deepEqual(status.generate(items, { ...opts, workers: [...workers, ...excluded] }), base);
  for (const w of workers) assert.equal(base.body.split(w.name).length - 1, 1, base.body);
  assert.deepEqual(status.generate([...items].reverse(), { ...opts, workers: [...workers].reverse() }), base);
});

test("persisted movement ignores bookkeeping and recovers after losing all local state", () => {
  const old = new Date(NOW - 48 * 3600000).toISOString();
  const items = [item("p0", { priority: "P0", updatedAt: old, contentUpdatedAt: old, news: "2026-10-01: Waiting" })];
  const f = fixture(items);
  f.publish({ auto: true });
  const before = status.recover(f.updates[0]);
  assert.match(f.updates[0].body, /At risk/);
  Object.assign(items[0], { updatedAt: new Date(NOW + 4 * 3600000).toISOString(),
    contentUpdatedAt: new Date(NOW + 4 * 3600000).toISOString(), news: "2026-10-03: Waiting", "actual tokens": 999 });
  assert.equal(f.publish({ auto: true }, { now: NOW + 4 * 3600000 }).skipped, "no material change");
  const history = JSON.parse(fs.readFileSync(`${f.stateFile}.observations.json`, "utf8"));
  assert.equal(history.items[0].movedAt, NOW - 48 * 3600000);
  fs.rmSync(f.stateFile);
  fs.rmSync(`${f.stateFile}.observations.json`);
  assert.equal(f.publish({ auto: true }, { now: NOW + 8 * 3600000 }).skipped, "no material change");
  assert.equal(status.recover(f.updates[0]).digest, before.digest);
  f.publish({}, { now: NOW + 8 * 3600000 });
  assert.match(f.updates[0].body, /At risk/);
});

test("material movement resets P0 inactivity but timestamp-only activity never does", () => {
  const old = new Date(NOW - 48 * 3600000).toISOString();
  const i = item("p0", { priority: "P0", updatedAt: old, contentUpdatedAt: old,
    body: "Original", news: "2026-10-01: Waiting", comments: [{ body: "Initial", updatedAt: old }] });
  const observations = status.observe([i], [], NOW);
  for (const extra of [{ status: "In Progress" }, { priority: "P1" }, { lead: "new-lead" },
    { branch: "new-branch" }, { news: "2026-10-03: New event" }, { body: "Edited" },
    { title: "New title" }, { state: "CLOSED", closedAt: new Date(NOW).toISOString() },
    { comments: [{ body: "Answer", updatedAt: new Date(NOW).toISOString() }] }]) {
    const result = status.generate([{ ...i, ...extra }], { now: NOW, since: SINCE, observations });
    assert.equal(result.observations[0].movedAt, NOW, JSON.stringify(extra));
    assert.equal(result.status, "on-track");
  }
  for (const extra of [{ updatedAt: new Date(NOW).toISOString() }, { contentUpdatedAt: new Date(NOW).toISOString() },
    { run: "new-run", "actual tokens": 100 }, { news: "2026-10-03: Waiting" },
    { comments: [{ body: "Initial", updatedAt: new Date(NOW).toISOString() }] }]) {
    const result = status.generate([{ ...i, ...extra }], { now: NOW, since: SINCE, observations });
    assert.equal(result.status, "at-risk", JSON.stringify(extra));
    assert.equal(result.observations[0].movedAt, observations[0].movedAt);
  }
});

test("movement during throttle is persisted independently of the posted event baseline", () => {
  const items = [item("p0", { priority: "P0", status: "Draft" })];
  const f = fixture(items);
  f.publish({ auto: true });
  items[0].status = "In Review";
  assert.equal(f.publish({ auto: true }, { now: NOW + 3600000 }).skipped, "four-hour throttle");
  assert.equal(JSON.parse(fs.readFileSync(`${f.stateFile}.observations.json`, "utf8")).items[0].movedAt, NOW + 3600000);
  assert.ok(f.publish({ auto: true }, { now: NOW + 4 * 3600000 }).url);
  assert.match(f.updates[0].body, /promoted upstream/);
  items[0].updatedAt = new Date(NOW + 25 * 3600000).toISOString();
  assert.ok(f.publish({ auto: true }, { now: NOW + 25 * 3600000 }).url);
  assert.match(f.updates[0].body, /At risk/);
});

test("another aging P0 changes the digest even when the project is already at risk", () => {
  const old = new Date(NOW - 48 * 3600000).toISOString();
  const items = [item("old-p0", { priority: "P0", updatedAt: old, contentUpdatedAt: old }),
    item("new-p0", { priority: "P0" })];
  const first = status.generate(items, { now: NOW, since: SINCE });
  const later = status.generate(items, { now: NOW + 24 * 3600000, since: SINCE, observations: first.observations });
  assert.equal(first.status, "at-risk");
  assert.equal(later.status, "at-risk");
  assert.notEqual(first.digest, later.digest);
  assert.match(later.body, /At risk:.*new-p0.*old-p0/);
});

test("waiting asks use documented Blocks links to avoid repeating a blocked parent", () => {
  const parent = item("parent", { status: "Needs human", why: "Answer the question" });
  const ask = status.normalize(node(item("question", { status: "Needs human", labels: ["question"],
    body: `Blocks: ${parent.url}\n\nChoose A or B`, why: "Choose A or B" })));
  const report = (extra = {}) => status.generate([parent, { ...ask, ...extra }], { now: NOW, since: SINCE }).body;
  assert.doesNotMatch(report().split("## Waiting on the operator")[1], /\[parent\]/);
  assert.match(report(), /\[question\].*decision: Choose A or B/);
  assert.match(report({ state: "CLOSED" }), /\[parent\].*Answer the question/);
  assert.match(report({ blocks: "https://github.com/example/repo/issues/other" }), /\[parent\]/);
});

test("ask labels normalize and incomplete field observations are rejected", () => {
  for (const [label, askClass] of [["question", "decision"], ["chore", "action"], ["review", "review"]]) {
    assert.equal(status.normalize(node(item("ask", { labels: [label] }))).askClass, askClass);
  }
  const n = node(item("one"));
  n.fieldValues.pageInfo.hasNextPage = true;
  assert.throws(() => status.normalize(n), /incomplete observation/);
});

test("mutation status mappings, custom body, URL and successful snapshot", () => {
  const bodyFile = path.join(WORK, "body.md");
  fs.writeFileSync(bodyFile, "Custom report\nwith multiple lines.");
  for (const [cli, api] of Object.entries(status.STATUS)) {
    const f = fixture([item("one"), item("two")]);
    const r = f.publish({ status: cli, body: bodyFile, since: "2026-10-03T01:00:00Z" });
    assert.equal(r.url, f.updates[0].project.url);
    const call = f.calls.find((c) => c.query === status.MUTATION);
    assert.equal(call.variables.project, "PVT_test");
    assert.equal(call.variables.status, api);
    assert.match(call.variables.body, /^Custom report\nwith multiple lines\.\n\n<!-- bot-board-status-v1:/);
    const saved = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    assert.equal(saved.id, f.updates[0].id);
    assert.equal(saved.items.length, 2);
    assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  }
});

test("automatic throttle, material gating, failed mutation and crash recovery", () => {
  const items = [item("one", { news: "2026-10-03: First event" })];
  const f = fixture(items);
  assert.ok(f.publish({ auto: true }).url);
  const saved = fs.readFileSync(f.stateFile, "utf8");
  items[0].news = "2026-10-03: Next event";
  assert.equal(f.publish({ auto: true }, { now: NOW + 3 * 3600000 }).skipped, "four-hour throttle");
  f.setFail(true);
  assert.throws(() => f.publish({ auto: true }, { now: NOW + 4 * 3600000 }), /mutation rejected/);
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), saved);
  f.setFail(false);
  assert.ok(f.publish({ auto: true }, { now: NOW + 4 * 3600000 }).url);
  assert.match(f.updates[0].body, /Next event/);
  // Losing the local snapshot after a successful post is safe: recover
  // the digest and transition baseline from the project update itself.
  fs.rmSync(f.stateFile);
  assert.equal(f.publish({ auto: true }, { now: NOW + 8 * 3600000 }).skipped, "no material change");
  items[0].news = "2026-10-04: Next event";
  items[0].updatedAt = new Date(NOW + 5 * 3600000).toISOString();
  assert.equal(f.publish({ auto: true }, { now: NOW + 8 * 3600000 }).skipped, "no material change");
});

test("latest external project update throttles and recovered baseline detects promotion", () => {
  const items = [item("one", { status: "Draft" })];
  const f = fixture(items);
  f.publish();
  f.updates.unshift({ id: "human", body: "External report", createdAt: new Date(NOW + 3600000).toISOString() });
  assert.equal(f.publish({ auto: true }, { now: NOW + 4 * 3600000 }).skipped, "four-hour throttle");
  items[0].status = "In Review";
  f.publish({ auto: true }, { now: NOW + 5 * 3600000 });
  assert.match(f.updates[0].body, /promoted upstream/);
});

test("successful local post throttles an API listing that has not caught up", () => {
  const f = fixture([item("one")]);
  f.publish({ auto: true });
  f.updates.length = 0;
  assert.equal(f.publish({ auto: true }, { now: NOW + 3600000 }).skipped, "four-hour throttle");
  assert.equal(f.publish({ auto: true }, { now: NOW + 4 * 3600000 }).skipped, "no material change");
});

test("recovery takes the appended marker when custom body contains a copied old report", () => {
  const items = [item("one", { status: "Draft" })];
  const f = fixture(items);
  f.publish();
  const copied = path.join(WORK, "copied-report.md");
  fs.writeFileSync(copied, f.updates[0].body);
  items[0].status = "In Review";
  f.publish({ body: copied }, { now: NOW + 3600000 });
  const saved = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
  fs.rmSync(f.stateFile);
  assert.equal(status.recover(f.updates[0]).digest, saved.digest);
  assert.equal(f.publish({ auto: true }, { now: NOW + 5 * 3600000 }).skipped, "no material change");
});

test("snapshot write failure reports successful URL and recovers from the remote marker", () => {
  const f = fixture([item("one")]);
  // A directory at the snapshot pathname forces rename to fail after
  // posting, without depending on uid or filesystem permission behavior.
  f.onPost(() => fs.mkdirSync(f.stateFile, { recursive: true }));
  assert.throws(() => f.publish(), /posted https:.*saving the snapshot failed/);
  assert.equal(f.updates.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)).sort(), ["snapshot.json", "snapshot.json.observations.json"]);
  fs.rmSync(f.stateFile, { recursive: true });
  assert.equal(f.publish({ auto: true }, { now: NOW + 4 * 3600000 }).skipped, "no material change");
});

test("invalid arguments, body reads, observations and mutation payloads fail without advancing baseline", () => {
  for (const args of [["--status", "bad"], ["--since", "yesterday"], ["--body"], ["--auto", "--status", "on-track"], ["--other"]]) {
    assert.throws(() => status.parseArgs(args));
  }
  const f = fixture();
  assert.throws(() => f.publish({ body: path.join(WORK, "missing") }), /ENOENT/);
  assert.throws(() => f.publish({}, { staleHours: 0 }), /positive number/);
  assert.throws(() => f.publish({}, { request: () => ({}) }), /cannot read project/);
  const empty = path.join(WORK, "empty");
  fs.writeFileSync(empty, "");
  assert.throws(() => f.publish({ body: empty }), /empty/);
  fs.writeFileSync(empty, "x".repeat(65536));
  assert.throws(() => f.publish({ body: empty }), /body limit/);
  assert.equal(f.calls.length, 0, "invalid bodies and thresholds must fail before remote reads");
  const badMutation = (query) => query === status.MUTATION ? { createProjectV2StatusUpdate: { statusUpdate: {} } } :
    { node: { [query === status.ITEMS_QUERY ? "items" : "statusUpdates"]: { nodes: [], pageInfo: { hasNextPage: false } } } };
  assert.throws(() => f.publish({}, { request: badMutation }), /baseline not saved/);
  assert.ok(!fs.existsSync(f.stateFile));
});

// Exercise the actual shell routing and gh --input JSON using a fake gh.
// Every subprocess inherits this PATH; no live gh or API is reachable.
const BIN = path.join(WORK, "bin");
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'project' && args[1] === 'view') {
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
  process.stdout.write('PVT_selected\\n');
} else if (args.join(' ') === 'api graphql --input -') {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(payload) + '\\n');
  if (process.env.FAKE_ERROR) {
    process.stderr.write(process.env.FAKE_ERROR); process.exit(1);
  }
  const s = require(${JSON.stringify(path.join(__dirname, "..", "lib", "board-status-update.js"))});
  const store = JSON.parse(fs.readFileSync(process.env.FAKE_STORE, 'utf8'));
  if (payload.query === s.MUTATION) {
    const update = { id: 'U_one', project: {url: 'https://github.com/orgs/example/projects/7'},
      createdAt: new Date().toISOString(), body: payload.variables.body };
    store.updates = [update]; fs.writeFileSync(process.env.FAKE_STORE, JSON.stringify(store));
    process.stdout.write(JSON.stringify({data: {createProjectV2StatusUpdate: {statusUpdate: update}}}));
  } else if (process.env.FAKE_GRAPHQL_ERROR) {
    process.stdout.write(JSON.stringify({errors: [{message: 'permission denied'}]}));
  } else {
    const field = payload.query === s.ITEMS_QUERY ? 'items' : 'statusUpdates';
    process.stdout.write(JSON.stringify({data: {node: {[field]: {nodes: field === 'items' ? (store.items || []) : store.updates,
      pageInfo: {hasNextPage: false}}}}}));
  }
} else { process.stderr.write('unexpected fake gh call: ' + args.join(' ')); process.exit(1); }
`, { mode: 0o755 });

function cliFixture() {
  const dir = path.join(WORK, `cli-${serial++}`);
  fs.mkdirSync(dir);
  const store = path.join(dir, "store.json");
  const calls = path.join(dir, "calls");
  fs.writeFileSync(store, JSON.stringify({ updates: [] }));
  const config = path.join(dir, "operator.json");
  fs.writeFileSync(config, "{}");
  const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, HOME: dir,
    XDG_CACHE_HOME: path.join(dir, "cache"), XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CONFIG_HOME: path.join(dir, "config"), BOT_OPERATOR_CONFIG: config,
    FAKE_STORE: store, FAKE_CALLS: calls, GH_TOKEN: "", GITHUB_TOKEN: "" };
  const args = [path.join(__dirname, "..", "bin", "bot-board"), "--project", "orgs/example/7", "status-update"];
  return { env, args, calls, store, run: (extra = [], vars = {}) => spawnSync("bash", [...args, ...extra],
    { env: { ...env, ...vars }, encoding: "utf8" }) };
}

test("shell resolves the selected project, prints mutation URL and auto skips", () => {
  const f = cliFixture();
  const r = f.run(["--status", "off-track"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "https://github.com/orgs/example/projects/7\n");
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], ["project", "view", "7", "--owner", "example", "--format", "json", "--jq", ".id"]);
  assert.equal(calls.find((c) => c.query === status.MUTATION).variables.project, "PVT_selected");
  assert.match(f.run(["--auto"]).stdout, /four-hour throttle/);
});

test("CLI rejects bad flags and unreadable or invalid bodies before project resolution", () => {
  const f = cliFixture();
  const body = path.join(path.dirname(f.store), "body.md");
  const cases = [
    { args: ["--unknown"], message: /unknown argument/ },
    { args: ["--status", "bad"], message: /--status must/ },
    { args: ["--status", "toString"], message: /--status must/ },
    { args: ["--since", "yesterday"], message: /ISO timestamp/ },
    { args: ["--body"], message: /requires an argument/ },
    { args: ["--auto", "--body", body], message: /cannot be combined/ },
    { args: [], vars: { BOT_BOARD_STATUS_P0_HOURS: "0" }, message: /positive number/ },
    { args: ["--body", body], message: /ENOENT/ },
    { args: ["--body", path.dirname(body)], message: /cannot read --body/ },
    { args: ["--body", body], contents: " \n", message: /empty/ },
    { args: ["--body", body], contents: Buffer.from([0xc3, 0x28]), message: /UTF-8/ },
    { args: ["--body", body], contents: "x".repeat(65536), message: /body limit/ },
  ];
  if (process.getuid?.() !== 0) cases.push({ args: ["--body", body], contents: "Valid text", mode: 0, message: /EACCES/ });
  for (const { args, vars, contents, mode, message } of cases) {
    if (contents !== undefined) fs.writeFileSync(body, contents);
    if (mode !== undefined) fs.chmodSync(body, mode);
    const r = f.run(args, vars);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, "");
    assert.ok(!fs.existsSync(f.calls), `remote call before validation: ${args}`);
    assert.ok(!fs.existsSync(f.env.XDG_STATE_HOME), "preflight must not create publication state");
  }
  fs.chmodSync(body, 0o600);
});

test("CLI reads only the public heartbeat and scopes it to the selected project", () => {
  const f = cliFixture();
  const i = item("selected", { status: "In Progress" });
  const done = item("done", { status: "Done" });
  const closed = item("closed", { state: "CLOSED" });
  const merged = item("merged", { state: "MERGED" });
  fs.writeFileSync(f.store, JSON.stringify({ updates: [], items: [i, done, closed, merged].map(node) }));
  const dir = path.join(f.env.XDG_STATE_HOME, "bot-heartbeat");
  fs.mkdirSync(dir, { recursive: true });
  const worker = (name, item_url, age = 0) => ({ name, item_url, status: "testing",
    last_activity_at: new Date(Date.now() - age).toISOString() });
  fs.writeFileSync(path.join(dir, "last-publish.json"), JSON.stringify({
    input: { workers: [worker("private-worker", i.url)] },
    published: { workers: [worker("public-worker", i.url), worker("done-worker", done.url),
      worker("closed-worker", closed.url), worker("merged-worker", merged.url), worker("other-project-worker", item("other").url),
      worker("stale-worker", i.url, 7 * 3600000)] },
  }));
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(fs.readFileSync(f.store, "utf8")).updates[0].body;
  assert.match(body, /public-worker/);
  assert.doesNotMatch(body, /private-worker|other-project-worker|stale-worker|done-worker|closed-worker|merged-worker/);
  // Older saved state with no public publication must not fall back to input.
  fs.writeFileSync(path.join(dir, "last-publish.json"), JSON.stringify({ input: { workers: [worker("private-worker", i.url)] } }));
  assert.equal(f.run().status, 0);
  assert.doesNotMatch(JSON.parse(fs.readFileSync(f.store, "utf8")).updates[0].body, /private-worker/);
});

test("fake gh rate limits and GraphQL errors propagate", () => {
  for (const [vars, code, message] of [[{ FAKE_ERROR: "API rate limit exceeded" }, 75, /rate limit/],
    [{ FAKE_GRAPHQL_ERROR: "1" }, 1, /permission denied/]]) {
    const r = cliFixture().run([], vars);
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, message);
  }
});

test("concurrent automatic CLI publishers post only once under the local flock", async () => {
  const f = cliFixture();
  const run = () => new Promise((resolve) => {
    const p = spawn("bash", [...f.args, "--auto"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (s) => { stderr += s; });
    p.on("close", (code) => resolve({ code, stderr }));
  });
  for (const r of await Promise.all([run(), run()])) assert.equal(r.code, 0, r.stderr);
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((c) => c.query === status.MUTATION).length, 1);
});

test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

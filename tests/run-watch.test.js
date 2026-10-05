"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { watch, reason } = require("../lib/run-watch.js");
const { key } = require("../lib/run-health.js");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const at = (n) => new Date(NOW - n * 60e3).toISOString();
const repo = "example/devspace";
const run = { repo, id: 42, run_attempt: 1, status: "in_progress", jobs: [{ name: "Agent", status: "in_progress",
  steps: [{ name: "Run agent", status: "in_progress", started_at: at(30) }] }] };
const item = { id: "PVTI_test", title: "Test", status: "In Progress", run: `https://github.com/${repo}/actions/runs/42`, "budget tokens": 100 };
const observation = { schema: "run-observation/v1", repo, run_id: 42, attempt: 1, observed_at: at(0),
  last_activity_at: at(20), window_started_at: at(10), tokens: { input: 10, output: 1, cache_write: 0 }, events: [] };

function harness() {
  const state = { version: 1, runs: {} }, calls = [];
  let current = structuredClone(run), board = [structuredClone(item)], telemetry = [structuredClone(observation)];
  const io = {
    api: (endpoint) => { calls.push(endpoint); return endpoint.includes("/jobs?") ? { total_count: 1, jobs: current.jobs } : current; },
    board: () => board, observations: async () => telemetry, save: () => calls.push("save"),
    cancel: () => { calls.push("cancel"); current = { ...current, status: "completed", conclusion: "cancelled" }; },
    set: (id, args) => calls.push([id, ...args]), warn: () => {},
    updateRun: (owner, result, opts) => { calls.push({ publication: structuredClone({ owner, result, opts }) }); return true; },
    deregister: (name) => { calls.push({ cleanup: name }); return true; },
  };
  const sweep = (now = NOW, extra = {}) => watch({ repo, workflow: "agent.yml", now, board: [item], runs: [current], state, ...extra }, io);
  return { state, calls, io, sweep, run: (r) => { current = r; }, board: (b) => { board = b; }, telemetry: (t) => { telemetry = t; } };
}

test("grace persists, cancel once, confirm then Todo/Why/clear Run", async () => {
  const h = harness();
  await h.sweep(NOW, { apply: true });
  assert.equal(h.calls.includes("cancel"), false);
  // Refresh observation timestamp; inactivity alone must not mean a stale feed.
  h.telemetry([{ ...observation, observed_at: new Date(NOW + 5 * 60e3).toISOString() }]);
  const outcome = await h.sweep(NOW + 5 * 60e3, { apply: true });
  assert.equal(outcome.failed, false);
  assert.equal(h.calls.filter((c) => c === "cancel").length, 1);
  const update = h.calls.find(Array.isArray);
  assert.ok(update.includes("Todo"));
  assert.ok(update.some((s) => s.startsWith("Run watch stalled:")));
  assert.ok(h.state.runs[key(run)].cancel_confirmed);
  assert.match(reason(h.state, repo, 42, 1, item.id), /stalled/);
  assert.equal(reason(h.state, repo, 42, 2, item.id), "");
  await h.sweep(NOW + 6 * 60e3, { apply: true });
  assert.equal(h.calls.filter((c) => c === "cancel").length, 1);
  assert.equal(h.calls.filter(Array.isArray).length, 1);
  assert.equal(h.calls.filter((c) => c.cleanup === "run-42").length, 1);
  assert.ok(h.calls.findIndex((c) => c.cleanup) < h.calls.findIndex(Array.isArray));
});

test("heartbeat updates require live apply and a unique fresh owner", async () => {
  for (const extra of [{}, { apply: true, dryRun: true }, { apply: true, offline: true },
    { apply: true, runsFile: "fixture.json" }, { apply: true, observationsFile: "fixture.json" }]) {
    const h = harness();
    await h.sweep(NOW, extra);
    assert.equal(h.calls.some((c) => c.publication), false);
  }
  const h = harness();
  h.board([{ ...item, title: "Fresh title" }]);
  await h.sweep(NOW, { apply: true });
  const publication = h.calls.find((c) => c.publication).publication;
  assert.equal(publication.owner.title, "Fresh title");
  assert.equal(publication.result.item, item.id);
  assert.equal(publication.result.run, item.run);
  assert.equal(publication.result.observed_at, observation.observed_at);
  assert.equal(publication.opts.evaluatedAt, at(0));
  for (const fresh of [[{ ...item, status: "Todo", run: "" }], [{ ...item, lead: "topic" }],
    [item, { ...item, id: "PVTI_other" }], [item, { ...item, id: "PVTI_alias", run: item.run.toUpperCase() + "/" }]]) {
    const skipped = harness();
    skipped.board(fresh);
    await skipped.sweep(NOW, { apply: true });
    assert.equal(skipped.calls.some((c) => c.publication), false);
  }
});

test("publication, returned health and stored health use fresh recovery/unknown evidence", async () => {
  for (const healthy of [true, false]) {
    const h = harness();
    await h.sweep();
    let n = 0;
    const fresh = healthy ? [{ ...observation, last_activity_at: at(0) }] : [];
    h.io.observations = async () => ++n === 1 ? [observation] : fresh;
    const outcome = await h.sweep(NOW + 5 * 60e3, { apply: true });
    const expected = healthy ? "healthy" : "unknown";
    assert.equal(outcome.results[0].health, expected);
    assert.equal(h.state.runs[key(run)].result.health, expected);
    assert.equal(h.calls.find((c) => c.publication).publication.result.health, expected);
    assert.equal(h.calls.includes("cancel"), false);
  }
});

test("false or throwing heartbeat publication warns without suppressing cancellation", async () => {
  for (const throws of [false, true]) {
    const h = harness(), warnings = [];
    h.io.warn = (message) => warnings.push(message);
    h.io.updateRun = () => { if (throws) throw new Error("unavailable"); return false; };
    const outcome = await h.sweep(NOW, { apply: true, graceMs: 0 });
    assert.equal(outcome.failed, false);
    assert.ok(warnings.some((w) => /heartbeat publication.*failed/.test(w)));
    assert.ok(outcome.results[0].actions.some((a) => a.type === "heartbeat" && a.status === "failed"));
    assert.equal(h.calls.filter((c) => c === "cancel").length, 1);
  }
});

test("completed/cancelled runs never publish, including after Todo cleared Run", async () => {
  for (const conclusion of ["success", "cancelled"]) {
    const h = harness();
    h.run({ ...run, status: "completed", conclusion });
    await h.sweep(NOW, { apply: true });
    assert.equal(h.calls.some((c) => c.publication), false);
    const staleListing = harness();
    staleListing.io.api = () => ({ ...run, status: "completed", conclusion });
    assert.equal((await staleListing.sweep(NOW, { apply: true })).results[0].health, "unknown");
    assert.equal(staleListing.calls.some((c) => c.publication), false);
  }
  const h = harness();
  await h.sweep(NOW, { apply: true, graceMs: 0 });
  const published = h.calls.filter((c) => c.publication).length;
  await h.sweep(NOW, { apply: true, board: [{ ...item, status: "Todo", run: "" }] });
  assert.equal(h.calls.filter((c) => c.publication).length, published);
});

test("failed cleanup retries after Run is cleared, but cannot remove a newer attempt", async () => {
  for (const rerun of [false, true]) {
    const h = harness(), warnings = [];
    h.io.warn = (message) => warnings.push(message);
    h.io.deregister = () => false;
    assert.equal((await h.sweep(NOW, { apply: true, graceMs: 0 })).failed, true);
    assert.ok(h.state.runs[key(run)].board_applied);
    assert.equal(h.state.runs[key(run)].heartbeat_cleaned, false);
    assert.ok(warnings.some((w) => /heartbeat cleanup/.test(w)));
    let cleaned = 0;
    h.io.deregister = () => { cleaned++; return true; };
    if (rerun) h.run({ ...run, run_attempt: 2 });
    await h.sweep(NOW, { apply: true, board: [{ ...item, status: "Todo", run: "" }], runs: [] });
    assert.equal(cleaned, rerun ? 0 : 1);
    assert.equal(h.state.runs[key(run)].heartbeat_cleaned, !rerun);
  }
});

test("dry run is read-only; recovery and new attempts restart grace", async () => {
  const h = harness();
  await h.sweep(NOW, { dryRun: true, apply: true });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.state.runs, {});
  assert.equal(h.state.runs[key(run)]?.cancel_requested, undefined);
  await h.sweep();
  h.telemetry([{ ...observation, last_activity_at: at(0) }]);
  await h.sweep();
  assert.equal(h.state.runs[key(run)].since, null);
  h.run({ ...run, run_attempt: 2 });
  h.telemetry([{ ...observation, attempt: 2 }]);
  await h.sweep(NOW, { apply: true });
  assert.equal(h.calls.includes("cancel"), false);
});

test("metadata outages break grace without losing durable cancellation flags", async () => {
  for (const listing of [false, true]) {
    const h = harness();
    await h.sweep(NOW);
    const get = h.io.api;
    h.io.api = () => { throw new Error("metadata outage"); };
    if (listing) {
      await assert.rejects(h.sweep(NOW + 5 * 60e3, { runs: undefined }), /metadata unavailable/);
    } else {
      h.run({ ...run, jobs: undefined });
      assert.equal((await h.sweep(NOW + 5 * 60e3)).failed, true);
    }
    assert.equal(h.state.runs[key(run)].since, null);
    assert.equal(h.state.runs[key(run)].health, "unknown");
    h.io.api = get;
    h.run(structuredClone(run));
    h.telemetry([{ ...observation, observed_at: new Date(NOW + 6 * 60e3).toISOString() }]);
    await h.sweep(NOW + 6 * 60e3, { apply: true });
    assert.equal(h.calls.includes("cancel"), false);
    assert.equal(h.state.runs[key(run)].since, NOW + 6 * 60e3);
    Object.assign(h.state.runs[key(run)], { cancel_requested: true, cancel_confirmed: true, heartbeat_cleaned: true });
    h.run({ ...run, jobs: undefined });
    h.io.api = () => { throw new Error("metadata outage"); };
    await h.sweep(NOW + 7 * 60e3);
    for (const flag of ["cancel_requested", "cancel_confirmed", "heartbeat_cleaned"]) assert.equal(h.state.runs[key(run)][flag], true);
  }
});

test("workflow collection paginates and reads the exact attempt's active steps", async () => {
  const endpoints = [];
  const outcome = await watch({ repo, workflow: "agent.yml", now: NOW, board: [item], dryRun: true }, {
    api: (endpoint) => {
      endpoints.push(endpoint);
      if (endpoint.endsWith("page=1")) return { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ ...run, id: 1000 + i })) };
      if (endpoint.endsWith("page=2")) return { workflow_runs: [{ ...run, jobs: undefined }] };
      return { total_count: 1, jobs: run.jobs };
    }, observations: async () => [observation],
  });
  assert.equal(outcome.results[0].health, "stalled");
  assert.ok(endpoints[2].includes("/42/attempts/1/jobs?"));
});

test("unavailable read URL and malformed offline observations are conservative unknown", async () => {
  const original = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => { calls++; throw new Error("unavailable"); };
    const opts = { repo, now: NOW, board: [item], runs: [run], dryRun: true };
    assert.equal((await watch({ ...opts, readURL: "https://telemetry.invalid/observations" })).results[0].health, "unknown");
    assert.equal(calls, 1);
    assert.equal((await watch({ ...opts, readURL: "https://user:pass@telemetry.invalid/" })).results[0].health, "unknown");
    assert.equal(calls, 1);
    assert.equal((await watch({ ...opts, observationsFile: "/nonexistent-observations" })).results[0].health, "unknown");
  } finally { global.fetch = original; }
});

test("fresh ownership/status/attempt/telemetry guards refuse cancellation", async () => {
  for (const change of [
    (h) => h.board([{ ...item, lead: "topic" }]),
    (h) => h.board([{ ...item, status: "Draft" }]),
    (h) => h.board([{ ...item, run: item.run + "1" }]),
    (h) => h.board([item, { ...item, id: "PVTI_duplicate" }]),
    (h) => h.io.api = (endpoint) => endpoint.includes("/jobs?") ? { jobs: run.jobs } : { ...run, run_attempt: 2 },
    (h) => h.io.api = (endpoint) => endpoint.includes("/jobs?") ? { jobs: [] } : { ...run, status: "completed", conclusion: "success" },
    (h) => h.io.api = (endpoint) => endpoint.includes("/jobs?") ? { total_count: 1, jobs: [] } : run,
    (h) => { let n = 0; h.io.observations = async () => ++n === 1 ? [observation] : []; },
  ]) {
    const h = harness();
    await h.sweep();
    change(h);
    await h.sweep(NOW + 5 * 60e3, { apply: true });
    assert.equal(h.calls.includes("cancel"), false);
  }
  const duplicate = harness();
  duplicate.board([item, { ...item, id: "PVTI_duplicate" }]);
  const ambiguous = await duplicate.sweep(NOW, { board: [item, { ...item, id: "PVTI_duplicate" }], apply: true, graceMs: 0 });
  assert.equal(ambiguous.results[0].health, "unknown");
  assert.equal(duplicate.calls.includes("cancel"), false);
  for (const change of [{ lead: "topic" }, { workflow: "manual" }, { status: "Todo" }]) {
    const h = harness();
    assert.equal((await h.sweep(NOW, { board: [{ ...item, ...change }] })).results.length, 0);
  }
});

test("failing and runaway cancellation use refreshed evidence and actual item budget", async () => {
  for (const kind of ["failing", "runaway"]) {
    const h = harness();
    const telemetry = (now) => ({ ...observation, observed_at: new Date(now).toISOString(), last_activity_at: new Date(now).toISOString(),
      tokens: { input: kind === "runaway" ? 200 : 10, output: 1, cache_write: 0 },
      events: kind === "failing" ? Array(6).fill({ at: new Date(now).toISOString(), kind: "request", error: true }) : [] });
    h.telemetry([telemetry(NOW)]);
    assert.equal((await h.sweep()).results[0].health, kind);
    h.telemetry([telemetry(NOW + 5 * 60e3)]);
    assert.equal((await h.sweep(NOW + 5 * 60e3, { apply: true })).failed, false);
    assert.equal(h.calls.filter((c) => c === "cancel").length, 1);
  }
  const h = harness();
  h.telemetry([{ ...observation, tokens: { input: 200, output: 1, cache_write: 0 } }]);
  await h.sweep();
  h.board([{ ...item, "budget tokens": 500 }]);
  await h.sweep(NOW + 5 * 60e3, { apply: true });
  assert.equal(h.calls.includes("cancel"), false);
});

test("cancellation pending changes no board; failed update retries without recancel", async () => {
  const h = harness();
  h.io.cancel = () => h.calls.push("cancel");
  await h.sweep();
  await h.sweep(NOW + 5 * 60e3, { apply: true });
  assert.equal(h.calls.some(Array.isArray), false);
  h.run({ ...run, status: "completed", conclusion: "cancelled" });
  h.io.set = () => { throw new Error("board down"); };
  assert.equal((await h.sweep(NOW + 5 * 60e3, { apply: true, runs: [] })).failed, true);
  h.io.set = (id, args) => h.calls.push([id, ...args]);
  assert.equal((await h.sweep(NOW + 5 * 60e3, { apply: true, runs: [] })).failed, false);
  assert.equal(h.calls.filter((c) => c === "cancel").length, 1);
});

test("ambiguous cancel error is never posted twice; absent/unusable feed remains unknown", async () => {
  const h = harness();
  h.io.cancel = () => { h.calls.push("cancel"); throw new Error("transport lost"); };
  await h.sweep();
  assert.equal((await h.sweep(NOW + 5 * 60e3, { apply: true })).failed, true);
  await h.sweep(NOW + 5 * 60e3, { apply: true });
  assert.equal(h.calls.filter((c) => c === "cancel").length, 1);
  for (const telemetry of [[], {}, [observation, observation]]) {
    const fresh = harness();
    fresh.telemetry(telemetry);
    const outcome = await fresh.sweep();
    assert.equal(outcome.results[0].health, "unknown");
  }
});

test("offline CLI persists reports, dryrun unchanged; reconcile preserves watch reason without artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-watch-"));
  try {
    for (const [name, data] of Object.entries({ board: [item], runs: [run], observations: [observation] })) fs.writeFileSync(path.join(tmp, `${name}.json`), JSON.stringify(data));
    const stateFile = path.join(tmp, "state.json");
    const args = [path.resolve(__dirname, "../lib/run-watch.js"), "--board-file", path.join(tmp, "board.json"), "--runs-file", path.join(tmp, "runs.json"), "--observations-file", path.join(tmp, "observations.json"), "--state-file", stateFile, "--now", at(0), "--json"];
    const env = { ...process.env, BOT_RUNS_REPO: repo };
    const output = JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8" }));
    assert.equal(output[0].health, "stalled");
    const before = fs.readFileSync(stateFile, "utf8");
    execFileSync(process.execPath, [...args, "--dry-run"], { env });
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
    // Fake gh only returns completed cancellation metadata. Any artifact call
    // would fail the JSON parser, so this exercises the summary-free path.
    const state = JSON.parse(before);
    Object.assign(state.runs[key(run)], { cancel_requested: true, why: "Run watch stalled: no activity" });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const fake = path.join(tmp, "gh");
    fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n' + JSON.stringify(${JSON.stringify({ id: 42, run_attempt: 1, status: "completed", conclusion: "cancelled" })}));\n`);
    fs.chmodSync(fake, 0o700);
    const reconciled = JSON.parse(execFileSync("bash", [path.resolve(__dirname, "../bin/bot-runs"), "reconcile", "--board-file", path.join(tmp, "board.json"), "--json"], {
      env: { ...env, PATH: `${tmp}:${process.env.PATH}`, XDG_CACHE_HOME: tmp, BOT_RUNS_WATCH_STATE: stateFile }, encoding: "utf8",
    }));
    assert.ok(reconciled[0].set.includes("Run watch stalled: no activity"));
    const boardCommand = path.join(tmp, "board-command");
    const writes = path.join(tmp, "writes");
    fs.writeFileSync(boardCommand, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('list')) process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(tmp, "fresh.json"))}));
else fs.appendFileSync(${JSON.stringify(writes)}, JSON.stringify(process.argv) + '\\n');
`);
    fs.chmodSync(boardCommand, 0o700);
    const heartbeatCommand = path.join(tmp, "heartbeat-command");
    fs.writeFileSync(heartbeatCommand, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(writes)}, 'cleanup\\n');\n`);
    fs.chmodSync(heartbeatCommand, 0o700);
    // The apply snapshot is still coordinator-owned. Fresh ownership must
    // refuse all writes, including News and heartbeat cleanup.
    for (const fresh of [[{ ...item, lead: "topic" }], [{ ...item, workflow: "manual" }],
      [item, { ...item, id: "PVTI_duplicate" }], [{ ...item, status: "Todo" }]]) {
      fs.writeFileSync(path.join(tmp, "fresh.json"), JSON.stringify(fresh));
      const refused = JSON.parse(execFileSync("bash", [path.resolve(__dirname, "../bin/bot-runs"), "reconcile", "--apply", "--board-file", path.join(tmp, "board.json"), "--json"], {
        env: { ...env, PATH: `${tmp}:${process.env.PATH}`, XDG_CACHE_HOME: tmp, BOT_RUNS_WATCH_STATE: stateFile,
          BOT_RUNS_BOT_BOARD: boardCommand, BOT_RUNS_HEARTBEAT: heartbeatCommand }, encoding: "utf8",
      }));
      assert.equal(refused[0].set, null);
      assert.equal(fs.existsSync(writes), false);
    }
    fs.writeFileSync(path.join(tmp, "fresh.json"), JSON.stringify([item]));
    const counter = path.join(tmp, "metadata-count");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const count = fs.existsSync(${JSON.stringify(counter)}) ? 2 : 1;
fs.writeFileSync(${JSON.stringify(counter)}, 'read');
process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n' + JSON.stringify({id: 42, run_attempt: count, status: 'completed', conclusion: 'cancelled'}));
`);
    const rerun = JSON.parse(execFileSync("bash", [path.resolve(__dirname, "../bin/bot-runs"), "reconcile", "--apply", "--board-file", path.join(tmp, "board.json"), "--json"], {
      env: { ...env, PATH: `${tmp}:${process.env.PATH}`, XDG_CACHE_HOME: tmp, BOT_RUNS_WATCH_STATE: stateFile,
        BOT_RUNS_BOT_BOARD: boardCommand, BOT_RUNS_HEARTBEAT: heartbeatCommand }, encoding: "utf8",
    }));
    assert.equal(rerun[0].set, null);
    assert.equal(fs.existsSync(writes), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

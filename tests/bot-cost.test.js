// Offline tests of bin/bot-cost against the synthetic transcripts, runs and
// prices in tests/fixtures/bot-cost (a fake gh serves the Actions runs and
// jobs, a fake bot-runs the agent runs). Run with tests/bot-cost.sh, or
// node --test tests/bot-cost.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FIXTURES = path.join(__dirname, "fixtures", "bot-cost");
const TOOL = path.join(__dirname, "..", "bin", "bot-cost");
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cost-test-"));
const GH_LOG = path.join(CACHE, "gh.log");
const ENV = {
  ...process.env, XDG_CACHE_HOME: CACHE, FAKE_GH_LOG: GH_LOG, BOT_COST_NOW: "2026-09-22T00:00:00Z",
  BOT_COST_GH: path.join(FIXTURES, "fake-gh"), BOT_COST_BOT_RUNS: path.join(FIXTURES, "fake-bot-runs"),
  BOT_COST_MODELS_JSON: path.join(FIXTURES, "models.json"),
};
const ARGS = ["--since", "2026-09-20", "--until", "2026-09-23", "--projects", path.join(FIXTURES, "projects", "proj")];

// The module reads its environment once, at load.
Object.assign(process.env, ENV);
const cost = require(TOOL);
test.after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

const run = (args) => execFileSync(TOOL, args, { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`);

test("times: ages, today and yesterday, and splitting at midnight UTC", () => {
  const now = new Date("2026-09-21T15:30:00Z");
  const cases = [
    ["today", "2026-09-21T00:00:00.000Z"],
    ["yesterday", "2026-09-20T00:00:00.000Z"],
    ["12h", "2026-09-21T03:30:00.000Z"],
    ["2d", "2026-09-19T15:30:00.000Z"],
    ["2026-09-01", "2026-09-01T00:00:00.000Z"],
  ];
  for (const [s, want] of cases) assert.equal(cost.parseTime(s, now).toISOString(), want, s);
  assert.throws(() => cost.parseTime("soon", now), /not an age/);
  assert.deepEqual(cost.splitByDay(Date.parse("2026-09-20T23:00:00Z"), Date.parse("2026-09-22T01:00:00Z")),
    [["2026-09-20", 3600], ["2026-09-21", 86400], ["2026-09-22", 3600]]);
});

test("runner size and kind come from the job's labels and group", () => {
  const cases = [
    [{ labels: ["rhel10-x86_64-16c-64g"], runner_group_name: "rhel10" }, false, 16, "other"],
    [{ labels: ["rhel10-x86_64-64c-256g"], runner_group_name: "rhel10" }, false, 64, "other"],
    [{ labels: ["ubuntu-24.04-16core"], runner_group_name: "Default" }, false, 16, "other"],
    [{ labels: ["ubuntu-24.04"], runner_group_name: "GitHub Actions" }, false, 4, "standard"],
    [{ labels: ["ubuntu-latest"], runner_group_name: "GitHub Actions" }, true, 2, "standard"],
    [{ labels: ["self-hosted", "linux"], runner_group_name: "Default" }, false, null, "unknown"],
  ];
  for (const [job, priv, cores, kind] of cases) {
    const r = cost.runnerOf(job, priv);
    assert.deepEqual([r.cores, r.kind], [cores, kind], job.labels.join(","));
  }
});

test("runner rates are GitHub's list rates, rounding sizes up", () => {
  const cases = [[4, 0.012], [16, 0.042], [64, 0.162], [12, 0.042], [192, 0.504]];
  for (const [cores, want] of cases) close(cost.usdPerMinute(cores), want, `${cores} cores`);
});

test("model ids resolve to models.dev entries", () => {
  const models = JSON.parse(fs.readFileSync(path.join(FIXTURES, "models.json"), "utf8"));
  const cases = [
    ["claude-opus-5-5", "anthropic/claude-opus-5-5"],
    ["claude-opus-5-5[1m]", "anthropic/claude-opus-5-5"],
    ["claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5"],
    ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"],
    ["gizmo-1", "elsewhere/gizmo-1"],
    ["mystery-9", null],
  ];
  for (const [id, want] of cases) assert.equal((cost.modelPrice(models, id) || { id: null }).id, want, id);
});

test("message prices cover cache writes, long context and fast mode", () => {
  const models = JSON.parse(fs.readFileSync(path.join(FIXTURES, "models.json"), "utf8"));
  const u = (o) => ({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, speed: null, ...o });
  const cases = [
    ["claude-opus-5-5", u({ input: 1e6, output: 1e6 }), 24],
    ["claude-opus-5-5", u({ cache_read: 1e6, cache_write_5m: 1e6, cache_write_1h: 1e6 }), 0.2 + 5 + 8],
    ["claude-sonnet-4-5", u({ input: 100000, output: 1e6 }), 0.3 + 15],
    ["claude-sonnet-4-5", u({ input: 150000, cache_read: 100000, output: 1e6 }), 0.9 + 0.06 + 22.5],
    ["claude-sonnet-4-5", u({ input: 100000, output: 1e6, speed: "fast" }), 0.6 + 30],
  ];
  for (const [model, usage, want] of cases) close(cost.usdOf(cost.modelPrice(models, model), usage), want, `${model} ${JSON.stringify(usage)}`);
});

test("devspace names come from start commands, not prose", () => {
  const cases = [
    ["bot-devspace start --cores 16 --duration 120 cfs-x", ["cfs-x"]],
    ["NAME=b-2482; bot-devspace start --cores 4 \"$NAME\" > /tmp/log 2>&1", ["b-2482"]],
    ["~/h/bin/bot-devspace start --ref main --no-provision ${N}", []],
    ["echo 'bot-devspace start there fell back to runner'", []],
    ["bot-devspace start --cores 64 BAD_Name", []],
    ["bot-devspace stop cfs-x", []],
  ];
  for (const [cmd, want] of cases) assert.deepEqual(cost.devspacesStarted(cmd), want, cmd);
});

test("the fixture window adds up per day, per model and per task", async () => {
  const s = JSON.parse(run([...ARGS, "--json"]));
  assert.equal(s.schema, "bot-cost/v1");
  assert.equal(s.estimate, true);
  // The window stops at now.
  assert.equal(s.window.until, "2026-09-22T00:00:00.000Z");
  const days = Object.fromEntries(s.days.map((d) => [d.date, d]));
  assert.deepEqual(Object.keys(days), ["2026-09-20", "2026-09-21"]);

  // 09-20: devspace 101's first hour (16 cores), run 104 (no size), agent
  // runs 201 (30 min) and 202 (10 min) on 4-core standard runners.
  const d20 = days["2026-09-20"];
  assert.equal(d20.compute.runs, 4);
  close(d20.compute.core_hours, 16 + 2 + 4 / 6, "09-20 core-hours");
  close(d20.compute.list_usd, 60 * 0.042 + 40 * 0.012, "09-20 compute");
  // The coordinator's message, the worker's (priced once, with its final
  // usage and 1-hour cache writes), and run 201's two long- and short-context requests.
  const coordinator = (10 * 4 + 1000 * 20 + 1e6 * 0.2) / 1e6;
  const worker = (100 * 4 + 2000 * 20 + 50000 * 0.2 + 6000 * 5 + 4000 * 8) / 1e6;
  const agentRun = (250000 * 6 + 1000 * 22.5 + 1000 * 3 + 100 * 15) / 1e6;
  close(d20.inference.usd, coordinator + worker + agentRun, "09-20 inference");
  assert.equal(d20.inference.mock_tokens, 1100);
  assert.equal(d20.inference.unpriced_tokens, 0);

  // 09-21: devspace 101's second hour and devspace 102, still running, for
  // its hour on 64 cores; the reviewer's message and an unknown model.
  const d21 = days["2026-09-21"];
  assert.equal(d21.compute.runs, 2);
  close(d21.compute.core_hours, 16 + 64, "09-21 core-hours");
  close(d21.compute.list_usd, 60 * 0.042 + 60 * 0.162, "09-21 compute");
  close(d21.inference.usd, (1000 * 20) / 1e6, "09-21 inference");
  assert.equal(d21.inference.unpriced_tokens, 1000);
  close(s.totals.total_usd, s.days.reduce((n, d) => n + d.total_usd, 0), "total");

  assert.deepEqual(s.runs.map((r) => r.run_id).sort(), [101, 102, 104, 201, 202]);
  const byRun = Object.fromEntries(s.runs.map((r) => [r.run_id, r]));
  assert.equal(byRun[102].running, true);
  assert.deepEqual([byRun[104].cores, byRun[104].kind], [null, "unknown"]);
  assert.deepEqual([byRun[201].billed, byRun[201].inference_source, byRun[202].mock], ["free", "token-usage", true]);
  assert.equal(byRun[101].billed, "unknown");

  const models = Object.fromEntries(s.models.map((m) => [m.model, m]));
  assert.equal(models["mystery-9"].priced_as, null);
  assert.equal(models["claude-opus-5-5[1m]"].priced_as, "anthropic/claude-opus-5-5");

  // Devspace cfs-x belongs to the worker that started it, and so to its item.
  const tasks = Object.fromEntries(s.tasks.map((t) => [t.key, t]));
  const t1 = tasks.PVTI_item1;
  assert.deepEqual([t1.scratch, t1.devspaces, t1.label], ["cfs-x", ["cfs-x"], "Fix the cfs thing"]);
  close(t1.core_hours, 32, "item1 core-hours");
  close(t1.inference_usd, worker, "item1 inference");
  assert.equal(t1.tokens, 100 + 2000 + 50000 + 10000 + 1000);
  close(tasks.PVTI_item2.inference_usd, agentRun, "item2 inference");
  close(tasks["devspace:big"].core_hours, 64, "unowned devspace");
  assert.deepEqual(tasks["agent:r1"].devspaces, []);
  assert.equal(tasks["agent:r1"].scratch, null);
  assert.ok(tasks["session:sess1"]);

  // What a run footer needs per task: when its messages ran, which
  // sessions, subagents and Actions runs it had, and its tokens per model.
  const tok = (o) => ({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, ...o });
  const RUNS = "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs";
  const AGENT_RUNS = "https://github.com/cgwalters-bot/cgwalters-devspace-sandbox/actions/runs";
  const footerCases = [
    ["PVTI_item1", "2026-09-20T22:00:01.000Z", "2026-09-21T01:00:00.000Z", ["sess1"], ["w1"], [`${RUNS}/101`], {
      "claude-opus-5-5": [tok({ input: 100, output: 2000, cache_read: 50000, cache_write_5m: 6000, cache_write_1h: 4000 }), worker],
      "mystery-9": [tok({ input: 500, output: 500 }), 0],
    }],
    ["PVTI_item2", "2026-09-20T12:10:00.500Z", "2026-09-20T12:20:00.500Z", [], [], [`${AGENT_RUNS}/201`], {
      "claude-sonnet-4-5": [tok({ input: 251000, output: 1100 }), agentRun],
    }],
    ["agent:r1", "2026-09-21T02:00:00.000Z", "2026-09-21T02:00:00.000Z", ["sess1"], ["r1"], [], {
      "claude-opus-5-5[1m]": [tok({ output: 1000 }), (1000 * 20) / 1e6],
    }],
    ["devspace:big", null, null, [], [], [`${RUNS}/102`], {}],
  ];
  for (const [key, first, last, sessions, subagents, runUrls, models] of footerCases) {
    const t = tasks[key];
    assert.deepEqual([t.first_message_at, t.last_message_at, t.sessions, t.subagents, t.run_urls],
      [first, last, sessions, subagents, runUrls], key);
    assert.deepEqual(Object.keys(t.models).sort(), Object.keys(models).sort(), `${key} models`);
    for (const [m, [tokens, usd]] of Object.entries(models)) {
      assert.deepEqual(t.models[m].tokens, tokens, `${key} ${m} tokens`);
      close(t.models[m].usd, usd, `${key} ${m} usd`);
    }
  }

  const notes = s.notes.join("\n");
  for (const want of [/group\(s\) rhel10 are not/, /free in public repositories/, /1 run\(s\) had a runner of unknown size/,
    /1k tokens of agent.yml runs came from the mock/, /No price on models.dev for model\(s\) mystery-9/, /1-hour cache writes/]) {
    assert.match(notes, want);
  }
});

test("text output is labeled an estimate and names its price sources", () => {
  const out = run([...ARGS, "--tasks", "3"]);
  assert.match(out, /^Estimated cost, 2026-09-20T00:00Z to 2026-09-22T00:00Z \(approximate: list prices, not a bill\)/);
  assert.match(out, /^2026-09-21 +2 +80\.0 +\$12\.24 /m);
  assert.match(out, /^total +5 /m);
  assert.match(out, /^By task \(top 3 of \d+\):$/m);
  assert.match(out, /^PVTI_item1 scratch cfs-x devspace cfs-x: Fix the cfs thing +32\.0 +\$5\.04 /m);
  assert.match(out, /^mystery-9 .* unpriced$/m);
  assert.match(out, /actions-runner-pricing \(checked in, retrieved \d{4}-\d{2}-\d{2}\)/);
  assert.match(out, /inference: .*models\.json/);
});

test("finished runs' jobs are cached, running ones refetched", () => {
  fs.rmSync(GH_LOG, { force: true });
  run([...ARGS, "--no-inference", "--json"]);
  const jobCalls = fs.readFileSync(GH_LOG, "utf8").split("\n").filter((l) => l.includes("/jobs"));
  assert.deepEqual(jobCalls.map((l) => /runs\/(\d+)\/jobs/.exec(l)[1]), ["102"]);
});

test("usage errors", () => {
  const cases = [
    [["--repo", "nope"], /--repo takes OWNER\/REPO/],
    [["--since", "later"], /not an age/],
    [["--since", "2026-09-21", "--until", "2026-09-20"], /the window is empty/],
    [["--bogus"], /unexpected argument/],
  ];
  for (const [args, want] of cases) {
    assert.throws(() => run(args), (e) => e.status === 2 && want.test(e.stderr), args.join(" "));
  }
});

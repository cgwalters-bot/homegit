// Offline tests of bin/bot-footer over bot-cost's fixtures (the synthetic
// transcripts, runs and prices in tests/fixtures/bot-cost, served by its
// fake gh and bot-runs). Run with tests/bot-footer.sh, or
// node --test tests/bot-footer.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FIXTURES = path.join(__dirname, "fixtures", "bot-cost");
const TOOL = path.join(__dirname, "..", "bin", "bot-footer");
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bot-footer-test-"));
const ENV = {
  ...process.env, XDG_CACHE_HOME: CACHE, BOT_COST_NOW: "2026-09-22T00:00:00Z",
  BOT_COST_GH: path.join(FIXTURES, "fake-gh"), BOT_COST_BOT_RUNS: path.join(FIXTURES, "fake-bot-runs"),
  BOT_COST_MODELS_JSON: path.join(FIXTURES, "models.json"),
};
const PROJECTS = ["--projects", path.join(FIXTURES, "projects", "proj")];
const RUNS = "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs";
const AGENT_RUNS = "https://github.com/cgwalters-bot/cgwalters-devspace-sandbox/actions/runs";
const MARKER_RE = /^<!-- bot-run\/v1 (\{.*\}) -->$/;

const footer = require(TOOL);
test.after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

const run = (args) => execFileSync(TOOL, [...PROJECTS, ...args], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// [args, human line, fields of the JSON]; the window is --since 2d before
// BOT_COST_NOW, 2026-09-20T00:00Z.
const CASES = [
  [["--item", "PVTI_item1"],
    "<sub>Bot run: session sess1, agent w1 · claude-opus-5-5 60k in (83% cached) / 2k out, mystery-9 500 in / 500 out"
    + " · ~$0.11 inference + ~$5.04 compute (est., list prices) · 3h 0m wall"
    + ` · 32.0 core-h, Actions run [101](${RUNS}/101)</sub>`,
    { task: "PVTI_item1", item: "PVTI_item1", sessions: ["sess1"], agents: ["w1"], duration_s: 10799, core_hours: 32,
      usd: { inference: 0.1124, compute: 5.04, total: 5.1524 }, run_urls: [`${RUNS}/101`],
      window_since: "2026-09-20T00:00:00.000Z", generated_at: "2026-09-22T00:00:00.000Z", estimate: true }],
  [["--item", "PVTI_item1", "--no-compute"],
    "<sub>Bot run: session sess1, agent w1 · claude-opus-5-5 60k in (83% cached) / 2k out, mystery-9 500 in / 500 out"
    + " · ~$0.11 inference (est., list prices) · 3h 0m wall</sub>",
    { core_hours: 0, run_urls: [], usd: { inference: 0.1124, compute: 0, total: 0.1124 } }],
  // An agent.yml run: no local session, its compute and inference.
  [["--item", "PVTI_item2"],
    "<sub>Bot run: PVTI_item2 · claude-sonnet-4-5 251k in / 1k out · ~$1.53 inference + ~$0.36 compute (est., list prices)"
    + ` · 10m wall · 2.0 core-h, Actions run [201](${AGENT_RUNS}/201)</sub>`,
    { sessions: [], agents: [], duration_s: 600, first_message_at: "2026-09-20T12:10:00.500Z" }],
  [["--task", "agent:r1", "--no-compute"],
    "<sub>Bot run: session sess1, agent r1 · claude-opus-5-5[1m] 0 in / 1k out · ~$0.02 inference (est., list prices) · 0s wall</sub>",
    { task: "agent:r1", item: null, duration_s: 0 }],
];

test("footers of the fixture tasks", () => {
  for (const [args, human, fields] of CASES) {
    const lines = run(args).split("\n");
    assert.equal(lines.length, 3, `${args.join(" ")}: two lines and a newline`);
    assert.equal(lines[0], human, args.join(" "));
    const m = MARKER_RE.exec(lines[1]);
    assert.ok(m, `${args.join(" ")}: no marker line in ${lines[1]}`);
    const rec = JSON.parse(m[1]);
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(rec[k], v, `${args.join(" ")}: ${k}`);
    assert.deepEqual(JSON.parse(run([...args, "--json"])), rec, `${args.join(" ")}: --json`);
  }
});

test("the JSON has per-model tokens and cost, and nothing to end its comment", () => {
  const rec = JSON.parse(run(["--item", "PVTI_item1", "--json"]));
  assert.deepEqual(Object.keys(rec.models), ["claude-opus-5-5", "mystery-9"]);
  assert.deepEqual(rec.models["claude-opus-5-5"],
    { tokens: { input: 100, output: 2000, cache_read: 50000, cache_write_5m: 6000, cache_write_1h: 4000 }, usd: 0.1124 });
  const m = footer.marker({ ...rec, models: { "a--b--->": {} } });
  assert.ok(!m.slice(4, -3).includes("--"), m);
  assert.deepEqual(JSON.parse(MARKER_RE.exec(m)[1]).models, { "a--b--->": {} });
});

test("durations are wall time, rounded", () => {
  const cases = [[0, "0s"], [59, "59s"], [60, "1m"], [2520, "42m"], [3599, "1h 0m"], [5430, "1h 31m"]];
  for (const [s, want] of cases) assert.equal(footer.fmtDuration(s), want, String(s));
});

test("errors name close matches or how to find the task", () => {
  const cases = [
    [["--item", "PVTI_item"], 1, /no task PVTI_item in \d+ task\(s\) since 2026-09-20T00:00:00.000Z; close matches: .*PVTI_item1/],
    // The worker's prompt named the item, so bot-cost keyed its task by that.
    [["--scratch", "/tmp/c/scratchpad/cfs-x/"], 1, /no task scratch:cfs-x .*close matches: PVTI_item1$/m],
    [["--item", "PVTI_nope"], 1, /keys tasks by the board item .* 'bot-cost --since 2d' lists them/],
    [["--since", "later", "--item", "PVTI_item1"], 2, /bot-cost failed: .*not an age/],
    [[], 2, /name the task with --item, --scratch or --task/],
    [["--item", "PVTI_item1", "--scratch", "x"], 2, /give one of --item, --scratch and --task/],
    [["--item", "item1"], 2, /--item takes a board item id/],
    [["--bogus"], 2, /unexpected argument/],
  ];
  for (const [args, status, want] of cases) {
    assert.throws(() => run([...args, "--no-compute"]), (e) => e.status === status && want.test(e.stderr),
      `${args.join(" ")}`);
  }
});

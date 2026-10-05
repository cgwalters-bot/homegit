// Offline tests of bin/bot-actuals with real bot-cost transcripts and a fake
// board. Run with bash tests/bot-actuals.sh, or node --test tests/bot-actuals.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FIXTURES = path.join(__dirname, "fixtures", "bot-actuals");
const TOOL = path.join(__dirname, "..", "bin", "bot-actuals");
const WORK = fs.mkdtempSync(path.join(os.homedir(), "bot-actuals-test-"));
const LOG = path.join(WORK, "calls.jsonl");
const ENV = {
  ...process.env, NODE_OPTIONS: "", XDG_CACHE_HOME: WORK,
  BOT_ACTUALS_COST: path.join(__dirname, "..", "bin", "bot-cost"),
  BOT_ACTUALS_BOARD: "fixture-board", FAKE_ACTUALS_LOG: LOG,
  BOT_COST_NOW: "2026-09-22T00:00:00Z",
  BOT_COST_MODELS_JSON: path.join(__dirname, "fixtures", "bot-cost", "models.json"),
};
const COST_ARGS = ["--since", "30d", "--no-compute", "--tasks", "0", "--json"];
const EXPECTED = [
  { id: "PVTI_item1", title: "By id and issue URL", tokens: 12400 },
  { id: "PVTI_item2", title: "By issue URL", tokens: 500 },
  { id: "PVTI_item3", title: "By Branch PR URL", tokens: 400 },
];

test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

function run(args = [], board = "without-actuals") {
  fs.rmSync(LOG, { force: true });
  return execFileSync(process.execPath, ["--require", path.join(FIXTURES, "dependencies.js"), TOOL, ...args], {
    env: { ...ENV, FAKE_ACTUALS_BOARD: path.join(FIXTURES, `${board}.json`) },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

function calls() {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map(JSON.parse) : [];
}

function writes(items) {
  return [
    ["board", "field-ensure", "--number", "Actual tokens"],
    ...items.map((it) => ["board", "set", it.id, "--field", "Actual tokens", String(it.tokens)]),
  ];
}

test("sets fresh tokens on Done items, matching ids, issue URLs and Branch PR URLs", () => {
  assert.deepEqual(JSON.parse(run(["--json"])), EXPECTED);
  assert.deepEqual(calls(), [["cost", ...COST_ARGS], ["board", "list", "--json"], ...writes(EXPECTED)]);
});

test("preserves prior actuals by default, and --all overwrites them", () => {
  assert.equal(run([], "with-actuals"), "nothing to set\n");
  assert.deepEqual(calls(), [["cost", ...COST_ARGS], ["board", "list", "--json"]]);
  assert.deepEqual(JSON.parse(run(["--all", "--json"], "with-actuals")), EXPECTED);
  assert.deepEqual(calls(), [["cost", ...COST_ARGS], ["board", "list", "--json"], ...writes(EXPECTED)]);
});

test("--dry-run prints the proposed writes without ensuring or setting a field", () => {
  assert.equal(run(["--since", "2d", "--dry-run"]), EXPECTED.map((it) =>
    `would set Actual tokens = ${it.tokens} on ${it.id} (${it.title})\n`).join(""));
  assert.deepEqual(calls(), [["cost", ...COST_ARGS.map((a) => a === "30d" ? "2d" : a)], ["board", "list", "--json"]]);
  assert.deepEqual(JSON.parse(run(["--dry-run", "--json"])), EXPECTED);
  assert.deepEqual(calls(), [["cost", ...COST_ARGS], ["board", "list", "--json"]]);
});

test("a brief without an Item: line does not attribute its prose issue URL", () => {
  const cost = JSON.parse(execFileSync(process.execPath, [ENV.BOT_ACTUALS_COST, ...COST_ARGS,
    "--projects", path.join(FIXTURES, "projects", "proj")], { env: ENV, encoding: "utf8" }));
  const task = cost.tasks.find((t) => t.key === "agent:unmarked");
  assert.ok(task, "the unmarked brief still produces a bot-cost task");
  assert.equal(task.item, null);
  assert.equal(task.fresh_tokens, 700);
  assert.deepEqual(JSON.parse(run(["--json"])), EXPECTED);
  assert.ok(!calls().some((c) => c[1] === "set" && c[2] === "PVTI_unmarked"));
});

test("bot-cost failure is nonzero and never reads or writes the board", () => {
  assert.throws(() => run(["--since", "later"]), (e) => e.status === 1 && /not an age/.test(e.stderr));
  assert.deepEqual(calls(), [["cost", ...COST_ARGS.map((a) => a === "30d" ? "later" : a)]]);
});

test("--help describes usage without calling either dependency", () => {
  const out = run(["--help"]);
  assert.match(out, /^Usage: bot-actuals /);
  assert.match(out, /Item: URL-or-PVTI_ID/);
  assert.match(out, /--dry-run/);
  assert.deepEqual(calls(), []);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

test("shell and direct Node watch CLI share a crash-safe lock across cancellation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-watch-lock-"));
  const repo = "example/devspace", now = "2026-10-05T12:00:00Z";
  const run = { id: 42, run_attempt: 1, status: "in_progress", jobs: [{ name: "Agent", status: "in_progress",
    steps: [{ name: "Run agent", status: "in_progress", started_at: "2026-10-05T11:00:00Z" }] }] };
  const item = { id: "PVTI_test", status: "In Progress", title: "Lock test", run: `https://github.com/${repo}/actions/runs/42`, "budget tokens": 100 };
  const root = path.resolve(__dirname, "..");
  let child;
  try {
    const boardFile = path.join(tmp, "board.json"), stateFile = path.join(tmp, "state.json");
    fs.writeFileSync(boardFile, JSON.stringify([item]));
    const observations = path.join(tmp, "observations.json");
    fs.writeFileSync(observations, JSON.stringify([{ schema: "run-observation/v1", repo, run_id: 42, attempt: 1,
      observed_at: now, last_activity_at: "2026-10-05T11:30:00Z", window_started_at: "2026-10-05T11:55:00Z",
      tokens: { input: 1, output: 0, cache_write: 0 }, events: [] }]));
    fs.writeFileSync(path.join(tmp, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.FAKE_RUN_WATCH, run = ${JSON.stringify(run)};
const endpoint = process.argv.find(a => a.startsWith('repos/'));
if (process.argv.includes('POST')) {
  fs.appendFileSync(dir + '/cancels', 'cancel\\n');
  fs.writeFileSync(dir + '/entered', '');
  const until = Date.now() + 10000;
  while (!fs.existsSync(dir + '/release') && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  fs.writeFileSync(dir + '/completed', '');
} else if (endpoint.includes('/workflows/')) process.stdout.write(JSON.stringify({workflow_runs:[run]}));
else if (endpoint.includes('/jobs?')) process.stdout.write(JSON.stringify({total_count:1,jobs:run.jobs}));
else process.stdout.write(JSON.stringify(fs.existsSync(dir + '/completed') ? {...run,status:'completed',conclusion:'cancelled'} : run));
`, { mode: 0o700 });
    const boardCommand = path.join(tmp, "board");
    fs.writeFileSync(boardCommand, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('set')) fs.writeFileSync(process.env.BOARD_FILE, JSON.stringify([{...${JSON.stringify(item)},status:'Todo',run:''}]));
else process.stdout.write(fs.readFileSync(process.env.BOARD_FILE));
`, { mode: 0o700 });
    const args = ["watch", "--apply", "--board-file", boardFile, "--state-file", stateFile,
      "--observations-file", observations, "--now", now, "--grace-minutes", "0", "--json"];
    const env = { ...process.env, PATH: `${tmp}:${process.env.PATH}`, BOT_RUNS_REPO: repo,
      BOT_RUNS_BOT_BOARD: boardCommand, XDG_STATE_HOME: tmp, XDG_CACHE_HOME: tmp,
      FAKE_RUN_WATCH: tmp, BOARD_FILE: boardFile };
    child = spawn("bash", [path.join(root, "bin/bot-runs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const exit = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(tmp, "entered")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(path.join(tmp, "entered")), stderr);
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).runs[`${repo}/42/1`].cancel_requested, true);
    const parallelShell = spawnSync("bash", [path.join(root, "bin/bot-runs"), ...args], { env, encoding: "utf8" });
    assert.notEqual(parallelShell.status, 0);
    assert.match(parallelShell.stderr, /another bot-runs watch holds/);
    const parallelNode = spawnSync(process.execPath, [path.join(root, "lib/run-watch.js"), ...args.slice(1)], { env, encoding: "utf8" });
    assert.equal(parallelNode.status, 75);
    assert.match(parallelNode.stderr, /another bot-runs watch holds/);
    assert.equal(fs.readFileSync(path.join(tmp, "cancels"), "utf8"), "cancel\n");
    fs.writeFileSync(path.join(tmp, "release"), "");
    assert.equal(await exit, 0, stderr);
    const afterExit = spawnSync("bash", [path.join(root, "bin/bot-runs"), ...args], { env, encoding: "utf8" });
    assert.equal(afterExit.status, 0, afterExit.stderr);
    assert.equal(fs.readFileSync(path.join(tmp, "cancels"), "utf8"), "cancel\n");
    assert.ok(fs.existsSync(`${stateFile}.lock`));
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

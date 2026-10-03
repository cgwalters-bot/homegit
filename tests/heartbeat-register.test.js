// Offline command tests: saved input is authoritative, including local IDs.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const URL = "https://github.com/o/r/issues/1";
const OLD_WORKER = { name: "existing", item_url: "https://github.com/o/r/pull/2", started_at: "2026-09-28T12:00:00Z", status: "testing", agent_ids: ["agent123"], devspace: "work" };

for (const mode of ["assign", "dispatch"]) {
  for (const scenario of ["append", "dedup", "no-session", "name-collision", "missing", "corrupt", "malformed", "invalid-worker", "draft", "publish-fails", "usage-fails", "board-fails", "budget-fails", "dry-run"]) {
    if (mode === "assign" && scenario === "budget-fails") continue;
    test(`${mode}: ${scenario}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-register-test-"));
      try {
        const state = path.join(dir, "state", "bot-heartbeat", "last-publish.json");
        fs.mkdirSync(path.dirname(state), { recursive: true });
        const now = Date.now();
        const updated = new Date(now - 600000).toISOString();
        const last = { session: "saved-session", input: {
          updated_at: updated,
          coordinator: { session: "coordinator-session", loop_state: "sleeping", next_wake_at: new Date(now - 300000).toISOString() },
          workers: [OLD_WORKER],
        }, published: { updated_at: updated } };
        if (scenario === "dedup") last.input.workers.push({ ...OLD_WORKER, name: "already-working", item_url: URL, agent_ids: ["agent456"] });
        if (scenario === "no-session") last.session = null;
        if (scenario === "name-collision") last.input.workers[0] = { ...OLD_WORKER, name: mode === "assign" ? "PVTI_item" : "run-123" };
        if (scenario === "malformed") delete last.input.coordinator;
        if (scenario === "invalid-worker") last.input.workers[0] = { ...OLD_WORKER, status: "bogus" };
        if (scenario !== "missing") fs.writeFileSync(state, scenario === "corrupt" ? "{" : JSON.stringify(last));
        const before = fs.existsSync(state) ? fs.readFileSync(state, "utf8") : null;
        const item = { id: "PVTI_item", title: "task", status: "Todo", content: scenario === "draft" ? { type: "DraftIssue" } : { url: URL } };
        fs.writeFileSync(path.join(dir, "items.json"), JSON.stringify([item]));
        fs.writeFileSync(path.join(dir, "operator.json"), "{}");
        fs.writeFileSync(path.join(dir, "brief"), "Do the task.");
        const script = (name, body) => {
          const file = path.join(dir, name);
          fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
          return file;
        };
        const board = script("board", `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(['board', ...args]) + '\\n');
if (process.env.SCENARIO === 'board-fails' && args[0] === 'set') process.exit(1);
if (args[0] === 'list') process.stdout.write(fs.readFileSync(process.env.ITEMS));
`);
        const heartbeat = script("heartbeat", `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.CALLS, JSON.stringify(['heartbeat', ...process.argv.slice(2)]) + '\\n');
if (process.env.SCENARIO === 'publish-fails') process.exit(1);
const hb = require(${JSON.stringify(path.join(ROOT, "bin", "bot-heartbeat"))}).validate(input, Date.now()).hb;
fs.writeFileSync(process.env.STATE, JSON.stringify({ session: process.env.CLAUDE_CODE_SESSION_ID || null, input, published: hb }));
if (process.env.SCENARIO === 'usage-fails') process.exit(1);
`);
        script("gh", `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(['gh', ...args]) + '\\n');
if (args.includes('POST')) {
  fs.readFileSync(0);
  console.log(JSON.stringify({workflow_run_id: 123, html_url: 'https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/123'}));
} else if (args.includes('repos/o/r')) console.log('public');
else process.exit(1);
`);
        const pace = script("pace", "process.exit(process.env.SCENARIO === 'budget-fails' ? 1 : 0);\n");
        const env = { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, "state"), XDG_CACHE_HOME: path.join(dir, "cache"),
          BOT_OPERATOR_CONFIG: path.join(dir, "operator.json"), BOT_PACE_BOARD: board, BOT_PACE_HEARTBEAT: heartbeat,
          BOT_RUNS_BOT_BOARD: board, BOT_RUNS_BOT_PACE: pace, BOT_RUNS_HEARTBEAT: heartbeat,
          CALLS: path.join(dir, "calls"), ITEMS: path.join(dir, "items.json"), STATE: state, SCENARIO: scenario, CLAUDE_CODE_SESSION_ID: "caller-session" };
        for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "BOT_RUNS_REPO", "BOT_RUNS_REF", "BOT_RUNS_WORKFLOW"]) delete env[key];
        const args = mode === "assign" ? ["assign", item.id] : ["dispatch", "--item", item.id, "--repo", "o/r", "--no-preamble", path.join(dir, "brief")];
        if (scenario === "dry-run") args.push("--dry-run");
        const r = spawnSync(path.join(ROOT, "bin", mode === "assign" ? "bot-pace" : "bot-runs"), args, { encoding: "utf8", env });
        assert.equal(r.status, scenario === "board-fails" ? 1 : 0, r.stderr);
        const calls = fs.existsSync(env.CALLS) ? fs.readFileSync(env.CALLS, "utf8").trim().split("\n").map(JSON.parse) : [];
        const publishes = calls.filter((c) => c[0] === "heartbeat");
        const published = ["append", "dedup", "no-session", "publish-fails", "usage-fails", "budget-fails"].includes(scenario);
        assert.deepEqual(publishes, published ? [["heartbeat", "publish", "--require-saved-state"]] : []);
        if (published && scenario !== "publish-fails") {
          const saved = JSON.parse(fs.readFileSync(state, "utf8"));
          assert.equal(saved.session, last.session);
          assert.deepEqual(saved.input.coordinator.session, last.input.coordinator.session);
          assert.equal(saved.input.coordinator.loop_state, "sleeping");
          assert.equal(Date.parse(saved.input.coordinator.next_wake_at) - Date.parse(saved.input.updated_at), 300000);
          assert.ok(Date.parse(saved.input.updated_at) >= now);
          assert.deepEqual(saved.input.workers.slice(0, last.input.workers.length), last.input.workers);
          assert.equal(saved.input.workers.filter((w) => w.item_url === URL).length, 1);
          if (scenario !== "dedup") assert.equal(saved.input.workers.at(-1).name, mode === "assign" ? item.id : "run-123");
        } else {
          assert.equal(fs.existsSync(state) ? fs.readFileSync(state, "utf8") : null, before);
        }
        if (["missing", "corrupt", "malformed", "invalid-worker", "name-collision", "draft", "publish-fails", "usage-fails"].includes(scenario)) assert.match(r.stderr, /warning: heartbeat registration/);
        if (scenario === "dry-run") assert.ok(calls.every((c) => c[0] === "board" && c[1] === "list"));
        if (mode === "dispatch" && scenario === "board-fails") assert.match(r.stderr, /run was dispatched, but recording it on the board failed/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// Exercise the actual sweep shell with offline sibling tools. No live gh calls.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("each sweep watches before reconcile, preserves both results and propagates failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-watch-sweep-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const root = path.resolve(__dirname, "..");
  const script = (name, source) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  try {
    for (const name of ["bot-watch", "operator.sh", "gh-http.sh", "review-state.sh"]) fs.copyFileSync(path.join(root, "bin", name), path.join(bin, name));
    script("bot-operator", `process.stdout.write('OP_BOT_LOGIN=bot; OP_OPERATOR_LOGIN=operator; OP_OPERATOR_POSSESSIVE=operator; OP_FORGE_ORG=forge;');`);
    script("gh", `if (process.argv.includes('user')) process.stdout.write('bot'); else process.exit(99);`);
    for (const name of ["bot-priority-health", "bot-priority-propagate", "bot-drive", "bot-signoff-due", "bot-promote-due", "bot-operator-activity"]) script(name, `process.stdout.write('[]');`);
    script("bot-reconcile", `process.stdout.write('{"actions":[]}');`);
    script("bot-runs", `const fs = require('node:fs');
const command = process.argv[2];
fs.appendFileSync(process.env.CALLS, command + '\\n');
const i = process.argv.indexOf('--board-file');
const board = JSON.parse(fs.readFileSync(process.argv[i + 1]));
if (board.some(item => item.lead === 'topic')) process.exit(98);
if (command === 'reconcile' && !fs.readFileSync(process.env.CALLS, 'utf8').startsWith('watch\\n')) process.exit(97);
process.stdout.write(JSON.stringify([{item:'PVTI_test',line:command,health:command === 'watch' ? 'unknown' : undefined}]));
if (command === 'watch' && process.env.FAIL_WATCH) process.exit(1);`);
    const board = path.join(tmp, "board.json");
    fs.writeFileSync(board, JSON.stringify([{ id: "PVTI_test", title: "Item", status: "In Progress", content: { type: "DraftIssue" } },
      { id: "PVTI_topic", title: "Topic", lead: "topic", status: "In Progress", content: { type: "DraftIssue" } }]));
    for (const fail of [false, true]) {
      const calls = path.join(tmp, `calls-${fail}`);
      const result = spawnSync("bash", [path.join(bin, "bot-watch"), "--board-file", board, "--state-file", path.join(tmp, "state.json"),
        "--lead", "coordinator", "--dry-run", "--json"], { encoding: "utf8", env: { ...process.env,
        PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: tmp, XDG_CACHE_HOME: tmp, CALLS: calls, FAIL_WATCH: fail ? "1" : "" } });
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      assert.equal(fs.readFileSync(calls, "utf8"), "watch\nreconcile\n");
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.devspace_runs.map((r) => r.line), ["watch", "reconcile"]);
      assert.equal(report.devspace_runs_failed, fail);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

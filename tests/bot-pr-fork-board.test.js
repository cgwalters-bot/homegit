// Exercise the actual fork-pr command functions with unrelated operations
// stubbed out: no git pushes, credentials, or GitHub calls.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "bin", "bot-pr"), "utf8");
const functions = source.slice(source.indexOf("record_fork_pr() {"), source.indexOf("cmd_set_item() {"));
const URL = "https://github.com/forge/r/pull/7";

for (const scenario of ["created", "existing", "mismatched", "create-fails", "created-board-fails", "existing-board-fails"]) {
  test(`fork-pr board: ${scenario}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-board-test-"));
    try {
      const log = path.join(dir, "calls");
      const board = path.join(dir, "board");
      fs.writeFileSync(board, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.SCENARIO.endsWith('board-fails')) process.exit(1);
`, { mode: 0o755 });
      const body = path.join(dir, "body");
      fs.writeFileSync(body, "Test body\nLLMs: test\n");
      const script = `set -euo pipefail
BOT_BOARD=$BOARD
REVIEWER=operator
BOT_LOGIN=bot
FORGE_ORG=forge
BRANCH_PREFIX=bot/
ITEM_ID_RE='PVTI_[A-Za-z0-9_]+'
META_START='<!-- bot-meta -->'
LLMS_TRAILER='LLMs: test'
fatal() { printf '%s\\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\\n' "$*" >&2; }
info() { :; }
valid_repo() { return 0; }
require_yaml_parser() { :; }
check_login() { :; }
ensure_fork() { printf 'forge/r\\n'; }
check_item_free() { :; }
find_stack_parent() { :; }
fork_setup() { :; }
sync_base() { :; }
push_branch() { :; }
ref_sha() { printf 'abcdef\\n'; }
prune_after_push() { :; }
recorded_item() { if test "$SCENARIO" = mismatched; then printf 'PVTI_other\\n'; else printf 'PVTI_item\\n'; fi; }
meta_section() { printf 'metadata\\n'; }
lock_state() { :; }
load_state() { printf '{"prs":{}}\\n'; }
body_hash() { printf 'hash\\n'; }
save_state() { :; }
ghapi() {
  case "$*" in
    *compare/*) printf '1 0\\n' ;;
    '-X GET repos/o/r/pulls '*) : ;;
    '-X GET repos/forge/r/pulls '*)
      case "$SCENARIO" in existing*|mismatched) printf '{"html_url":"${URL}"}\\n' ;; esac ;;
    '-X POST repos/forge/r/pulls --input -')
      jq empty
      if test "$SCENARIO" = create-fails; then return 1; fi
      printf '{"html_url":"${URL}", "body":"test"}\\n' ;;
    *collaborators/*) printf 'write\\n' ;;
    *) fatal "Unexpected mock API call: $*" ;;
  esac
}
${functions}
cmd_fork_pr --repo o/r --base main --branch bot/task --item PVTI_item --title Test --body-file "$BODY"
`;
      const env = { ...process.env, BOARD: board, BODY: body, CALLS: log, SCENARIO: scenario };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
      const failed = scenario.endsWith("fails");
      assert.equal(r.status, failed ? 1 : 0, r.stderr);
      const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
      assert.deepEqual(calls, ["mismatched", "create-fails"].includes(scenario) ? [] : [[
        "set", "PVTI_item", ...(scenario.startsWith("created") ? ["--status", "Draft"] : []), "--branch", URL,
        "--why", `Fork PR ${URL}; awaiting review by operator`,
        "--news", `Fork PR ready for review: ${URL}`,
      ]]);
      if (scenario.endsWith("board-fails")) {
        assert.match(r.stderr, /fork PR is open, but updating the board failed; retry: bot-board set PVTI_item/);
        assert.ok(r.stderr.includes(URL));
      } else if (scenario === "create-fails") assert.match(r.stderr, /opening the draft PR/);
      else assert.equal(r.stdout.trim(), URL);
      if (scenario === "mismatched") assert.match(r.stderr, /records board item PVTI_other, not PVTI_item/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

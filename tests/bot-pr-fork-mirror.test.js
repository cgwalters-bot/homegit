// fork-pr --upstream-base: a fork-only mirror branch is the PR base, nothing
// is synced or stacked, and the bot-meta section records the upstream branch.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "bin", "bot-pr"), "utf8");
const functions = source.slice(source.indexOf("record_fork_pr() {"), source.indexOf("cmd_set_item() {"));

// Upstream has main only; the fork has main and its mirror, upstream-main.
for (const [name, args, status, expected] of [
  ["mirror", "--base upstream-main --upstream-base main", 0, ""],
  ["missing upstream branch", "--base upstream-main --upstream-base nope", 1, "has no branch 'nope'"],
  ["missing fork mirror", "--base other-mirror --upstream-base main", 1, "has no branch 'other-mirror'"],
  ["no flag", "--base upstream-main", 1, "has no branch 'upstream-main'"],
]) {
  test(`fork-pr --upstream-base: ${name}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-mirror-test-"));
    try {
      const body = path.join(dir, "body");
      fs.writeFileSync(body, "Test body\nLLMs: test\n");
      const script = `set -euo pipefail
BOT_BOARD=true
REVIEWER=operator
BOT_LOGIN=bot
FORGE_ORG=forge
BRANCH_PREFIX=bot/
ITEM_ID_RE='PVTI_[A-Za-z0-9_]+'
META_START='<!-- bot-meta -->'
LLMS_TRAILER='LLMs: test'
fatal() { printf '%s\\n' "$*" >&2; exit 1; }
warn() { :; }
info() { :; }
valid_repo() { return 0; }
require_yaml_parser() { :; }
check_login() { :; }
ensure_fork() { printf 'forge/r\\n'; }
check_item_free() { :; }
find_stack_parent() { :; }
fork_setup() { :; }
sync_base() { fatal "sync_base must not run"; }
push_branch() { :; }
ref_sha() {
  case "$1:$2" in
    o/r:main|forge/r:upstream-main|forge/r:bot/task) printf 'abcdef\\n' ;;
  esac
}
prune_after_push() { :; }
recorded_item() { :; }
meta_section() { printf 'upstream base %s\\n' "$2" >&2; printf 'meta\\n'; }
lock_state() { :; }
load_state() { printf '{"prs":{}}\\n'; }
body_hash() { printf 'hash\\n'; }
save_state() { :; }
record_fork_pr() { :; }
ghapi() {
  case "$*" in
    *compare/upstream-main...*) printf '1 0\\n' ;;
    '-X GET repos/o/r/pulls '*|'-X GET repos/forge/r/pulls '*) : ;;
    '-X POST repos/forge/r/pulls --input -')
      jq -c "{base}" >&2
      printf '{"html_url":"u", "body":"test"}\\n' ;;
    *collaborators/*) printf 'write\\n' ;;
    *) fatal "Unexpected mock API call: $*" ;;
  esac
}
${functions}
cmd_fork_pr --repo o/r ${args} --branch bot/task --item PVTI_item --title Test --body-file "$BODY"
`;
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, BODY: body } });
      assert.equal(r.status, status, r.stderr);
      if (status === 0) {
        assert.match(r.stderr, /"base":"upstream-main"/);
        assert.match(r.stderr, /upstream base main\n/);
      } else {
        assert.ok(r.stderr.includes(expected), r.stderr);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

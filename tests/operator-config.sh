#!/usr/bin/env bash
# Offline tests of the tools under another operator's config (jmarrero,
# with jmarrero-bot, the jmarrero-forge org and its board 7), against a
# fake gh that logs every call: they must use that config, and nothing
# of the default one (cgwalters) may leak into their output or the API
# paths they call. No network. The config loader itself is tested by
# operator.test.js.
#   tests/operator-config.sh
set -euo pipefail
shopt -s inherit_errexit

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BIN=${TESTS}/../bin
# What must not show up anywhere under the other config.
readonly LEAK=cgwalters

WORK=$(mktemp -d "${TMPDIR:-/tmp}/operator-config-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export HOME=${WORK}/home XDG_CONFIG_HOME=${WORK}/config XDG_CACHE_HOME=${WORK}/cache XDG_STATE_HOME=${WORK}/state
export FAKE=${WORK}/fake PATH=${WORK}/bin:${PATH}
export FAKE_BOARD_REST=${TESTS}/fixtures/bot-board/fake-rest
unset GH_TOKEN GITHUB_TOKEN BOT_OPERATOR_CONFIG
mkdir -p "${HOME}" "${WORK}/bin" "${FAKE}" "${XDG_CONFIG_HOME}/bot-harness"

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# Found at the default path, under XDG_CONFIG_HOME.
cat >"${XDG_CONFIG_HOME}/bot-harness/operator.json" <<'EOF'
{
  "operator": {"login": "jmarrero", "name": "Joseph Marrero", "email": "jmarrero@example.com"},
  "bot": {"login": "jmarrero-bot"},
  "forge_org": "jmarrero-forge",
  "heartbeat_issue": 9,
  "board": {"number": 7},
  "devspace": {"repo": "jmarrero-bot/jmarrero-devspace-sandbox"}
}
EOF

# The fake gh logs each call's arguments to $FAKE/calls, and answers
# what the tools below ask; anything else fails.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE}/calls"
case "$1 $2" in
    "project field-list") echo '{"fields": []}'; exit 0 ;;
    "project view") echo PVT_fake; exit 0 ;;
    "api -i") exec "${FAKE_BOARD_REST:?}" "${FAKE}/no-items.json" "$3" ;;
esac
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter=.
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        --input) cat >"${FAKE}/input"; shift 2 ;;
        --paginate) shift ;;
        *) path=$1; shift ;;
    esac
done
case "${method} ${path}" in
    "GET user") jq -rn '{login: "jmarrero-bot"} | '"${filter}" ;;
    "GET rate_limit") echo 5000 ;;
    "GET repos/"*/bot-ops) jq -rn '{private: true} | '"${filter}" ;;
    "GET repos/"*/issues/*/comments*) echo '[]' | jq -r "${filter}" ;;
    "POST repos/"*/issues/*/comments) jq -rn '{html_url: "https://github.com/x/y/issues/1#issuecomment-1"} | '"${filter}" ;;
    "GET repos/"*/actions/runs/*) jq -rn '{path: ".github/workflows/devspace.yml", status: "in_progress", conclusion: null} | '"${filter}" ;;
    *) echo "fake gh: unexpected: ${method} ${path}" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

# run NAME CMD...: runs CMD, keeping its output (both streams) in
# $WORK/out/NAME for the leak check and in OUT; fails NAME if it fails.
mkdir -p "${WORK}/out"
OUT=
run() {
    local name=$1
    shift
    if ! OUT=$("$@" 2>&1); then
        fail "${name}: failed: ${OUT}"
    fi
    printf '%s\n' "${OUT}" >"${WORK}/out/${name//\//_}"
}

# expect NAME PATTERN: OUT has a line matching PATTERN (grep -E).
expect() {
    grep -qE -- "$2" <<<"${OUT}" || fail "$1: no line matching '$2' in: ${OUT}"
}

# --- bot-operator and the shell helper ---
run operator-json "${BIN}/bot-operator" --json
test "$(jq -c '[.operator.login, .bot.login, .bot.git_email, .tracker_repo, .board.owner, .board.number, .board.state_items, .board.epics, .generated_by_url]' <<<"${OUT}")" = \
    '["jmarrero","jmarrero-bot","jmarrero+llm@example.com","jmarrero-forge/tracker","jmarrero-forge",7,{},{},"https://github.com/jmarrero/#llms"]' ||
    fail "operator-json: ${OUT}"
run operator-shell bash -c "source '${BIN}/operator.sh' && declare -p OP_OPERATOR_LOGIN OP_BOARD OP_BOARD_URL OP_BOARD_STATE_ITEMS OP_BOARD_EPICS"
expect operator-shell '^declare -- OP_OPERATOR_LOGIN="jmarrero"$'
expect operator-shell '^declare -- OP_BOARD="orgs/jmarrero-forge/7"$'
expect operator-shell '^declare -A OP_BOARD_STATE_ITEMS=\(\)$'
# A name that needs quoting survives the shell helper.
jq '.operator.name = "Seán O'"'"'Brien \"$(x)\""' "${XDG_CONFIG_HOME}/bot-harness/operator.json" >"${WORK}/quoted.json"
run operator-quoting env BOT_OPERATOR_CONFIG="${WORK}/quoted.json" bash -c "source '${BIN}/operator.sh' && printf '%s\n' \"\${OP_OPERATOR_NAME}\""
test "${OUT}" = "Seán O'Brien \"\$(x)\"" || fail "operator-quoting: ${OUT}"
# A broken config stops the shell tools, rather than falling back.
echo '{"operator": {"logn": "x"}}' >"${WORK}/broken.json"
if OUT=$(BOT_OPERATOR_CONFIG=${WORK}/broken.json "${BIN}/bot-board" list 2>&1); then
    fail "broken config: bot-board ran anyway: ${OUT}"
fi
expect "broken config" "unknown key 'operator.logn'"
if OUT=$(BOT_OPERATOR_CONFIG=${WORK}/broken.json "${BIN}/bot-heartbeat" --help 2>&1); then
    fail "broken config: bot-heartbeat ran anyway: ${OUT}"
fi
expect "broken config (node)" "unknown key 'operator.logn'"

# --- Every tool's help ---
for tool in bot-board bot-notify bot-watch bot-pr bot-git bot-land bot-heartbeat bot-priority-health \
    upstream-policy bot-signoff-due bot-promote-due bot-tmt-number bot-review-guide bot-devspace bot-work bot-feedback \
    bot-runs dco-signoff bot-operator; do
    run "help-${tool}" "${BIN}/${tool}" --help
done
OUT=$(cat "${WORK}/out/help-bot-git")
expect "help-bot-git" "'Joseph Marrero <jmarrero\+llm@example.com>'"
OUT=$(cat "${WORK}/out/help-bot-priority-health")
if grep -q composefs-stable <<<"${OUT}"; then fail "help-bot-priority-health: names the default epic board"; fi

# --- bot-git: the bot's identity, and the operator's sign-off refused ---
git init -q "${WORK}/repo"
cd "${WORK}/repo"
git config user.name "Someone Else" && git config user.email someone@example.com
echo a >a && git add a
run bot-git-commit "${BIN}/bot-git" commit -q -m "a: Add" -m "Generated-by: AI"
test "$(git log -1 --format='%an <%ae>|%cn <%ce>')" = \
    'Joseph Marrero <jmarrero+llm@example.com>|Joseph Marrero <jmarrero+llm@example.com>' ||
    fail "bot-git commit: made as $(git log -1 --format='%an <%ae>|%cn <%ce>')"
echo b >a
if OUT=$("${BIN}/bot-git" commit -q -s -a -m "a: Change" 2>&1); then fail "bot-git commit -s: signed off"; fi
printf '%s\n' "${OUT}" >"${WORK}/out/bot-git-signoff"
expect "bot-git commit -s" "add jmarrero's own on their approval"
cd "${WORK}"

# --- bot-heartbeat: the configured tracker and issue ---
export BOT_HEARTBEAT_NOW=2026-09-28T20:00:00Z
run heartbeat bash -c "echo '{\"coordinator\": {\"session\": \"s-1\", \"loop_state\": \"sleeping\"}, \"workers\": []}' | '${BIN}/bot-heartbeat' publish"
grep -q '^api --paginate repos/jmarrero-forge/tracker/issues/9/comments' "${FAKE}/calls" ||
    fail "heartbeat: didn't read jmarrero-forge/tracker#9: $(cat "${FAKE}/calls")"
grep -q '^api -X POST repos/jmarrero-forge/tracker/issues/9/comments' "${FAKE}/calls" ||
    fail "heartbeat: didn't write to jmarrero-forge/tracker#9: $(cat "${FAKE}/calls")"
grep -q 'in jmarrero-bot/homegit' "${FAKE}/input" || fail "heartbeat: comment doesn't name jmarrero-bot/homegit: $(cat "${FAKE}/input")"
grep -q '^api -X POST repos/jmarrero-forge/bot-ops/issues/1/comments' "${FAKE}/calls" ||
    fail "heartbeat: didn't write the usage snapshot to jmarrero-forge/bot-ops#1: $(cat "${FAKE}/calls")"

# --- bot-board: the configured board, no default state items or epics ---
run board-list "${BIN}/bot-board" list --json
grep -q ' orgs/jmarrero-forge/projectsV2/7/items' "${FAKE}/calls" ||
    fail "board-list: didn't read orgs/jmarrero-forge/projectsV2/7: $(cat "${FAKE}/calls")"
run board-state "${BIN}/bot-board" state-get lease
test "$(tail -n1 <<<"${OUT}")" = '{}' || fail "board-state: a lease on a board without state items: ${OUT}"
if grep -q PVTI_lADOE9 "${FAKE}/calls"; then fail "board-state: read the default board's state items"; fi
if OUT=$("${BIN}/bot-board" --project composefs-stable list 2>&1); then fail "board-epic: the default epic board is known"; fi
printf '%s\n' "${OUT}" >"${WORK}/out/board-epic"
expect board-epic "unknown project 'composefs-stable'; valid: workstream,"

# --- bot-priority-health: no epic board to sweep ---
echo '[]' >"${WORK}/board.json"
run priority-health "${BIN}/bot-priority-health" --board-file "${WORK}/board.json"
expect priority-health '^Priority health: nothing to flag$'

# --- bot-devspace: the configured runner repository and host names ---
mkdir -p "${XDG_STATE_HOME}/bot-devspace/t1" && echo 42 >"${XDG_STATE_HOME}/bot-devspace/t1/run_id"
run devspace-list "${BIN}/bot-devspace" list
expect devspace-list '^t1 +42 +in_progress +jmarrero-devspace-42$'
grep -q 'repos/jmarrero-bot/jmarrero-devspace-sandbox/actions/runs/42' "${FAKE}/calls" ||
    fail "devspace-list: didn't read the run in jmarrero-bot/jmarrero-devspace-sandbox: $(cat "${FAKE}/calls")"

# --- Nothing of the default config anywhere ---
if leaks=$(grep -ris "${LEAK}" "${WORK}/out" "${FAKE}/calls" "${FAKE}/input"); then
    fail "'${LEAK}' leaked under another operator's config: ${leaks}"
fi

if test "${failures}" -ne 0; then
    echo "${failures} failure(s)" 1>&2
    exit 1
fi
echo "ok: the tools follow another operator's config, and nothing of the default one leaks"

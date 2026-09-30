#!/usr/bin/env bash
# shellcheck disable=SC2016 # backticks here are Markdown code spans
# Offline tests of bin/bot-heartbeat: schema validation and limits,
# dropping workers on private items, the comment it renders, that
# publish edits the bot's one heartbeat comment in place (creating it
# once, skipping unchanged writes), and that the usage snapshot (whose
# sums bot-heartbeat-usage.test.js checks) goes only to the private
# repository, never into the public heartbeat. A fake gh answers from
# files. No network.
#   tests/bot-heartbeat.sh
set -euo pipefail
shopt -s inherit_errexit

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly TOOL=${TESTS}/../bin/bot-heartbeat
readonly COMMENTS_API=repos/cgwalters-forge/tracker/issues/176/comments
readonly USAGE_API=repos/cgwalters-forge/bot-ops/issues/1/comments
# The line --dry-run prints between the heartbeat and the usage comment.
readonly SEPARATOR='<!-- cgwalters-forge/bot-ops#1 -->'
readonly EX_INVALID=3

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-heartbeat-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE=${WORK}/fake PATH=${WORK}/bin:${PATH}
export BOT_HEARTBEAT_NOW=2026-09-28T20:00:00Z
# The usage snapshot reads these transcripts, and no status line reading.
export BOT_HEARTBEAT_PROJECTS=${TESTS}/fixtures/bot-heartbeat/projects XDG_CACHE_HOME=${WORK}/cache
mkdir -p "${WORK}/bin" "${FAKE}"

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# The fake gh. $FAKE holds: private (OWNER/REPO per line: private
# repositories), broken (repositories whose read fails with a 500),
# comments.json (the issue's comments), calls (every call) and
# written (the last POST or PATCH, as "METHOD PATH" then its input);
# usage-comments.json and usage-written are the same for the usage
# issue in cgwalters-forge/bot-ops, which is private unless ops-public
# exists. Any other repository is public, and one named */missing is a
# 404.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter=. input=false
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        --input) input=true; shift 2 ;;
        --paginate) shift ;;
        *) path=$1; shift ;;
    esac
done
comments=${FAKE}/comments.json usage=${FAKE}/usage-comments.json
test -e "${comments}" || echo '[]' >"${comments}"
test -e "${usage}" || echo '[]' >"${usage}"
case "${method} ${path}" in
    "GET repos/cgwalters-forge/tracker/issues/176/comments?per_page=100") jq -r "${filter}" "${comments}" ;;
    "GET repos/cgwalters-forge/bot-ops/issues/1/comments?per_page=100") jq -r "${filter}" "${usage}" ;;
    "GET repos/cgwalters-forge/bot-ops")
        private=true
        test ! -e "${FAKE}/ops-public" || private=false
        jq -rn --argjson p "${private}" "{private: \$p} | ${filter}" ;;
    "POST repos/cgwalters-forge/bot-ops/issues/1/comments"|"PATCH repos/cgwalters-forge/bot-ops/issues/comments/"*)
        ${input} || { echo "fake gh: no --input" 1>&2; exit 1; }
        { echo "${method} ${path}"; cat; } >"${FAKE}/usage-written"
        echo '{"html_url": "https://github.com/cgwalters-forge/bot-ops/issues/1#issuecomment-8"}' | jq -r "${filter}" ;;
    "GET user") jq -rn --arg login "${FAKE_LOGIN:-cgwalters-bot}" "{login: \$login} | ${filter}" ;;
    "GET repos/"*/missing) echo "gh: Not Found (HTTP 404)" 1>&2; exit 1 ;;
    "GET repos/"*)
        repo=${path#repos/}
        if grep -qxiF "${repo}" "${FAKE}/broken" 2>/dev/null; then echo "gh: Server Error (HTTP 500)" 1>&2; exit 1; fi
        private=false
        grep -qxiF "${repo}" "${FAKE}/private" 2>/dev/null && private=true
        jq -rn --argjson p "${private}" "{private: \$p} | ${filter}" ;;
    "POST repos/cgwalters-forge/tracker/issues/176/comments"|"PATCH repos/cgwalters-forge/tracker/issues/comments/"*)
        ${input} || { echo "fake gh: no --input" 1>&2; exit 1; }
        { echo "${method} ${path}"; cat; } >"${FAKE}/written"
        echo '{"html_url": "https://github.com/cgwalters-forge/tracker/issues/176#issuecomment-9"}' | jq -r "${filter}" ;;
    *) echo "fake gh: unexpected: ${method} ${path}" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

reset() {
    rm -rf "${FAKE:?}"/*
}

# The two parts of a --dry-run's output: the heartbeat, and the usage
# comment after the separator.
heartbeat_part() { sed "/^${SEPARATOR//\//\\/}\$/,\$d"; }
usage_part() { sed -n "/^${SEPARATOR//\//\\/}\$/,\${//!p}"; }
json_of() { sed -n '/^```json$/,/^```$/{/^```/d;p}'; }
# Fail if the public heartbeat in "$2" carries anything of the usage.
no_usage() {
    if grep -qE 'usage|tokens|used_percent|observed_at|resets_at|agent_ids|aw1|ar1|^Usage' <<<"$2"; then
        fail "$1: the public heartbeat carries usage: $2"
    fi
}

# A valid heartbeat; each worker is "name|item_url|devspace".
heartbeat() {
    local w workers=() name url ds
    for w in "$@"; do
        IFS='|' read -r name url ds <<<"${w}"
        workers+=("$(jq -cn --arg n "${name}" --arg u "${url}" --arg d "${ds}" \
            '{name: $n, item_url: $u, started_at: "2026-09-28T19:40:00Z", status: "testing"} + (if $d == "" then {} else {devspace: $d} end)')")
    done
    jq -cn --argjson w "[$(IFS=,; echo "${workers[*]}")]" \
        '{updated_at: "2026-09-28T19:59:30Z", coordinator: {session: "s-1", loop_state: "sleeping"}, workers: $w}'
}

readonly PUB=https://github.com/cgwalters-forge/review/pull/16
readonly UPSTREAM=https://github.com/bootc-dev/bootc/issues/2482
readonly PRIV=https://github.com/acme/secret/issues/1
readonly GONE=https://github.com/acme/missing/pull/2

# --- A dry run: filtering and rendering.
reset
echo acme/secret >"${FAKE}/private"
if ! out=$(heartbeat "ops-v2|${PUB}|ops-v2" "bootc-2482|${UPSTREAM}|" "hidden|${PRIV}|hidden" "gone|${GONE}|" |
    "${TOOL}" publish --dry-run 2>"${WORK}/err"); then
    fail "dry run failed: $(cat "${WORK}/err")"
fi
grep -q 'left out 2 worker' "${WORK}/err" || fail "dry run didn't say it dropped the private workers: $(cat "${WORK}/err")"
test "$(head -1 <<<"${out}")" = '<!-- bot-heartbeat v1 -->' || fail "comment doesn't start with the marker"
json=$(heartbeat_part <<<"${out}" | json_of)
test "$(jq -c '[.schema, .updated_at, .coordinator.loop_state, [.workers[].name], .workers[0].devspace, (.workers[1] | has("devspace"))]' <<<"${json}")" = \
    '["bot-heartbeat/v1","2026-09-28T19:59:30Z","sleeping",["ops-v2","bootc-2482"],"ops-v2",false]' ||
    fail "unexpected JSON: ${json}"
grep -qF '| `ops-v2` | `cgwalters-forge/review#16` | testing |' <<<"${out}" || fail "no table row for ops-v2: ${out}"
# Outside the JSON (a code block), items appear only in code spans, which
# GitHub neither links nor cross-references.
outside=$(heartbeat_part <<<"${out}" | sed '/^```json$/,/^```$/d; s/`[^`]*`//g')
if grep -qE 'https://|#[0-9]' <<<"${outside}"; then
    fail "an item is referenced outside code: ${outside}"
fi
if grep -q 'secret\|missing\|hidden' <<<"${out}"; then fail "a private item leaked: ${out}"; fi
test ! -e "${FAKE}/written" || fail "dry run wrote a comment"

no_usage "dry run" "$(heartbeat_part <<<"${out}")"

# The usage comment: aggregates, and a worker's tokens from the
# transcripts of its agent_ids, which are themselves never written. None
# of it is in the public heartbeat.
reset
out=$(heartbeat "ops-v2|${PUB}|ops-v2" | jq -c '.workers[0].agent_ids = ["aw1", "ar1"]' | "${TOOL}" publish --dry-run 2>"${WORK}/err") ||
    fail "publish with agent_ids failed: $(cat "${WORK}/err")"
no_usage "dry run with agent_ids" "$(heartbeat_part <<<"${out}")"
test "$(heartbeat_part <<<"${out}" | json_of | jq -c 'keys, (.workers[0] | keys)')" = \
    "$(printf '%s\n' '["coordinator","schema","updated_at","workers"]' '["devspace","item_url","name","started_at","status"]')" ||
    fail "unexpected keys in the public heartbeat: ${out}"
usage=$(usage_part <<<"${out}")
test "$(head -1 <<<"${usage}")" = '<!-- bot-usage v1 -->' || fail "usage comment doesn't start with its marker: ${usage}"
json=$(json_of <<<"${usage}")
test "$(jq -c '[.schema, .session, .workers, [.windows[].kind], .windows[0].requests, .coordinator_tokens.output, has("observed_at")]' <<<"${json}")" = \
    '["bot-usage/v1","s-1",[{"name":"ops-v2","tokens":{"input":11,"output":550,"cache_read":2500,"cache_write":100}}],["five_hour","seven_day"],6,100,false]' ||
    fail "unexpected usage: ${json}"
if grep -q 'agent_ids\|aw1\|ar1' <<<"${out}"; then fail "agent ids were written: ${out}"; fi
grep -qF '| `ops-v2` | 3k |' <<<"${usage}" || fail "no tokens in the usage table: ${usage}"
grep -q '^Usage, 5-hour window: 5k tokens (2k output) in 6 requests since 2026-09-28T15:00:00Z; 7-day window: ' <<<"${usage}" || fail "no usage line: ${usage}"
out=$(heartbeat "ops-v2|${PUB}|ops-v2" | "${TOOL}" publish --dry-run --no-usage 2>/dev/null) || fail "publish --no-usage failed"
if grep -qF "${SEPARATOR}" <<<"${out}"; then fail "--no-usage printed a usage comment: ${out}"; fi

# next_wake_at may be in the future.
reset
out=$(jq -c '.coordinator.next_wake_at = "2026-09-28T20:29:30.5Z"' <<<"$(heartbeat)" | "${TOOL}" publish --dry-run 2>"${WORK}/err") ||
    fail "publish with next_wake_at failed: $(cat "${WORK}/err")"
grep -qF '"next_wake_at": "2026-09-28T20:29:30Z"' <<<"${out}" || fail "next_wake_at not kept: ${out}"

# updated_at defaults to now.
reset
out=$(jq -c 'del(.updated_at)' <<<"$(heartbeat)" | "${TOOL}" publish --dry-run 2>/dev/null) || fail "publish without updated_at failed"
grep -qF '"updated_at": "2026-09-28T20:00:00Z"' <<<"${out}" || fail "updated_at didn't default to now: ${out}"

# A failure to read a repository's visibility (other than 404) fails the publish.
reset
echo bootc-dev/bootc >"${FAKE}/broken"
if heartbeat "b|${UPSTREAM}|" | "${TOOL}" publish >/dev/null 2>"${WORK}/err"; then
    fail "publish succeeded without the visibility"
fi
grep -q 'HTTP 500' "${WORK}/err" || fail "visibility error not reported: $(cat "${WORK}/err")"
test ! -e "${FAKE}/written" || fail "publish wrote despite the error"

# --- Invalid input: (jq edit of a one-worker heartbeat, expected message)
too_many=$(jq -cn '[range(33) | {name: "w\(.)", item_url: "https://github.com/cgwalters-forge/review/pull/16", started_at: "2026-09-28T19:40:00Z", status: "working"}]')
cases=(
    '.extra = 1|unknown key '\''extra'\'''
    '.workers[0].note = "private text"|workers[0]: unknown key '\''note'\'''
    '.coordinator.loop_state = "napping"|coordinator.loop_state: must be one of'
    '.coordinator.cwd = "/home"|coordinator: unknown key'
    'del(.coordinator.session)|coordinator: '\''session'\'' is missing'
    '.workers[0].status = "done"|workers[0].status: must be one of'
    '.workers[0].item_url = "https://example.com/a/b/issues/1"|workers[0].item_url: must be a github.com issue'
    '.workers[0].item_url = "https://github.com/a/b/issues/1#frag"|workers[0].item_url'
    '.workers[0].name = "has space"|workers[0].name'
    '.workers[0].devspace = "Upper"|workers[0].devspace'
    '.workers[0].agent_ids = ["a/../b"]|workers[0].agent_ids[0]'
    '.workers[0].started_at = "2026-09-28T21:00:00Z"|is in the future'
    '.updated_at = "yesterday"|updated_at: must be a UTC time'
    '.workers += .workers|is listed twice'
    '.workers = "none"|workers: must be an array'
    ".workers = ${too_many}|33 workers; at most 32"
    '.coordinator.next_wake_at = "2026-09-28T19:00:00Z"|next_wake_at: is before updated_at'
    '.coordinator.next_wake_at = "2026-09-28T23:00:00Z"|next_wake_at: 2026-09-28T23:00:00Z is more than 120 minutes ahead'
)
for case in "${cases[@]}"; do
    edit=${case%%|*} want=${case#*|}
    reset
    rc=0
    heartbeat "ops-v2|${PUB}|ops-v2" | jq -c "${edit}" | "${TOOL}" publish >/dev/null 2>"${WORK}/err" || rc=$?
    test "${rc}" -eq "${EX_INVALID}" || fail "[${edit}] exit ${rc}, want ${EX_INVALID}: $(cat "${WORK}/err")"
    grep -qF -- "${want}" "${WORK}/err" || fail "[${edit}] error lacks '${want}': $(cat "${WORK}/err")"
    test ! -e "${FAKE}/calls" || fail "[${edit}] called gh on invalid input"
done
for input in 'not json' "$(head -c 20000 /dev/zero | tr '\0' ' ')"; do
    reset
    rc=0
    printf '%s' "${input}" | "${TOOL}" publish >/dev/null 2>"${WORK}/err" || rc=$?
    test "${rc}" -eq "${EX_INVALID}" || fail "[${input:0:10}] exit ${rc}, want ${EX_INVALID}"
done

# --- Publishing: create once, then edit the bot's comment in place.
# Only as the bot, which is whose comment it looks for.
reset
if heartbeat "ops-v2|${PUB}|ops-v2" | FAKE_LOGIN=someone "${TOOL}" publish 2>"${WORK}/err"; then
    fail "publish as another login succeeded"
fi
grep -qF "gh is authenticated as 'someone'" "${WORK}/err" || fail "wrong login not reported: $(cat "${WORK}/err")"
test ! -e "${FAKE}/written" || fail "publish as another login created a comment"
reset
heartbeat "ops-v2|${PUB}|ops-v2" | jq -c '.workers[0].agent_ids = ["aw1"]' | "${TOOL}" publish 2>"${WORK}/err" || fail "first publish failed: $(cat "${WORK}/err")"
test "$(head -1 "${FAKE}/written")" = "POST ${COMMENTS_API}" || fail "first publish didn't create the comment: $(head -1 "${FAKE}/written")"
test "$(head -1 "${FAKE}/usage-written")" = "POST ${USAGE_API}" || fail "first publish didn't create the usage comment: $(head -1 "${FAKE}/usage-written" 2>&1)"
no_usage "publish" "$(tail -n +2 "${FAKE}/written" | jq -r .body)"
tail -n +2 "${FAKE}/usage-written" | jq -r .body | grep -qF '"cache_read": 2000' || fail "the usage comment lacks the worker's tokens"
# The body as JSON: a command substitution would drop its final newline.
body=$(tail -n +2 "${FAKE}/written" | jq .body)
# Someone else's comment that looks like it, then the bot's.
jq -n --argjson b "${body}" '[{id: 1, html_url: "u1", user: {login: "someone"}, body: $b},
    {id: 2, html_url: "u2", user: {login: "cgwalters-bot"}, body: "hello"},
    {id: 3, html_url: "u3", user: {login: "cgwalters-bot"}, body: $b}]' >"${FAKE}/comments.json"
rm "${FAKE}/written"
heartbeat "ops-v2|${PUB}|ops-v2" | "${TOOL}" publish 2>"${WORK}/err" || fail "unchanged publish failed: $(cat "${WORK}/err")"
test ! -e "${FAKE}/written" || fail "an unchanged heartbeat was written again"
grep -q 'unchanged' "${WORK}/err" || fail "unchanged publish didn't say so"
heartbeat "ops-v2|${PUB}|ops-v2" "b|${UPSTREAM}|" | "${TOOL}" publish 2>"${WORK}/err" || fail "second publish failed: $(cat "${WORK}/err")"
test "$(head -1 "${FAKE}/written")" = "PATCH repos/cgwalters-forge/tracker/issues/comments/3" ||
    fail "second publish didn't edit the bot's comment: $(head -1 "${FAKE}/written")"

# show reads it back.
body=$(tail -n +2 "${FAKE}/written" | jq .body)
jq -n --argjson b "${body}" '[{id: 3, html_url: "u3", user: {login: "cgwalters-bot"}, body: $b}]' >"${FAKE}/comments.json"
test "$("${TOOL}" show | jq -c '[.workers[].name]')" = '["ops-v2","b"]' || fail "show didn't read the heartbeat back"
body=$(tail -n +2 "${FAKE}/usage-written" | jq .body)
jq -n --argjson b "${body}" '[{id: 4, html_url: "u4", user: {login: "cgwalters-bot"}, body: $b}]' >"${FAKE}/usage-comments.json"
test "$("${TOOL}" show --usage | jq -r .schema)" = bot-usage/v1 || fail "show --usage didn't read the usage back"
# A malformed one is an error, not a stack trace.
jq -n '[{id: 3, html_url: "u3", user: {login: "cgwalters-bot"}, body: "<!-- bot-heartbeat v1 -->\n```json\n{oops\n```"}]' >"${FAKE}/comments.json"
rc=0
"${TOOL}" show >/dev/null 2>"${WORK}/err" || rc=$?
if test "${rc}" -ne 1 || ! grep -q "JSON block is malformed" "${WORK}/err"; then
    fail "show of a malformed comment: exit ${rc}: $(cat "${WORK}/err")"
fi

# The usage goes only to a private repository.
reset
touch "${FAKE}/ops-public"
rc=0
heartbeat "ops-v2|${PUB}|ops-v2" | "${TOOL}" publish 2>"${WORK}/err" || rc=$?
test "${rc}" -eq 1 || fail "publish with a public usage repository: exit ${rc}"
grep -qF 'cgwalters-forge/bot-ops is not private' "${WORK}/err" || fail "public usage repository not reported: $(cat "${WORK}/err")"
test -e "${FAKE}/written" || fail "the heartbeat wasn't published first"
test ! -e "${FAKE}/usage-written" || fail "usage was written to a public repository"

if test "${failures}" -ne 0; then
    echo "${failures} failure(s)" 1>&2
    exit 1
fi
echo "ok: bot-heartbeat"

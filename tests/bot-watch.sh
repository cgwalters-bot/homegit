#!/usr/bin/env bash
# Offline tests of what bot-watch reports about comments and reviews,
# against a fake gh serving REST fixtures, with the board and the state in
# files (--board-file, --state-file). No network.
#   tests/bot-watch.sh
# The main fixture replays bootc-dev/bootc#2498: 'bot-pr promote' opened
# it, cgwalters requested changes 12 minutes later, and the next sweep saw
# the PR for the first time, recorded his review as seen and reported
# nothing.
# jq programs hold literal $variables.
# shellcheck disable=SC2016
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_WATCH=${TESTS}/../bin/bot-watch
readonly PR=https://github.com/bootc-dev/bootc/pull/2498
readonly ISSUE=https://github.com/example/proj/issues/5
readonly OLD_HEAD=1111111111111111111111111111111111111111
readonly NEW_HEAD=2222222222222222222222222222222222222222
readonly REVIEW_LINK=${PR}#pullrequestreview-5318238469

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-watch-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh
export XDG_CACHE_HOME=${WORK}/cache XDG_STATE_HOME=${WORK}/state
export PATH=${WORK}/bin:${PATH}
readonly REST=${FAKE_GH}/rest

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${REST}"
# The fake gh: 'gh api [-i] PATH' answers GETs with $FAKE_GH/rest/PATH.json
# (query string ignored), without an ETag; anything else fails.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
include=false path="" filter=""
while test $# -gt 0; do
    case "$1" in
        -i) include=true; shift ;;
        -H) shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        -*) echo "fake gh: unexpected option $1" 1>&2; exit 1 ;;
        *) path=${1%%\?*}; shift ;;
    esac
done
if test "${path}" = user; then
    echo cgwalters-bot
    exit 0
fi
fixture=${FAKE_GH}/rest/${path}.json
if ! test -e "${fixture}"; then
    ! ${include} || printf 'HTTP/2.0 404 Not Found\r\n\r\n'
    echo "fake gh: Not Found (HTTP 404): ${path}" 1>&2
    exit 1
fi
! ${include} || printf 'HTTP/2.0 200 OK\r\n\r\n'
jq -c "${filter:-.}" "${fixture}"
EOF
chmod +x "${WORK}/bin/gh"

# put PATH JSON: writes a fixture.
put() {
    mkdir -p "$(dirname "${REST}/$1.json")"
    printf '%s\n' "$2" >"${REST}/$1.json"
}

# pr HEAD UPDATED_AT: the PR, opened by the bot at 13:17.
pr() {
    put repos/bootc-dev/bootc/pulls/2498 "$(jq -nc --arg head "$1" --arg updated "$2" '
        {state: "open", merged: false, title: "Fix the thing", updated_at: $updated,
         created_at: "2026-09-25T13:17:00Z", user: {login: "cgwalters-bot"},
         head: {sha: $head, repo: {owner: {login: "cgwalters-forge"}}}}')"
}
# commit SHA DATE
commit() {
    put "repos/bootc-dev/bootc/commits/$1" "$(jq -nc --arg date "$2" \
        '{committer: {login: "cgwalters-bot"}, commit: {committer: {name: "Colin Walters", date: $date}}}')"
    put "repos/bootc-dev/bootc/commits/$1/check-runs" '{"total_count": 0, "check_runs": []}'
    put "repos/bootc-dev/bootc/commits/$1/status" '{"total_count": 0, "state": "pending", "statuses": []}'
}
# review ID LOGIN STATE AT [BODY]
review() {
    jq -nc --argjson id "$1" --arg login "$2" --arg state "$3" --arg at "$4" --arg body "${5:-}" \
        '{id: $id, user: {login: $login}, state: $state, submitted_at: $at, body: $body,
          html_url: "https://github.com/bootc-dev/bootc/pull/2498#pullrequestreview-\($id)"}'
}
# comment ID LOGIN AT BODY
comment() {
    jq -nc --argjson id "$1" --arg login "$2" --arg at "$3" --arg body "$4" \
        '{id: $id, user: {login: $login}, created_at: $at, body: $body,
          html_url: "https://github.com/bootc-dev/bootc/pull/2498#issuecomment-\($id)"}'
}
# reviews/comments: the PR's reviews and comments, from JSON lines on stdin.
reviews() { put repos/bootc-dev/bootc/pulls/2498/reviews "$(jq -sc .)"; }
comments() { put repos/bootc-dev/bootc/issues/2498/comments "$(jq -sc .)"; }
# Reviews and comments, by name.
declare -A FIX
# values NAME...: FIX[NAME]..., one per line.
values() {
    local name
    for name in "$@"; do printf '%s\n' "${FIX[${name}]}"; done
}

FIX[CHANGES]=$(review 5318238469 cgwalters CHANGES_REQUESTED 2026-09-25T13:29:02Z "Please split this commit.")
FIX[PROMOTED]=$(comment 900 cgwalters-bot 2026-09-25T13:17:30Z "Promoted from the forge.")

pr "${OLD_HEAD}" 2026-09-25T13:29:02Z
commit "${OLD_HEAD}" 2026-09-25T13:10:00Z
values CHANGES | reviews
values PROMOTED | comments
put repos/bootc-dev/bootc/issues/2498/events '[]'
put repos/bootc-dev/bootc/pulls/2498/comments '[{"id": 30, "pull_request_review_id": 5318238471, "body": "Typo here."}]'
# Someone else's issue, with a month of history before it reached the board.
put repos/example/proj/issues/5 '{"state": "open", "title": "Old bug", "updated_at": "2026-09-01T10:00:00Z",
    "created_at": "2026-08-01T10:00:00Z", "user": {"login": "someone"}}'
put repos/example/proj/issues/5/comments '[{"id": 7, "user": {"login": "cgwalters"}, "created_at": "2026-09-01T10:00:00Z",
    "body": "Old news", "html_url": "https://github.com/example/proj/issues/5#issuecomment-7"}]'

jq -n --arg pr "${PR}" --arg issue "${ISSUE}" '[
    {id: "PVTI_pr", title: "Fix the thing", status: "In Review", workflow: "fork",
     content: {type: "PullRequest", url: $pr}},
    {id: "PVTI_issue", title: "Old bug", status: "Todo", workflow: "fork",
     content: {type: "Issue", url: $issue}}]' >"${WORK}/board.json"

# A state from earlier sweeps, of an item since done: not the first sweep.
readonly EARLIER='{"version": 1, "items": {"https://github.com/example/proj/issues/1": {"updated_at": "2026-09-20T00:00:00Z", "state": "closed", "edge_ids": []}}}'

# sweep NAME [STATE]: runs a sweep with the state kept in NAME.state
# (started from STATE if given), its JSON report in NAME.json and its
# text report in NAME.txt (from a dry run of the same state).
sweep() {
    local state=${WORK}/$1.state
    test $# -lt 2 || printf '%s\n' "$2" >"${state}"
    cp "${state}" "${WORK}/$1.state.before"
    "${BOT_WATCH}" --dry-run --board-file "${WORK}/board.json" --state-file "${state}" \
        >"${WORK}/$1.txt" 2>"${WORK}/$1.err" || { cat "${WORK}/$1.err" 1>&2; fail "$1: text sweep failed"; }
    "${BOT_WATCH}" --json --board-file "${WORK}/board.json" --state-file "${state}" \
        >"${WORK}/$1.json" 2>"${WORK}/$1.err" || { cat "${WORK}/$1.err" 1>&2; fail "$1: sweep failed"; }
}

# expect NAME DESCRIPTION JQ [JQ_ARGS...]: JQ must hold for NAME's JSON
# report.
expect() {
    jq -e "${@:4}" "$3" "${WORK}/$1.json" >/dev/null || fail "$1: $2; report: $(jq -c . "${WORK}/$1.json")"
}

# (a) First sight of the bot's PR: the review after it was opened is news,
# its own comment isn't. (b) First sight of someone else's issue: its
# history isn't.
sweep watch "${EARLIER}"
expect watch "the review on the new PR is reported once, the rest not" '
    [.items[].changes[]] as $c
    | ($c | length) == 1
      and $c[0].url == $pr and $c[0].type == "review" and $c[0].review_state == "CHANGES_REQUESTED"
      and $c[0].author == "cgwalters" and $c[0].from_requester' --arg pr "${PR}"
expect watch "both URLs are newly tracked" '.new_urls | length == 2'
grep -q "review CHANGES_REQUESTED by @cgwalters (operator): Please split this commit." "${WORK}/watch.txt" ||
    fail "watch: the text report lacks the review: $(cat "${WORK}/watch.txt")"

# (c) The unanswered review is listed on every sweep, the second too,
# though it's no news any more.
readonly OUTSTANDING_JQ='.outstanding_reviews | length == 1 and .[0].url == $pr
    and .[0].review_state == "CHANGES_REQUESTED" and .[0].link == $link and .[0].items[0].id == "PVTI_pr"'
expect watch "the review is outstanding" "${OUTSTANDING_JQ}" --arg pr "${PR}" --arg link "${REVIEW_LINK}"
sweep watch
expect watch "the second sweep has no news" '.items == []'
expect watch "the review is still outstanding" "${OUTSTANDING_JQ}" --arg pr "${PR}" --arg link "${REVIEW_LINK}"
if ! grep -qx "Outstanding reviews by cgwalters:" "${WORK}/watch.txt" ||
    ! grep -q "review CHANGES_REQUESTED at 2026-09-25T13:29:02Z: Please split this commit." "${WORK}/watch.txt"; then
    fail "watch: the text report lacks the outstanding review: $(cat "${WORK}/watch.txt")"
fi

# The very first sweep reports nothing, but lists the outstanding review.
sweep first '{}'
expect first "the first sweep has no news" '.items == []'
expect first "the first sweep lists the outstanding review" "${OUTSTANDING_JQ}" --arg pr "${PR}" --arg link "${REVIEW_LINK}"

# What answers the review, or doesn't: a newer push; the bot's reply;
# his approval after it; a comment of his after the bot's reply.
# CASE|HEAD|HEAD_DATE|OUTSTANDING|REVIEWS|COMMENTS, the last two as keys
# of FIX.
FIX[REPLY]=$(comment 901 cgwalters-bot 2026-09-25T13:40:00Z "Split in two.")
FIX[APPROVED]=$(review 5318238470 cgwalters APPROVED 2026-09-25T13:45:00Z)
FIX[AGAIN]=$(comment 902 cgwalters 2026-09-25T13:50:00Z "One more thing.")
FIX[LINE_ONLY]=$(review 5318238471 cgwalters COMMENTED 2026-09-25T13:55:00Z)
while IFS='|' read -r name head head_date count rev com; do
    pr "${head}" 2026-09-25T14:00:00Z
    commit "${head}" "${head_date}"
    # shellcheck disable=SC2086 # lists of names
    values ${rev} | reviews
    # shellcheck disable=SC2086
    values ${com} | comments
    sweep "case-${name}" "$(cat "${WORK}/watch.state")"
    expect "case-${name}" "${count} outstanding" '.outstanding_reviews | length == $n' --argjson n "${count}"
done <<EOF
pushed|${NEW_HEAD}|2026-09-25T13:35:00Z|0|CHANGES|PROMOTED
push-predates-review|${NEW_HEAD}|2026-09-25T13:20:00Z|1|CHANGES|PROMOTED
replied|${OLD_HEAD}|2026-09-25T13:10:00Z|0|CHANGES|PROMOTED REPLY
approved|${OLD_HEAD}|2026-09-25T13:10:00Z|0|CHANGES APPROVED|PROMOTED
asked-again|${OLD_HEAD}|2026-09-25T13:10:00Z|1|CHANGES|PROMOTED REPLY AGAIN
line-comments|${OLD_HEAD}|2026-09-25T13:10:00Z|1|CHANGES LINE_ONLY|PROMOTED REPLY
EOF
grep -q "review COMMENTED at 2026-09-25T13:55:00Z: (line comments)" "${WORK}/case-line-comments.txt" ||
    fail "case-line-comments: text report: $(cat "${WORK}/case-line-comments.txt")"

test "${failures}" -eq 0 || { echo "${failures} failure(s)" 1>&2; exit 1; }
echo "ok: bot-watch first-sight news and outstanding reviews as expected"

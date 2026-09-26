#!/usr/bin/env bash
# Offline tests of what bot-watch reports about comments and reviews,
# against a fake gh serving REST fixtures (with ETags), with the board
# and the state in files (--board-file, --state-file). No network.
#   [KEEP=1] tests/bot-watch.sh   (KEEP=1 keeps the work directory)
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
readonly BOT=cgwalters-bot
readonly GH=https://github.com
readonly PR=${GH}/bootc-dev/bootc/pull/2498
readonly ISSUE=${GH}/example/proj/issues/5
readonly BOT_ISSUE=${GH}/example/proj/issues/6
readonly FORK_PR=${GH}/cgwalters-forge/bootc/pull/19
readonly OFF_BOARD_PR=${GH}/bootc-dev/bootc/pull/2600
readonly OLD_HEAD=1111111111111111111111111111111111111111
readonly NEW_HEAD=2222222222222222222222222222222222222222
readonly FORK_HEAD=3333333333333333333333333333333333333333
readonly OFF_BOARD_HEAD=4444444444444444444444444444444444444444
readonly REVIEW_LINK=${PR}#pullrequestreview-5318238469

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-watch-test.XXXXXX")
readonly WORK
trap 'test -n "${KEEP:-}" || rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh
export XDG_CACHE_HOME=${WORK}/cache XDG_STATE_HOME=${WORK}/state UPSTREAM_POLICY_DIR=${WORK}/policy
export PATH=${WORK}/bin:${PATH}
readonly REST=${FAKE_GH}/rest

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${REST}"
# The fake gh: 'gh api [-i] PATH' answers GETs with $FAKE_GH/rest/PATH.json
# (query string ignored), with its checksum as the ETag, and 304 for a
# matching If-None-Match. With $FAKE_GH/rest/PATH.fail, it fails with
# that file's first line as the HTTP status and its second as gh's error.
# Each answer is logged as "STATUS PATH" to $FAKE_GH/calls.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
include=false path="" filter="" if_none_match=""
while test $# -gt 0; do
    case "$1" in
        -i) include=true; shift ;;
        -H) [[ "$2" != If-None-Match:* ]] || if_none_match=${2#If-None-Match: }; shift 2 ;;
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
if test -e "${FAKE_GH}/rest/${path}.fail"; then
    { read -r status; read -r message; } <"${FAKE_GH}/rest/${path}.fail"
    echo "${status%% *} ${path}" >>"${FAKE_GH}/calls"
    ! ${include} || printf 'HTTP/2.0 %s\r\n\r\n' "${status}"
    echo "gh: ${message}" 1>&2
    exit 1
fi
if ! test -e "${fixture}"; then
    echo "404 ${path}" >>"${FAKE_GH}/calls"
    ! ${include} || printf 'HTTP/2.0 404 Not Found\r\n\r\n'
    echo "fake gh: Not Found (HTTP 404): ${path}" 1>&2
    exit 1
fi
etag="\"$(sha256sum "${fixture}" | cut -c1-16)\""
if ${include} && test "${if_none_match}" = "${etag}"; then
    echo "304 ${path}" >>"${FAKE_GH}/calls"
    printf 'HTTP/2.0 304 Not Modified\r\nEtag: %s\r\n\r\n' "${etag}"
    exit 1
fi
echo "200 ${path}" >>"${FAKE_GH}/calls"
! ${include} || printf 'HTTP/2.0 200 OK\r\nEtag: %s\r\n\r\n' "${etag}"
jq -c "${filter:-.}" "${fixture}"
EOF
chmod +x "${WORK}/bin/gh"

# put PATH JSON: writes a fixture.
put() {
    mkdir -p "$(dirname "${REST}/$1.json")"
    printf '%s\n' "$2" >"${REST}/$1.json"
}

# pr REPO NUMBER HEAD UPDATED_AT: an open PR, opened by the bot at 13:17.
pr() {
    put "repos/$1/pulls/$2" "$(jq -nc --arg head "$3" --arg updated "$4" '
        {state: "open", merged: false, title: "Fix the thing", updated_at: $updated,
         created_at: "2026-09-25T13:17:00Z", user: {login: "cgwalters-bot"},
         head: {sha: $head, repo: {owner: {login: "cgwalters-forge"}}}}')"
    put "repos/$1/issues/$2/events" '[]'
}
# commit REPO SHA DATE [COMMITTER]: a commit, by the bot by default.
commit() {
    put "repos/$1/commits/$2" "$(jq -nc --arg date "$3" --arg by "${4:-${BOT}}" \
        '{committer: {login: $by}, commit: {committer: {name: "Someone", date: $date}}}')"
    put "repos/$1/commits/$2/check-runs" '{"total_count": 0, "check_runs": []}'
    put "repos/$1/commits/$2/status" '{"total_count": 0, "state": "pending", "statuses": []}'
}
# review ID LOGIN STATE AT [BODY]: a review of the main PR.
review() {
    jq -nc --argjson id "$1" --arg login "$2" --arg state "$3" --arg at "$4" --arg body "${5:-}" --arg pr "${PR}" \
        '{id: $id, user: {login: $login}, state: $state, submitted_at: $at, body: $body,
          html_url: "\($pr)#pullrequestreview-\($id)"}'
}
# comment URL ID LOGIN AT BODY: an issue or PR comment.
comment() {
    jq -nc --arg url "$1" --argjson id "$2" --arg login "$3" --arg at "$4" --arg body "$5" \
        '{id: $id, user: {login: $login}, created_at: $at, body: $body, html_url: "\($url)#issuecomment-\($id)"}'
}
# reviews PATH / comments PATH: reviews or comments from JSON lines on
# stdin, at PATH (a URL's API path, repos/O/R/{pulls,issues}/N).
reviews() { put "$1/reviews" "$(jq -sc .)"; }
comments() { put "$1/comments" "$(jq -sc .)"; }
readonly PR_API=repos/bootc-dev/bootc/pulls/2498 PR_ISSUE_API=repos/bootc-dev/bootc/issues/2498
# Reviews and comments of the main PR, by name.
declare -A FIX
# values NAME...: FIX[NAME]..., one per line.
values() {
    local name
    for name in "$@"; do printf '%s\n' "${FIX[${name}]}"; done
}

FIX[CHANGES]=$(review 5318238469 cgwalters CHANGES_REQUESTED 2026-09-25T13:29:02Z "Please split this commit.")
FIX[PROMOTED]=$(comment "${PR}" 900 "${BOT}" 2026-09-25T13:17:30Z "Promoted from the forge.")

pr bootc-dev/bootc 2498 "${OLD_HEAD}" 2026-09-25T13:29:02Z
commit bootc-dev/bootc "${OLD_HEAD}" 2026-09-25T13:10:00Z
values CHANGES | reviews "${PR_API}"
values PROMOTED | comments "${PR_ISSUE_API}"
put "${PR_API}/comments" '[{"id": 30, "pull_request_review_id": 5318238471, "body": "Typo here."}]'

# Someone else's issue, with a month of history before it reached the
# board, and comments since the last sweep (13:00) by cgwalters and by
# someone else: only his is news.
put repos/example/proj/issues/5 '{"state": "open", "title": "Old bug", "updated_at": "2026-09-25T13:06:00Z",
    "created_at": "2026-08-01T10:00:00Z", "user": {"login": "someone"}}'
{
    comment "${ISSUE}" 7 cgwalters 2026-09-01T10:00:00Z "Old news"
    comment "${ISSUE}" 8 cgwalters 2026-09-25T13:05:00Z "Bot, please take this."
    comment "${ISSUE}" 9 someone 2026-09-25T13:06:00Z "Me too"
} | comments repos/example/proj/issues/5
# An issue the bot opened at 12:00: all since then is news, but its own.
put repos/example/proj/issues/6 '{"state": "open", "title": "Bot bug", "updated_at": "2026-09-25T12:40:00Z",
    "created_at": "2026-09-25T12:00:00Z", "user": {"login": "cgwalters-bot"}}'
{
    comment "${BOT_ISSUE}" 10 "${BOT}" 2026-09-25T12:00:30Z "Details."
    comment "${BOT_ISSUE}" 11 cgwalters 2026-09-25T12:30:00Z "Why?"
    comment "${BOT_ISSUE}" 12 someone 2026-09-25T12:40:00Z "Same here"
} | comments repos/example/proj/issues/6
# The bot's fork PR, which cgwalters asked changes of: 'bot-pr inbox'
# business, neither news nor outstanding here.
pr cgwalters-forge/bootc 19 "${FORK_HEAD}" 2026-09-25T13:00:00Z
commit cgwalters-forge/bootc "${FORK_HEAD}" 2026-09-25T12:50:00Z
review 1 cgwalters CHANGES_REQUESTED 2026-09-25T13:00:00Z "No." | reviews repos/cgwalters-forge/bootc/pulls/19
: | comments repos/cgwalters-forge/bootc/issues/19
# The bot's upstream PR that isn't on the board, with his review: found
# by the search, as are fork PRs, which are left out (#20 has no
# fixtures: reading it would warn), and #2700, which can't be read and
# is skipped with a warning. The search's answer is well over a pipe's size
# (64KiB), like the real one.
readonly UNREADABLE_PR=${GH}/bootc-dev/bootc/pull/2700
pr bootc-dev/bootc 2600 "${OFF_BOARD_HEAD}" 2026-09-25T13:00:00Z
commit bootc-dev/bootc "${OFF_BOARD_HEAD}" 2026-09-25T12:00:00Z
review 2 cgwalters CHANGES_REQUESTED 2026-09-25T13:00:00Z "Off the board." |
    jq -c --arg u "${OFF_BOARD_PR}" '.html_url = "\($u)#pullrequestreview-2"' | reviews repos/bootc-dev/bootc/pulls/2600
: | comments repos/bootc-dev/bootc/issues/2600
put search/issues "$(jq -nc --arg a "${PR}" --arg b "${OFF_BOARD_PR}" --arg c "${FORK_PR}" --arg d "${UNREADABLE_PR}" \
    '{total_count: 5, items: [{html_url: $a}, {html_url: $b}, {html_url: $c},
                              {html_url: "https://github.com/cgwalters-forge/bootc/pull/20"},
                              {html_url: $d, body: ("x" * 1000000)}]}')"

# board [URL...]: the board, with the main PR (unless "no-pr" comes
# first), the two issues, and the fork PR in the Branch field of the
# first issue's item.
board() {
    local with_pr=true
    test "${1:-}" != no-pr || with_pr=false
    jq -n --argjson with_pr "${with_pr}" --arg pr "${PR}" --arg issue "${ISSUE}" --arg bot_issue "${BOT_ISSUE}" --arg fork "${FORK_PR}" '
        [if $with_pr then {id: "PVTI_pr", title: "Fix the thing", status: "In Review", workflow: "fork",
                          content: {type: "PullRequest", url: $pr}} else empty end,
         {id: "PVTI_issue", title: "Old bug", status: "Draft", workflow: "fork", branch: $fork,
          content: {type: "Issue", url: $issue}},
         {id: "PVTI_bot_issue", title: "Bot bug", status: "Todo", workflow: "fork",
          content: {type: "Issue", url: $bot_issue}}]' >"${WORK}/board.json"
}
board

# A state from an earlier sweep at 13:00, of an item since done.
readonly EARLIER='{"version": 1, "swept_at": "2026-09-25T13:00:00Z",
    "items": {"https://github.com/example/proj/issues/1": {"updated_at": "2026-09-20T00:00:00Z", "state": "closed", "edge_ids": []}}}'

# sweep NAME NOW [STATE]: runs a sweep at NOW with the state kept in
# NAME.state (started from STATE if given), its JSON report in NAME.json
# and its text report in NAME.txt (from a dry run of the same state).
sweep() {
    local state=${WORK}/$1.state
    test $# -lt 3 || printf '%s\n' "$3" >"${state}"
    "${BOT_WATCH}" --dry-run --now "$2" --board-file "${WORK}/board.json" --state-file "${state}" \
        >"${WORK}/$1.txt" 2>"${WORK}/$1.err" || { cat "${WORK}/$1.err" 1>&2; fail "$1: text sweep failed"; }
    "${BOT_WATCH}" --json --now "$2" --board-file "${WORK}/board.json" --state-file "${state}" \
        >"${WORK}/$1.json" 2>"${WORK}/$1.err" || { cat "${WORK}/$1.err" 1>&2; fail "$1: sweep failed"; }
}

# expect NAME DESCRIPTION [JQ_ARGS...] JQ: JQ must hold for NAME's JSON
# report.
expect() {
    jq -e "${@:3:$#-3}" "${!#}" "${WORK}/$1.json" >/dev/null || fail "$1: $2; report: $(jq -c . "${WORK}/$1.json")"
}

# (a) First sight of the bot's PR and issue: what came after they were
# opened is news, their own comments aren't. (b) First sight of someone
# else's issue: only cgwalters' comment since the last sweep is news.
# Nothing is from the fork PR.
readonly FIRST_SIGHT_JQ='
    [.items[].changes[] | [.url, .type, .author, .at]] | sort == ([
        [$pr, "review", "cgwalters", "2026-09-25T13:29:02Z"],
        [$issue, "comment", "cgwalters", "2026-09-25T13:05:00Z"],
        [$bot_issue, "comment", "cgwalters", "2026-09-25T12:30:00Z"],
        [$bot_issue, "comment", "someone", "2026-09-25T12:40:00Z"]] | sort)'
first_sight_args=(--arg pr "${PR}" --arg issue "${ISSUE}" --arg bot_issue "${BOT_ISSUE}")
sweep watch 2026-09-25T14:00:00Z "${EARLIER}"
expect watch "first-sight news" "${first_sight_args[@]}" "${FIRST_SIGHT_JQ}"
expect watch "all URLs are newly tracked" '.new_urls | length == 4'
grep -q "review CHANGES_REQUESTED by @cgwalters (operator): Please split this commit." "${WORK}/watch.txt" ||
    fail "watch: the text report lacks the review: $(cat "${WORK}/watch.txt")"

# (c) The unanswered reviews are listed on every sweep, also the second,
# with no news: the board's PR, and the one off the board, not the fork
# PR. The second sweep's reads are all answered 304.
readonly OUTSTANDING_JQ='[.outstanding_reviews[] | {url, review_state, link, items: [.items[].id]}] == [
    {url: $pr, review_state: "CHANGES_REQUESTED", link: $link, items: ["PVTI_pr"]},
    {url: $off, review_state: "CHANGES_REQUESTED", link: "\($off)#pullrequestreview-2", items: []}]'
outstanding_args=(--arg pr "${PR}" --arg link "${REVIEW_LINK}" --arg off "${OFF_BOARD_PR}")
expect watch "the reviews are outstanding" "${outstanding_args[@]}" "${OUTSTANDING_JQ}"
sweep watch 2026-09-25T14:10:00Z
# Once more, with every resource read before.
: >"${FAKE_GH}/calls"
sweep watch 2026-09-25T14:10:00Z
expect watch "the second sweep has no news" '.items == []'
expect watch "the reviews are still outstanding" "${outstanding_args[@]}" "${OUTSTANDING_JQ}"
if ! grep -qx "Outstanding reviews by cgwalters:" "${WORK}/watch.txt" ||
    ! grep -q "review CHANGES_REQUESTED at 2026-09-25T13:29:02Z: Please split this commit." "${WORK}/watch.txt" ||
    ! grep -q "bootc-dev/bootc#2600  (not on the board)" "${WORK}/watch.txt"; then
    fail "watch: the text report lacks the outstanding reviews: $(cat "${WORK}/watch.txt")"
fi
if ! grep -q "reading ${UNREADABLE_PR} (off the board) for outstanding reviews failed (status 66); skipped" "${WORK}/watch.err" ||
    grep -q -e "checking the bot's open PRs off the board failed" -e pull/20 "${WORK}/watch.err"; then
    fail "watch: expected only a warning about ${UNREADABLE_PR}: $(cat "${WORK}/watch.err")"
fi
if grep -v -e '^304 ' -e '^200 search/issues$' -e '^404 repos/bootc-dev/bootc/pulls/2700$' "${FAKE_GH}/calls" | grep -q . ||
    ! grep -q "^304 ${PR_API}/reviews$" "${FAKE_GH}/calls"; then
    fail "watch: the second sweep read unchanged resources without 304s: $(sort "${FAKE_GH}/calls" | uniq -c)"
fi

# The very first sweep reports nothing, but lists the outstanding reviews.
sweep first 2026-09-25T14:00:00Z '{}'
expect first "the first sweep has no news" '.items == []'
expect first "the first sweep lists the outstanding reviews" "${outstanding_args[@]}" "${OUTSTANDING_JQ}"

# Leave and return: the PR leaves the board, cgwalters comments while
# it's away, and it comes back. Only that comment is news, not his
# review from before it left, which the first sweep reported.
cp "${WORK}/watch.state" "${WORK}/away.state"
board no-pr
sweep away 2026-09-25T14:20:00Z
expect away "the PR is remembered as dropped" --arg pr "${PR}" '.state_advanced'
jq -e --arg pr "${PR}" '.dropped[$pr] == "2026-09-25T14:00:00Z" and (.items | has($pr) | not)' "${WORK}/away.state" >/dev/null ||
    fail "away: the state doesn't remember the dropped PR: $(cat "${WORK}/away.state")"
{ values PROMOTED; comment "${PR}" 904 cgwalters 2026-09-25T14:25:00Z "While you were away."; } | comments "${PR_ISSUE_API}"
board
sweep away 2026-09-25T14:30:00Z
expect away "only the news since it left" --arg pr "${PR}" '
    [.items[].changes[] | [.url, .type, .at]] == [[$pr, "comment", "2026-09-25T14:25:00Z"]]'
jq -e --arg pr "${PR}" '.dropped | has($pr) | not' "${WORK}/away.state" >/dev/null ||
    fail "away: the returned PR is still dropped: $(cat "${WORK}/away.state")"
values PROMOTED | comments "${PR_ISSUE_API}"

# A state from before swept_at and dropped: its updated_at is when the
# last sweep ran, and the URL no longer on the board becomes dropped.
sweep legacy 2026-09-25T14:00:00Z "$(jq -c 'del(.swept_at) | .updated_at = "2026-09-25T13:00:00Z"' <<<"${EARLIER}")"
expect legacy "first-sight news from an old state" "${first_sight_args[@]}" "${FIRST_SIGHT_JQ}"
jq -e '.swept_at == "2026-09-25T14:00:00Z"
       and .dropped == {"https://github.com/example/proj/issues/1": "2026-09-25T13:00:00Z"}' "${WORK}/legacy.state" >/dev/null ||
    fail "legacy: the new state lacks swept_at or dropped: $(cat "${WORK}/legacy.state")"

# The search failing, generically or rate limited, costs only the PR off
# the board: the sweep still reports and writes its state, and exits 1.
for failure in "502 Bad Gateway|HTTP 502: Bad Gateway" "403 Forbidden|API rate limit exceeded for user (HTTP 403)"; do
    printf '%s\n' "${failure%%|*}" "${failure#*|}" >"${REST}/search/issues.fail"
    printf '%s\n' "${EARLIER}" >"${WORK}/search.state"
    rc=0
    "${BOT_WATCH}" --json --now 2026-09-25T14:00:00Z --board-file "${WORK}/board.json" --state-file "${WORK}/search.state" \
        >"${WORK}/search.json" 2>"${WORK}/search.err" || rc=$?
    test "${rc}" -eq 1 || fail "search ${failure%%|*}: exit status ${rc}, not 1: $(cat "${WORK}/search.err")"
    expect search "search ${failure%%|*}: the board's news and outstanding review" "${first_sight_args[@]}" \
        --arg link "${REVIEW_LINK}" "(${FIRST_SIGHT_JQ})"' and .search_failed and .state_advanced
        and ([.outstanding_reviews[].link] == [$link])'
    jq -e .swept_at "${WORK}/search.state" >/dev/null ||
        fail "search ${failure%%|*}: the state wasn't written: $(cat "${WORK}/search.state")"
    grep -q "only the board's PRs were checked" "${WORK}/search.err" ||
        fail "search ${failure%%|*}: no warning: $(cat "${WORK}/search.err")"
done
rm "${REST}/search/issues.fail"

# What answers his review, or doesn't. After a push, answering needs the
# head commit's committer to be the bot or him.
# CASE|HEAD|HEAD_DATE|COMMITTER|OUTSTANDING|REVIEW_STATE|COUNT|REVIEWS|COMMENTS,
# the last two as keys of FIX; REVIEW_STATE and COUNT of the one listed.
FIX[REPLY]=$(comment "${PR}" 901 "${BOT}" 2026-09-25T13:40:00Z "Split in two.")
FIX[APPROVED]=$(review 5318238470 cgwalters APPROVED 2026-09-25T13:45:00Z)
FIX[AGAIN]=$(comment "${PR}" 902 cgwalters 2026-09-25T13:50:00Z "One more thing.")
FIX[LGTM]=$(comment "${PR}" 903 cgwalters 2026-09-25T13:46:00Z "LGTM, thanks!")
FIX[MENTION]=$(comment "${PR}" 905 cgwalters 2026-09-25T13:47:00Z "@cgwalters-bot also bump the version")
FIX[OTHER_MENTION]=$(comment "${PR}" 906 cgwalters 2026-09-25T13:47:00Z "cc @cgwalters-bot-helper")
FIX[BOTLINE]=$(review 5318238480 "${BOT}" COMMENTED 2026-09-25T13:41:00Z)
FIX[LINE_ONLY]=$(review 5318238471 cgwalters COMMENTED 2026-09-25T13:55:00Z)
FIX[COMMENTED]=$(review 5318238472 cgwalters COMMENTED 2026-09-25T13:35:00Z "Nit: naming.")
FIX[CHANGES_AGAIN]=$(review 5318238473 cgwalters CHANGES_REQUESTED 2026-09-25T13:50:00Z "Still wrong.")
FIX[DISMISSED]=$(review 5318238474 cgwalters DISMISSED 2026-09-25T13:29:02Z "Please split this commit.")
while IFS='|' read -r name head head_date committer count state listed rev com; do
    pr bootc-dev/bootc 2498 "${head}" 2026-09-25T14:00:00Z
    commit bootc-dev/bootc "${head}" "${head_date}" "${committer}"
    # shellcheck disable=SC2086 # lists of names
    values ${rev} | reviews "${PR_API}"
    # shellcheck disable=SC2086
    values ${com} | comments "${PR_ISSUE_API}"
    sweep "case-${name}" 2026-09-25T15:00:00Z "$(cat "${WORK}/watch.state")"
    expect "case-${name}" "${count} outstanding (${state}, ${listed})" --arg pr "${PR}" --argjson n "${count}" \
        --arg state "${state}" --argjson listed "${listed}" '
        [.outstanding_reviews[] | select(.url == $pr)] as $o
        | ($o | length) == $n and ($n == 0 or ($o[0].count == $listed and ($o[0].review_state // "comment") == $state))'
done <<EOF
pushed|${NEW_HEAD}|2026-09-25T13:35:00Z|${BOT}|0|-|0|CHANGES|PROMOTED
push-predates-review|${NEW_HEAD}|2026-09-25T13:20:00Z|${BOT}|1|CHANGES_REQUESTED|1|CHANGES|PROMOTED
update-branch-by-web-flow|${NEW_HEAD}|2026-09-25T13:35:00Z|web-flow|1|CHANGES_REQUESTED|1|CHANGES|PROMOTED
pushed-by-him|${NEW_HEAD}|2026-09-25T13:35:00Z|cgwalters|0|-|0|CHANGES|PROMOTED
his-push-after-line-comments|${NEW_HEAD}|2026-09-25T14:00:00Z|cgwalters|0|-|0|CHANGES COMMENTED LINE_ONLY|PROMOTED
web-flow-after-line-comments|${NEW_HEAD}|2026-09-25T14:00:00Z|web-flow|1|COMMENTED|2|CHANGES COMMENTED LINE_ONLY|PROMOTED
pushed-by-someone|${NEW_HEAD}|2026-09-25T13:35:00Z|someone|1|CHANGES_REQUESTED|1|CHANGES|PROMOTED
reply-doesnt-answer-changes|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|CHANGES_REQUESTED|1|CHANGES|PROMOTED REPLY
bot-line-reply|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|CHANGES_REQUESTED|1|CHANGES BOTLINE|PROMOTED
reply-answers-commented|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|0|-|0|COMMENTED|PROMOTED REPLY
push-answers-commented|${NEW_HEAD}|2026-09-25T13:36:00Z|${BOT}|0|-|0|COMMENTED|PROMOTED
his-later-review|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|COMMENTED|1|CHANGES LINE_ONLY|PROMOTED
dismissed|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|0|-|0|DISMISSED|PROMOTED
approved|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|0|-|0|CHANGES APPROVED|PROMOTED
lgtm-after-approve|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|0|-|0|CHANGES APPROVED|PROMOTED LGTM
mention-after-approve|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|comment|1|CHANGES APPROVED|PROMOTED LGTM MENTION
other-mention-after-approve|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|0|-|0|CHANGES APPROVED|PROMOTED OTHER_MENTION
count-after-approve|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|comment|1|COMMENTED APPROVED|PROMOTED MENTION
review-after-approve|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|CHANGES_REQUESTED|1|CHANGES APPROVED CHANGES_AGAIN|PROMOTED LGTM
asked-again|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|comment|2|CHANGES|PROMOTED REPLY AGAIN
line-comments|${OLD_HEAD}|2026-09-25T13:10:00Z|${BOT}|1|COMMENTED|1|COMMENTED LINE_ONLY|PROMOTED REPLY
EOF
grep -q "review COMMENTED at 2026-09-25T13:55:00Z: (line comments)" "${WORK}/case-line-comments.txt" ||
    fail "case-line-comments: text report: $(cat "${WORK}/case-line-comments.txt")"

# --- Needs rebase ---
# The bot's PRs in example/rb from cgwalters-forge/rb:bot/rb-N.
# rb_pr N HEAD MERGEABLE_STATE MERGEABLE BEHIND: PR #N, BEHIND commits
# behind main (by the compare API).
rb_pr() {
    put "repos/example/rb/pulls/$1" "$(jq -nc --argjson n "$1" --arg head "$2" --arg ms "$3" --argjson m "$4" '
        {state: "open", merged: false, title: "Rebase \($n)", updated_at: "2026-09-25T12:00:00Z",
         created_at: "2026-09-25T11:00:00Z", user: {login: "cgwalters-bot"}, mergeable: $m, mergeable_state: $ms,
         base: {ref: "main"}, head: {sha: $head, ref: "bot/rb-\($n)", repo: {full_name: "cgwalters-forge/rb", owner: {login: "cgwalters-forge"}}}}')"
    put "repos/example/rb/issues/$1/events" '[]'
    : | reviews "repos/example/rb/pulls/$1"
    : | comments "repos/example/rb/issues/$1"
    put "repos/example/rb/compare/main...cgwalters-forge:bot/rb-$1" "{\"behind_by\": $5}"
}
# rb_ci SHA CONCLUSION: the commit SHA of example/rb with one check run.
rb_ci() {
    commit example/rb "$1" 2026-09-25T11:30:00Z
    put "repos/example/rb/commits/$1/check-runs" "$(jq -nc --arg c "$2" \
        '{total_count: 1, check_runs: [{name: "tests", status: "completed", conclusion: $c, check_suite: {id: 1}}]}')"
}
put repos/example/rb/actions/runs '{"workflow_runs": []}'
put repos/example/rb/actions/workflows '{"workflows": []}'
# No merge queue: no branch rules, and no workflows.
put repos/example/rb/rules/branches/main '[]'
put repos/example/rb/git/trees/main '{"truncated": false, "tree": []}'
readonly RB=${GH}/example/rb/pull
# #1 fails CI and is behind; #2 conflicts; #3 fails but is up to date;
# #4 is fine; #5's base must be up to date and it isn't. The fork PR
# conflicts with its base. #2600 off the board is behind a base that must
# be up to date too, but has cgwalters' outstanding review: left out.
rb_pr 1 aaaa000000000000000000000000000000000001 blocked true 3
rb_ci aaaa000000000000000000000000000000000001 failure
rb_pr 2 aaaa000000000000000000000000000000000002 dirty false 5
commit example/rb aaaa000000000000000000000000000000000002 2026-09-25T11:30:00Z
rb_pr 3 aaaa000000000000000000000000000000000003 blocked true 0
rb_ci aaaa000000000000000000000000000000000003 failure
rb_pr 4 aaaa000000000000000000000000000000000004 clean true 2
rb_ci aaaa000000000000000000000000000000000004 success
rb_pr 5 aaaa000000000000000000000000000000000005 behind true 1
rb_ci aaaa000000000000000000000000000000000005 success
# #6 fails CI and is behind, and his change request was answered by the
# bot's push since (at 11:30): listed, as 'bot-pr rebase' takes it.
rb_pr 6 aaaa000000000000000000000000000000000006 blocked true 2
rb_ci aaaa000000000000000000000000000000000006 failure
review 60 cgwalters CHANGES_REQUESTED 2026-09-25T11:10:00Z "Fix it." | reviews repos/example/rb/pulls/6
put repos/cgwalters-forge/bootc/pulls/19 "$(jq -c '.mergeable = false | .mergeable_state = "dirty" | .base.ref = "main" | .body = "Why.\n\n<!-- bot-meta -->\n<!-- /bot-meta -->"' \
    "${REST}/repos/cgwalters-forge/bootc/pulls/19.json")"
put repos/bootc-dev/bootc/pulls/2600 "$(jq -c '.mergeable = true | .mergeable_state = "behind" | .base.ref = "main"' \
    "${REST}/repos/bootc-dev/bootc/pulls/2600.json")"
jq -n --arg rb "${RB}" --arg fork "${FORK_PR}" '
    [range(1; 7) as $n | {id: "PVTI_rb\($n)", title: "Rebase \($n)", status: "In Review",
                           content: {type: "PullRequest", url: "\($rb)/\($n)"}}
     | if $n == 2 then .branch = $fork else . end]' >"${WORK}/board.json"

readonly NEEDS_REBASE_JQ='[.needs_rebase[] | [.url, .reason, .conflicts, .behind_by, [.items[].id]]] | sort == ([
    ["\($rb)/1", "ci", false, 3, ["PVTI_rb1"]],
    ["\($rb)/2", "conflict", true, null, ["PVTI_rb2"]],
    [$fork, "conflict", true, null, ["PVTI_rb2"]],
    ["\($rb)/5", "behind", false, null, ["PVTI_rb5"]],
    ["\($rb)/6", "ci", false, 2, ["PVTI_rb6"]]] | sort)'
rebase_args=(--arg rb "${RB}" --arg fork "${FORK_PR}")
sweep rebase 2026-09-25T16:00:00Z "${EARLIER}"
expect rebase "the PRs that need a rebase" "${rebase_args[@]}" "${NEEDS_REBASE_JQ}"
jq -e --arg rb "${RB}" '.rebase["\($rb)/1"] == "aaaa000000000000000000000000000000000001"' "${WORK}/rebase.state" >/dev/null ||
    fail "rebase: the state doesn't remember #1: $(cat "${WORK}/rebase.state")"
if ! grep -qx "Needs rebase (bot-pr rebase URL):" "${WORK}/rebase.txt" ||
    ! grep -qx "  conflict-free:" "${WORK}/rebase.txt" || ! grep -qx "  conflicting (a worker resolves):" "${WORK}/rebase.txt" ||
    ! grep -q "CI failing (tests), 3 behind main at aaaa000000" "${WORK}/rebase.txt" ||
    ! grep -q "conflicts with main at 3333333333" "${WORK}/rebase.txt"; then
    fail "rebase: the text report lacks the rebase section: $(cat "${WORK}/rebase.txt")"
fi
# Listed until done: the same again.
sweep rebase 2026-09-25T16:10:00Z
expect rebase "still listed" "${rebase_args[@]}" "${NEEDS_REBASE_JQ}"
# #1 rebased, its CI running: remembered. Then CI fails, and main has
# moved again: not listed again, and remembered while its CI fails.
rb_pr 1 aaaa000000000000000000000000000000000011 blocked true 0
rb_ci aaaa000000000000000000000000000000000011 failure
put repos/example/rb/commits/aaaa000000000000000000000000000000000011/check-runs \
    '{"total_count": 1, "check_runs": [{"name": "tests", "status": "in_progress", "conclusion": null, "check_suite": {"id": 1}}]}'
sweep rebase 2026-09-25T16:15:00Z
jq -e --arg rb "${RB}" '.rebase["\($rb)/1"] == "aaaa000000000000000000000000000000000001"' "${WORK}/rebase.state" >/dev/null ||
    fail "rebase: the state forgot #1 while its CI runs: $(cat "${WORK}/rebase.state")"
rb_pr 1 aaaa000000000000000000000000000000000011 blocked true 1
rb_ci aaaa000000000000000000000000000000000011 failure
sweep rebase 2026-09-25T16:20:00Z
expect rebase "not listed once rebased" --arg rb "${RB}" '[.needs_rebase[].url] | index("\($rb)/1") | not'
jq -e --arg rb "${RB}" '.rebase["\($rb)/1"] == "aaaa000000000000000000000000000000000001"' "${WORK}/rebase.state" >/dev/null ||
    fail "rebase: the state forgot #1 while its CI fails: $(cat "${WORK}/rebase.state")"
# Its CI passes: forgotten.
rb_ci aaaa000000000000000000000000000000000011 success
sweep rebase 2026-09-25T16:30:00Z
jq -e --arg rb "${RB}" '.rebase | has("\($rb)/1") | not' "${WORK}/rebase.state" >/dev/null ||
    fail "rebase: the state still remembers #1: $(cat "${WORK}/rebase.state")"

# A merge queue, or a record saying so: only the conflicting PRs are
# listed, as 'bot-pr rebase' refuses the others.
readonly CONFLICTING_JQ='[.needs_rebase[].url] | sort == ([$fork, "\($rb)/2"] | sort)'
expect rebase "conflict-free ones listed before" --arg rb "${RB}" '[.needs_rebase[].url] | index("\($rb)/5")'
put repos/example/rb/rules/branches/main '[{"type": "merge_queue", "parameters": {}}]'
rm -r "${XDG_CACHE_HOME}/upstream-policy"
sweep rebase 2026-09-25T16:40:00Z
expect rebase "merge queue: only the conflicting ones" "${rebase_args[@]}" "${CONFLICTING_JQ}"
grep -qx "  conflict-free:" "${WORK}/rebase.txt" && fail "rebase: merge queue: conflict-free ones listed: $(cat "${WORK}/rebase.txt")"
put repos/example/rb/rules/branches/main '[]'
rm -r "${XDG_CACHE_HOME}/upstream-policy"
mkdir -p "${UPSTREAM_POLICY_DIR}/example"
printf '%s\n' --- 'verdict: bot-ok' 'ai-trailer: none' 'dco: no' 'sources: []' 'checked: today' 'rebase: conflicts-only' --- '' 'Asked.' \
    >"${UPSTREAM_POLICY_DIR}/example/rb.md"
sweep rebase 2026-09-25T16:50:00Z
expect rebase "record: only the conflicting ones" "${rebase_args[@]}" "${CONFLICTING_JQ}"
# Like bootc: a workflow runs on merge_group, but cgwalters maintains it
# and wants conflict-free rebases, so its pushed record says 'rebase: any'.
readonly WF_TREE=aaaa0000000000000000000000000000000000a1 WF_DIR=aaaa0000000000000000000000000000000000a2
readonly WF_BLOB=aaaa0000000000000000000000000000000000a3
put repos/example/rb/git/trees/main "{\"truncated\": false, \"tree\": [{\"path\": \".github\", \"type\": \"tree\", \"sha\": \"${WF_TREE}\"}]}"
put "repos/example/rb/git/trees/${WF_TREE}" "{\"truncated\": false, \"tree\": [{\"path\": \"workflows\", \"type\": \"tree\", \"sha\": \"${WF_DIR}\"}]}"
put "repos/example/rb/git/trees/${WF_DIR}" "{\"truncated\": false, \"tree\": [{\"path\": \"ci.yml\", \"type\": \"blob\", \"sha\": \"${WF_BLOB}\"}]}"
put "repos/example/rb/git/blobs/${WF_BLOB}" "$(jq -nc --arg c "$(printf 'on:\n  pull_request:\n  merge_group:\n' | base64 -w0)" '{content: $c, encoding: "base64"}')"
export UPSTREAM_POLICY_DIR=${WORK}/homegit/upstream-policy
mkdir -p "${UPSTREAM_POLICY_DIR}/example"
sweep rebase 2026-09-25T17:00:00Z
expect rebase "merge_group: only the conflicting ones" "${rebase_args[@]}" "${CONFLICTING_JQ}"
printf '%s\n' --- 'verdict: bot-ok' 'ai-trailer: none' 'dco: no' 'sources: []' 'checked: today' 'rebase: any' --- '' 'Maintained.' \
    >"${UPSTREAM_POLICY_DIR}/example/rb.md"
git -C "${WORK}/homegit" init -q
git -C "${WORK}/homegit" add -A
git -C "${WORK}/homegit" -c user.name=t -c user.email=t@example.com commit -q -m "rebase: any"
git -C "${WORK}/homegit" update-ref refs/remotes/origin/main HEAD
rm -r "${XDG_CACHE_HOME}/upstream-policy"
sweep rebase 2026-09-25T17:10:00Z
expect rebase "rebase: any: the conflict-free ones listed again" --arg rb "${RB}" '[.needs_rebase[].url] | index("\($rb)/5")'
grep -qx "  conflict-free:" "${WORK}/rebase.txt" || fail "rebase: any: conflict-free ones not listed: $(cat "${WORK}/rebase.txt")"

test "${failures}" -eq 0 || { echo "${failures} failure(s)" 1>&2; exit 1; }
echo "ok: bot-watch first-sight news, outstanding reviews and PRs that need a rebase as expected"

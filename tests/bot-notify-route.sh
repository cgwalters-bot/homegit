#!/usr/bin/env bash
# Offline tests of how 'bot-notify --dry-run' routes notification threads,
# against a fake 'gh' serving a fixed GitHub (and the bot-board state it
# reads). No network, no quota. The cases: answers to a question in the
# tracker (only cgwalters' comment counts, the bot's own and others'
# don't, and nothing about them is filed), a request on another tracker
# issue, a thread whose trigger has no text at all, and a forge fork PR.
#   tests/bot-notify-route.sh
set -euo pipefail

BIN=$(cd "$(dirname "$0")/../bin" && pwd)
readonly BIN
readonly TRACKER=cgwalters-forge/tracker

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh-store
mkdir -p "${FAKE_GH}/api" "${WORK}/bin"
export PATH=${WORK}/bin:${PATH} HOME=${WORK}/home XDG_CACHE_HOME=${WORK}/home/cache XDG_STATE_HOME=${WORK}/home/state
unset GH_TOKEN GITHUB_TOKEN

# The fake gh answers 'gh api PATH' from $FAKE_GH/api/PATH (the path
# with '/' as '_' and the query string dropped; a 404 when missing), applies
# --jq like gh does, and serves 'gh api -i' with a 200 and headers. Only
# reads: any write fails the test.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
test "$1" = api || { echo "fake gh: unexpected call: $*" 1>&2; exit 1; }
shift
path= filter= headers=false
while test $# -gt 0; do
    case "$1" in
        --jq) filter=$2; shift 2 ;;
        -i) headers=true; shift ;;
        --paginate) shift ;;
        -H|-f|-F) shift 2 ;;
        -X) test "$2" = GET || { echo "fake gh: write: $*" 1>&2; exit 1; }; shift 2 ;;
        *) path=$1; shift ;;
    esac
done
file=${store}/api/$(sed 's/?.*//; s,/,_,g' <<<"${path}")
test -e "${file}" || { echo "gh: Not Found (HTTP 404) ${path}" 1>&2; exit 1; }
if ${headers}; then
    printf 'HTTP/2.0 200 OK\r\nDate: Sat, 26 Sep 2026 12:00:00 GMT\r\nX-Poll-Interval: 60\r\n\r\n'
    cat "${file}"
elif test -n "${filter}"; then
    jq -r "${filter}" "${file}"
else
    cat "${file}"
fi
EOF
chmod +x "${WORK}/bin/gh"

api() { # api PATH: stdin becomes the answer to 'gh api PATH'
    cat >"${FAKE_GH}/api/${1//\//_}"
}

echo '{"login": "cgwalters-bot"}' | api user
# bot-board state-get reads the state item with one GraphQL query.
jq -n '{data: {node: {id: "PVTI_lAHOAQ_SPs4Bj2Gizg8Znwk", isArchived: true,
    content: {id: "DI_lAHOAQ_SPs4Bj2GizgLL1Nk", title: "bot-state: notifications",
              body: "state\n\n```json\n{\"since\": \"2026-09-26T00:00:00Z\"}\n```\n"}}}}' | api graphql
echo '[]' | api notifications
echo '[]' | api users/cgwalters/events/public
echo '{"items": []}' | api search/issues
echo '[]' | api repos/cgwalters-bot/cgwalters-bot/issues
for repo in "${TRACKER}" example/repo cgwalters-forge/bootc; do
    echo '{"visibility": "public"}' | api "repos/${repo}"
done

# comment ISSUE ID LOGIN BODY: one comment on tracker issue ISSUE
comment() {
    jq -nc --arg t "${TRACKER}" --arg n "$1" --arg id "$2" --arg login "$3" --arg body "$4" '{id: ($id | tonumber),
        user: {login: $login, type: "User"}, body: $body, created_at: "2026-09-26T10:0\($id):00Z",
        updated_at: "2026-09-26T10:0\($id):00Z", html_url: "https://github.com/\($t)/issues/\($n)#issuecomment-\($id)"}'
}
# Tracker #3: a question with the bot's answer, someone's and his.
jq -n --arg t "${TRACKER}" '{number: 3, title: "Split the interfaces?", html_url: "https://github.com/\($t)/issues/3",
    labels: [{name: "question"}], body: "Blocks: x"}' | api "repos/${TRACKER}/issues/3"
{ comment 3 1 cgwalters-bot "A"; comment 3 2 someone "C, obviously"; comment 3 3 cgwalters $'B\nbut keep the old name'; } |
    jq -s . | api "repos/${TRACKER}/issues/3/comments"
# Tracker #8: a work item, with his request.
jq -n --arg t "${TRACKER}" '{number: 8, title: "bootc: composefs edit", html_url: "https://github.com/\($t)/issues/8",
    labels: [], body: ""}' | api "repos/${TRACKER}/issues/8"
comment 8 4 cgwalters "Please also cover sealed images." | jq -s . | api "repos/${TRACKER}/issues/8/comments"
# Tracker #9: a question with only the bot's comment.
jq -n --arg t "${TRACKER}" '{number: 9, title: "Q", html_url: "https://github.com/\($t)/issues/9",
    labels: [{name: "question"}], body: ""}' | api "repos/${TRACKER}/issues/9"
comment 9 5 cgwalters-bot "B" | jq -s . | api "repos/${TRACKER}/issues/9/comments"
# Tracker #10: his answer mentions the bot, so it comes as a mention.
jq -n --arg t "${TRACKER}" '{number: 10, title: "Q", html_url: "https://github.com/\($t)/issues/10",
    labels: [{name: "question"}], body: "", user: {login: "cgwalters-bot", type: "User"},
    created_at: "2026-09-26T09:00:00Z"}' | api "repos/${TRACKER}/issues/10"
comment 10 6 cgwalters "@cgwalters-bot go with A" | jq -s . | api "repos/${TRACKER}/issues/10/comments"
# Tracker #11: a chore he says he did.
jq -n --arg t "${TRACKER}" '{number: 11, title: "Rerun", html_url: "https://github.com/\($t)/issues/11",
    labels: [{name: "chore"}], body: ""}' | api "repos/${TRACKER}/issues/11"
comment 11 7 cgwalters "Reran them." | jq -s . | api "repos/${TRACKER}/issues/11/comments"
# example/repo#5: an assignment GitHub has no event for yet, in a thread
# without comments: the fallback trigger has no text.
jq -n '{number: 5, title: "Some issue", html_url: "https://github.com/example/repo/issues/5", labels: [], body: null}' |
    api repos/example/repo/issues/5
echo '[]' | api repos/example/repo/issues/5/events

# thread ID REASON REPO NUMBER [TYPE]
thread() {
    jq -nc --arg id "$1" --arg reason "$2" --arg repo "$3" --arg n "$4" --arg type "${5:-Issue}" '{id: $id,
        reason: $reason, unread: true, updated_at: "2026-09-26T11:00:00Z", last_read_at: null,
        subject: {type: $type, title: "t", url: "https://api.github.com/repos/\($repo)/issues/\($n)", latest_comment_url: null},
        repository: {full_name: $repo, owner: {login: ($repo | split("/")[0])}, private: false,
                     html_url: "https://github.com/\($repo)"}}'
}
{
    thread 101 author "${TRACKER}" 3
    thread 102 author "${TRACKER}" 8
    thread 103 author "${TRACKER}" 9
    thread 104 assign example/repo 5
    thread 105 mention cgwalters-forge/bootc 7 PullRequest
    thread 106 mention "${TRACKER}" 10
    thread 107 author "${TRACKER}" 11
} | jq -s . >"${WORK}/threads.json"

out=$("${BIN}/bot-notify" --dry-run --from-file "${WORK}/threads.json" 2>"${WORK}/err") ||
    fail "bot-notify failed: $(cat "${WORK}/err")"$'\n'"${out}"
records=$(sed -n 's/^\(answer\|request\) //p' <<<"${out}")

jq -se 'length == 4' <<<"${records}" >/dev/null || fail "expected 4 records, got:"$'\n'"${records}"
jq -se 'any(.[]; .type == "answer" and .thread_id == "107" and .choice == null)' \
    <<<"${records}" >/dev/null || fail "his comment on a chore isn't an answer:"$'\n'"${records}"
jq -se 'any(.[]; .type == "answer" and .reason == "mention" and .thread_id == "106" and .choice == null)' \
    <<<"${records}" >/dev/null || fail "his answer mentioning the bot isn't an answer:"$'\n'"${records}"
jq -se --arg t "${TRACKER}" 'any(.[]; .type == "answer" and .author == "cgwalters" and .choice == "B"
    and .question and .thread_url == "https://github.com/\($t)/issues/3" and .thread_id == "101"
    and .url == "https://github.com/\($t)/issues/3#issuecomment-3")' <<<"${records}" >/dev/null ||
    fail "no answer B by cgwalters on #3:"$'\n'"${records}"
jq -se --arg t "${TRACKER}" 'any(.[]; .type == "request" and .author == "cgwalters" and .choice == null
    and (.question | not) and .thread_url == "https://github.com/\($t)/issues/8")' <<<"${records}" >/dev/null ||
    fail "no request by cgwalters on #8:"$'\n'"${records}"
# Nothing in the tracker is filed; the empty trigger is (it's nobody's ask).
grep -q "would file: Assignment: someone on example/repo#5" <<<"${out}" ||
    fail "the assignment without a trigger wasn't routed:"$'\n'"${out}"
test "$(grep -c "would file" <<<"${out}")" -eq 1 || fail "filed more than the assignment:"$'\n'"${out}"
grep -q "Skipped mention in cgwalters-forge/bootc" <<<"${out}" || fail "the forge PR thread wasn't skipped:"$'\n'"${out}"
grep -A1 "^Thread comment in ${TRACKER}: t \[thread 103\]" <<<"${out}" | grep -q "nothing new for the bot" ||
    fail "the bot's own answer on #9 wasn't ignored:"$'\n'"${out}"
echo "ok: tracker answers and requests routed; the bot's own and others' comments ignored"

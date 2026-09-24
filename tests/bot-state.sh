#!/usr/bin/env bash
# Offline tests of the state the bot scripts keep on the Workstream board
# ('bot-board state-get/state-put'), against a fake 'gh' that keeps the
# project's state items in a temporary directory. No network, no quota.
#   tests/bot-state.sh [TEST...]
# State bodies hold literal backquotes (a fenced JSON block).
# shellcheck disable=SC2016
set -euo pipefail

BIN=$(cd "$(dirname "$0")/../bin" && pwd)
readonly BIN

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

# The fake gh. Draft items live in $FAKE_GH/items/DRAFT_ID.{item,title,body};
# every call is appended to $FAKE_GH/calls. With $FAKE_GH/fail-graphql,
# every GraphQL call is rate limited; with $FAKE_GH/fail-write, draft
# writes fail.
write_fake_gh() {
    cat >"$1/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
arg() { # arg NAME ARGS...: the value of '-f NAME=...'
    local name=$1
    shift
    while test $# -gt 0; do
        if test "$1" = -f && [[ "$2" == "${name}="* ]]; then
            printf '%s' "${2#"${name}"=}"
            return 0
        fi
        shift
    done
}
draft_of() { # draft_of ITEM_ID
    grep -lx "$1" "${store}"/items/*.item 2>/dev/null | head -n1 | xargs -r basename -s .item
}
case "$1 $2" in
    "api user") echo "${FAKE_GH_LOGIN:-cgwalters-bot}"; exit 0 ;;
    "api rate_limit") echo 5000; exit 0 ;;
    "api graphql")
        query=$(arg query "$@")
        if test -e "${store}/fail-graphql"; then
            echo "gh: API rate limit exceeded" 1>&2
            exit 1
        fi
        case "${query}" in
            *updateProjectV2DraftIssue*)
                if test -e "${store}/fail-write"; then
                    echo "gh: HTTP 502: Bad Gateway" 1>&2
                    exit 1
                fi
                draft=$(arg id "$@")
                test -e "${store}/items/${draft}.title" || { echo "gh: Could not resolve to a node with the global id of '${draft}'" 1>&2; exit 1; }
                arg body "$@" >"${store}/items/${draft}.body"
                jq -nc --arg id "${draft}" --rawfile t "${store}/items/${draft}.title" \
                    '{updateProjectV2DraftIssue: {draftIssue: {id: $id, title: ($t | rtrimstr("\n"))}}}'
                ;;
            *archiveProjectV2Item*) echo '{}' ;;
            *"node(id:"*)
                item=$(arg id "$@")
                draft=$(draft_of "${item}")
                test -n "${draft}" || { echo '{"node": null}'; exit 0; }
                jq -nc --arg item "${item}" --arg d "${draft}" \
                    --rawfile t "${store}/items/${draft}.title" --rawfile b "${store}/items/${draft}.body" \
                    '{node: {id: $item, isArchived: true, content: {id: $d, title: ($t | rtrimstr("\n")), body: $b}}}'
                ;;
            *) echo "fake gh: unexpected query: ${query}" 1>&2; exit 1 ;;
        esac
        exit 0
        ;;
    "project item-create")
        n=$(find "${store}/items" -name '*.item' | wc -l)
        shift 2
        while test $# -gt 0; do
            case "$1" in
                --title) title=$2; shift 2 ;;
                --body) body=$2; shift 2 ;;
                *) shift ;;
            esac
        done
        printf '%s\n' "PVTI_fake${n}" >"${store}/items/DI_fake${n}.item"
        printf '%s\n' "${title}" >"${store}/items/DI_fake${n}.title"
        printf '%s' "${body}" >"${store}/items/DI_fake${n}.body"
        echo "PVTI_fake${n}"
        exit 0
        ;;
    "project view") echo PVT_fake; exit 0 ;;
    "project field-list")
        echo '{"fields": [{"id": "F_workflow", "name": "Workflow", "options": [{"id": "O_manual", "name": "manual"}]}]}'
        exit 0
        ;;
    "project item-edit") exit 0 ;;
esac
# Notifications: nothing new. $FAKE_GH/on-poll runs first, if it exists,
# to simulate another machine writing meanwhile.
if test "$1 $2" = "api -i" && [[ "$3" == notifications\?* ]]; then
    test ! -x "${store}/on-poll" || "${store}/on-poll"
    printf 'HTTP/2.0 304 Not Modified\r\nDate: Thu, 24 Sep 2026 00:00:00 GMT\r\nX-Poll-Interval: 60\r\n\r\n'
    echo "gh: HTTP 304" 1>&2
    exit 1
fi
# cgwalters' public events (bot-notify's safety net): none.
if test "$1 $2" = "api -i" && [[ "$3" == users/*/events/public* ]]; then
    printf 'HTTP/2.0 200 OK\r\nEtag: W/"e"\r\n\r\n[]'
    exit 0
fi
if test "$1 $2 $3" = "api -X PATCH" && [[ "$4" == notifications/threads/* ]]; then
    exit 0
fi
# No fork PRs, open or closed, and no mentions.
if [[ " $* " == *" search/issues "* ]]; then
    exit 0
fi
if test -n "${FAKE_GH_EXTRA:-}" && test -x "${FAKE_GH_EXTRA}"; then
    exec "${FAKE_GH_EXTRA}" "$@"
fi
echo "fake gh: unexpected call: $*" 1>&2
exit 1
EOF
    chmod +x "$1/gh"
}

# state_ids NAME: prints "ITEM_ID DRAFT_ID" of the state item NAME: the
# ones in bot-board's STATE_ITEMS, else the fake project's.
state_ids() {
    local ids draft
    ids=$(sed -n "s/^ *\[$1\]='\(PVTI_[^ ]*\) \(DI_[^']*\)'.*/\1 \2/p" "${BIN}/bot-board")
    if test -z "${ids}"; then
        draft=$(grep -lx "bot-state: $1" "${FAKE_GH}"/items/*.title | head -n1 | xargs basename -s .title)
        ids="$(cat "${FAKE_GH}/items/${draft}.item") ${draft}"
    fi
    echo "${ids}"
}

# set_project_state NAME JSON: writes the state on the fake project, as
# another machine would, creating the draft that bot-board's STATE_ITEMS
# names for NAME if needed.
set_project_state() {
    local item draft
    read -r item draft <<<"$(state_ids "$1")"
    echo "${item}" >"${FAKE_GH}/items/${draft}.item"
    echo "bot-state: $1" >"${FAKE_GH}/items/${draft}.title"
    printf 'x\n\n```json\n%s\n```\n' "$(jq -c . <<<"$2")" >"${FAKE_GH}/items/${draft}.body"
}

# project_state NAME: the JSON on the fake project.
project_state() {
    local draft
    read -r _ draft <<<"$(state_ids "$1")"
    awk '/^```json/ { f = 1; next } f && /^```/ { exit } f' "${FAKE_GH}/items/${draft}.body"
}

graphql_calls() {
    grep -c '^api graphql' "${FAKE_GH}/calls" 2>/dev/null || true
}

reset_calls() {
    : >"${FAKE_GH}/calls"
}

# expect_json ACTUAL EXPECTED [WHAT]
expect_json() {
    jq -ne --argjson a "$1" --argjson b "$2" '$a == $b' >/dev/null ||
        fail "${3:-JSON}: expected $(jq -c . <<<"$2"), got $(jq -c . <<<"$1")"
}

expect_eq() {
    test "$1" = "$2" || fail "${3:-value}: expected '$2', got '$1'"
}

# --- bot-board --------------------------------------------------------------

test_merge3() {
    # Data driven: base, ours, theirs, expected.
    local cases=(
        '{"a":1} {"a":2} {"a":1} {"a":2}'
        '{"a":1} {"a":1} {"a":3} {"a":3}'
        '{"a":1} {"a":2} {"a":3} {"a":2}'
        '{"p":{"x":1}} {"p":{"x":1,"y":2}} {"p":{"x":1,"z":3}} {"p":{"x":1,"y":2,"z":3}}'
        '{"p":{"x":1,"y":2}} {"p":{"x":1}} {"p":{"x":1,"y":2,"z":3}} {"p":{"x":1,"z":3}}'
        '{"p":{"x":{"s":1,"t":1}}} {"p":{"x":{"s":2,"t":1}}} {"p":{"x":{"s":1,"t":5}}} {"p":{"x":{"s":2,"t":5}}}'
        '{} {"a":1} {"b":2} {"a":1,"b":2}'
        '{"a":1} {} {"a":1,"b":2} {"b":2}'
        '{"a":1} {"a":1} {} {}'
    )
    local c b o t want got
    for c in "${cases[@]}"; do
        read -r b o t want <<<"${c}"
        got=$(jq -nc --argjson b "${b}" --argjson o "${o}" --argjson t "${t}" \
            "$(sed -n "/^readonly MERGE3_JQ='/,/^'/p" "${BIN}/bot-board" | sed '1d;$d') merge3(\$b; \$o; \$t)")
        expect_json "${got}" "${want}" "merge3 ${b} ${o} ${t}"
    done
}

test_checked_put() {
    set_project_state notifications '{"since":"a","pending":{}}'
    reset_calls
    local got
    got=$("${BIN}/bot-board" state-get --track notifications)
    expect_json "${got}" '{"since":"a","pending":{}}' "state-get"
    expect_eq "$(graphql_calls)" 1 "GraphQL calls of state-get"
    # Nothing changed: no call at all.
    reset_calls
    "${BIN}/bot-board" state-put --checked notifications "${got}"
    expect_eq "$(graphql_calls)" 0 "GraphQL calls of an unchanged checked put"
    # A change: one reread, one write.
    reset_calls
    "${BIN}/bot-board" state-put --checked notifications '{"since":"b","pending":{}}'
    expect_eq "$(graphql_calls)" 2 "GraphQL calls of a checked put"
    expect_json "$(project_state notifications)" '{"since":"b","pending":{}}' "after a checked put"
}

test_race_merge() {
    set_project_state notifications '{"since":"a","pending":{"u1":{"n":1}},"acked":{}}'
    "${BIN}/bot-board" state-get --track notifications >/dev/null
    # Another machine acks u1 and advances since, between our read and write.
    set_project_state notifications '{"since":"c","pending":{},"acked":{"u1":"t"}}'
    "${BIN}/bot-board" state-put --checked notifications '{"since":"b","pending":{"u1":{"n":1},"u2":{"n":2}},"acked":{}}' 2>"${WORK}/err"
    grep -q 'changed since it was read' "${WORK}/err" || fail "no note about the concurrent write"
    expect_json "$(project_state notifications)" '{"since":"b","pending":{"u2":{"n":2}},"acked":{"u1":"t"}}' "merged state"
    # The mirror now tracks what was written, so the next put is clean.
    reset_calls
    "${BIN}/bot-board" state-put --checked notifications "$(project_state notifications)"
    expect_eq "$(graphql_calls)" 0 "GraphQL calls after the merge"
}

test_race_strict() {
    set_project_state notifications '{"holder":null}'
    "${BIN}/bot-board" state-get --track notifications >/dev/null
    set_project_state notifications '{"holder":"other"}'
    local rc=0
    "${BIN}/bot-board" state-put --checked --strict notifications '{"holder":"me"}' 2>/dev/null || rc=$?
    expect_eq "${rc}" 3 "exit status of a strict conflict"
    expect_json "$(project_state notifications)" '{"holder":"other"}' "state after a strict conflict"
    expect_json "$("${BIN}/bot-board" state-get notifications)" '{"holder":"other"}' "state-get after a strict conflict"
    # A failed strict write isn't merged back in later either: another
    # machine's lease must never turn into ours.
    "${BIN}/bot-board" state-get --track notifications >/dev/null
    touch "${FAKE_GH}/fail-write"
    ! "${BIN}/bot-board" state-put --checked --strict notifications '{"holder":"me"}' 2>/dev/null ||
        fail "a failing strict write succeeded"
    rm "${FAKE_GH}/fail-write"
    set_project_state notifications '{"holder":"third"}'
    expect_json "$("${BIN}/bot-board" state-get notifications)" '{"holder":"third"}' "state-get after a failed strict write"
}

test_size_cap() {
    set_project_state notifications '{"a":1}'
    "${BIN}/bot-board" state-get --track notifications >/dev/null
    local big rc=0
    big=$(jq -nc '{a: 1, big: ("x" * 70000)}')
    reset_calls
    "${BIN}/bot-board" state-put --checked notifications "${big}" 2>"${WORK}/err" || rc=$?
    test "${rc}" -ne 0 || fail "an oversized state was accepted"
    grep -q 'over the 65536' "${WORK}/err" || fail "no size error: $(cat "${WORK}/err")"
    expect_json "$(project_state notifications)" '{"a":1}' "state after an oversized put"
    # The unwritten change is kept locally and merged into the next read.
    local got
    got=$("${BIN}/bot-board" state-get notifications 2>"${WORK}/err")
    grep -q 'could not write' "${WORK}/err" || fail "no note about the unwritten change"
    expect_eq "$(jq -r '.big | length' <<<"${got}")" 70000 "unwritten change merged back"
}

test_failed_write_kept() {
    set_project_state notifications '{"n":1}'
    "${BIN}/bot-board" state-get --track notifications >/dev/null
    touch "${FAKE_GH}/fail-graphql"
    local rc=0
    "${BIN}/bot-board" state-put --checked notifications '{"n":2,"new":true}' 2>/dev/null || rc=$?
    expect_eq "${rc}" 75 "exit status when rate limited"
    rm "${FAKE_GH}/fail-graphql"
    # Meanwhile another machine changed n; ours is kept and merged.
    set_project_state notifications '{"n":5}'
    local got
    got=$("${BIN}/bot-board" state-get --track notifications 2>/dev/null)
    expect_json "${got}" '{"n":2,"new":true}' "state-get after a failed write"
    "${BIN}/bot-board" state-put --checked notifications "${got}"
    expect_json "$(project_state notifications)" '{"n":2,"new":true}' "state after the retry"
}

test_create() {
    "${BIN}/bot-board" state-get --track newthing >/dev/null 2>&1
    "${BIN}/bot-board" state-put --checked newthing '{"a":1}' 2>/dev/null
    expect_json "$(project_state newthing)" '{"a":1}' "created state item"
}

# --- bot-pr -----------------------------------------------------------------

test_pr_inbox_migration() {
    local recent old legacy
    recent=$(date -u -d '1 hour ago' +%FT%TZ)
    old=$(date -u -d '30 days ago' +%FT%TZ)
    # Another machine already recorded B; this one still has A in its file,
    # plus a fork PR gone long ago and a PR closed long ago.
    set_project_state pr-inbox "$(jq -nc --arg r "${recent}" \
        '{version: 2, prs: {B: {body: "hb", seen: $r}}, closed: {}}')"
    legacy=${XDG_STATE_HOME}/bot-pr/inbox.json
    mkdir -p "$(dirname "${legacy}")"
    jq -nc --arg r "${recent}" --arg o "${old}" '{version: 2, last_check: $r,
        prs: {A: {body: "ha", seen: $r, bot_body: "ha"}, Gone: {body: "hg", seen: $o}},
        closed: {C: true}}' >"${legacy}"
    # A dry run reads both, and writes neither.
    reset_calls
    "${BIN}/bot-pr" inbox --dry-run 2>/dev/null
    expect_eq "$(graphql_calls)" 1 "GraphQL calls of a dry run"
    test -e "${legacy}" || fail "a dry run moved the old state file"
    # A real run moves the file's entries to the board.
    reset_calls
    "${BIN}/bot-pr" inbox 2>"${WORK}/err"
    grep -q 'Moved the inbox state' "${WORK}/err" || fail "no migration note: $(cat "${WORK}/err")"
    expect_eq "$(graphql_calls)" 3 "GraphQL calls of an inbox run"
    { test ! -e "${legacy}" && test -e "${legacy}.migrated"; } || fail "the old state file was not moved away"
    expect_json "$(project_state pr-inbox | jq -c '{prs: (.prs | map_values(.body)), closed}')" \
        '{"prs":{"A":"ha","B":"hb"},"closed":{}}' "migrated inbox state"
    # The next run finds the state on the board alone.
    "${BIN}/bot-pr" inbox 2>"${WORK}/err"
    ! grep -q 'Moved' "${WORK}/err" || fail "migrated twice"
    expect_json "$(project_state pr-inbox | jq -c '.prs | keys')" '["A","B"]' "inbox state after the next run"
}

# --- bot-notify -------------------------------------------------------------

# request URL THREAD_ID: a pending request record.
request() {
    jq -nc --arg u "$1" --arg t "$2" '{reason: "mention", repo: "o/r", private: false, number: "1",
        title: "t", thread_url: "https://github.com/o/r/issues/1", thread_id: $t,
        author: "cgwalters", url: $u, excerpt: "please", located: true}'
}

test_notify_migration() {
    local legacy recent
    recent=$(date -u -d '1 day ago' +%FT%TZ)
    set_project_state notifications '{"since":"2026-09-20T00:00:00Z","last_modified":"LM"}'
    legacy=${XDG_STATE_HOME}/bot-notify/pending.json
    mkdir -p "$(dirname "${legacy}")"
    jq -nc --argjson r "$(request U1 11)" --arg recent "${recent}" \
        '{version: 1, pending: {U1: $r}, acked: {U0: $recent}}' >"${legacy}"
    # A dry run prints the old file's request, and writes nothing.
    reset_calls
    "${BIN}/bot-notify" --dry-run >"${WORK}/out" 2>&1
    grep -q '^request .*"url":"U1"' "${WORK}/out" || fail "dry run did not print the old request: $(cat "${WORK}/out")"
    expect_eq "$(graphql_calls)" 1 "GraphQL calls of a dry run"
    test -e "${legacy}" || fail "a dry run moved the old file"
    # A real run moves it to the board; a 304 moves a poll position that
    # is over an hour old up to the poll.
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    grep -q 'Moved the unacked requests' "${WORK}/out" || fail "no migration note: $(cat "${WORK}/out")"
    test ! -e "${legacy}" || fail "the old file is still there"
    expect_json "$(project_state notifications | jq -c '{since, last_modified, p: (.pending | keys), a: (.acked | keys)}')" \
        '{"since":"2026-09-24T00:00:00Z","last_modified":"LM","p":["U1"],"a":["U0"]}' "migrated notifications state"
    # Still printed by the next run, which has nothing to write.
    reset_calls
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    grep -q '^request .*"url":"U1"' "${WORK}/out" || fail "the migrated request is not printed"
    grep -q 'No changes' "${WORK}/out" || fail "an unchanged run wrote: $(cat "${WORK}/out")"
    expect_eq "$(graphql_calls)" 1 "GraphQL calls of an unchanged run"
    # Acking it records that on the board.
    "${BIN}/bot-notify" ack 11 >/dev/null
    expect_json "$(project_state notifications | jq -c '{p: (.pending | keys), a: (.acked | keys)}')" \
        '{"p":[],"a":["U0","U1"]}' "state after the ack"
}

test_notify_ack_retried() {
    set_project_state notifications "$(jq -nc --argjson r "$(request U1 11)" \
        '{since: "2026-09-20T00:00:00Z", last_modified: "LM", pending: {U1: $r}, acked: {}}')"
    # The ack's write fails...
    touch "${FAKE_GH}/fail-write"
    ! "${BIN}/bot-notify" ack 11 >/dev/null 2>&1 || fail "an ack whose write failed succeeded"
    rm "${FAKE_GH}/fail-write"
    expect_json "$(project_state notifications | jq -c '.pending | keys')" '["U1"]' "state after the failed ack"
    # ... so the next run, with nothing new of its own, writes it.
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    ! grep -q '^request ' "${WORK}/out" || fail "the acked request is still printed: $(cat "${WORK}/out")"
    expect_json "$(project_state notifications | jq -c '{p: (.pending | keys), a: (.acked | keys)}')" \
        '{"p":[],"a":["U1"]}' "state after the next run"
}

test_notify_ack_url() {
    local pr=https://github.com/o/r/pull/1
    # A request the safety net found has its PR's URL as its thread id.
    set_project_state notifications "$(jq -nc --argjson r "$(request U1 "${pr}")" \
        '{since: "2026-09-20T00:00:00Z", last_modified: "LM", pending: {U1: $r}, acked: {}}')"
    reset_calls
    "${BIN}/bot-notify" ack "${pr}" >/dev/null
    expect_json "$(project_state notifications | jq -c '{p: (.pending | keys), a: (.acked | keys)}')" \
        '{"p":[],"a":["U1"]}' "state after acking by URL"
    ! grep -q 'notifications/threads' "${FAKE_GH}/calls" || fail "acking by URL marked a thread read"
    ! "${BIN}/bot-notify" ack https://example.com/x 2>/dev/null || fail "acked a URL that is no issue or PR"
}

test_notify_race() {
    local legacy item draft
    set_project_state notifications "$(jq -nc --argjson r "$(request U1 11)" \
        '{since: "2026-09-20T00:00:00Z", last_modified: "LM", pending: {U1: $r}, acked: {}}')"
    # This machine still has a request of its own to move to the board...
    legacy=${XDG_STATE_HOME}/bot-notify/pending.json
    mkdir -p "$(dirname "${legacy}")"
    jq -nc --argjson r "$(request U2 22)" '{version: 1, pending: {U2: $r}, acked: {}}' >"${legacy}"
    # ... while another machine acks U1 during its poll.
    read -r item draft <<<"$(state_ids notifications)"
    printf 'x\n\n```json\n%s\n```\n' "$(jq -nc \
        '{since: "2026-09-20T00:00:00Z", last_modified: "LM", pending: {}, acked: {U1: "2026-09-24T00:00:00Z"}}')" \
        >"${FAKE_GH}/race.body"
    printf '#!/bin/sh\nmv -f "%s" "%s"\n' "${FAKE_GH}/race.body" "${FAKE_GH}/items/${draft}.body" >"${FAKE_GH}/on-poll"
    chmod +x "${FAKE_GH}/on-poll"
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    grep -q 'changed since it was read' "${WORK}/out" || fail "no merge note: $(cat "${WORK}/out")"
    # U1 stays acked, and U2 is added.
    expect_json "$(project_state notifications | jq -c '{p: (.pending | keys), a: (.acked | keys)}')" \
        '{"p":["U2"],"a":["U1"]}' "state after the race"
}

# --- bot-work ---------------------------------------------------------------

# run_bot_work: runs bot-work with a fake agent that saves the lease it
# sees on the project as $WORK/lease-seen; prints bot-work's stderr.
run_bot_work() {
    local draft
    read -r _ draft <<<"$(state_ids lease)"
    printf '#!/bin/sh\ncp "%s" "%s"\n' "${FAKE_GH}/items/${draft}.body" "${WORK}/lease-seen" >"${WORK}/bin/opencode"
    chmod +x "${WORK}/bin/opencode"
    rm -f "${WORK}/lease-seen"
    "${BIN}/bot-work" 2>&1
}

# wait_lease_cleared: waits for the background keeper to clear the lease.
wait_lease_cleared() {
    local _
    for _ in $(seq 50); do
        test "$(project_state lease)" != '{}' || return 0
        sleep 0.2
    done
    fail "the lease was not cleared after the run: $(project_state lease)"
}

test_lease() {
    local future past out me
    future=$(date -u -d '10 minutes' +%FT%TZ)
    past=$(date -u -d '1 minute ago' +%FT%TZ)
    # Free: taken for the run, and cleared after it.
    set_project_state lease '{}'
    run_bot_work >/dev/null
    test -e "${WORK}/lease-seen" || fail "the agent did not run"
    me=$(awk '/^```json/ { f = 1; next } f && /^```/ { exit } f' "${WORK}/lease-seen" | jq -r .host)
    [[ "${me}" == "$(hostname)"* ]] || fail "lease holder during the run: expected this machine, got '${me}'"
    wait_lease_cleared
    # Held by another machine: refused.
    set_project_state lease "$(jq -nc --arg e "${future}" '{host: "elsewhere", pid: 1, token: "t", expires_at: $e}')"
    if out=$(run_bot_work); then
        fail "ran while another machine held the lease"
    fi
    grep -q 'bot-work run on elsewhere (pid 1) holds the lease' <<<"${out}" || fail "unexpected refusal: ${out}"
    test ! -e "${WORK}/lease-seen" || fail "the agent ran while another machine held the lease"
    # A lease this machine failed to write is not ours later.
    set_project_state lease '{}'
    touch "${FAKE_GH}/fail-write"
    ! run_bot_work >/dev/null || fail "ran without writing the lease"
    rm "${FAKE_GH}/fail-write"
    set_project_state lease "$(jq -nc --arg e "${future}" '{host: "elsewhere", pid: 2, token: "t", expires_at: $e}')"
    out=$(run_bot_work) && fail "ran while another machine held the lease, after a failed write"
    grep -q 'bot-work run on elsewhere (pid 2) holds the lease' <<<"${out}" || fail "unexpected refusal: ${out}"
    # Lapsed, or held by an earlier run here that is gone: taken over.
    local holder
    for holder in elsewhere "${me}"; do
        set_project_state lease "$(jq -nc --arg h "${holder}" --arg e "${past}" --arg f "${future}" \
            '{host: $h, pid: 1, token: "t", expires_at: (if $h == "elsewhere" then $e else $f end)}')"
        out=$(run_bot_work)
        grep -q 'Taking over the lease' <<<"${out}" || fail "no takeover of ${holder}'s lease: ${out}"
        test -e "${WORK}/lease-seen" || fail "the agent did not run after taking over ${holder}'s lease"
        wait_lease_cleared
    done
}

# --- runner -----------------------------------------------------------------

all_tests() {
    declare -F | awk '$3 ~ /^test_/ { sub(/^test_/, "", $3); print $3 }'
}

# run_test NAME: runs test_NAME in a fresh fake world. Called in a
# separate process per test, so that set -e holds inside it.
run_test() {
    WORK=$(mktemp -d)
    trap 'rm -rf "${WORK}"' EXIT
    FAKE_GH=${WORK}/gh-store
    mkdir -p "${FAKE_GH}/items" "${WORK}/bin" "${WORK}/home/run"
    write_fake_gh "${WORK}/bin"
    export FAKE_GH WORK
    export PATH=${WORK}/bin:${PATH}
    export HOME=${WORK}/home XDG_STATE_HOME=${WORK}/home/state XDG_CACHE_HOME=${WORK}/home/cache
    export XDG_RUNTIME_DIR=${WORK}/home/run
    unset GH_TOKEN GITHUB_TOKEN
    "test_$1"
}

if test "${1:-}" = --one; then
    run_test "$2"
    exit 0
fi
tests=("$@")
test "${#tests[@]}" -gt 0 || mapfile -t tests < <(all_tests)
failed=0
for t in "${tests[@]}"; do
    if "$0" --one "${t}"; then
        echo "ok ${t}"
    else
        echo "not ok ${t}"
        failed=$((failed + 1))
    fi
done
test "${failed}" -eq 0 || { echo "${failed} test(s) failed" 1>&2; exit 1; }
echo "all ${#tests[@]} tests passed"

#!/usr/bin/env bash
# Offline tests of the state the bot scripts keep on the Workstream board
# ('bot-board state-get/state-put'), against a fake 'gh' that keeps the
# project's state items in a temporary directory, and of what 'bot-pr
# promote' takes as an approval, against REST fixtures in that fake gh.
# No network, no quota.
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
arg() { # arg NAME ARGS...: the value of '-f NAME=...' (or -F)
    local name=$1
    shift
    while test $# -gt 0; do
        if { test "$1" = -f || test "$1" = -F; } && [[ "$2" == "${name}="* ]]; then
            printf '%s' "${2#"${name}"=}"
            return 0
        fi
        shift
    done
}
draft_of() { # draft_of ITEM_ID
    grep -lx "$1" "${store}"/items/*.item 2>/dev/null | head -n1 | xargs -r basename -s .item
}
# REST fixtures: a GET of PATH (query string ignored) answers with
# $FAKE_GH/rest/PATH.json, if it exists, filtered by --jq like gh does,
# or with a 404 if $FAKE_GH/rest/PATH.404 exists. A search for open
# issues or PRs answers with $FAKE_GH/rest/search/issues-open.json.
if test "$1" = api && test -d "${store}/rest"; then
    method=GET path="" filter="" args=("${@:2}")
    while test "${#args[@]}" -gt 0; do
        case "${args[0]}" in
            -X) method=${args[1]}; args=("${args[@]:2}") ;;
            -f|-F|-H) args=("${args[@]:2}") ;;
            --jq) filter=${args[1]}; args=("${args[@]:2}") ;;
            -*) args=("${args[@]:1}") ;;
            *) test -n "${path}" || path=${args[0]%%\?*}; args=("${args[@]:1}") ;;
        esac
    done
    fixture=${store}/rest/${path}.json
    if test "${path}" = search/issues; then
        fixture=/nonexistent
        [[ " $(arg q "$@") " != *" is:open "* ]] || fixture=${store}/rest/search/issues-open.json
    fi
    if test "${method}" = GET && test -e "${fixture}"; then
        jq -rc "${filter:-.}" "${fixture}"
        exit 0
    fi
    if test "${method}" = GET && test -e "${store}/rest/${path}.404"; then
        echo "gh: Not Found (HTTP 404)" 1>&2
        exit 1
    fi
fi
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
            # bot-board's item lookup: board N's items, all on one page.
            *"items(first: 100, query"*)
                n=$(arg number "$@")
                echo "lookup ${n}" >>"${store}/calls"
                items=${store}/items-${n}.json
                test -e "${items}" || items=${store}/items.json
                jq -c '{board: {projectV2: {items: {pageInfo: {hasNextPage: false}, nodes: [.items[]
                    | {id, content, priority: null, org: null}]}}}}' "${items}"
                ;;
            # A PR body's edits: $FAKE_GH/body-edits.json (as
            # [{at, by}], newest first), or none.
            *userContentEdits*)
                jq -c '{data: {repository: {pullRequest: {userContentEdits: {totalCount: length,
                        nodes: [.[] | {editedAt: .at, editor: {login: .by}}]}}}}}' \
                    "$(test -e "${store}/body-edits.json" && echo "${store}/body-edits.json" || echo /dev/stdin)" <<<'[]' |
                    jq -rc "${filter:-.}"
                ;;
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
    # Per board NUMBER: $FAKE_GH/fields-NUMBER.json (items-NUMBER.json
    # is served over REST below).
    "project field-list")
        if test -e "${store}/fields-$3.json"; then
            cat "${store}/fields-$3.json"
        else
            echo '{"fields": [{"id": "F_workflow", "name": "Workflow", "options": [{"id": "O_manual", "name": "manual"}]}]}'
        fi
        exit 0
        ;;
    "project item-edit") exit 0 ;;
esac
# Board N's items, from $FAKE_GH/items-N.json, over REST.
if test "$1 $2" = "api -i" && [[ "$3" =~ ^(users|orgs)/[^/]+/projectsV2/([0-9]+)/ ]]; then
    exec "${FAKE_BOARD_REST:?}" "${store}/items-${BASH_REMATCH[2]}.json" "$3"
fi
# Notifications: nothing new. $FAKE_GH/on-poll runs first, if it exists,
# to simulate another machine writing meanwhile.
if test "$1 $2" = "api -i" && [[ "$3" == notifications\?* ]]; then
    test ! -x "${store}/on-poll" || "${store}/on-poll"
    printf 'HTTP/2.0 304 Not Modified\r\nDate: Thu, 24 Sep 2026 00:00:00 GMT\r\nX-Poll-Interval: 60\r\n\r\n'
    echo "gh: HTTP 304" 1>&2
    exit 1
fi
# The bot's gists: $FAKE_GH/gists.json (default none), with an ETag of
# its content, so a request with that ETag gets a 304.
if test "$1 $2" = "api -i" && [[ "$3" == gists\?* ]]; then
    body='[]'
    test ! -s "${store}/gists.json" || body=$(jq -c . "${store}/gists.json")
    etag="W/\"$(sha256sum <<<"${body}" | cut -c1-16)\""
    if test "${4:-} ${5:-}" = "-H If-None-Match: ${etag}"; then
        printf 'HTTP/2.0 304 Not Modified\r\nDate: Thu, 24 Sep 2026 00:00:00 GMT\r\nEtag: %s\r\n\r\n' "${etag}"
        echo "gh: HTTP 304" 1>&2
        exit 1
    fi
    printf 'HTTP/2.0 200 OK\r\nDate: Thu, 24 Sep 2026 00:00:00 GMT\r\nEtag: %s\r\n\r\n%s\n' "${etag}" "${body}"
    exit 0
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
# No tracker issues labelled needs-triage (bot-notify's quick captures).
if [[ " $* " == *" repos/"*"/issues?labels=needs-triage&"* ]]; then
    exit 0
fi
# Nothing new in the coordination repository.
if [[ " $* " == *" repos/cgwalters-forge/harness-coordination/issues?"* ]]; then
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
    # One over the 128KiB an argument holds (and ARG_MAX), on stdin as
    # the scripts pass it, gets the same error, not E2BIG.
    "${BIN}/bot-board" state-get --track notifications >/dev/null 2>&1
    rc=0
    jq -nc '{a: 1, big: ("x" * 3000000)}' |
        "${BIN}/bot-board" state-put --checked notifications - 2>"${WORK}/err" || rc=$?
    test "${rc}" -ne 0 || fail "an oversized state on stdin was accepted"
    grep -q 'over the 65536' "${WORK}/err" || fail "no size error for a state on stdin: $(cat "${WORK}/err")"
    expect_json "$(project_state notifications)" '{"a":1}' "state after an oversized put on stdin"
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

test_other_project() {
    cat >"${FAKE_GH}/fields-2.json" <<'JSON'
{"fields": [{"id": "F_area", "name": "Area", "type": "ProjectV2SingleSelectField",
             "options": [{"id": "O_docs", "name": "docs"}]},
            {"id": "F_owner", "name": "Owner", "type": "ProjectV2Field"}]}
JSON
    echo '{"items": [{"id": "PVTI_a", "title": "t", "area": "docs", "owner": "bot",
                      "content": {"type": "PullRequest", "url": "https://github.com/o/r/pull/1"}}]}' \
        >"${FAKE_GH}/items-2.json"
    reset_calls
    "${BIN}/bot-board" --project composefs-stable set o/r#1 --field Area docs --field Owner bot >/dev/null
    grep -qx 'lookup 2' "${FAKE_GH}/calls" || fail "set didn't look up the item on board 2: $(cat "${FAKE_GH}/calls")"
    grep -q -- '--field-id F_area --single-select-option-id=O_docs' "${FAKE_GH}/calls" || fail "Area not set"
    grep -q -- '--field-id F_owner --text=bot' "${FAKE_GH}/calls" || fail "Owner not set"
    ! "${BIN}/bot-board" --project composefs-stable set PVTI_a --field Area nope 2>/dev/null ||
        fail "an invalid option was accepted"
    "${BIN}/bot-board" --project=users/cgwalters-bot/2 show PVTI_a | grep -qx $'area:\tdocs' || fail "show lacks the Area field"
    test -d "${XDG_CACHE_HOME}/bot-board/users/cgwalters-bot/2/rest" || fail "board 2 isn't cached apart"
    grep -q '^api -i users/cgwalters-bot/projectsV2/2/items?' "${FAKE_GH}/calls" || fail "board 2 isn't the user's"
    ! "${BIN}/bot-board" --project=users/x 2>/dev/null || fail "a malformed board was accepted"
    # Board-bound commands and the default board.
    local cmd
    for cmd in "state-get x" "state-put x {}"; do
        # shellcheck disable=SC2086
        ! "${BIN}/bot-board" --project composefs-stable ${cmd} 2>/dev/null || fail "${cmd} ran on another board"
    done
    # fill-org works on any board with an Org field; this one has none.
    local out
    out=$("${BIN}/bot-board" --project composefs-stable fill-org --dry-run 2>&1 || true); grep -q "no .Org. field" <<<"${out}" ||
        fail "fill-org didn't say board 2 lacks Org"
    ! "${BIN}/bot-board" --project nope list 2>/dev/null || fail "an unknown board was accepted"
    reset_calls
    "${BIN}/bot-board" --refresh list >/dev/null
    grep -q '^api -i orgs/cgwalters-forge/projectsV2/1/items?' "${FAKE_GH}/calls" || fail "the default isn't the Workstream board"
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

# BOT_GH_READ_ONLY ('bot-sweep --read-only'): a dry inbox run reads no
# state from the board, and no sweep or inbox run but a dry one starts.
# Nothing else heeds it: the state is read and written as ever.
test_read_only() {
    local recent cmd out
    recent=$(date -u -d '1 hour ago' +%FT%TZ)
    set_project_state pr-inbox "$(jq -nc --arg r "${recent}" '{version: 2, prs: {B: {body: "hb", seen: $r}}, closed: {}}')"
    export BOT_GH_READ_ONLY=1
    reset_calls
    "${BIN}/bot-pr" inbox --dry-run >/dev/null 2>"${WORK}/err" || fail "a read-only dry inbox run failed: $(cat "${WORK}/err")"
    expect_eq "$(graphql_calls)" 0 "GraphQL calls of a read-only dry run"
    ! grep -q '^api user' "${FAKE_GH}/calls" || fail "a read-only run asked who gh is"
    for cmd in "bot-pr inbox" "bot-watch" "bot-watch --apply"; do
        reset_calls
        # shellcheck disable=SC2086
        ! out=$("${BIN}/"${cmd} 2>&1) || fail "'${cmd}' ran with BOT_GH_READ_ONLY set"
        grep -q 'BOT_GH_READ_ONLY is set' <<<"${out}" || fail "'${cmd}' failed otherwise: ${out}"
        expect_eq "$(graphql_calls)" 0 "GraphQL calls of a refused '${cmd}'"
    done
    expect_json "$(project_state pr-inbox | jq -c '.prs | keys')" '["B"]' "inbox state after the refused runs"
    expect_json "$("${BIN}/bot-board" state-get pr-inbox | jq -c '.prs | keys')" '["B"]' "state-get with BOT_GH_READ_ONLY set"
}

# An open fork PR whose body alone is over ARG_MAX: the inbox run that
# records it passes the open PRs to jq, and the state to bot-board,
# without exceeding an argument's size.
test_pr_inbox_big() {
    local url=https://github.com/cgwalters-forge/big/pull/1 body pr
    body=$'Why.\n\n<!-- bot-meta -->\n- Upstream: `up/big`, base `main`\n<!-- /bot-meta -->\n'$(head -c 3000000 /dev/zero | tr '\0' x)
    pr=$(jq -nc --rawfile b <(printf '%s' "${body}") --arg u "${url}" '{html_url: $u, number: 1, title: "Big", body: $b, state: "open",
        repository_url: "https://api.github.com/repos/cgwalters-forge/big",
        head: {ref: "bot/big", sha: "3333333333333333333333333333333333333333"}}')
    set_project_state pr-inbox '{}'
    rest search/issues-open "$(jq -c '{items: [.]}' <<<"${pr}")"
    rest repos/cgwalters-forge/big/pulls/1 "${pr}"
    local ep
    for ep in pulls/1/reviews pulls/1/comments issues/1/comments issues/1/timeline activity; do
        rest "repos/cgwalters-forge/big/${ep}" '[]'
    done
    "${BIN}/bot-pr" inbox 2>"${WORK}/err" || fail "inbox failed: $(cat "${WORK}/err")"
    project_state pr-inbox | jq -e --arg u "${url}" '.prs[$u].body | length == 64' >/dev/null ||
        fail "the big PR is not in the state: $(project_state pr-inbox)"
}

# --- bot-pr promote ----------------------------------------------------------

readonly PR_FORK=cgwalters-forge/demo PR_BRANCH=bot/demo PR_HEAD=2222222222222222222222222222222222222222

# rest PATH JSON: a REST fixture for the fake gh.
rest() {
    mkdir -p "$(dirname "${FAKE_GH}/rest/$1")"
    printf '%s\n' "$2" >"${FAKE_GH}/rest/$1.json"
}

# promote_world COMMENTS REVIEWS LOGGED_PUSH TIMELINE: a fork PR whose head
# PR_HEAD the fork's activity log last shows pushed as LOGGED_PUSH
# ({at, after, by}, by defaulting to the bot), with the issue COMMENTS and REVIEWS as [{login, at, body}]
# and [{login, at, state, commit}], and the PR's TIMELINE events.
promote_world() {
    local body
    body=$'Why.\n\nGenerated-by: https://github.com/cgwalters/#llms\n\n<!-- bot-meta -->\n- Upstream: `up/demo`, base `main`\n- Board item: `PVTI_demo`\n<!-- /bot-meta -->'
    rest "repos/${PR_FORK}/pulls/1" "$(jq -nc --arg b "${body}" --arg h "${PR_HEAD}" --arg ref "${PR_BRANCH}" --arg f "${PR_FORK}" \
        '{user: {login: "cgwalters-bot"}, state: "open", title: "Demo", body: $b,
          head: {ref: $ref, sha: $h, repo: {full_name: $f}}, base: {ref: "main"}}')"
    rest "repos/${PR_FORK}" '{"parent": {"full_name": "up/demo"}, "source": {"full_name": "up/demo"}}'
    rest "repos/${PR_FORK}/issues/1/comments" "$(jq -c '[.[] | {user: {login}, created_at: .at, updated_at: .at,
        html_url: "https://github.com/\("'"${PR_FORK}"'")/pull/1#issuecomment-\(.at)", body}]' <<<"$1")"
    rest "repos/${PR_FORK}/pulls/1/reviews" "$(jq -c '[.[] | {user: {login}, submitted_at: .at, state, body: "",
        id: 7, commit_id: .commit, html_url: "https://github.com/x/review"}]' <<<"$2")"
    rest "repos/${PR_FORK}/pulls/1/comments" '[]'
    rest "repos/${PR_FORK}/activity" "$(jq -c '[{timestamp: .at, after, activity_type: "push", actor: {login: (.by // "cgwalters-bot")}}]' <<<"$3")"
    rest "repos/${PR_FORK}/issues/1/timeline" "$4"
    rest "repos/up/demo/pulls" '[]'
    rest "repos/up/demo/compare/main...cgwalters-forge:${PR_BRANCH}" '{"ahead_by": 1, "behind_by": 0}'
    rest "repos/up/demo/rules/branches/main" '[]'
    rest "repos/up/demo/commits/main/check-runs" '{"check_runs": []}'
}

# The head was pushed at 10:00, from a commit made at 09:50.
readonly PUSHED_10='{"at": "2026-09-24T10:00:00Z", "after": "2222222222222222222222222222222222222222"}'
readonly COMMITTED_0950='[{"event": "committed", "sha": "2222222222222222222222222222222222222222", "committer": {"date": "2026-09-24T09:50:00Z"}}]'

# expect_promote WHAT APPROVED PATTERN [ARGS...]: 'promote --dry-run
# ARGS' approves (yes) or refuses (no), and its output matches the extended
# regex PATTERN.
expect_promote() {
    local out
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run "${@:4}" 2>&1) ||
        fail "$1: promote --dry-run failed: ${out}"
    if grep -q 'a real promote would stop here' <<<"${out}"; then
        test "$2" = no || fail "$1: expected an approval, got: ${out}"
    else
        test "$2" = yes || fail "$1: expected a refusal, got: ${out}"
    fi
    grep -qE "$3" <<<"${out}" || fail "$1: output doesn't match '$3': ${out}"
}

test_pr_promote_command() {
    local cmd='[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "/promote"}]'
    promote_world "${cmd}" '[]' "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "/promote on the current head" yes 'cgwalters: APPROVED by /promote https://'
    # With leading text and CRLF line ends, as the web UI sends them.
    promote_world '[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "Thanks!\r\n  /promote \r\n"}]' '[]' \
        "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "/promote on a line of its own" yes 'open a ready-for-review PR'
    promote_world '[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "/draft\r\n/promote"}]' '[]' \
        "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "/promote with /draft" yes 'open a draft PR'
}

test_pr_promote_command_void() {
    local cmd='[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "/promote"}]'
    local pushed_1010='{"at": "2026-09-24T10:10:00Z", "after": "2222222222222222222222222222222222222222"}'
    promote_world "${cmd}" '[]' "${pushed_1010}" \
        '[{"event": "head_ref_force_pushed", "created_at": "2026-09-24T10:10:00Z"}]'
    expect_promote "/promote, then a force-push" no 'commits pushed after cgwalters approved'
    # Only the push log shows that a commit made before the comment was
    # pushed after it.
    promote_world "${cmd}" '[]' "${pushed_1010}" "${COMMITTED_0950}"
    expect_promote "/promote, then a push of an older commit" no 'commits pushed after cgwalters approved'
    promote_world "${cmd}" '[]' '{"at": "2026-09-24T10:00:00Z", "after": "1111111111111111111111111111111111111111"}' \
        "${COMMITTED_0950}"
    expect_promote "/promote, push log behind the head" no "can't be told"
    promote_world "${cmd}" '[{"login": "cgwalters", "at": "2026-09-24T10:07:00Z", "state": "CHANGES_REQUESTED", "commit": "2222222222222222222222222222222222222222"}]' \
        "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "/promote, then changes requested" no 'is not approved'
    promote_world '[{"login": "someone", "at": "2026-09-24T10:05:00Z", "body": "/promote"}]' '[]' \
        "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "/promote by another login" no 'is not approved'
    promote_world '[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "please /promote this"}]' '[]' \
        "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "/promote inside a sentence" no 'is not approved'
}

test_pr_promote_go_ahead_hint() {
    promote_world '[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "Looks fine go ahead and push a PR to proper upstream"}]' \
        '[]' "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "a go-ahead in words" no "issuecomment-2026-09-24T10:05:00Z reads like a go-ahead.*reply '/promote'"
    # Not for one from before the current head was pushed.
    promote_world '[{"login": "cgwalters", "at": "2026-09-24T09:55:00Z", "body": "LGTM"}]' \
        '[]' "${PUSHED_10}" "${COMMITTED_0950}"
    local out
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run 2>&1)
    ! grep -q 'go-ahead' <<<"${out}" || fail "a go-ahead from before the last push was pointed out: ${out}"
}

test_pr_promote_dco() {
    local cmd='[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "/promote"}]'
    local dco_rules='[{"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "DCO"}]}}]'
    local out
    promote_world "${cmd}" '[]' "${PUSHED_10}" "${COMMITTED_0950}"
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run 2>&1) || fail "promote failed: ${out}"
    ! grep -q 'DCO' <<<"${out}" || fail "a DCO note without a DCO rule: ${out}"

    rest "repos/up/demo/rules/branches/main" "${dco_rules}"
    # By default, his approval signs off, and the body says which one.
    expect_promote "DCO required" yes \
        "add 'Signed-off-by: Colin Walters <walters@verbum.org>' to the commits lacking it"
    expect_promote "DCO required, the approval named" yes \
        '^The `Signed-off-by: Colin Walters <walters@verbum.org>` on these commits was added on cgwalters.s approval of the review draft: https://github.com/cgwalters-forge/demo/pull/1#issuecomment-'
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run 2>&1)
    ! grep -q '/signoff' <<<"${out}" || fail "a /signoff note although promote signs off: ${out}"

    # With --no-signoff, the maintainers are told how to sign off.
    local workflow=${FAKE_GH}/rest/repos/up/demo/contents/.github/workflows/signoff.yml
    mkdir -p "$(dirname "${workflow}")"
    touch "${workflow}.404"
    expect_promote "DCO required, no /signoff workflow" yes \
        $'requires DCO, and these commits have no `Signed-off-by`.*git rebase --signoff <upstream>/main' --no-signoff
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run --no-signoff 2>&1)
    # The note goes before the trailer, which stays last.
    grep -A2 'requires DCO' <<<"${out}" | tail -n1 | grep -qxF 'Generated-by: https://github.com/cgwalters/#llms' ||
        fail "the DCO note isn't right before the trailer: ${out}"

    rm "${workflow}.404"
    rest "repos/up/demo/contents/.github/workflows/signoff.yml" '{"path": ".github/workflows/signoff.yml"}'
    expect_promote "DCO required, with the /signoff workflow" yes 'requires DCO; comment `/signoff`' --no-signoff
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run --no-signoff 2>&1)
    test "$(grep -c 'requires DCO' <<<"${out}")" -eq 1 || fail "expected one DCO note: ${out}"
}

test_pr_promote_policy() {
    local cmd='[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "/promote"}]'
    local human='[{"login": "cgwalters", "at": "2026-09-24T10:05:00Z", "body": "My text.\r\n/promote --human-text"}]'
    local dco_rules='[{"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "DCO"}]}}]'
    local out
    promote_world "${cmd}" '[]' "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "bot-ok" yes '^Policy: +bot-ok$'
    local verdict
    for verdict in stale:'re-check the policy' human-only:'policy is human-only' no-go:'policy is no-go'; do
        echo "${verdict%%:*}" >"${WORK}/policy"
        expect_promote "${verdict%%:*}" no "${verdict#*:}"
    done
    echo human-text >"${WORK}/policy"
    expect_promote "human-text, /promote" no \
        "contribution policy is human-text: the PR title and body and the commit messages must be cgwalters's own.*'/promote --human-text'"
    # From anyone else, '/promote --human-text' approves nothing.
    promote_world '[{"login": "someone", "at": "2026-09-24T10:05:00Z", "body": "/promote --human-text"}]' '[]' \
        "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "human-text, by another login" no 'is not approved'

    # His '/promote --human-text' approves like '/promote', but GitHub must
    # show the text is his: he pushed the approved head, made the body's
    # last edit and set the title, and the bot's trailer line is gone.
    local his_push his_title
    his_push=$(jq -c '. + {by: "cgwalters"}' <<<"${PUSHED_10}")
    his_title=$(jq -c '. + [{event: "renamed", actor: {login: "cgwalters"}, rename: {from: "Bot title", to: "Demo"}}]' <<<"${COMMITTED_0950}")
    promote_world "${human}" '[]' "${PUSHED_10}" "${COMMITTED_0950}"
    expect_promote "human-text, all the bot's" no \
        "pushed by cgwalters-bot, not cgwalters; the body was last edited by no one since it was opened, not cgwalters; the title was not last set by cgwalters; the body still has the bot's 'Generated-by: .*' line"
    sed -i 's,\\n\\nGenerated-by: [^\\]*,,' "${FAKE_GH}/rest/repos/${PR_FORK}/pulls/1.json"
    echo '[{"at": "2026-09-24T10:03:00Z", "by": "cgwalters"}, {"at": "2026-09-24T09:00:00Z", "by": "cgwalters-bot"}]' \
        >"${FAKE_GH}/body-edits.json"
    rest "repos/${PR_FORK}/activity" "$(jq -c '[{timestamp: .at, after, activity_type: "push", actor: {login: .by}}]' <<<"${his_push}")"
    expect_promote "human-text, the bot's title" no "but the title was not last set by cgwalters;"
    rest "repos/${PR_FORK}/issues/1/timeline" "$(jq -c '. + [{event: "renamed", actor: {login: "cgwalters"}, rename: {from: "Bot", to: "Other"}}]' <<<"${COMMITTED_0950}")"
    expect_promote "human-text, retitled since" no "but the title was not last set by cgwalters;"
    rest "repos/${PR_FORK}/issues/1/timeline" "${his_title}"
    rest "repos/up/demo/rules/branches/main" "${dco_rules}"
    expect_promote "human-text, his text" yes '^Policy: +human-text, text by cgwalters'
    # promote adds nothing to his body, not even the DCO approval note.
    out=$("${BIN}/bot-pr" promote "https://github.com/${PR_FORK}/pull/1" --dry-run 2>&1)
    ! grep -q 'on these commits was added' <<<"${out}" || fail "a note added to his text: ${out}"
    # A later body edit by the bot takes it back.
    echo '[{"at": "2026-09-24T10:04:00Z", "by": "cgwalters-bot"}, {"at": "2026-09-24T10:03:00Z", "by": "cgwalters"}]' \
        >"${FAKE_GH}/body-edits.json"
    expect_promote "human-text, the bot edited last" no "the body was last edited by cgwalters-bot, not cgwalters"
    # On a bot-ok repository, it still says the text is his, so it's checked.
    echo bot-ok >"${WORK}/policy"
    expect_promote "bot-ok, /promote --human-text" no "the body was last edited by cgwalters-bot"
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

# A secret gist of the bot's, as the fake gh lists it.
readonly GIST_ID=0123abcd
readonly GIST_URL=https://gist.github.com/cgwalters-bot/${GIST_ID}
# The fake gh's Date, the end of the window a gist check routes.
readonly FAKE_NOW=2026-09-24T00:00:00Z

# fake_etag JSON: the ETag the fake gh gives a gist listing.
fake_etag() {
    echo "W/\"$(sha256sum <<<"$(jq -c . <<<"$1")" | cut -c1-16)\""
}

# set_gist_comments COMMENT...: the gist, listed as updated, holds these
# comments, each "ID LOGIN CREATED_AT BODY...".
set_gist_comments() {
    local c id login at body
    mkdir -p "${FAKE_GH}/rest/gists/${GIST_ID}"
    for c in "$@"; do
        read -r id login at body <<<"${c}"
        jq -nc --arg id "${id}" --arg l "${login}" --arg at "${at}" --arg b "${body}" \
            '{id: ($id | tonumber), user: {login: $l, type: "User"}, body: $b, created_at: $at, updated_at: $at}'
    done | jq -s . >"${FAKE_GH}/rest/gists/${GIST_ID}/comments.json"
    jq -n --arg id "${GIST_ID}" --arg u "${GIST_URL}" --argjson n "$#" '[{id: $id, html_url: $u, public: false,
        description: "An analysis", files: {"a.md": {}}, comments: $n, updated_at: "2026-09-23T23:00:00Z"}]' \
        >"${FAKE_GH}/gists.json"
}

# set_notify_state GISTS: the notifications state, with a poll position,
# nothing pending and the gist check at GISTS (null for none yet).
set_notify_state() {
    set_project_state notifications "$(jq -nc --argjson g "$1" '{since: "2026-09-23T23:30:00Z",
        last_modified: "LM", pending: {}, acked: {}} + if $g != null then {gists: $g} else {} end')"
}

gist_comment_calls() {
    grep -c "gists/${GIST_ID}/comments" "${FAKE_GH}/calls" 2>/dev/null || true
}

test_notify_gists_first_run() {
    set_notify_state null
    set_gist_comments "1 cgwalters 2026-09-23T22:00:00Z Please redo this"
    reset_calls
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    grep -q 'First check of cgwalters-bot.s gists' "${WORK}/out" || fail "no first-check note: $(cat "${WORK}/out")"
    ! grep -q '^request ' "${WORK}/out" || fail "the first run routed old comments: $(cat "${WORK}/out")"
    expect_eq "$(gist_comment_calls)" 0 "comment reads on the first run"
    expect_json "$(project_state notifications | jq -c .gists)" "{\"since\":\"${FAKE_NOW}\"}" "gist state after the first run"
}

test_notify_gists_route() {
    local empty
    empty=$(fake_etag '[]')
    set_notify_state "$(jq -nc --arg e "${empty}" '{since: "2026-09-23T22:00:00Z", etag: "W/\"old\"", empty_etag: $e}')"
    # His old comment, a new one of his, someone's, the bot's own, and his
    # latest, made after the listing (so for the next run).
    set_gist_comments "1 cgwalters 2026-09-23T21:00:00Z Old" \
        "2 cgwalters 2026-09-23T22:30:00Z Please also cover @someone's runner" \
        "3 someone 2026-09-23T22:40:00Z Do something else" \
        "4 cgwalters-bot 2026-09-23T22:50:00Z Updated" \
        "5 cgwalters 2026-09-24T00:00:30Z Later"
    mkdir -p "${FAKE_GH}/rest/repos/cgwalters-bot/cgwalters-bot"
    echo '[]' >"${FAKE_GH}/rest/repos/cgwalters-bot/cgwalters-bot/issues.json"
    cat >"${WORK}/gh-extra" <<'EOF'
#!/usr/bin/env bash
test "$1 $2 $3 $4" = "api -X POST repos/cgwalters-bot/cgwalters-bot/issues" || { echo "fake gh: unexpected call: $*" 1>&2; exit 1; }
printf '%s\n' "$@" >>"${FAKE_GH}/filed"
echo https://github.com/cgwalters-bot/cgwalters-bot/issues/1
EOF
    chmod +x "${WORK}/gh-extra"
    FAKE_GH_EXTRA=${WORK}/gh-extra "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    local records
    records=$(sed -n 's/^request //p' "${WORK}/out")
    jq -se --arg g "${GIST_URL}" 'length == 1 and (.[0] | .reason == "gist_comment" and .author == "cgwalters"
        and .thread_id == $g and .thread_url == $g and .url == "\($g)#gistcomment-2" and .private
        and (.excerpt | startswith("Please also cover")) and .title == "An analysis")' <<<"${records}" >/dev/null ||
        fail "expected one request for comment 2: $(cat "${WORK}/out")"
    grep -qx "title=Gist comment: @someone on gist ${GIST_ID}" "${FAKE_GH}/filed" ||
        fail "someone's comment wasn't filed: $(cat "${FAKE_GH}/filed" 2>/dev/null)"
    ! grep -q 'Do something else' "${FAKE_GH}/filed" || fail "a secret gist's text was filed publicly"
    test "$(grep -c '^title=' "${FAKE_GH}/filed")" -eq 1 || fail "filed more than someone's comment"
    expect_json "$(project_state notifications | jq -c '{p: (.pending | keys), g: .gists}')" \
        "$(jq -nc --arg u "${GIST_URL}#gistcomment-2" --arg n "${FAKE_NOW}" --arg e "${empty}" \
            '{p: [$u], g: {since: $n, empty_etag: $e, etag: $e}}')" "state after routing"
    # Acking the gist's URL clears it, and marks no thread read.
    reset_calls
    "${BIN}/bot-notify" ack "${GIST_URL}" >/dev/null
    expect_json "$(project_state notifications | jq -c '{p: (.pending | keys), a: (.acked | keys)}')" \
        "$(jq -nc --arg u "${GIST_URL}#gistcomment-2" '{p: [], a: [$u]}')" "state after the ack"
    ! grep -q 'notifications/threads' "${FAKE_GH}/calls" || fail "acking a gist marked a thread read"
}

test_notify_gists_unchanged() {
    set_gist_comments "1 cgwalters 2026-09-23T22:30:00Z Please"
    set_notify_state "$(jq -nc --arg e "$(fake_etag "$(cat "${FAKE_GH}/gists.json")")" \
        '{since: "2026-09-23T22:00:00Z", etag: $e}')"
    reset_calls
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1
    ! grep -q '^request ' "${WORK}/out" || fail "a 304 routed comments: $(cat "${WORK}/out")"
    expect_eq "$(gist_comment_calls)" 0 "comment reads after a 304"
    expect_eq "$(grep -c '^api -i gists?' "${FAKE_GH}/calls")" 1 "gist listings"
    grep -q 'No changes' "${WORK}/out" || fail "an unchanged run wrote: $(cat "${WORK}/out")"
    expect_eq "$(graphql_calls)" 1 "GraphQL calls of an unchanged run"
}

# A gist check position whose listing is not a 304, so the gist is read.
gist_position() {
    jq -nc --arg e "$(fake_etag '[]')" '{since: "2026-09-23T22:00:00Z", etag: "W/\"old\"", empty_etag: $e}'
}

# set_mention REPO PRIVATE: a notification thread for REPO#1, private or
# not, in which cgwalters mentions the bot; bot-notify reads it from
# $WORK/threads.json.
set_mention() {
    local dir=${FAKE_GH}/rest/repos/$1/issues
    mkdir -p "${dir}/1"
    jq -n --arg r "$1" '{number: 1, title: "Issue title", html_url: "https://github.com/\($r)/issues/1", labels: [],
        body: "", user: {login: "someone", type: "User"}, created_at: "2026-09-20T00:00:00Z"}' >"${dir}/1.json"
    jq -n --arg r "$1" '[{user: {login: "cgwalters", type: "User"}, body: "@cgwalters-bot Please look at this",
        html_url: "https://github.com/\($r)/issues/1#issuecomment-9", created_at: "2026-09-23T23:40:00Z",
        updated_at: "2026-09-23T23:40:00Z"}]' >"${dir}/1/comments.json"
    jq -n --arg r "$1" --argjson p "$2" '[{id: "42", reason: "mention", unread: true, updated_at: "2026-09-23T23:40:00Z",
        last_read_at: null, subject: {type: "Issue", title: "Issue title", url: "https://api.github.com/repos/\($r)/issues/1",
        latest_comment_url: null}, repository: {full_name: $r, owner: {login: ($r | split("/")[0])}, private: $p,
        html_url: "https://github.com/\($r)"}}]' >"${WORK}/threads.json"
}

test_notify_private_redacted() {
    local c kind private out stored want
    # KIND PRIVATE: whether the stored request keeps its excerpt and title
    # depends only on whether its source is public; the run that found it
    # prints them either way.
    for c in "repo true" "repo false" "gist true" "gist false"; do
        read -r kind private <<<"${c}"
        rm -rf "${FAKE_GH}/rest" "${FAKE_GH}/gists.json" "${WORK}/threads.json"
        echo '[]' >"${WORK}/threads.json"
        set_notify_state "$(gist_position)"
        if test "${kind}" = repo; then
            set_mention o/r "${private}"
        else
            set_gist_comments "1 cgwalters 2026-09-23T22:30:00Z @cgwalters-bot Please look at this"
            jq --argjson p "${private}" '.[0].public = ($p | not)' "${FAKE_GH}/gists.json" >"${WORK}/g" &&
                mv "${WORK}/g" "${FAKE_GH}/gists.json"
        fi
        "${BIN}/bot-notify" --from-file "${WORK}/threads.json" >"${WORK}/out" 2>&1 ||
            fail "${c}: bot-notify failed: $(cat "${WORK}/out")"
        out=$(sed -n 's/^request //p' "${WORK}/out")
        jq -se 'length == 1 and (.[0] | (.excerpt | test("Please look at this")) and .title != null)' <<<"${out}" >/dev/null ||
            fail "${c}: the run didn't print the request with its text: $(cat "${WORK}/out")"
        stored=$(project_state notifications | jq -c '.pending | to_entries | map(.value | {private, excerpt, title})')
        if ${private}; then
            ! project_state notifications | grep -q 'Please look\|Issue title\|An analysis' ||
                fail "${c}: the public state quotes a private source: $(project_state notifications)"
            want='[{"private":true,"excerpt":null,"title":null}]'
        else
            want=$(jq -nc --arg t "$(test "${kind}" = repo && echo "Issue title" || echo "An analysis")" \
                '[{private: false, excerpt: "@cgwalters-bot Please look at this", title: $t}]')
        fi
        expect_json "${stored}" "${want}" "${c}: stored request"
        # A later run prints the stored request as it is.
        "${BIN}/bot-notify" >"${WORK}/out" 2>&1 || fail "${c}: the second run failed: $(cat "${WORK}/out")"
        expect_json "$(sed -n 's/^request //p' "${WORK}/out" | jq -sc 'map({private, excerpt, title})')" "${want}" \
            "${c}: request printed by a later run"
    done
}

test_notify_private_scrubbed() {
    # A private request stored with its text before redaction existed
    # loses it on the next run, even one with nothing new.
    set_project_state notifications "$(jq -nc --argjson r "$(request U1 11 | jq -c '.private = true')" \
        '{since: "2026-09-23T23:30:00Z", last_modified: "LM", pending: {U1: $r}, acked: {}}')"
    "${BIN}/bot-notify" >"${WORK}/out" 2>&1 || fail "bot-notify failed: $(cat "${WORK}/out")"
    expect_json "$(project_state notifications | jq -c '.pending.U1 | {excerpt, title, url}')" \
        '{"excerpt":null,"title":null,"url":"U1"}' "the old private request"
}

test_notify_gists_failed() {
    local c what gists
    gists=$(gist_position)
    # What fails, then the gist check's position must stay put, so that
    # the next run reads the same comments again: reading the gist's
    # comments (a 404 or a 500), or, with the gist read fine, a thread.
    cat >"${WORK}/gh-extra" <<'EOF'
#!/usr/bin/env bash
echo "gh: HTTP 500: Internal Server Error ($*)" 1>&2
exit 1
EOF
    chmod +x "${WORK}/gh-extra"
    for what in gist-404 gist-500 thread; do
        rm -rf "${FAKE_GH}/rest"
        set_notify_state "${gists}"
        set_gist_comments "1 cgwalters 2026-09-23T22:30:00Z Please"
        echo '[]' >"${WORK}/threads.json"
        case "${what}" in
            gist-404) mv "${FAKE_GH}/rest/gists/${GIST_ID}/comments."{json,404} ;;
            gist-500) rm "${FAKE_GH}/rest/gists/${GIST_ID}/comments.json" ;;
            # The thread's issue has no fixture, so reading it is a 500.
            thread) set_mention o/r false; rm "${FAKE_GH}/rest/repos/o/r/issues/1.json" ;;
        esac
        FAKE_GH_EXTRA=${WORK}/gh-extra "${BIN}/bot-notify" --from-file "${WORK}/threads.json" >"${WORK}/out" 2>&1 &&
            fail "${what}: a run that failed to read GitHub succeeded: $(cat "${WORK}/out")"
        expect_json "$(project_state notifications | jq -c .gists)" "${gists}" "${what}: gist state after the failure"
    done
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

# write_fake_policy DIR: a fake 'upstream-policy check' (tested on its
# own in tests/upstream-policy.sh) whose verdict is in $WORK/policy
# (default bot-ok), with its exit statuses; 'stale' is a stale record.
write_fake_policy() {
    cat >"$1/upstream-policy" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = check || exit 1
verdict=$(cat "${WORK}/policy" 2>/dev/null || echo bot-ok)
case "${verdict} ${3:-}" in
    "bot-ok "* | "human-text --allow-human-text") echo "${verdict}" ;;
    "human-text "*) echo "error: $2's policy is human-text" 1>&2; exit 5 ;;
    "stale "*) echo "error: $2's policy record is stale; re-check the policy" 1>&2; exit 4 ;;
    *) echo "error: $2's policy is ${verdict}" 1>&2; exit 6 ;;
esac
EOF
    chmod +x "$1/upstream-policy"
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
    write_fake_policy "${WORK}/bin"
    export FAKE_GH WORK BOT_PR_UPSTREAM_POLICY=${WORK}/bin/upstream-policy
    export FAKE_BOARD_REST=${BIN}/../tests/fixtures/bot-board/fake-rest
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

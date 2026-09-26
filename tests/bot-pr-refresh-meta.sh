#!/usr/bin/env bash
# Offline tests of 'bot-pr refresh-meta': it re-renders an old bot-meta
# section from the current template, keeping the upstream, base and item
# it records and the text outside it (edits by cgwalters included, with
# line endings normalized), writes nothing when the section is current,
# and refuses a section it can't parse, one someone else edited, or one
# whose Fork CI line it can't know. It keeps the run footers at the end
# of the section, where 'set-body --footer' adds them after any earlier
# ones, and set-body and fork-pr refuse a --footer that isn't one. bot-pr
# runs from a copy of bin/ whose
# bot-board is a fake keeping the inbox state in a file, and a fake gh
# serves one fork PR and a fork with no workflows. No network.
#   tests/bot-pr-refresh-meta.sh
# PR bodies hold literal backquotes.
# shellcheck disable=SC2016
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly FORK=cgwalters-forge/bootc
readonly URL=https://github.com/${FORK}/pull/7
readonly ITEM=PVTI_lAHOAQ_SPs4Bj2Gizg8P4Io

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-refresh-meta-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh XDG_STATE_HOME=${WORK}/state
export PATH=${WORK}/fakes:${PATH}

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${WORK}/fakes"
cp "${TESTS}/../bin/bot-pr" "${TESTS}/../bin/bot-git" "${TESTS}/../bin/dco-detect.sh" "${WORK}/bin/"
# The fake bot-board: the inbox state in $FAKE_GH/state.json.
cat >"${WORK}/bin/bot-board" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
    state-get) cat "${FAKE_GH}/state.json" 2>/dev/null || echo '{}' ;;
    state-put) printf '%s\n' "${@: -1}" >"${FAKE_GH}/state.json" ;;
    *) echo "fake bot-board: unexpected: $*" 1>&2; exit 1 ;;
esac
EOF
# The fake gh: the fork PR's JSON in $FAKE_GH/pr.json (PATCH replaces its
# body), its body's edits for GraphQL in $FAKE_GH/edits.json ([{at, by,
# body}], newest first; by "null" is a deleted account), GraphQL failing
# if $FAKE_GH/graphql-fails exists, listing workflows failing if
# $FAKE_GH/workflows-fail exists,
# and a fork without workflows or BOT_PR_CI. Every call is logged to
# $FAKE_GH/calls; anything else fails.
cat >"${WORK}/fakes/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter="" input=""
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f|-F|-H) shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        --input) input=$2; shift 2 ;;
        -*) shift ;;
        *) path=$1; shift ;;
    esac
done
fork=cgwalters-forge/bootc
json=""
case "${method} ${path%%\?*}" in
    "GET user") json='{"login": "cgwalters-bot"}' ;;
    "GET repos/${fork}") json='{"fork": true, "default_branch": "main"}' ;;
    "PUT repos/${fork}/actions/permissions") ;;
    "GET repos/${fork}/actions/variables/BOT_PR_CI") echo "gh: Not Found (HTTP 404)" 1>&2; exit 1 ;;
    "GET repos/${fork}/actions/workflows")
        test ! -e "${store}/workflows-fail" || { echo "gh: Server Error (HTTP 502)" 1>&2; exit 1; }
        json='{"workflows": []}' ;;
    "GET repos/${fork}/pulls/7") json=$(cat "${store}/pr.json") ;;
    "PATCH repos/${fork}/pulls/7")
        test "${input}" = - || { echo "fake gh: PATCH without --input -" 1>&2; exit 1; }
        jq --slurpfile b /dev/stdin '.body = $b[0].body' "${store}/pr.json" >"${store}/pr.new"
        mv "${store}/pr.new" "${store}/pr.json"
        json=$(cat "${store}/pr.json") ;;
    "GET graphql" | "POST graphql")
        test ! -e "${store}/graphql-fails" || { echo "gh: Server Error (HTTP 502)" 1>&2; exit 1; }
        json=$(jq '{data: {repository: {pullRequest: {userContentEdits: {totalCount: length,
            nodes: map({editedAt: .at, editor: (if .by == "null" then null else {login: .by} end),
                diff: .body})}}}}}' "${store}/edits.json") ;;
    *) echo "fake gh: unexpected ${method} ${path}" 1>&2; exit 1 ;;
esac
test -n "${json}" || exit 0
if test -n "${filter}"; then
    jq -r "${filter}" <<<"${json}"
else
    printf '%s\n' "${json}"
fi
EOF
chmod +x "${WORK}/bin/bot-board" "${WORK}/fakes/gh"

# The text outside bot-meta, as cgwalters might have edited it in the web
# UI (CRLF, which bodies are normalized from).
readonly TEXT='Fix the thing.

<!-- cgwalters: it matters because -->

Generated-by: https://github.com/cgwalters/#llms'

# The section as fork-pr wrote it before the fork CI and sign-off changes.
old_meta() {
    cat <<EOF
<!-- bot-meta -->
---

**Review draft in cgwalters-forge, not upstream yet.** This section is removed when the PR is opened upstream.

- Upstream: \`bootc-dev/bootc\`, base \`${1:-main}\`
- Board item: \`${ITEM}\`

To review:
- **Approve** to open it upstream, ready for review.
- Comment \`/draft\`, then approve, to open it upstream as a draft (\`/ready\` undoes that).
- **Close** to drop it.
- Edit the title and description freely: they become the upstream PR's. Review comments are addressed with fixup commits and a reply here.
<!-- /bot-meta -->
EOF
}

# reset BODY [EDITS]: the fork PR with BODY, whose edit history is EDITS
# (a JSON array of {at, by, body}, newest first).
reset() {
    rm -rf "${FAKE_GH}"
    mkdir -p "${FAKE_GH}"
    jq -n --arg body "$1" '{number: 7, state: "open", user: {login: "cgwalters-bot"},
        updated_at: "2026-09-25T00:00:00Z", body: $body}' >"${FAKE_GH}/pr.json"
    printf '%s\n' "${2:-[]}" >"${FAKE_GH}/edits.json"
    : >"${FAKE_GH}/calls"
}

body() {
    jq -r .body "${FAKE_GH}/pr.json"
}

# edits AT BY BODY [AT BY BODY...]: a JSON edit history for reset.
edits() {
    local out='[]'
    while test $# -gt 0; do
        out=$(jq -c --arg at "$1" --arg by "$2" --arg body "$3" '. + [{at: $at, by: $by, body: $body}]' <<<"${out}")
        shift 3
    done
    printf '%s\n' "${out}"
}

patches() {
    grep -c "^api -X PATCH repos/${FORK}/pulls/7" "${FAKE_GH}/calls" || true
}

# fork_writes: how many calls changed the fork's settings.
fork_writes() {
    grep -c "^api -X PUT repos/${FORK}/actions" "${FAKE_GH}/calls" || true
}

# run NAME: refresh-meta, its stderr in $WORK/NAME.err.
run() {
    "${WORK}/bin/bot-pr" refresh-meta "${URL}" 2>"${WORK}/$1.err"
}

# check_refreshed NAME BASE: the text is intact, and the section is the
# current template's, with BASE and the item.
check_refreshed() {
    local name=$1 base=$2 actual
    actual=$(body)
    [[ "${actual}" == "${TEXT}"$'\n\n<!-- bot-meta -->\n'* ]] ||
        fail "${name}: the text outside bot-meta changed: ${actual}"
    local want
    for want in "- Upstream: \`bootc-dev/bootc\`, base \`${base}\`" "- Board item: \`${ITEM}\`" \
        "- Fork CI: off;" "Review comments are squashed into the commits they concern" '/promote'; do
        [[ "${actual}" == *"${want}"* ]] || fail "${name}: no '${want}' in: ${actual}"
    done
    [[ "${actual}" != *"fixup commits"* ]] || fail "${name}: still mentions fixup commits"
    [[ "${actual}" == *'<!-- /bot-meta -->' ]] || fail "${name}: the section isn't at the end"
}

# An old section with the bot's own text: refreshed, and recorded as the
# bot's write so that inbox doesn't report it.
reset "${TEXT}"$'\n\n'"$(old_meta)"
if run old; then
    check_refreshed old main
    test "$(patches)" = 1 || fail "old: expected one PATCH, got $(patches)"
    test "$(jq -r --arg u "${URL}" '.prs[$u].bot_body' "${FAKE_GH}/state.json")" = \
        "$(jq -r .body "${FAKE_GH}/pr.json" | sha256sum | cut -d' ' -f1)" ||
        fail "old: the new body isn't recorded as the bot's"
    grep -q "Refreshed the bot-meta section of ${URL}" "${WORK}/old.err" || fail "old: $(cat "${WORK}/old.err")"
else
    fail "old: refresh-meta failed: $(cat "${WORK}/old.err")"
fi
# ... and a second run finds nothing to do.
: >"${FAKE_GH}/calls"
if run again; then
    test "$(patches)" = 0 || fail "again: rewrote a current section"
    grep -q "already current" "${WORK}/again.err" || fail "again: $(cat "${WORK}/again.err")"
else
    fail "again: refresh-meta failed: $(cat "${WORK}/again.err")"
fi

# cgwalters edited the text in the web UI (CRLF), not the section: his
# text is kept, the base carries over, and his edit is left for inbox to
# report.
EDITED=${TEXT//$'\n'/$'\r\n'}$'\r\n\r\n'$(old_meta stable)
readonly EDITED
reset "${EDITED}" "$(edits 2026-09-25T10:00:00Z cgwalters "${EDITED}" \
    2026-09-24T10:00:00Z cgwalters-bot "Old text."$'\n\n'"$(old_meta stable)")"
if run edited; then
    check_refreshed edited stable
    jq -e --arg u "${URL}" '.prs[$u].reviewer_edit.at == "2026-09-25T10:00:00Z"' "${FAKE_GH}/state.json" >/dev/null ||
        fail "edited: his edit isn't kept for inbox: $(cat "${FAKE_GH}/state.json")"
else
    fail "edited: refresh-meta failed: $(cat "${WORK}/edited.err")"
fi

# Sections someone else edited, whose edits GitHub doesn't show, or whose
# Fork CI line can't be known are refused without writing anything. BY
# are the editors after FIRST (newest first), each leaving the section
# edited; FLAG a failure for the fake gh ("-" for none).
while IFS="|" read -r name by first flag want; do
    args=()
    for e in ${by//,/ }; do
        args+=(2026-09-25T10:00:00Z "${e}" "${TEXT}"$'\n\n'"$(old_meta)")
    done
    reset "${TEXT}"$'\n\n'"$(old_meta)" "$(edits "${args[@]}" \
        2026-09-24T10:00:00Z "${first}" "${TEXT}"$'\n\n'"$(old_meta stable)")"
    test "${flag}" = - || : >"${FAKE_GH}/${flag}"
    if run "${name}"; then
        fail "${name}: refresh-meta succeeded"
    else
        grep -q "${want}" "${WORK}/${name}.err" || fail "${name}: no '${want}' in: $(cat "${WORK}/${name}.err")"
    fi
    test "$(patches)" = 0 || fail "${name}: wrote the body"
done <<'EOF'
his-meta|cgwalters|cgwalters-bot|-|cgwalters edited .*'s bot-meta section
with-ghost|null,cgwalters|cgwalters-bot|-|cgwalters, ghost edited .*'s bot-meta section
no-bot-version|cgwalters|someone|-|cannot tell whether someone edited
graphql-down|cgwalters|cgwalters-bot|graphql-fails|cannot tell whether someone edited
fork-setup-unsure|cgwalters|cgwalters-bot|workflows-fail|the Fork CI line may be wrong
EOF

# Sections it can't re-render are refused, without writing anything.
while IFS='|' read -r name from to want; do
    reset "${TEXT}"$'\n\n'"$(old_meta | sed "s/${from}/${to}/")"
    if run "${name}"; then
        fail "${name}: refresh-meta succeeded"
    else
        grep -q "${want}" "${WORK}/${name}.err" || fail "${name}: no '${want}' in: $(cat "${WORK}/${name}.err")"
    fi
    test "$(patches)" = 0 || fail "${name}: wrote the body"
    test "$(fork_writes)" = 0 || fail "${name}: changed the fork's settings"
done <<'EOF'
no-upstream|- Upstream:|- Target:|cannot find the 'Upstream
no-item|- Board item:.*|- Board item: none|record one with
EOF

# Run footers: bot-footer's, and an agent.yml run's, which the apply step
# wrote right after the section's start.
readonly F1='<sub>Bot run: session aaaaaaaa · ~$1.00 inference (est., list prices) · 5m wall</sub>
<!-- bot-run/v1 {"task":"PVTI_x","sessions":["aaaaaaaa"],"estimate":true} -->'
readonly F2='<sub>Bot run: session bbbbbbbb, agent cccccccc · ~$2.00 inference (est., list prices) · 9m wall</sub>
<!-- bot-run/v1 {"task":"PVTI_x","sessions":["bbbbbbbb"],"agents":["cccccccc"],"estimate":true} -->'
readonly AGENT_FOOTER='Agent run [1003](https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1003): claude, 10m, success
<!-- agent-run-summary/v1 {"run_id":1003,"result":"success","duration_s":600} -->'
readonly SECTION_END=$'\n<!-- /bot-meta -->'

# refresh-meta keeps both, at the end, and then finds the section current.
meta=$(old_meta)
meta=${meta%%$'\n'*}$'\n'${AGENT_FOOTER}$'\n'${meta#*$'\n'}
reset "${TEXT}"$'\n\n'"${meta%"${SECTION_END}"}"$'\n\n'"${F1}${SECTION_END}"
if run footers; then
    check_refreshed footers main
    [[ "$(body)" == *$'with a reply here.\n\n'"${AGENT_FOOTER}"$'\n\n'"${F1}${SECTION_END}" ]] ||
        fail "footers: not kept at the end of the section: $(body)"
    test "$(grep -c 'run/v1\|run-summary/v1' <<<"$(body)")" = 2 || fail "footers: duplicated: $(body)"
    : >"${FAKE_GH}/calls"
    run footers-again || fail "footers-again: $(cat "${WORK}/footers-again.err")"
    test "$(patches)" = 0 || fail "footers-again: rewrote a current section"
else
    fail "footers: refresh-meta failed: $(cat "${WORK}/footers.err")"
fi

# set-body --footer alone adds one after the others and keeps the text;
# with --body-file too, it replaces the text as well. A pipe works.
printf '%s\n' "${F2}" >"${WORK}/f2"
if "${WORK}/bin/bot-pr" set-body "${URL}" --footer "${WORK}/f2" 2>"${WORK}/add.err"; then
    [[ "$(body)" == "${TEXT}"$'\n\n<!-- bot-meta -->\n'*$'with a reply here.\n\n'"${AGENT_FOOTER}"$'\n\n'"${F1}"$'\n\n'"${F2}${SECTION_END}" ]] ||
        fail "add: $(body)"
else
    fail "add: set-body --footer failed: $(cat "${WORK}/add.err")"
fi
printf 'New text.\n\nGenerated-by: https://github.com/cgwalters/#llms\n' >"${WORK}/new-body"
if "${WORK}/bin/bot-pr" set-body "${URL}" --body-file "${WORK}/new-body" --footer <(printf '%s\n' "${F1}") 2>"${WORK}/both.err"; then
    [[ "$(body)" == $'New text.\n\nGenerated-by: https://github.com/cgwalters/#llms\n\n<!-- bot-meta -->\n'*"${F1}"$'\n\n'"${F2}"$'\n\n'"${F1}${SECTION_END}" ]] ||
        fail "both: $(body)"
else
    fail "both: set-body --body-file --footer failed: $(cat "${WORK}/both.err")"
fi
# ... and still refreshes to the same section.
: >"${FAKE_GH}/calls"
run footers-kept || fail "footers-kept: $(cat "${WORK}/footers-kept.err")"
test "$(patches)" = 0 || fail "footers-kept: refresh-meta rewrote the footers: $(body)"

# A --footer that isn't bot-footer's output is refused, by set-body before
# writing and by fork-pr before any call.
printf 'Fix it.\n' >"${WORK}/body"
while IFS='|' read -r name content want; do
    printf '%b' "${content}" >"${WORK}/footer-${name}"
    : >"${FAKE_GH}/calls"
    if "${WORK}/bin/bot-pr" set-body "${URL}" --footer "${WORK}/footer-${name}" 2>"${WORK}/${name}.err"; then
        fail "${name}: set-body accepted it"
    else
        grep -q "${want}" "${WORK}/${name}.err" || fail "${name}: no '${want}' in: $(cat "${WORK}/${name}.err")"
    fi
    test "$(patches)" = 0 || fail "${name}: set-body wrote the body"
    : >"${FAKE_GH}/calls"
    if "${WORK}/bin/bot-pr" fork-pr --repo bootc-dev/bootc --base main --branch bot/x --item "${ITEM}" --title T \
        --body-file "${WORK}/body" --footer "${WORK}/footer-${name}" 2>"${WORK}/${name}-fork.err"; then
        fail "${name}: fork-pr accepted it"
    else
        grep -q "${want}" "${WORK}/${name}-fork.err" || fail "${name}: fork-pr: no '${want}' in: $(cat "${WORK}/${name}-fork.err")"
    fi
    test ! -s "${FAKE_GH}/calls" || fail "${name}: fork-pr called gh: $(cat "${FAKE_GH}/calls")"
done <<'EOF'
empty||is empty; did bot-footer fail
no-marker|<sub>Bot run: x</sub>\n|doesn't look like bot-footer output
marker-only|<!-- bot-run/v1 {"task":"x"} -->\n|doesn't look like bot-footer output
three-lines|a\nb\n<!-- bot-run/v1 {"task":"x"} -->\n|doesn't look like bot-footer output
other-comment|<sub>x</sub>\n<!-- bot-run/v2 {"task":"x"} -->\n|doesn't look like bot-footer output
meta-marker|<!-- /bot-meta -->\n<!-- bot-run/v1 {"task":"x"} -->\n|doesn't look like bot-footer output
EOF

# Only forge fork PRs.
if "${WORK}/bin/bot-pr" refresh-meta https://github.com/cgwalters-bot/bootc/pull/1 2>"${WORK}/own.err"; then
    fail "own: refresh-meta accepted a PR in the bot's own fork"
else
    grep -q "only handles forge fork PRs" "${WORK}/own.err" || fail "own: $(cat "${WORK}/own.err")"
fi

if test "${failures}" -gt 0; then
    echo "${failures} failure(s)" 1>&2
    exit 1
fi
echo "ok: bot-pr refresh-meta"

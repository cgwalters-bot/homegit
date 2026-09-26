#!/usr/bin/env bash
# Offline tests of 'bot-board question', 'resolve' and 'issue' against a
# fake 'gh' that serves a fixed board and records every write. No
# network, no quota.
#   tests/bot-board-question.sh
set -euo pipefail

BIN=$(cd "$(dirname "$0")/../bin" && pwd)
readonly BIN
readonly TRACKER=https://github.com/cgwalters-forge/tracker

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh-store
mkdir -p "${FAKE_GH}" "${WORK}/bin"
export PATH=${WORK}/bin:${PATH} HOME=${WORK}/home XDG_CACHE_HOME=${WORK}/home/cache
unset GH_TOKEN GITHUB_TOKEN

# The fake gh serves $FAKE_GH/{fields,items}.json and appends each write
# to $FAKE_GH/log, one line each: "issue PAYLOAD" for a new issue (which
# becomes tracker#42, REST id 900), "sub REPO#N ID", "add URL", "edit
# ITEM FIELD VALUE", "comment REPO#N BODY", "close REPO#N".
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
log() { printf '%s\n' "$*" >>"${store}/log"; }
arg() { # arg NAME ARGS...: the value after NAME
    local name=$1; shift
    while test $# -gt 0; do test "$1" != "${name}" || { echo "$2"; return; }; shift; done
}
case "$1 $2" in
    "project field-list") cat "${store}/fields.json" ;;
    "project item-list") echo list >>"${store}/lists"; cat "${store}/items.json" ;;
    "project view") echo PVT_fake ;;
    "project item-add") url=$(arg --url "$@"); log "add ${url}"; echo "PVTI_new" ;;
    "project item-edit")
        value=$(printf '%s\n' "$@" | sed -n 's/^--\(text\|single-select-option-id\)=//p')
        test -n "${value}" || value=$(arg --single-select-option-id "$@")
        log "edit $(arg --id "$@") $(arg --field-id "$@") ${value}" ;;
    "api rate_limit") echo 5000 ;;
    # The item lookup: the board's items with the fields it reads, all on
    # one page; and an item's content by id.
    "api graphql")
        filter=$(arg --jq "$@")
        if grep -q 'items(first: 100, query' <<<"$*"; then
            jq '{data: {user: {projectV2: {items: {pageInfo: {hasNextPage: false}, nodes: [.items[]
                | {id, content, priority: (if .priority then {name: .priority} else null end),
                   org: (if .org then {name: .org} else null end)}]}}}}}' "${store}/items.json"
        else
            id=$(printf '%s\n' "$@" | sed -n 's/^id=//p')
            jq --arg id "${id}" '{data: {node: {content: (first(.items[] | select(.id == $id) | .content) // null)}}}' \
                "${store}/items.json"
        fi | jq -r "${filter:-.}" ;;
    "api -X")
        method=$3 path=$4
        case "${method} ${path}" in
            "POST repos/cgwalters-forge/tracker/issues")
                log "issue $(jq -c .)"
                echo '{"id": 900, "number": 42, "html_url": "https://github.com/cgwalters-forge/tracker/issues/42"}' ;;
            "POST repos/cgwalters-forge/tracker/issues/78/sub_issues")
                echo "gh: Validation Failed (HTTP 422)" 1>&2; exit 1 ;;
            POST\ repos/*/sub_issues)
                p=${path#repos/}; p=${p%/sub_issues}
                log "sub ${p%/issues/*}#${p##*/} $(arg -F "$@")" ;;
            POST\ repos/*/comments)
                p=${path#repos/}; p=${p%/comments}
                log "comment ${p%/issues/*}#${p##*/} $(arg -f "$@")" ;;
            "POST repos/cgwalters-forge/tracker/labels")
                log "label $(printf '%s\n' "$@" | sed -n 's/^name=//p') $(printf '%s\n' "$@" | sed -n 's/^color=//p')" ;;
            POST\ repos/*/labels)
                p=${path#repos/}; p=${p%/labels}
                log "addlabels ${p%/issues/*}#${p##*/} $(jq -c .labels)" ;;
            DELETE\ repos/*/labels/*)
                p=${path#repos/}; name=${p##*/}; p=${p%/labels/*}
                log "rmlabel ${p%/issues/*}#${p##*/} ${name}" ;;
            PATCH\ repos/*)
                p=${path#repos/}
                log "close ${p%/issues/*}#${p##*/} $(printf '%s ' "$@" | grep -o 'state_reason=[a-z_]*')" ;;
            *) echo "fake gh: unexpected call: $*" 1>&2; exit 1 ;;
        esac ;;
    # 'gh api PATH --jq FILTER' reads $FAKE_GH/api/PATH (with '/' as '_', no
    # query string); a 404 when there's none.
    api\ --paginate|api\ repos/*)
        path=$2; test "${path}" != --paginate || path=$3
        file=${store}/api/$(sed 's/?.*//; s,/,_,g' <<<"${path}")
        test -e "${file}" || { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
        filter=$(arg --jq "$@"); jq -r "${filter:-.}" "${file}" ;;
    *) echo "fake gh: unexpected call: $*" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

jq -n '{fields: (
    [{name: "Status", opts: ["Todo", "In Progress", "Needs human", "Done"]},
     {name: "Priority", opts: ["P0", "P1", "P2"]},
     {name: "Org", opts: ["bootc-dev", "composefs", "cgwalters-bot", "other"]}]
    | map({id: "F_\(.name)", name, options: [.opts[] | {id: "O_\(.)", name: .}]})
    + [{id: "F_Why", name: "Why"}])}' >"${FAKE_GH}/fields.json"
# Issue 42 is a question, 43 isn't; the tracker has two labels so far.
mkdir -p "${FAKE_GH}/api"
echo '{"labels": [{"name": "question"}, {"name": "P1"}]}' >"${FAKE_GH}/api/repos_cgwalters-forge_tracker_issues_42"
echo '{"labels": [{"name": "enhancement"}]}' >"${FAKE_GH}/api/repos_cgwalters-forge_tracker_issues_43"
echo '[{"name": "question"}, {"name": "P1"}]' >"${FAKE_GH}/api/repos_cgwalters-forge_tracker_labels"
jq -n --arg t "${TRACKER}" '{items: [
    {id: "PVTI_parent", title: "composefs-rs: design a stable varlink API v1", status: "In Progress",
     priority: "P0", org: "composefs", content: {type: "Issue", url: "\($t)/issues/5", body: ""}},
    {id: "PVTI_pr", title: "UKI Addons Support", status: "In Review", priority: "P1",
     content: {type: "PullRequest", url: "https://github.com/bootc-dev/bootc/pull/9"}},
    {id: "PVTI_q", title: "Q", status: "Needs human", content: {type: "Issue", url: "\($t)/issues/42"}},
    {id: "PVTI_np", title: "No priority", org: "bootc-dev", content: {type: "Issue", url: "\($t)/issues/44"}}]}' \
    >"${FAKE_GH}/items.json"

# run ARGS...: runs bot-board with a fresh cache and log; its stdout is in
# $out, and the log in $FAKE_GH/log.
run() {
    rm -rf "${HOME}/cache" "${FAKE_GH}/log" "${FAKE_GH}/lists"
    touch "${FAKE_GH}/log" "${FAKE_GH}/lists"
    out=$("${BIN}/bot-board" "$@" 2>"${WORK}/err")
}

expect_log() { # expect_log LINE: the log has exactly this line
    grep -qxF "$1" "${FAKE_GH}/log" || fail "no '$1' in the log:"$'\n'"$(cat "${FAKE_GH}/log")"
}

# --- A question blocking a tracker issue: a sub-issue ---------------------

run question "${TRACKER}/issues/5" "Split the interfaces?" \
    --option "Split into Repository and Oci" --option "One interface" --option "Decide later" \
    --recommend "container-libs#651 wants them apart" --context "From the varlink proposal."
test "${out}" = "${TRACKER}/issues/42" || fail "question printed '${out}', not its URL"
want_body="Blocks: ${TRACKER}/issues/5

From the varlink proposal.

Q: Split the interfaces?

Options:
A) Split into Repository and Oci
B) One interface
C) Decide later

Recommended: A, because container-libs#651 wants them apart

Answer with a comment on this issue: an option's letter alone on the first line (e.g. \`B\`), optionally followed by your own text, or just text. Only comments by the cgwalters login count."
payload=$(sed -n 's/^issue //p' "${FAKE_GH}/log")
test "$(jq -r .body <<<"${payload}")" = "${want_body}" ||
    fail "question body:"$'\n'"$(jq -r .body <<<"${payload}")"
jq -e '.title == "Split the interfaces?" and .labels == ["question", "P0", "target:composefs"] and .assignees == ["cgwalters"]' \
    <<<"${payload}" >/dev/null || fail "question issue fields: ${payload}"
expect_log "sub cgwalters-forge/tracker#5 sub_issue_id=900"
expect_log "add ${TRACKER}/issues/42"
# On the board before it's a sub-issue, which the board's "Auto-add
# sub-issues" workflow would otherwise race.
test "$(grep -m1 -oE '^(add|sub) ' "${FAKE_GH}/log")" = "add " || fail "made a sub-issue before adding it to the board"
# Org and Priority come from the blocked item.
expect_log "edit PVTI_new F_Org O_composefs"
expect_log "edit PVTI_new F_Status O_Needs human"
expect_log "edit PVTI_new F_Why Q: Split the interfaces? (rec A)"
expect_log "edit PVTI_new F_Priority O_P0"
expect_log "edit PVTI_parent F_Status O_Needs human"
# Missing labels are created with their colors; P1 exists already.
expect_log "label P0 d73a4a"
expect_log "label target:composefs 1d76db"
! grep -q '^label P1 ' "${FAKE_GH}/log" || fail "recreated an existing label"
echo "ok: question on a tracker issue"

# A full listing costs ~300 GraphQL points; a question needs none.
test ! -s "${FAKE_GH}/lists" || fail "question listed the whole board"

# --- A question blocking an upstream PR: no sub-issue ---------------------

run question bootc-dev/bootc#9 "Rerun the red legs, then merge." --priority P2
payload=$(sed -n 's/^issue //p' "${FAKE_GH}/log")
# An upstream link is in a code span, so it adds nothing to its timeline.
jq -e '.body | startswith("Blocks: `https://github.com/bootc-dev/bootc/issues/9`\n\nQ: Rerun the red legs, then merge.\n\nAnswer with a comment on this issue: just text.")' \
    <<<"${payload}" >/dev/null || fail "question body without options: $(jq .body <<<"${payload}")"
! grep -q '^sub ' "${FAKE_GH}/log" || fail "a sub-issue of an upstream item"
expect_log "edit PVTI_new F_Priority O_P2"
echo "ok: question on an upstream item"

# A PR URL keeps /pull/ in the Blocks line and finds the PR's item.
run question https://github.com/bootc-dev/bootc/pull/9 "Drop commit 3?" --option Drop --option Keep
jq -e '.body | startswith("Blocks: `https://github.com/bootc-dev/bootc/pull/9`\n")' \
    <(sed -n 's/^issue //p' "${FAKE_GH}/log") >/dev/null || fail "PR URL in the Blocks line"
expect_log "edit PVTI_pr F_Status O_Needs human"
expect_log "edit PVTI_new F_Why Q: Drop commit 3?"
expect_log "edit PVTI_new F_Priority O_P1"
echo "ok: question on an upstream PR"

# A blocked item missing from the board (or not listed yet): the question
# is still asked, and a failed sub-issue link only warns.
run question "${TRACKER}/issues/78" "Anything?" --priority P1
expect_log "add ${TRACKER}/issues/42"
grep -q "Org is not set" "${WORK}/err" || fail "no warning about the unset Org: $(cat "${WORK}/err")"
! grep -q "F_Status O_Needs human" <(grep -v '^edit PVTI_new ' "${FAKE_GH}/log") || fail "set the status of an item not on the board"
grep -q "is not on the board" "${WORK}/err" || fail "no warning about the missing item: $(cat "${WORK}/err")"
grep -q "making .* a sub-issue .* failed" "${WORK}/err" || fail "no warning about the failed sub-issue: $(cat "${WORK}/err")"
echo "ok: question on an item missing from the board"

# --- Refusals: nothing is created -----------------------------------------

# "ERROR SUBSTRING|ARGS" (tab-separated args)
readonly REFUSALS=(
    "at least two options|question	${TRACKER}/issues/5	Q?	--option	only"
    "needs options|question	${TRACKER}/issues/5	Q?	--recommend	because"
    "usage:|question	${TRACKER}/issues/5"
    "expected an issue or PR URL|question	PVTI_parent	Q?"
    "invalid Priority 'P7'|question	${TRACKER}/issues/5	Q?	--priority	P7"
    "must be an issue in cgwalters-forge/tracker|issue	--parent	bootc-dev/bootc#9	T	B"
    "no longer drafts|draft	T	B"
    "say in TEXT|resolve	${TRACKER}/issues/42	 "
    "closes questions in cgwalters-forge/tracker|resolve	https://github.com/bootc-dev/bootc/pull/9	Merged."
    "isn't labelled 'question'|resolve	${TRACKER}/issues/43	Done."
)
for c in "${REFUSALS[@]}"; do
    IFS='|' read -r want argline <<<"${c}"
    IFS=$'\t' read -r -a args <<<"${argline}"
    if run "${args[@]}"; then fail "'${argline}' succeeded"; fi
    grep -qF "${want}" "${WORK}/err" || fail "'${argline}': no '${want}' in: $(cat "${WORK}/err")"
    test ! -s "${FAKE_GH}/log" || fail "'${argline}' wrote: $(cat "${FAKE_GH}/log")"
done
echo "ok: ${#REFUSALS[@]} refusals"

# --- resolve ---------------------------------------------------------------

run resolve cgwalters-forge/tracker#42 "Split the interfaces in forge composefs-rs#9."
expect_log "comment cgwalters-forge/tracker#42 body=Split the interfaces in forge composefs-rs#9."
expect_log "close cgwalters-forge/tracker#42 state_reason=completed"
expect_log "edit PVTI_q F_Status O_Done"
test ! -s "${FAKE_GH}/lists" || fail "resolve listed the whole board"
echo "ok: resolve"

# --- Labels follow Priority and Org on tracker issues ---------------------

# "ARGS|EXPECTED label calls, ';'-separated, or - for none" (tab-separated
# args); tracker#42 has the labels question and P1.
readonly LABEL_CASES=(
    "set	${TRACKER}/issues/42	--priority	P2|addlabels cgwalters-forge/tracker#42 [\"P2\"];rmlabel cgwalters-forge/tracker#42 P1"
    "set	cgwalters-forge/tracker#42	--org	cgwalters-bot|addlabels cgwalters-forge/tracker#42 [\"target:cgwalters-bot\"]"
    "set	PVTI_q	--priority	P1	--status	Done|-"
    "set	PVTI_q	--priority	P0	--org	bootc-dev|addlabels cgwalters-forge/tracker#42 [\"P0\",\"target:bootc-dev\"];rmlabel cgwalters-forge/tracker#42 P1"
    "set	https://github.com/bootc-dev/bootc/pull/9	--priority	P0|-"
    "set	PVTI_q	--why	x|-"
    "--project	composefs-stable	set	PVTI_q	--priority	P0|-"
)
for c in "${LABEL_CASES[@]}"; do
    IFS='|' read -r argline want <<<"${c}"
    IFS=$'\t' read -r -a args <<<"${argline}"
    run "${args[@]}" || fail "'${argline}' failed: $(cat "${WORK}/err")"
    test ! -s "${FAKE_GH}/lists" || fail "'${argline}' listed the whole board"
    if test "${want}" = -; then
        ! grep -qE '^(addlabels|rmlabel) ' "${FAKE_GH}/log" || fail "'${argline}' changed labels: $(cat "${FAKE_GH}/log")"
    else
        IFS=';' read -r -a wants <<<"${want}"
        for w in "${wants[@]}"; do expect_log "${w}"; done
        test "$(grep -cE '^(addlabels|rmlabel) ' "${FAKE_GH}/log")" -eq "${#wants[@]}" ||
            fail "'${argline}': other label calls: $(cat "${FAKE_GH}/log")"
    fi
done
# Own infrastructure gets the lighter target color.
run set "${TRACKER}/issues/42" --org cgwalters-bot
expect_log "label target:cgwalters-bot bfd4f2"
echo "ok: ${#LABEL_CASES[@]} label syncs"

run labels --dry-run
grep -qxF "${TRACKER}/issues/5: P0, target:composefs" <<<"${out}" || fail "labels --dry-run: ${out}"
grep -qxF "${TRACKER}/issues/42: no priority" <<<"${out}" || fail "labels --dry-run: ${out}"
# An item with an Org but no Priority keeps the Org as its target.
grep -qxF "${TRACKER}/issues/44: no priority, target:bootc-dev" <<<"${out}" || fail "labels --dry-run: ${out}"
test ! -s "${FAKE_GH}/log" || fail "labels --dry-run wrote: $(cat "${FAKE_GH}/log")"
# #5 gets both labels, #42 loses P1 (its item has no Priority).
echo '{"labels": []}' >"${FAKE_GH}/api/repos_cgwalters-forge_tracker_issues_5"
run labels
expect_log "addlabels cgwalters-forge/tracker#5 [\"P0\",\"target:composefs\"]"
expect_log "rmlabel cgwalters-forge/tracker#42 P1"
test "$(grep -c '^label target:composefs ' "${FAKE_GH}/log")" -eq 1 || fail "created a label twice: $(cat "${FAKE_GH}/log")"
! run --project composefs-stable labels || fail "labels ran on another board"
echo "ok: labels"

run add --priority P2 https://github.com/bootc-dev/bootc/issues/77
expect_log "add https://github.com/bootc-dev/bootc/issues/77"
expect_log "edit PVTI_new F_Priority O_P2"
echo "ok: add --priority"

# --- issue -----------------------------------------------------------------

run issue --parent "${TRACKER}/issues/5" --priority P1 "bootc: composefs edit" "Body."
payload=$(sed -n 's/^issue //p' "${FAKE_GH}/log")
jq -e '. == {title: "bootc: composefs edit", body: "Body.", labels: ["P1", "target:bootc-dev"]}' <<<"${payload}" >/dev/null ||
    fail "issue payload: ${payload}"
expect_log "sub cgwalters-forge/tracker#5 sub_issue_id=900"
expect_log "add ${TRACKER}/issues/42"
expect_log "edit PVTI_new F_Org O_bootc-dev"
expect_log "edit PVTI_new F_Priority O_P1"
test "${out}" = PVTI_new || fail "issue printed '${out}'"
echo "ok: issue"

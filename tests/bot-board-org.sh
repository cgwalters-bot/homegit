#!/usr/bin/env bash
# Offline tests of how 'bot-board fill-org' derives an item's Org, and of
# 'list --field' filtering by a text field (Lead), against
# a fake 'gh' serving a fixed board and repository lookups. No network,
# no quota.
#   tests/bot-board-org.sh
set -euo pipefail

BIN=$(cd "$(dirname "$0")/../bin" && pwd)
readonly BIN

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh-store
mkdir -p "${FAKE_GH}" "${WORK}/bin"
export PATH=${WORK}/bin:${PATH} HOME=${WORK}/home XDG_CACHE_HOME=${WORK}/home/cache
export FAKE_BOARD_REST=${BIN}/../tests/fixtures/bot-board/fake-rest
unset GH_TOKEN GITHUB_TOKEN

# The fake gh: the board is $FAKE_GH/{fields,items}.json (fake-rest
# serves the items over REST), and 'gh api repos/OWNER/REPO' answers
# from $FAKE_GH/sources (lines "OWNER/REPO SOURCE", SOURCE '-' for a
# repository that isn't a fork; other repositories are a 404). GraphQL calls are appended to
# $FAKE_GH/mutations, one line each.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
case "$1 $2" in
    "project field-list") cat "${store}/fields.json" ;;
    "api -i") exec "${FAKE_BOARD_REST:?}" "${store}/items.json" "$3" ;;
    "project view") echo PVT_fake ;;
    "api rate_limit") echo 5000 ;;
    "api graphql") { printf '%s' "$*" | tr -s '\n ' ' '; echo; } >>"${store}/mutations"; echo '{}' ;;
    # Tracker issues have no labels yet; label writes are logged.
    "api --paginate") echo '' ;;
    api\ repos/cgwalters-forge/tracker/issues/*) echo '[]' ;;
    "api -X") echo "$3 ${4#repos/cgwalters-forge/tracker/}" >>"${store}/labels" ;;
    api\ repos/*)
        source=$(awk -v r="${2#repos/}" '$1 == r { print $2 }' "${store}/sources")
        test -n "${source}" || { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
        test "${source}" = - || echo "${source}"
        ;;
    *) echo "fake gh: unexpected call: $*" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

jq -n '{fields: [{id: "F_org", name: "Org", options: [
    "bootc-dev", "coreos", "osbuild", "redhat-cop", "cgwalters-forge", "cgwalters-bot", "other"
    | {id: "O_\(.)", name: .}]}, {id: "F_lead", name: "Lead"}]}' >"${FAKE_GH}/fields.json"
cat >"${FAKE_GH}/sources" <<'EOF'
cgwalters-forge/bootc bootc-dev/bootc
cgwalters-forge/image-builder osbuild/image-builder
cgwalters-forge/cgwalters-devspace-sandbox bootc-dev/cgwalters-devspace-sandbox
cgwalters-forge/review -
cgwalters-bot/homegit cgwalters/homegit
cgwalters-bot/praxis-credential-broker -
cgwalters/cgwalters -
EOF

# One item per case: "EXPECTED ORG|CURRENT ORG|CONTENT URL|BRANCH|TITLE|BODY",
# with EXPECTED '=' when fill-org --all must leave the item alone.
readonly CASES=(
    "bootc-dev||https://github.com/bootc-dev/bootc/issues/1|||"
    "bootc-dev|other||https://github.com/cgwalters-forge/bootc/pull/13|x|"
    "osbuild|||https://github.com/cgwalters-forge/image-builder/pull/2|x|"
    "redhat-cop|other|https://github.com/redhat-cop/rhel-bootc-examples/issues/19|||"
    "cgwalters-forge|cgwalters-bot|https://github.com/cgwalters-forge/review/issues/1|||"
    "cgwalters-bot||https://github.com/cgwalters-bot/homegit/issues/3|||"
    "cgwalters-bot|other||https://github.com/cgwalters/cgwalters/pull/1|x|"
    "cgwalters-bot|bootc-dev|https://github.com/bootc-dev/cgwalters-devspace-sandbox/issues/4|||"
    "cgwalters-bot|||https://github.com/cgwalters-forge/cgwalters-devspace-sandbox/pull/3|x|"
    "bootc-dev|||https://github.com/bootc-dev/bootc/compare/main...cgwalters-bot:bot/x|x|"
    # Branch, where the work lands, beats the content URL.
    "=|bootc-dev|https://github.com/cgwalters-bot/praxis-credential-broker/issues/2|https://github.com/cgwalters-forge/bootc/pull/15||"
    "osbuild||||image-builder: fail loudly|"
    "redhat-cop||||rhel-bootc-examples: bump|"
    "cgwalters-bot||||Coordinator on demand|"
    # Body links, skipping non-repository paths and unknown repositories.
    "bootc-dev||||stabilize composefs|see https://github.com/users/cgwalters-bot and https://github.com/cgwalters-forge/gone, then https://github.com/bootc-dev/bootc/pull/2483"
    "=|cgwalters-bot|||Pivot: GitHub App identity|"
    "other||||Something unrelated|"
    "coreos||https://github.com/coreos/rpm-ostree/pull/5635|||"
    "=|other|https://github.com/example/unknown/issues/1|||"
    # A tracker issue's URL says nothing: its title, then its body links.
    "bootc-dev||https://github.com/cgwalters-forge/tracker/issues/5||bootc: composefs edit|"
    "osbuild|cgwalters-forge|https://github.com/cgwalters-forge/tracker/issues/6||Anything|see https://github.com/cgwalters-forge/image-builder/pull/2"
    "other||https://github.com/cgwalters-forge/tracker/issues/7||Something unrelated|"
)

items=()
for i in "${!CASES[@]}"; do
    IFS='|' read -r _ org url branch title body <<<"${CASES[i]}"
    items+=("$(jq -nc --arg id "PVTI_${i}" --arg org "${org}" --arg url "${url}" \
        --arg branch "${branch}" --arg title "${title:-item ${i}}" --arg body "${body}" '
        {id: $id, title: $title,
         content: (if $url == "" then {type: "DraftIssue", body: $body} else {type: "Issue", url: $url, body: $body} end)}
        + (if $org == "" then {} else {org: $org} end)
        + (if $branch == "" then {} else {branch: $branch} end)')")
done
printf '%s\n' "${items[@]}" | jq -s '{items: .}' >"${FAKE_GH}/items.json"

out=$("${BIN}/bot-board" fill-org --all 2>/dev/null)
for i in "${!CASES[@]}"; do
    IFS='|' read -r want org _ <<<"${CASES[i]}"
    got=$(awk -F'\t' -v id="PVTI_${i}" '$1 == id { print $2 }' <<<"${out}")
    if test "${want}" = = || test "${want}" = "${org}"; then
        test -z "${got}" || fail "case ${i} (${CASES[i]}): changed to '${got}'"
    else
        test "${got}" = "${want}" || fail "case ${i} (${CASES[i]}): got '${got:-no change}', want '${want}'"
        grep -qF "itemId: \"PVTI_${i}\", fieldId: \$field, value: {singleSelectOptionId: \"O_${want}\"}" \
            "${FAKE_GH}/mutations" || fail "case ${i}: no mutation setting O_${want}"
    fi
done
# Tracker issues whose Org changed get the matching label; nothing else.
for want in "POST labels" "POST issues/5/labels" "POST issues/6/labels" "POST issues/7/labels"; do
    grep -qxF "${want}" "${FAKE_GH}/labels" || fail "no '${want}' label call: $(cat "${FAKE_GH}/labels")"
done
test "$(grep -c '/labels$' "${FAKE_GH}/labels")" -eq 3 || fail "label calls for non-tracker items: $(cat "${FAKE_GH}/labels")"
echo "all ${#CASES[@]} fill-org cases passed, tracker labels synced"

# list --field NAME=VALUE: items 0 and 1 are led by wfc, 2 by coordinator,
# the rest by nobody.
jq '.items |= [to_entries[] | .value + (if .key < 2 then {lead: "wfc"} elif .key == 2 then {lead: "coordinator"} else {} end)]' \
    "${FAKE_GH}/items.json" >"${WORK}/led.json"
mv "${WORK}/led.json" "${FAKE_GH}/items.json"
# CASE|ARGS (space separated)|EXPECTED IDS, sorted
readonly LIST_CASES=(
    "led by wfc|--field Lead=wfc|PVTI_0 PVTI_1"
    "--field=NAME=VALUE form|--field=Lead=coordinator|PVTI_2"
    "lead unset|--field Lead=none|$(seq -f 'PVTI_%g' 3 $((${#CASES[@]} - 1)) | tr '\n' ' ' | sed 's/ $//')"
    "repeats all match|--field Lead=wfc --field Org=other|PVTI_1"
    "no match|--field Lead=nobody|"
)
for c in "${LIST_CASES[@]}"; do
    IFS='|' read -r name args want <<<"${c}"
    # shellcheck disable=SC2086 # the words are the arguments
    got=$("${BIN}/bot-board" --refresh list --json ${args} 2>"${WORK}/err" | jq -r '[.[].id] | sort | join(" ")') ||
        fail "list ${name}: $(cat "${WORK}/err")"
    want=$(tr ' ' '\n' <<<"${want}" | sort | tr '\n' ' ' | sed 's/ $//')
    test "${got}" = "${want}" || fail "list ${name}: got '${got}', want '${want}'"
done
"${BIN}/bot-board" list --field Nope=x >/dev/null 2>"${WORK}/err" && fail "list --field of an unknown field succeeded"
grep -q "no 'Nope' field" "${WORK}/err" || fail "unknown --field: $(cat "${WORK}/err")"
"${BIN}/bot-board" list --field Lead >/dev/null 2>"${WORK}/err" && fail "list --field without a value succeeded"
echo "list --field cases passed"

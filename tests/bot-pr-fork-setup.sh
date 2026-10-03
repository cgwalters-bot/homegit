#!/usr/bin/env bash
# Offline tests of what 'bot-pr fork-setup' does to a fork's workflows:
# by default every one is disabled and its active runs cancelled; --ci
# opts one in (recorded in the fork's BOT_PR_CI variable, so that later
# runs keep it), and --no-ci takes that back. A fake gh keeps the fork's
# workflows, variable and runs in a temporary directory, with the workflow
# files from tests/fixtures/workflows. No network.
#   tests/bot-pr-fork-setup.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_PR=${TESTS}/../bin/bot-pr
readonly FIXTURES=${TESTS}/fixtures/workflows
readonly FORK=cgwalters-forge/bootc
readonly VARIABLE=BOT_PR_CI

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-fork-setup-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh
export PATH=${WORK}/bin:${PATH}

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin"
# The fake gh, for the calls fork-setup makes. $FAKE_GH holds: workflows
# (ID STATE FILE per line, FILE in $FAKE_GH/files), variable (BOT_PR_CI's
# value, absent when unset), runs.json (the active runs; cancelled ones
# are removed) and calls (every call, one per line). Anything else fails.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter="" fields=()
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f|-F) fields+=("$2"); shift 2 ;;
        -H) shift 2 ;;
        --input) shift 2; cat >"${store}/input" ;;
        --jq) filter=$2; shift 2 ;;
        -*) shift ;;
        *) path=$1; shift ;;
    esac
done
names() { local f; for f in "${fields[@]}"; do test "${f%%=*}" != "names[]" || echo "${f#*=}"; done; }
field() { local f; for f in "${fields[@]}"; do test "${f%%=*}" != "$1" || { echo "${f#*=}"; return; }; done; }
notfound() { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
fork=cgwalters-forge/bootc
json=""
case "${method} ${path%%\?*}" in
    "GET user") json='{"login": "cgwalters-bot"}' ;;
    "GET repos/${fork}")
        json=$(jq -n --arg fork "$(test -e "${store}/nonfork" && echo false || echo true)" --rawfile t "${store}/topics" '{fork: ($fork == "true"), owner: {login: "cgwalters-forge"}, default_branch: "main", topics: ($t | split("\n") | map(select(. != "")))}') ;;
    "GET repos/${fork}/topics")
        json=$(jq -n --rawfile t "${store}/topics" '{names: ($t | split("\n") | map(select(. != "")))}') ;;
    "PUT repos/${fork}/topics") names >"${store}/topics" ;;
    "GET repos/${fork}/rulesets") json=$(cat "${store}/rulesets.json") ;;
    "POST repos/${fork}/rulesets")
        jq '.id = 77' "${store}/input" >"${store}/ruleset.json"
        jq -n --slurpfile r "${store}/ruleset.json" '$r' >"${store}/rulesets.json"
        json='{"id": 77}' ;;
    "PUT repos/${fork}/rulesets/77") cp "${store}/input" "${store}/ruleset.json"; echo put >>"${store}/ruleset-puts" ;;
    "DELETE repos/${fork}/rulesets/77") echo '[]' >"${store}/rulesets.json"; rm -f "${store}/ruleset.json" ;;
    "PUT repos/${fork}/actions/permissions") ;;
    "GET repos/${fork}/actions/variables/BOT_PR_CI")
        test -e "${store}/variable" || notfound
        json=$(jq -n --rawfile v "${store}/variable" '{name: "BOT_PR_CI", value: $v}') ;;
    "POST repos/${fork}/actions/variables")
        test "$(field name)" = BOT_PR_CI || { echo "fake gh: bad variable" 1>&2; exit 1; }
        ! test -e "${store}/variable" || { echo "gh: Conflict (HTTP 409)" 1>&2; exit 1; }
        printf '%s' "$(field value)" >"${store}/variable" ;;
    "PATCH repos/${fork}/actions/variables/BOT_PR_CI")
        test -e "${store}/variable" || notfound
        printf '%s' "$(field value)" >"${store}/variable" ;;
    "DELETE repos/${fork}/actions/variables/BOT_PR_CI")
        test -e "${store}/variable" || notfound
        rm "${store}/variable" ;;
    "GET repos/${fork}/actions/workflows")
        json=$(jq -Rn '{workflows: [inputs | split(" ") | {id: (.[0] | tonumber), state: .[1], path: ".github/workflows/\(.[2])"}]}' \
            <"${store}/workflows") ;;
    PUT\ repos/${fork}/actions/workflows/*/enable|PUT\ repos/${fork}/actions/workflows/*/disable)
        id=${path#"repos/${fork}/actions/workflows/"}
        action=${id#*/}
        id=${id%%/*}
        grep -q "^${id} " "${store}/workflows" || notfound
        state=disabled_manually
        test "${action}" = disable || state=active
        sed -i "s/^${id} [^ ]* /${id} ${state} /" "${store}/workflows" ;;
    "GET repos/${fork}/contents/.github/workflows/"*)
        file=${path%%\?*}
        file=${store}/files/${file#"repos/${fork}/contents/.github/workflows/"}
        test -e "${file}" || notfound
        cat "${file}"
        exit 0 ;;
    "GET repos/${fork}/actions/runs")
        status=${path#*status=}
        json=$(jq --arg s "${status%%&*}" '{workflow_runs: map(select(.status == $s))}' "${store}/runs.json") ;;
    POST\ repos/${fork}/actions/runs/*/cancel)
        id=${path#"repos/${fork}/actions/runs/"}
        id=${id%/cancel}
        jq -e --argjson id "${id}" 'any(.id == $id)' "${store}/runs.json" >/dev/null || notfound
        jq --argjson id "${id}" 'map(select(.id != $id))' "${store}/runs.json" >"${store}/runs.new"
        mv "${store}/runs.new" "${store}/runs.json" ;;
    *) echo "fake gh: unexpected ${method} ${path}" 1>&2; exit 1 ;;
esac
test -n "${json}" || exit 0
if test -n "${filter}"; then
    jq -r "${filter}" <<<"${json}"
else
    printf '%s\n' "${json}"
fi
EOF
chmod +x "${WORK}/bin/gh"

# A fork like bootc's after forking: its CI and PR bots, one of them
# disabled by GitHub, one never on the default branch (only listed
# because a PR ran it), and CI runs queued and in progress.
reset_fork() {
    rm -rf "${FAKE_GH}"
    mkdir -p "${FAKE_GH}/files"
    cp "${FIXTURES}/bcvk-main.yml" "${FAKE_GH}/files/ci.yml"
    cp "${FIXTURES}/bootc-auto-review.yml" "${FAKE_GH}/files/auto-review.yml"
    cp "${FIXTURES}/bootc-scheduled-release.yml" "${FAKE_GH}/files/scheduled-release.yml"
    cp "${FIXTURES}/infra-renovate.yml" "${FAKE_GH}/files/renovate.yml"
    cat >"${FAKE_GH}/workflows" <<'EOF'
11 active ci.yml
12 active auto-review.yml
13 disabled_fork scheduled-release.yml
14 active renovate.yml
15 active pr-only.yml
EOF
    cat >"${FAKE_GH}/runs.json" <<'EOF'
[{"id": 101, "workflow_id": 11, "event": "pull_request", "status": "queued", "name": "CI", "head_sha": "a", "head_branch": "bot/x", "created_at": "2026-01-01T00:00:00Z"},
 {"id": 102, "workflow_id": 11, "event": "pull_request", "status": "in_progress", "name": "CI", "head_sha": "b", "head_branch": "bot/y", "created_at": "2026-01-01T00:00:00Z"},
 {"id": 103, "workflow_id": 14, "event": "push", "status": "queued", "name": "Renovate", "head_sha": "c", "head_branch": "main", "created_at": "2026-01-01T00:00:00Z"}]
EOF
    : >"${FAKE_GH}/topics"
    echo '[]' >"${FAKE_GH}/rulesets.json"
    : >"${FAKE_GH}/calls"
}

# run NAME ARGS...: fork-setup with ARGS, its stderr in $WORK/NAME.err.
run() {
    local name=$1
    shift
    "${BOT_PR}" fork-setup "$@" 2>"${WORK}/${name}.err" || { fail "${name}: fork-setup failed: $(cat "${WORK}/${name}.err")"; return 1; }
}

# expect NAME STATES VARIABLE RUNS: the workflows' states ("ID:STATE ..."),
# the variable's value ("-" for unset) and the runs left ("ID ...").
expect() {
    local name=$1 states=$2 variable=$3 runs=$4 actual
    actual=$(awk '{printf "%s%s:%s", (NR > 1 ? " " : ""), $1, $2}' "${FAKE_GH}/workflows")
    test "${actual}" = "${states}" || fail "${name}: workflows are '${actual}', expected '${states}'"
    actual=-
    test ! -e "${FAKE_GH}/variable" || actual=$(cat "${FAKE_GH}/variable")
    test "${actual}" = "${variable}" || fail "${name}: ${VARIABLE} is '${actual}', expected '${variable}'"
    actual=$(jq -r 'map(.id) | join(" ")' "${FAKE_GH}/runs.json")
    test "${actual}" = "${runs}" || fail "${name}: runs left are '${actual}', expected '${runs}'"
}

# expect_err NAME REGEX: fork-setup's stderr matches REGEX.
expect_err() {
    grep -qE "$2" "${WORK}/$1.err" || fail "$1: no '$2' in: $(cat "${WORK}/$1.err")"
}

# The default: everything disabled, runs of what it disabled cancelled,
# and nothing fetched to classify.
reset_fork
if run default bootc; then
    expect default "11:disabled_manually 12:disabled_manually 13:disabled_fork 14:disabled_manually 15:disabled_manually" - ""
    expect_err default "^CI on ${FORK}: off; 4 workflow\(s\) disabled, 3 run\(s\) cancelled$"
    ! grep -q contents/ "${FAKE_GH}/calls" || fail "default: fetched workflow files: $(grep contents/ "${FAKE_GH}/calls")"
    grep -qx "api -X PUT repos/${FORK}/actions/permissions -F enabled=true -f allowed_actions=all" "${FAKE_GH}/calls" ||
        fail "default: Actions not kept enabled"
fi
# ... and idempotent: nothing to change the second time.
: >"${FAKE_GH}/calls"
if run again "${FORK}"; then
    expect again "11:disabled_manually 12:disabled_manually 13:disabled_fork 14:disabled_manually 15:disabled_manually" - ""
    expect_err again "^CI on ${FORK}: off$"
    ! grep -qE -- '-X (PUT|POST|PATCH|DELETE) .*/(workflows|variables|runs)' "${FAKE_GH}/calls" ||
        fail "again: changed something: $(grep -E -- '-X ' "${FAKE_GH}/calls")"
fi

# Opting in: the workflow is enabled from any disabled state, recorded,
# and its runs are left alone; the others are still disabled.
reset_fork
if run optin bootc --ci ci.yml --ci .github/workflows/scheduled-release.yml; then
    expect optin "11:active 12:disabled_manually 13:active 14:disabled_manually 15:disabled_manually" "ci.yml scheduled-release.yml" "101 102"
    expect_err optin "^Enabled on ${FORK}: scheduled-release.yml$"
    # The classifier only speaks up for workflows opted in.
    expect_err optin "scheduled-release.yml is opted in on ${FORK}, although it only runs on a schedule"
    ! grep -q "auto-review.yml is opted" "${WORK}/optin.err" || fail "optin: warned about auto-review.yml, which isn't opted in"
    expect_err optin "^CI on ${FORK}: only ci.yml scheduled-release.yml \(opted in;"
fi
# A later run without --ci (as every fork-pr does) keeps the opt-in,
# disabling only what someone enabled meanwhile.
sed -i 's/^12 [^ ]* /12 active /' "${FAKE_GH}/workflows"
if run keep bootc; then
    expect keep "11:active 12:disabled_manually 13:active 14:disabled_manually 15:disabled_manually" "ci.yml scheduled-release.yml" "101 102"
fi
# --ci adds to the list.
if run add bootc --ci renovate.yml; then
    expect add "11:active 12:disabled_manually 13:active 14:active 15:disabled_manually" "ci.yml renovate.yml scheduled-release.yml" "101 102"
    expect_err add "opted in on ${FORK} with schedule triggers, which also run: renovate.yml"
fi
# --no-ci --ci replaces it.
if run replace bootc --no-ci --ci auto-review.yml; then
    expect replace "11:disabled_manually 12:active 13:disabled_manually 14:disabled_manually 15:disabled_manually" auto-review.yml ""
    expect_err replace "auto-review.yml is opted in on ${FORK}, although it needs upstream's secrets \(APP_ID,APP_PRIVATE_KEY\)"
fi
# --no-ci alone turns CI off again and removes the variable.
if run off bootc --no-ci; then
    expect off "11:disabled_manually 12:disabled_manually 13:disabled_manually 14:disabled_manually 15:disabled_manually" - ""
    expect_err off "^Workflows opted in on ${FORK}: none$"
fi
# A workflow not listed yet (a PR will add it) is recorded, with a warning.
reset_fork
if run unlisted bootc --ci new.yml; then
    expect unlisted "11:disabled_manually 12:disabled_manually 13:disabled_fork 14:disabled_manually 15:disabled_manually" new.yml ""
    expect_err unlisted "new.yml is opted in on ${FORK} but GitHub lists no such workflow there"
fi

# Bad arguments fail before touching anything.
for args in "bootc --ci ../ci.yml" "bootc --ci" "bootc extra" "other-org/bootc" "bootc --bogus"; do
    reset_fork
    # shellcheck disable=SC2086 # split on purpose
    if "${BOT_PR}" fork-setup ${args} 2>/dev/null; then
        fail "fork-setup ${args}: succeeded"
    elif grep -qE -- '-X (PUT|POST|PATCH|DELETE)' "${FAKE_GH}/calls"; then
        fail "fork-setup ${args}: changed something before failing"
    fi
done

# The topic and the ruleset: NAME|TOPICS BEFORE|RULESET BEFORE|ARGS|TOPICS AFTER|RULESET AFTER
# (topics space-separated, "-" for none; the ruleset yes or no). No topic
# is a midstream; a real fork stays one unless fork-setup is run on it
# again with another kind; other topics are kept.
while IFS='|' read -r name before rs_before args after rs_after; do
    reset_fork
    test "${before}" = - || tr ' ' '\n' <<<"${before}" >"${FAKE_GH}/topics"
    test "${rs_before}" = no || echo '[{"id": 77, "name": "bot-midstream-no-merge"}]' >"${FAKE_GH}/rulesets.json"
    # shellcheck disable=SC2086 # split on purpose
    if ! run "${name}" bootc ${args}; then continue; fi
    actual=$(sort "${FAKE_GH}/topics" | paste -sd' ')
    test "${actual:-}" = "${after/#-/}" || fail "${name}: topics are '${actual}', expected '${after}'"
    actual=no
    ! jq -e 'length > 0' "${FAKE_GH}/rulesets.json" >/dev/null || actual=yes
    test "${actual}" = "${rs_after}" || fail "${name}: ruleset is ${actual}, expected ${rs_after}"
done <<'EOF'
untagged|-|no||bot-midstream|yes
other topics kept|rust cli|no||bot-midstream cli rust|yes
already midstream|bot-midstream|yes||bot-midstream|yes
a real fork stays one|bot-fork|no||bot-fork|no
--fork flips and unprotects|bot-midstream|yes|--fork|bot-fork|no
--fork on an untagged repo|-|no|--fork|bot-fork|no
no ruleset asked|-|no|--no-ruleset|bot-midstream|no
topic only|-|no|--topic-only|bot-midstream|no
EOF

# A repository that isn't a fork (one of the bot's own) is refused, untouched.
reset_fork
touch "${FAKE_GH}/nonfork"
if "${BOT_PR}" fork-setup bootc 2>"${WORK}/nonfork.err"; then
    fail "nonfork: fork-setup succeeded"
else
    expect_err nonfork "is not a fork"
    ! grep -qE -- '-X (PUT|POST|PATCH|DELETE)' "${FAKE_GH}/calls" || fail "nonfork: changed something"
fi

# The ruleset blocks merging: its required check is one nothing reports,
# on the default branch; and it is updated, not duplicated, the second time.
reset_fork
run ruleset bootc --no-ci >/dev/null
jq -e '.name == "bot-midstream-no-merge" and .enforcement == "active"
    and .conditions.ref_name.include == ["~DEFAULT_BRANCH"]
    and any(.rules[]; .type == "required_status_checks" and .parameters.required_status_checks[0].context == "bot-midstream-never-merge")' \
    "${FAKE_GH}/ruleset.json" >/dev/null || fail "ruleset: unexpected: $(cat "${FAKE_GH}/ruleset.json")"
run ruleset-again bootc
test "$(grep -c 'POST repos/.*/rulesets' "${FAKE_GH}/calls")" -eq 1 || fail "ruleset: added twice"
test -e "${FAKE_GH}/ruleset-puts" || fail "ruleset: not updated in place"
# --topic-only touches no workflow and no ruleset.
reset_fork
run topic-only bootc --topic-only
! grep -qE 'actions|rulesets' "${FAKE_GH}/calls" || fail "topic-only: $(grep -E 'actions|rulesets' "${FAKE_GH}/calls")"

# repo-kind: the topic decides; a fork with none is a midstream; a
# repository that isn't a fork is neither.
for kind_case in 'midstream|{"fork":true,"owner":{"login":"cgwalters-forge"}}' 'midstream|{"fork":true,"topics":["bot-midstream"]}' 'fork|{"fork":true,"topics":["bot-fork"]}' \
    'fork|{"fork":true,"topics":["bot-midstream","bot-fork"]}' 'midstream|{"fork":false,"topics":["bot-midstream"]}' 'none|{"fork":false}' \
    'none|{"fork":true,"owner":{"login":"cgwalters-bot"}}'; do
    mkdir -p "${WORK}/kind-bin"
    printf '#!/usr/bin/env bash\ncase "$*" in "api user") echo \x27{"login":"cgwalters-bot"}\x27 ;; "api repos/org/r") echo \x27%s\x27 ;; *) exit 1 ;; esac\n' "${kind_case#*|}" >"${WORK}/kind-bin/gh"
    chmod +x "${WORK}/kind-bin/gh"
    got=$(PATH=${WORK}/kind-bin:${PATH} "${BOT_PR}" repo-kind org/r 2>&1) || true
    test "${got}" = "${kind_case%%|*}" || fail "repo-kind ${kind_case#*|}: '${got}', expected ${kind_case%%|*}"
done

# The constants match lib/midstream.js, which bot-land and bot-reconcile use.
for pair in MIDSTREAM_TOPIC:bot-midstream FORK_TOPIC:bot-fork RULESET_NAME:bot-midstream-no-merge RULESET_CHECK:bot-midstream-never-merge; do
    grep -qx "readonly ${pair%%:*}=${pair#*:}" "${BOT_PR}" || fail "bot-pr lacks ${pair}"
    node -e 'const m = require(process.argv[1]); process.exit(Object.values(m).includes(process.argv[2]) ? 0 : 1)' \
        "${TESTS}/../lib/midstream.js" "${pair#*:}" || fail "lib/midstream.js lacks ${pair#*:}"
done

test "${failures}" -eq 0 || { echo "${failures} check(s) failed" 1>&2; exit 1; }
echo "ok: fork-setup disables all workflows by default and keeps only opted-in ones, and marks midstreams and forks with a topic and a ruleset"

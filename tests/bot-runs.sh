#!/usr/bin/env bash
# Offline tests of bot-runs, against a fake gh that serves the runs,
# artifacts, job logs and footer search of tests/fixtures/bot-runs: the
# recorded shapes of GitHub's REST answers, with summaries following
# docs/devspace-agent-runs.md. No network, no quota.
#   tests/bot-runs.sh [TEST...]
# jq programs hold literal $variables.
# shellcheck disable=SC2016
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_RUNS=${TESTS}/../bin/bot-runs
readonly FIXTURES=${TESTS}/fixtures/bot-runs
readonly RUNS_URL=https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

# expect_json ACTUAL EXPECTED [WHAT]
expect_json() {
    jq -ne --argjson a "$1" --argjson b "$2" '$a == $b' >/dev/null ||
        fail "${3:-JSON}: expected $(jq -c . <<<"$2"), got $(jq -c . <<<"$1")"
}

expect_eq() {
    test "$1" = "$2" || fail "${3:-value}: expected '$2', got '$1'"
}

# expect_lines OUTPUT PATTERN...: every (extended regex) PATTERN matches a
# line of OUTPUT.
expect_lines() {
    local out=$1 p
    shift
    for p in "$@"; do
        grep -qE -- "${p}" <<<"${out}" || fail "no line matching '${p}' in:
${out}"
    done
}

calls() { # calls PATTERN: how many gh calls matched PATTERN
    grep -cE -- "$1" "${FAKE_GH}/calls" 2>/dev/null || true
}

# The fake gh: 'gh api' for the calls bot-runs makes, answered from
# $FAKE_GH (a copy of the fixtures). Every call is appended to
# $FAKE_GH/calls. ETags are the hash of the body.
write_fake_gh() {
    cat >"$1/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter="" include=false inm="" fields=() input=""
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -i) include=true; shift ;;
        -H) [[ "$2" != If-None-Match:* ]] || inm=${2#If-None-Match: }; shift 2 ;;
        -f|-F) fields+=("$2"); shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        --input) input=$2; shift 2 ;;
        -*) echo "fake gh: unexpected option $1" 1>&2; exit 1 ;;
        *) path=$1; shift ;;
    esac
done
field() { local f; for f in "${fields[@]}"; do test "${f%%=*}" != "$1" || { printf '%s' "${f#*=}"; return; }; done; }
query() { # query NAME: the (decoded) query parameter NAME of path
    local q=${path#*\?}
    test "${q}" != "${path}" || return 0
    tr '&' '\n' <<<"${q}" | sed -n "s/^$1=//p" | sed 's/%3E/>/g; s/%3D/=/g' | head -n1
}
fail_http() { # fail_http CODE TEXT
    if ${include}; then printf 'HTTP/2.0 %s %s\r\n\r\n' "$1" "$2"; fi
    echo "gh: $2 (HTTP $1)" 1>&2
    exit 1
}
reply() { # reply JSON: with ETags and --jq, like gh
    local body=$1 etag
    etag="\"$(sha256sum <<<"${body}" | cut -c1-16)\""
    if ${include}; then
        if test "${inm}" = "${etag}"; then
            printf 'HTTP/2.0 304 Not Modified\r\nEtag: %s\r\n\r\n' "${etag}"
            echo "gh: HTTP 304" 1>&2
            exit 1
        fi
        printf 'HTTP/2.0 200 OK\r\nEtag: %s\r\n\r\n%s\n' "${etag}" "${body}"
    else
        jq -rc "${filter:-.}" <<<"${body}"
    fi
    exit 0
}
repo=${BOT_RUNS_REPO:-bootc-dev/cgwalters-devspace-sandbox}
runs=${store}/runs.json
# Every run is a dispatch of agent.yml from main at this commit, in a
# repository with id 1; $FAKE_GH/filter-NAME.jq, if any, is applied to the
# reply NAME (run, jobs, artifacts), to fake another one.
head_sha=$(printf 'a%.0s' $(seq 40))
filtered() { # filtered NAME: stdin through filter-NAME.jq
    if test -e "${store}/filter-$1.jq"; then jq -c -f "${store}/filter-$1.jq"; else cat; fi
}
# $FAKE_GH/rate-limited limits every call, rate-limited-search searches.
if test "${path}" = rate_limit; then
    echo "2026-09-25T12:00:00Z"
    exit 0
fi
if test -e "${store}/rate-limited" || { test -e "${store}/rate-limited-search" && test "${path}" = search/issues; }; then
    fail_http 403 "API rate limit exceeded for user ID 1"
fi
case "${method} ${path%%\?*}" in
    "GET repos/${repo}/actions/workflows/agent.yml/runs")
        per=$(query per_page) page=$(query page)
        reply "$(jq -c --arg st "$(query status)" --arg c "$(query created)" --argjson per "${per:-30}" --argjson page "${page:-1}" '
            .workflow_runs | map(select($st == "" or .status == $st or .conclusion == $st)
                | select($c == "" or .created_at >= ($c | ltrimstr(">="))))
            | {total_count: length, workflow_runs: .[($page - 1) * $per:$page * $per]}' "${runs}")"
        ;;
    "GET repos/${repo}/actions/runs/"*/artifacts)
        # $FAKE_GH/artifacts-fail: listing artifacts fails.
        test ! -e "${store}/artifacts-fail" || fail_http 502 "Bad Gateway"
        id=${path#repos/"${repo}"/actions/runs/}
        id=${id%%/*}
        # Artifacts are uploaded at the end of the run (its latest attempt).
        created=$(jq -r --argjson id "${id}" '.workflow_runs[] | select(.id == $id) | .updated_at' "${runs}")
        # Artifact ids are RUN * 10 + 1, 2, 3 in this order.
        reply "$(k=0; for a in agent-run agent-transcript safe-outputs; do
                k=$((k + 1)) n=$(( id * 10 + k ))
                if grep -qx "${id} ${a}" "${store}/expired.txt"; then
                    jq -nc --argjson n "${n}" --arg a "${a}" --arg c "${created}" '{id: $n, name: $a, expired: true, created_at: $c, expires_at: "2026-09-24T10:45:00Z"}'
                elif test -d "${store}/artifacts/${id}/${a}"; then
                    jq -nc --argjson n "${n}" --arg a "${a}" --arg c "${created}" '{id: $n, name: $a, expired: false, created_at: $c, expires_at: "2026-12-19T10:45:00Z"}'
                fi
            done | jq -sc --argjson id "${id}" --arg sha "${head_sha}" '{total_count: length,
                artifacts: map(. + {size_in_bytes: 1000, workflow_run: {id: $id, head_sha: $sha, repository_id: 1}})}' | filtered artifacts)"
        ;;
    "GET repos/${repo}/actions/runs/"*/jobs)
        id=${path#repos/"${repo}"/actions/runs/}
        id=${id%%/*}
        reply "$(jq -c --argjson id "${id}" --arg sha "${head_sha}" '.workflow_runs[] | select(.id == $id) | . as $r
            | {total_count: 3, jobs: ["Restrictions", "Agent", "Safe outputs"] | map({id: (if . == "Agent" then $id else $id * 10 + 7 end), name: ., run_id: $id, head_sha: $sha,
                status: $r.status, conclusion: $r.conclusion, started_at: $r.run_started_at, completed_at: $r.updated_at})}' "${runs}" | filtered jobs)"
        ;;
    "GET repos/${repo}/actions/runs/"*)
        id=${path#repos/"${repo}"/actions/runs/}
        body=$(jq -c --argjson id "${id}" --arg sha "${head_sha}" --arg repo "${repo}" '.workflow_runs[] | select(.id == $id)
            | {path: ".github/workflows/agent.yml", event: "workflow_dispatch", head_branch: "bot/agent-run-praxis", head_sha: $sha,
               repository: {id: 1, full_name: $repo}, head_repository: {id: 1, full_name: $repo}} + .' "${runs}" | filtered run)
        test -n "${body}" || fail_http 404 "Not Found"
        reply "${body}"
        ;;
    "GET repos/${repo}/actions/artifacts/"*/zip)
        n=${path#repos/"${repo}"/actions/artifacts/}
        n=${n%/zip}
        id=$((n / 10))
        case $((n % 10)) in 1) a=agent-run ;; 2) a=agent-transcript ;; *) a=safe-outputs ;; esac
        ! grep -qx "${id} ${a}" "${store}/expired.txt" || fail_http 410 "Artifact has expired"
        test -d "${store}/artifacts/${id}/${a}" || fail_http 404 "Not Found"
        cd "${store}/artifacts/${id}/${a}"
        zip -q -r -y - .
        ;;
    # The code that ran, as the checker: $FAKE_GH/checker-source is a tree.
    "GET repos/${repo}/tarball/${head_sha}")
        test -d "${store}/checker-source" || fail_http 404 "Not Found"
        tar -czf - -C "${store}" --transform "s,^checker-source,owner-repo-${head_sha:0:7}," checker-source
        ;;
    "GET repos/${repo}/actions/jobs/"*/logs)
        id=${path#repos/"${repo}"/actions/jobs/}
        f=${store}/job-logs/${id%/logs}.log
        test -e "${f}" || fail_http 404 "Not Found"
        cat "${f}"
        ;;
    "GET search/issues")
        q=$(field q)
        [[ "${q}" == *" in:body is:pr org:cgwalters-forge author:cgwalters-bot" ]] || { echo "fake gh: unexpected search: ${q}" 1>&2; exit 1; }
        f=${store}/search-${q%% *}.json
        test -e "${f}" && reply "$(cat "${f}")"
        reply '{"total_count": 0, "items": []}'
        ;;
    "POST repos/${repo}/actions/workflows/agent.yml/dispatches")
        cat "${input/#-//dev/stdin}" >"${store}/dispatch-body.json"
        # The answer before return_run_details: 204, no body.
        test -e "${store}/dispatch-204" && exit 0
        cat "${store}/dispatch-response.json"
        ;;
    "GET repos/${repo}/actions/workflows/"*) fail_http 404 "Not Found" ;;
    # A target repository: private-org's are private, gone's don't exist.
    "GET repos/"*/*)
        [[ "${path}" =~ ^repos/[^/]+/[^/]+$ ]] || { echo "fake gh: unexpected call: ${method} ${path}" 1>&2; exit 1; }
        case "${path}" in
            repos/private-org/*) reply '{"private": true, "visibility": "private"}' ;;
            repos/gone/*) fail_http 404 "Not Found" ;;
            *) reply '{"private": false, "visibility": "public"}' ;;
        esac
        ;;
    *) echo "fake gh: unexpected call: ${method} ${path}" 1>&2; exit 1 ;;
esac
EOF
    chmod +x "$1/gh"
    # The fake age: the "encrypted" file is the plain one.
    cat >"$1/age" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1 $2" = "--decrypt -i" && test "$4" = -o || { echo "fake age: unexpected: $*" 1>&2; exit 1; }
test -r "$3" || { echo "age: error: reading identity $3" 1>&2; exit 1; }
cp "$6" "$5"
EOF
    chmod +x "$1/age"
}

# The fake bot-board: logs its calls to $FAKE_GH/board-calls, lists
# $FAKE_GH/board.json and applies 'set' to it (an empty value removes
# the field). $FAKE_GH/board-fails makes every call fail.
write_fake_board() {
    cat >"$1/bot-board" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
board=${store}/board.json
echo "$*" >>"${store}/board-calls"
test ! -e "${store}/board-fails" || { echo "fake bot-board: failing" 1>&2; exit 1; }
test "$1" != --refresh || shift
case "$1" in
    field-ensure) ;;
    list) cat "${board}" ;;
    set)
        item=$2
        shift 2
        while test $# -gt 0; do
            case "$1" in
                --field) key=${2,,} value=$3; shift 3 ;;
                *) key=${1#--} value=$2; shift 2 ;;
            esac
            jq --arg i "${item}" --arg k "${key}" --arg v "${value}" \
                'map(if .id == $i then (if $v == "" then del(.[$k]) else .[$k] = $v end) else . end)' "${board}" >"${board}.new"
            mv "${board}.new" "${board}"
        done
        ;;
    *) echo "fake bot-board: unexpected: $*" 1>&2; exit 1 ;;
esac
EOF
    chmod +x "$1/bot-board"
}

# make_transcript RUN NAME [DIR]: packs the fixture transcript (or DIR)
# as RUN's transcript artifact file NAME.
make_transcript() {
    local dir=${3:-${FIXTURES}/transcripts/1001}
    mkdir -p "${FAKE_GH}/artifacts/$1/agent-transcript"
    tar --zstd -cf "${FAKE_GH}/artifacts/$1/agent-transcript/$2" -C "${dir}" .
}

# --- list --------------------------------------------------------------------

test_list_table() {
    local out
    out=$("${BOT_RUNS}" list)
    expect_lines "${out}" \
        '^RUN +ITEM +REPO +AGENT +RESULT +DURATION +TOKENS +AIC +OUTCOME$' \
        '^1005 +PVTI_item1 +composefs/composefs-rs +- +in_progress +- +- +- +in_progress$' \
        '^1004 +PVTI_item3 +containers/composefs +- +failure\? +30m +- +- +-$' \
        '^1003 +PVTI_item2 +bootc-dev/bootc +claude/claude-sonnet-4-5 +success\* +10m +300k/10k +30 +Draft https://github.com/cgwalters-forge/bootc/pull/3$' \
        '^1002 +PVTI_item1 +composefs/composefs-rs +opencode/gpt-5-codex +failure +30m +2M/60k +200 +Needs human$' \
        '^1001 +PVTI_item1 +composefs/composefs-rs +claude/claude-sonnet-4-5 +success +42m +1.2M/40k +124 +Draft https://github.com/cgwalters-forge/composefs-rs/pull/7$' \
        '^\* from the PR footer' '^\? no summary'
    # Footers by someone else, or outside the bot-meta section the agent
    # can't write, are not read.
    ! grep -qE 'PVTI_(forged|spoofed)' <<<"${out}" || fail "read a footer from outside the bot's bot-meta"
}

test_list_json() {
    local out
    out=$("${BOT_RUNS}" list --json)
    expect_json "$(jq -c 'map([.run_id, .source, .result, .duration_s])' <<<"${out}")" \
        '[[1005,"pending",null,null],[1004,"none","failure",1800],[1003,"footer","success",600],[1002,"artifact","failure",1800],[1001,"artifact","success",2520]]' \
        "list --json"
    expect_json "$(jq -c '.[4] | {item, repo, base, workflow, agent, model, cores, turns, tokens, aic, aic_budget, aic_pricing, outcome: .outcome.status}' <<<"${out}")" \
        '{"item":"PVTI_item1","repo":"composefs/composefs-rs","base":"main","workflow":"branch","agent":"claude","model":"claude-sonnet-4-5","cores":16,"turns":37,"tokens":{"input":1200000,"output":40000,"cache_read":900000,"cache_write":50000},"aic":123.5,"aic_budget":500,"aic_pricing":"mock","outcome":"Draft"}' \
        "list --json of run 1001"
    # Only the contract's files are kept.
    test -e "${XDG_STATE_HOME}/bot-runs/runs/1001/1/outcome.json" || fail "outcome.json not kept"
    test ! -e "${XDG_STATE_HOME}/bot-runs/runs/1001/1/extra.txt" || fail "kept a file the contract doesn't name"
}

test_list_cache() {
    local first
    first=$("${BOT_RUNS}" list --json)
    expect_eq "$(calls '/zip$')" 2 "artifact downloads of the first list"
    expect_eq "$(calls '^api -X GET search/issues')" 2 "footer searches of the first list"
    : >"${FAKE_GH}/calls"
    expect_json "$("${BOT_RUNS}" list --json)" "${first}" "a list answered from the caches"
    expect_eq "$(calls '/zip$')" 0 "artifact downloads of the second list"
    expect_eq "$(calls 'search/issues')" 0 "footer searches of the second list"
    expect_eq "$(calls '/artifacts')" 0 "artifact listings of the second list"
    expect_eq "$(calls 'workflows/agent.yml/runs.* -H If-None-Match: ')" 1 "conditional run listings"
    # A run with nothing found is looked up again a day later.
    touch -d '2 days ago' "${XDG_STATE_HOME}/bot-runs/runs/1004/1/none"
    "${BOT_RUNS}" list >/dev/null
    expect_eq "$(calls 'search/issues.*q=1004 ')" 1 "footer searches for 1004 after a day"
}

test_list_filters() {
    local out
    out=$("${BOT_RUNS}" list --item PVTI_item1 --json)
    expect_json "$(jq -c 'map(.run_id)' <<<"${out}")" '[1005,1002,1001]' "list --item"
    # Other items' runs are not even read.
    expect_eq "$(calls 'runs/100[34]/artifacts')" 0 "artifact listings of other items"
    out=$("${BOT_RUNS}" list --status in_progress --json)
    expect_json "$(jq -c 'map(.run_id)' <<<"${out}")" '[1005]' "list --status"
    out=$("${BOT_RUNS}" list --since 2026-09-21T00:00:00Z --json)
    expect_json "$(jq -c 'map(.run_id)' <<<"${out}")" '[1005,1004,1003]' "list --since"
    # --item reads on until it has LIMIT of that item's runs.
    out=$("${BOT_RUNS}" list --item PVTI_item2 --limit 1 --json)
    expect_json "$(jq -c 'map(.run_id)' <<<"${out}")" '[1003]' "list --item --limit"
    out=$("${BOT_RUNS}" list --item PVTI_item1 --limit 2 --json)
    expect_json "$(jq -c 'map(.run_id)' <<<"${out}")" '[1005,1002]' "list --item --limit 2"
    out=$("${BOT_RUNS}" list --limit 2 --json)
    expect_json "$(jq -c 'map(.run_id)' <<<"${out}")" '[1005,1004]' "list --limit"
    # Paging: 100 per page, a limit over it reads on.
    out=$("${BOT_RUNS}" list --limit 150 --json)
    expect_eq "$(jq length <<<"${out}")" 5 "list --limit 150"
}

test_workflow_missing() {
    local out
    out=$(BOT_RUNS_WORKFLOW=nope.yml "${BOT_RUNS}" list 2>&1) && fail "listed a missing workflow"
    expect_lines "${out}" 'workflow nope.yml not found in bootc-dev/cgwalters-devspace-sandbox'
    local cmd
    for cmd in show log diff; do
        out=$("${BOT_RUNS}" "${cmd}" 1001 9999 2>&1) && fail "${cmd} of a missing run succeeded"
        expect_lines "${out}" '^error: (run 9999 not found in bootc-dev/cgwalters-devspace-sandbox|.* takes one RUN)$'
    done
    out=$("${BOT_RUNS}" show 9999 2>&1) && fail "showed a missing run"
    expect_lines "${out}" '^error: run 9999 not found in bootc-dev/cgwalters-devspace-sandbox$'
}

test_schema_mismatch() {
    jq '.schema = "agent-run-summary/v2"' "${FIXTURES}/artifacts/1002/agent-run/summary.json" \
        >"${FAKE_GH}/artifacts/1002/agent-run/summary.json"
    local out
    out=$("${BOT_RUNS}" show 1002 --json 2>"${WORK}/err")
    grep -q 'run 1002: summary.json is not agent-run-summary/v1 (schema: agent-run-summary/v2); ignoring it' "${WORK}/err" ||
        fail "no warning about the schema: $(cat "${WORK}/err")"
    expect_json "$(jq -c '[.source, .summary, .flat.result]' <<<"${out}")" '["artifact",null,"success"]' "a v2 summary"
    # The rest of the artifact is still used.
    "${BOT_RUNS}" log 1002 | grep -q 'timeout, 1200s' || fail "lost the condensed log of a v2 run"
}

test_bad_types() {
    jq '.tokens = "x" | .tests = [{"exit_code": 1}] | .tools.Bash.calls = "many"' \
        "${FIXTURES}/artifacts/1002/agent-run/summary.json" >"${FAKE_GH}/artifacts/1002/agent-run/summary.json"
    local out
    out=$("${BOT_RUNS}" list --json 2>"${WORK}/err")
    grep -q 'run 1002: ignoring fields of the wrong type in its summary: tokens, tools, tests' "${WORK}/err" ||
        fail "no warning about the bad fields: $(cat "${WORK}/err")"
    expect_json "$(jq -c '.[] | select(.run_id == 1002) | [.result, .tokens, .aic]' <<<"${out}")" '["failure",null,200]' "a summary with bad fields"
    "${BOT_RUNS}" stats --since 2026-09-01 >/dev/null 2>&1 || fail "stats failed on a summary with bad fields"
    "${BOT_RUNS}" diff 1001 1002 >/dev/null 2>&1 || fail "diff failed on a summary with bad fields"
}

test_linked_summary() {
    # A link in the artifact is never followed.
    rm "${FAKE_GH}/artifacts/1002/agent-run/summary.json"
    ln -s ../../1001/agent-run/summary.json "${FAKE_GH}/artifacts/1002/agent-run/summary.json"
    local out
    out=$("${BOT_RUNS}" show 1002 --json)
    expect_json "$(jq -c '[.source, .summary]' <<<"${out}")" '["artifact",null]' "a linked summary.json"
}

test_rerun() {
    "${BOT_RUNS}" show 1001 >/dev/null
    # A rerun in progress: attempt 1's summary no longer applies.
    jq '(.workflow_runs[] | select(.id == 1001)) |= (.run_attempt = 2 | .status = "in_progress" | .conclusion = null
        | .run_started_at = "2026-09-24T09:00:00Z" | .updated_at = "2026-09-24T09:05:00Z")' \
        "${FIXTURES}/runs.json" >"${FAKE_GH}/runs.json"
    local out
    out=$("${BOT_RUNS}" show 1001 --json)
    expect_json "$(jq -c '[.run.attempt, .source, .summary]' <<<"${out}")" '[2,"pending",null]' "a rerun in progress"
    # Finished, with its own artifact.
    jq '(.workflow_runs[] | select(.id == 1001)) |= (.status = "completed" | .conclusion = "failure" | .updated_at = "2026-09-24T09:40:00Z")' \
        "${FAKE_GH}/runs.json" >"${WORK}/runs.json"
    mv "${WORK}/runs.json" "${FAKE_GH}/runs.json"
    jq '.run_attempt = 2 | .result = "timeout"' "${FIXTURES}/artifacts/1001/agent-run/summary.json" \
        >"${FAKE_GH}/artifacts/1001/agent-run/summary.json"
    out=$("${BOT_RUNS}" show 1001 --json)
    expect_json "$(jq -c '[.run.attempt, .source, .summary.result]' <<<"${out}")" '[2,"artifact","timeout"]' "a finished rerun"
    test -e "${XDG_STATE_HOME}/bot-runs/runs/1001/1/artifact" || fail "attempt 1's files are gone"
}

test_rate_limited() {
    local rc=0
    touch "${FAKE_GH}/rate-limited"
    "${BOT_RUNS}" list >/dev/null 2>"${WORK}/err" || rc=$?
    expect_eq "${rc}" 75 "exit status of a rate-limited list"
    grep -q 'GitHub is rate limiting the bot' "${WORK}/err" || fail "no rate limit message: $(cat "${WORK}/err")"
    rc=0
    "${BOT_RUNS}" show 1001 >/dev/null 2>&1 || rc=$?
    expect_eq "${rc}" 75 "exit status of a rate-limited show"
    # Only the footer search limited: the list goes on without footers,
    # and a later list finds them.
    rm "${FAKE_GH}/rate-limited"
    touch "${FAKE_GH}/rate-limited-search"
    local out
    out=$("${BOT_RUNS}" list --json 2>"${WORK}/err")
    grep -q 'the footer search is rate limited' "${WORK}/err" || fail "no footer search warning: $(cat "${WORK}/err")"
    expect_eq "$(calls 'search/issues')" 1 "footer searches once rate limited"
    expect_json "$(jq -c 'map(.source)' <<<"${out}")" '["pending","none","none","artifact","artifact"]' "sources while search is limited"
    rm "${FAKE_GH}/rate-limited-search"
    out=$("${BOT_RUNS}" list --json)
    expect_json "$(jq -c 'map(.source)' <<<"${out}")" '["pending","none","footer","artifact","artifact"]' "sources after the limit"
}

# --- show, log, transcript ---------------------------------------------------

test_show() {
    local out
    out=$("${BOT_RUNS}" show https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1001)
    expect_lines "${out}" \
        '^Run 1001: https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1001$' \
        '^Item: +PVTI_item1$' \
        '^Repo: +composefs/composefs-rs \(base main\), workflow branch$' \
        '^Agent: +claude/claude-sonnet-4-5, 16 cores$' \
        '^Result: +success, 42m, 37 turns$' \
        '^Tokens: +1.2M/40k in/out, 900k cache read$' \
        '^AIC: +124 of 500 \(mock\)$' \
        '^Summary: +artifact$' \
        '^## Agent run: PVTI_item1 on composefs/composefs-rs \(main\)$'
    # Without summary.md, the essentials of summary.json.
    out=$("${BOT_RUNS}" show 1002)
    expect_lines "${out}" '^Tools: Bash 20 \(3 errors\), Edit 5, Grep 4$' \
        '^Failure: timeout: cargo test exceeded 20m$' '^Test: cargo test -p composefs: exit 101, 20m$'
    out=$("${BOT_RUNS}" show 1003)
    expect_lines "${out}" '^Summary: +footer \(from the PR footer; partial\)$' '^Result: +success, 10m, 10 turns$' '^Tokens: +300k/10k in/out$' \
        '^Outcome: +Draft https://github.com/cgwalters-forge/bootc/pull/3$'
    out=$("${BOT_RUNS}" show 1004)
    expect_lines "${out}" '^Summary: +none \(no summary: artifact expired, no footer\)$' '^Result: +failure, 30m$' \
        '^Item: +PVTI_item3$'
    out=$("${BOT_RUNS}" show 1005)
    expect_lines "${out}" '^Status: +in_progress, created' '^Summary: +pending$'
}

test_show_json() {
    local out
    out=$("${BOT_RUNS}" show 1001 --json)
    expect_json "$(jq -c '[.run.id, .source, .summary.schema, .flat.aic, (.step_summary | startswith("## Agent run"))]' <<<"${out}")" \
        '[1001,"artifact","agent-run-summary/v1",123.5,true]' "show --json"
    out=$("${BOT_RUNS}" show 1003 --json)
    expect_json "$(jq -c '[.source, .summary.item, .step_summary]' <<<"${out}")" '["footer","PVTI_item2",null]' "show --json of a footer run"
}

test_log() {
    local out
    out=$("${BOT_RUNS}" log 1001)
    expect_eq "${out}" "$(cat "${FIXTURES}/artifacts/1001/agent-run/condensed.log")" "log from the artifact"
    out=$("${BOT_RUNS}" log 1001 --json)
    expect_json "$(jq -c '[.source, (.lines | length), .lines[1]]' <<<"${out}")" '["artifact",6,"▶ Read: src/fsck.rs"]' "log --json"
    # Expired: from the job log's group, then kept.
    out=$("${BOT_RUNS}" log 1004 --json)
    expect_json "${out}" '{"run_id":1004,"source":"job-log","lines":["turn 1, 10k in / 1k out","⚠ agent exited 1"]}' "log from the job log"
    : >"${FAKE_GH}/calls"
    "${BOT_RUNS}" log 1004 >/dev/null
    expect_eq "$(calls 'jobs')" 0 "job log reads for a kept log"
    # Neither left.
    out=$("${BOT_RUNS}" log 1003 2>&1) && fail "printed a log for run 1003"
    expect_lines "${out}" 'no condensed log for run 1003'
}

test_transcript() {
    local out dir
    make_transcript 1001 transcript.tar.zst
    out=$("${BOT_RUNS}" transcript 1001)
    dir=${XDG_CACHE_HOME}/bot-runs/transcripts/1001-1
    expect_lines "${out}" "^Transcript of run 1001 in ${dir}:$" '^  raw.jsonl$' '^  sessions/main.jsonl$' '^  token-usage.jsonl$'
    cmp -s "${dir}/raw.jsonl" "${FIXTURES}/transcripts/1001/raw.jsonl" || fail "raw.jsonl differs"
    expect_eq "$(stat -c %a "${dir}")" 700 "transcript directory mode"
    # Unpacked once.
    : >"${FAKE_GH}/calls"
    out=$("${BOT_RUNS}" transcript 1001 --json)
    expect_json "${out}" "$(jq -nc --arg d "${dir}" '{run_id: 1001, dir: $d, files: ["raw.jsonl", "sessions/main.jsonl", "token-usage.jsonl"]}')" "transcript --json"
    expect_eq "$(calls "artifacts")" 0 "artifact calls for an unpacked transcript"
    "${BOT_RUNS}" transcript 1001 --force --dir "${WORK}/t" >/dev/null
    test -e "${WORK}/t/sessions/main.jsonl" || fail "--dir not used"
    # Refreshed in place.
    "${BOT_RUNS}" transcript 1001 --force --dir "${WORK}/t/" >/dev/null
    # A directory holding something else is never replaced.
    mkdir "${WORK}/mine"
    echo precious >"${WORK}/mine/notes"
    out=$("${BOT_RUNS}" transcript 1001 --dir "${WORK}/mine" 2>&1) && fail "unpacked over an unrelated directory"
    expect_lines "${out}" "${WORK}/mine exists and doesn't hold an unpacked transcript"
    test -e "${WORK}/mine/notes" || fail "an unrelated directory was touched"
}

test_transcript_encrypted() {
    local out
    make_transcript 1002 transcript.tar.zst.age
    out=$("${BOT_RUNS}" transcript 1002 2>&1) && fail "unpacked an encrypted transcript without an identity"
    expect_lines "${out}" 'the transcript is encrypted; set BOT_RUNS_AGE_IDENTITY'
    echo "AGE-SECRET-KEY-FAKE" >"${WORK}/identity"
    BOT_RUNS_AGE_IDENTITY=${WORK}/identity "${BOT_RUNS}" transcript 1002 >/dev/null
    test -e "${XDG_CACHE_HOME}/bot-runs/transcripts/1002-1/token-usage.jsonl" || fail "encrypted transcript not unpacked"
}

test_transcript_missing() {
    local out
    out=$("${BOT_RUNS}" transcript 1003 2>&1) && fail "got an expired transcript"
    expect_lines "${out}" 'the transcript of run 1003 expired on 2026-09-24T10:45:00Z \(transcripts are kept 30 days\)' \
        "'bot-runs show 1003' has what's left"
    out=$("${BOT_RUNS}" transcript 1004 2>&1) && fail "got a transcript that was never uploaded"
    expect_lines "${out}" 'run 1004 has no agent-transcript artifact'
}

test_transcript_link() {
    local kind out
    for kind in symlink hardlink; do
        rm -rf "${WORK}/evil"
        mkdir -p "${WORK}/evil"
        echo x >"${WORK}/evil/raw.jsonl"
        if test "${kind}" = symlink; then
            ln -s /etc/passwd "${WORK}/evil/passwd"
        else
            ln "${WORK}/evil/raw.jsonl" "${WORK}/evil/again.jsonl"
        fi
        make_transcript 1001 transcript.tar.zst "${WORK}/evil"
        out=$("${BOT_RUNS}" transcript 1001 2>&1) && fail "unpacked a transcript with a ${kind}"
        expect_lines "${out}" 'holds entries other than files and directories'
    done
    test -z "$(ls -A "${XDG_CACHE_HOME}/bot-runs/transcripts" 2>/dev/null)" || fail "unpacked something"
}

# --- apply -------------------------------------------------------------------

# bot-runs apply checks a run's outputs with the safe-outputs code of the
# run's own commit (gh-aw's validation, vendored in the devspace repository;
# its tests are there). These tests use a stand-in for it that logs its
# calls and refuses on demand ($CHECKER/safe-outputs/mode: COMMAND-fail),
# and so check bot-runs' side: the run's provenance, the artifact, the
# contract with the checker, and the clone. With BOT_RUNS_REAL_CHECKER set
# to a checkout of the devspace repository, test_apply_real_checker runs
# the real one too.

# make_checker DIR: the stand-in, laid out like the repository (DIR holds
# safe-outputs/safe-outputs.mjs).
make_checker() {
    mkdir -p "$1/safe-outputs"
    cat >"$1/safe-outputs/safe-outputs.mjs" <<'EOF'
// The stand-in runs under node's permission model like the real checker:
// no process, no writes outside the scratch directory (so it logs its calls
// to stderr, "stub-call: JSON"), and it reads zips itself.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
const here = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
const flag = (name) => args[args.indexOf(`--${name}`) + 1];
const mode = existsSync(join(here, "mode")) ? readFileSync(join(here, "mode"), "utf8").trim() : "";
console.error(`stub-call: ${JSON.stringify([command, ...args])}`);
const refuse = (what) => { console.error(`stub: ${what} refused`); process.exit(1); };
if (command === "compile") {
  if (mode === "compile-fail") refuse("compile");
  writeFileSync(flag("out"), "{}\n");
} else if (command === "unpack") {
  if (mode === "unpack-fail") refuse("unpack");
  const zip = readFileSync(flag("zip"));
  let eocd = zip.length - 22;
  while (zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let at = zip.readUInt32LE(eocd + 16);
  mkdirSync(flag("dir"));
  for (let i = zip.readUInt16LE(eocd + 10); i > 0; i--) {
    const [method, compressed] = [zip.readUInt16LE(at + 10), zip.readUInt32LE(at + 20)];
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    writeFileSync(join(flag("dir"), name), method === 8 ? inflateRawSync(data) : data);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
} else if (command === "check") {
  const dir = flag("dir");
  const file = join(dir, "outputs.jsonl");
  const items = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const patch = readdirSync(dir).find((n) => n.startsWith("aw-"));
  const ok = mode !== "check-fail";
  writeFileSync(flag("json"), JSON.stringify({ ok, errors: ok ? [] : ["stub refusal"], items, patch: patch ? { file: patch } : null }));
  process.exit(ok ? 0 : 1);
} else if (command === "post-apply") {
  if (mode === "post-apply-fail") { console.error("  src/lib.rs: stub says no"); process.exit(1); }
  // The staged change, as git's view of it.
  if (!readFileSync(flag("raw"), "utf8").includes("src/lib.rs")) refuse("post-apply (an unexpected change)");
}
EOF
}

# make_change RUN [EDIT]: a target repository in $WORK/target (made once,
# with a commit on a side branch too) and RUN's safe-outputs artifact: the
# patch the shell code EDIT (default: editing src/lib.rs) makes in it, as
# the agent step makes it (one format-patch commit against the base, with
# gh-aw's X-GH-AW-Base-Commit header), a create_pull_request for it and
# base.json. Prints the base commit.
make_change() {
    local target=${WORK}/target out=${FAKE_GH}/artifacts/$1/safe-outputs commit
    if ! test -d "${target}"; then
        git init -q -b main "${target}"
        mkdir -p "${target}/src"
        echo 'pub fn f() {}' >"${target}/src/lib.rs"
        git -C "${target}" add -A
        git -C "${target}" -c user.name=t -c user.email=t@example.com commit -q -m init
        git -C "${target}" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m side
        git -C "${target}" branch -q side
        git -C "${target}" reset -q --hard HEAD^
    fi
    commit=$(git -C "${target}" rev-parse HEAD)
    (cd "${target}" && eval "${2:-echo 'pub fn g() {}' >>src/lib.rs}" && git add -A &&
        git -c user.name=agent -c user.email=agent@localhost commit -q -m "Check the superblock first" &&
        git format-patch --stdout --no-renames --no-signature -1 HEAD | sed "1a X-GH-AW-Base-Commit: ${commit}") >"${WORK}/change.patch"
    git -C "${target}" reset -q --hard "${commit}"
    git -C "${target}" clean -q -fdx
    rm -rf "${out}"
    mkdir -p "${out}"
    cp "${WORK}/change.patch" "${out}/aw-agent-run-$1.patch"
    jq -nc --arg b "agent-run-$1" '{type: "create_pull_request", title: "fsck: Check the superblock first", body: "A truncated image failed late.", branch: $b}' >"${out}/outputs.jsonl"
    jq -nc --arg c "${commit}" '{repo: "composefs/composefs-rs", ref: "main", commit: $c}' >"${out}/base.json"
    printf 'fsck: Check the superblock first\n\nA truncated image failed late.\n' >"${WORK}/message"
    echo "${commit}"
}

# set_json FILE FILTER: FILE through jq FILTER.
set_json() {
    jq -c "$2" "$1" >"$1.new" && mv "$1.new" "$1"
}

# use_stub_checker: apply uses the stand-in in $WORK/checker (as every test
# does from the start; for after a test has used another).
use_stub_checker() {
    export BOT_RUNS_SAFE_OUTPUTS_DIR=${WORK}/checker
}

# apply_logged RUN [ARGS...]: apply_run, with the stand-in's calls
# (stub-call lines of stderr) in $WORK/calls; its output is stdout's.
apply_logged() {
    local rc=0
    apply_run "$@" 2>"${WORK}/stderr" || rc=$?
    grep '^stub-call: ' "${WORK}/stderr" | sed 's/^stub-call: //' >"${WORK}/calls" || true
    return "${rc}"
}

checker_calls() { # checker_calls: the commands the stand-in ran, one per line
    jq -r '.[0]' "${WORK}/calls"
}

apply_run() { # apply_run RUN [ARGS...]: bot-runs apply of RUN to the fake target
    local run=$1
    shift
    "${BOT_RUNS}" apply "${run}" --repo composefs/composefs-rs --slug fsck-sb --message "${WORK}/message" \
        --source "${WORK}/target" "$@"
}

test_apply() {
    local commit out dir bot
    bot=$("${TESTS}/../bin/bot-operator" --json | jq -r '"\(.bot.git_name) <\(.bot.git_email)>"')
    use_stub_checker
    commit=$(make_change 1001)
    # No hook of the caller's runs.
    mkdir -p "${WORK}/hooks"
    for h in post-checkout pre-commit commit-msg post-commit; do
        printf '#!/bin/sh\ntouch %s/hook-ran\n' "${WORK}" >"${WORK}/hooks/${h}"
        chmod +x "${WORK}/hooks/${h}"
    done
    git config --global core.hooksPath "${WORK}/hooks"
    out=$(apply_logged 1001 --base main --json)
    dir=${XDG_CACHE_HOME}/bot-work/fsck-sb/composefs-rs
    expect_json "$(jq -c 'del(.head)' <<<"${out}")" "$(jq -nc --arg c "${commit}" --arg d "${dir}" '{run_id: 1001,
        run_url: "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1001/attempts/1",
        workflow_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repo: "composefs/composefs-rs", base: "main", base_commit: $c, branch: "bot/fsck-sb", dir: $d,
        item: "PVTI_item1", files: ["src/lib.rs"],
        pull_request: {title: "fsck: Check the superblock first", body: "A truncated image failed late."}, outputs: []}')" "apply --json"
    test ! -e "${WORK}/hook-ran" || fail "apply ran a hook"
    test -f "${dir}/.git" || fail "apply did not create a linked worktree"
    expect_eq "$(git -C "${WORK}/target" branch --show-current)" main "source branch unchanged"
    test -z "$(git -C "${WORK}/target" config --get remote.origin.pushurl || true)" || fail "changed source push URL"
    # The checker ran, in order, on the policy for this repository and base,
    # with the allowlist's maximum (post-apply's stderr is what apply shows on
    # a refusal, so it doesn't reach the log; test_apply_refused has its
    # refusal).
    expect_eq "$(checker_calls | tr '\n' ' ')" "compile unpack check " "checker commands"
    expect_json "$(jq -c 'select(.[0] == "compile") | .[1:] | . as $a | [range(0; length; 2)] | map({($a[.]): $a[. + 1]}) | add | del(.["--out"])' "${WORK}/calls")" \
        '{"--repo": "composefs/composefs-rs", "--base": "main", "--workflow": "branch", "--outputs": "all", "--max-outputs": "max"}' "compile arguments"
    expect_eq "$(git -C "${dir}" rev-parse HEAD^)" "${commit}" "parent"
    expect_eq "$(git -C "${dir}" rev-parse --abbrev-ref HEAD)" bot/fsck-sb "branch"
    expect_eq "$(git -C "${dir}" log -1 --format='%an <%ae>|%cn <%ce>')" "${bot}|${bot}" "identity"
    expect_eq "$(git -C "${dir}" log -1 --format='%s')" "fsck: Check the superblock first" "subject is the message file's"
    expect_eq "$(git -C "${dir}" log -1 --format='%(trailers:key=Generated-by,valueonly)' | head -n1)" AI "AI trailer"
    expect_eq "$(git -C "${dir}" log -1 --format='%(trailers:key=Agent-run,valueonly)' | head -n1)" \
        https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1001/attempts/1 "run trailer"
    expect_eq "$(git -C "${dir}" show HEAD:src/lib.rs | tail -n1)" 'pub fn g() {}' "applied content"
    test -z "$(git -C "${dir}" status --porcelain)" || fail "apply left changes uncommitted"
    # Its origin can't be pushed to, by accident or otherwise.
    git -C "${dir}" -c core.hooksPath=/dev/null push -q origin HEAD 2>/dev/null && fail "pushed to origin"
    # Never over an existing directory.
    out=$(apply_run 1001 2>&1) && fail "applied over an existing directory"
    expect_lines "${out}" "already exists"
}

# The outputs a run hands back that are not a pull request are only listed.
test_apply_other_outputs() {
    use_stub_checker
    make_change 1001 >/dev/null
    printf '%s\n' '{"type":"noop","message":"Nothing else to do."}' >>"${FAKE_GH}/artifacts/1001/safe-outputs/outputs.jsonl"
    local out
    out=$(apply_run 1001 --json)
    expect_json "$(jq -c .outputs <<<"${out}")" '[{"type": "noop", "text": "Nothing else to do."}]' "other outputs"
    out=$(apply_run 1001 --slug again 2>&1)
    expect_lines "${out}" 'also handed back, not acted on: noop: Nothing else to do\.' 'The agent proposed the title "fsck: Check the superblock first"'
    # Without a pull request there is nothing to apply, and no clone.
    rm -rf "${XDG_CACHE_HOME}/bot-runs/apply" "${FAKE_GH}/artifacts/1001/safe-outputs/aw-"*
    printf '%s\n' '{"type":"noop","message":"Nothing to do."}' >"${FAKE_GH}/artifacts/1001/safe-outputs/outputs.jsonl"
    out=$(apply_run 1001)
    expect_lines "${out}" 'handed back no create_pull_request, so nothing was applied' '  noop: Nothing to do\.'
    test ! -e "${XDG_CACHE_HOME}/bot-runs/apply" || fail "cloned for a run without a pull request"
    out=$(apply_run 1001 --json)
    expect_json "$(jq -c '{applied, outputs}' <<<"${out}")" '{"applied": false, "outputs": [{"type": "noop", "text": "Nothing to do."}]}' "no pull request, --json"
}

# Without an override, the checker is the run's own commit, fetched from
# the runs repository once and kept by commit.
test_apply_fetches_checker() {
    unset BOT_RUNS_SAFE_OUTPUTS_DIR
    make_checker "${FAKE_GH}/checker-source"
    mkdir -p "${FAKE_GH}/checker-source/vendor/gh-aw" "${FAKE_GH}/checker-source/agent" "${FAKE_GH}/checker-source/other"
    touch "${FAKE_GH}/checker-source/vendor/gh-aw/UPSTREAM.json" "${FAKE_GH}/checker-source/agent/redact.mjs" "${FAKE_GH}/checker-source/other/not-fetched"
    make_change 1001 >/dev/null
    local out dir=${XDG_CACHE_HOME}/bot-runs/safe-outputs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    apply_run 1001 >/dev/null
    test -f "${dir}/safe-outputs/safe-outputs.mjs" || fail "the checker was not kept"
    test -f "${dir}/vendor/gh-aw/UPSTREAM.json" || fail "vendor/gh-aw was not kept"
    test -f "${dir}/agent/redact.mjs" || fail "agent/redact.mjs was not kept"
    test ! -e "${dir}/other" || fail "kept what the checker doesn't need"
    expect_eq "$(calls 'tarball')" 1 "tarball downloads"
    rm -rf "${XDG_CACHE_HOME}/bot-runs/apply"
    apply_run 1001 --slug again >/dev/null
    expect_eq "$(calls 'tarball')" 1 "tarball downloads after a second apply"
    # A commit without the checker is refused.
    rm -rf "${XDG_CACHE_HOME}/bot-runs/apply" "${dir}" "${FAKE_GH}/checker-source/safe-outputs"
    out=$(apply_run 1001 2>&1) && fail "applied with a checker that isn't there"
    expect_lines "${out}" 'unpacking the code of a+ failed'
}

# Each refusal: RUN, the declared repository, the change's EDIT (- for
# none), extra setup (in which $OUT is run 1001's safe-outputs and $CHK the
# stand-in checker's mode file), and the expected error. Nothing is left
# behind. What the change may contain is the checker's to refuse (tested
# with gh-aw's validation in the devspace repository).
# shellcheck disable=SC2034 # OUT and CHK are for the setups' eval
test_apply_refused() {
    local run repo edit setup want out OUT=${FAKE_GH}/artifacts/1001/safe-outputs CHK=${WORK}/checker/safe-outputs/mode
    use_stub_checker
    while IFS='|' read -r run repo edit setup want; do
        rm -rf "${XDG_CACHE_HOME}/bot-runs/apply" "${XDG_CACHE_HOME}/bot-work" "${FAKE_GH}/artifacts/${run}/safe-outputs" "${FAKE_GH}"/filter-*.jq "${CHK}"
        cp "${FIXTURES}/expired.txt" "${FAKE_GH}/expired.txt"
        cp "${FIXTURES}/artifacts/1001/agent-run/summary.json" "${FAKE_GH}/artifacts/1001/agent-run/summary.json"
        rm -rf "${XDG_STATE_HOME}/bot-runs"
        echo 'A subject' >"${WORK}/message"
        test "${edit}" = - || make_change "${run}" "${edit}" >/dev/null
        eval "${setup}"
        out=$("${BOT_RUNS}" apply "${run}" --repo "${repo}" --slug s --message "${WORK}/message" --source "${WORK}/target" 2>&1) &&
            fail "applied run ${run} (${want})"
        expect_lines "${out}" "${want}"
        test ! -e "${XDG_CACHE_HOME}/bot-runs/apply/sources/${run}-s/composefs-rs" || fail "left a clone behind (${want})"
        test ! -e "${XDG_CACHE_HOME}/bot-work/s/composefs-rs" || fail "left a worktree behind (${want})"
    done <<'EOF'
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo compile-fail >"${CHK}"|the allowlist refuses composefs/composefs-rs at main with outputs all
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo unpack-fail >"${CHK}"|stub: unpack refused
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo check-fail >"${CHK}"|stub refusal
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo post-apply-fail >"${CHK}"|src/lib\.rs: stub says no
1001|composefs/composefs-rs|echo x >>src/lib.rs|set_json "${OUT}/base.json" ".commit = \"$(git -C "${WORK}/target" rev-parse side)\""|is not on main of
1001|composefs/composefs-rs|echo x >x|sed -i 's,^+++ b/x,+++ b/../x,; s,^diff --git a/x b/x,diff --git a/../x b/../x,' "${OUT}"/aw-*.patch|doesn't apply
1001|other/repo|echo x >>src/lib.rs|:|dispatched for composefs/composefs-rs, not other/repo
1001|composefs/composefs-rs|echo x >>src/lib.rs|set_json "${FAKE_GH}/artifacts/1001/agent-run/summary.json" '.repo = "other/repo"'|summary names other/repo, not composefs/composefs-rs
1001|composefs/composefs-rs|echo x >>src/lib.rs|set_json "${FAKE_GH}/artifacts/1001/agent-run/summary.json" '.run_id = 999'|summary is of run 999
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.event = "push"' >"${FAKE_GH}/filter-run.jq"|triggered by push, not a dispatch
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.head_branch = "evil"' >"${FAKE_GH}/filter-run.jq"|ran the workflow from evil, not a trusted agent branch
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.path = ".github/workflows/other.yml"' >"${FAKE_GH}/filter-run.jq"|ran \.github/workflows/other\.yml
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.head_repository.id = 9' >"${FAKE_GH}/filter-run.jq"|ran code from another repository
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.repository.full_name = "x/y"' >"${FAKE_GH}/filter-run.jq"|is in x/y, not bootc-dev/cgwalters-devspace-sandbox
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.jobs += [.jobs[0] + {name: "Other"}]' >"${FAKE_GH}/filter-jobs.jq"|has the jobs Restrictions, Agent, Safe outputs, Other, not Agent, Restrictions, Safe outputs
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo 'del(.jobs[2])' >"${FAKE_GH}/filter-jobs.jq"|has the jobs Restrictions, Agent, not
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.jobs[1].name = "Other"' >"${FAKE_GH}/filter-jobs.jq"|has the jobs Restrictions, Other, Safe outputs, not
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.jobs[0].head_sha = "b"' >"${FAKE_GH}/filter-jobs.jq"|job of another run or head
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.jobs[2].conclusion = "failure"' >"${FAKE_GH}/filter-jobs.jq"|did not succeed: Safe outputs \(failure\)
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.jobs[0].conclusion = "skipped"' >"${FAKE_GH}/filter-jobs.jq"|did not succeed: Restrictions \(skipped\)
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.artifacts[-1].workflow_run.head_sha = "b"' >"${FAKE_GH}/filter-artifacts.jq"|artifact of another run or head
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.artifacts[-1].workflow_run.id = 1002' >"${FAKE_GH}/filter-artifacts.jq"|artifact of another run or head
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.artifacts[-1].created_at = "2026-09-20T11:00:00Z"' >"${FAKE_GH}/filter-artifacts.jq"|artifact made outside its agent job
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.artifacts += [.artifacts[-1]]' >"${FAKE_GH}/filter-artifacts.jq"|has 2 safe-outputs artifacts
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '.artifacts[-1].size_in_bytes = 99999999' >"${FAKE_GH}/filter-artifacts.jq"|artifact of 99999999 bytes
1001|composefs/composefs-rs|echo x >>src/lib.rs|echo '1001 safe-outputs' >>"${FAKE_GH}/expired.txt"|expired artifact
1001|composefs/composefs-rs|echo x >>src/lib.rs|printf 'x\n\nSigned-off-by: A <a@b>\n' >"${WORK}/message"|has a Signed-off-by
1001|composefs/composefs-rs|echo x >>src/lib.rs|printf 'x\n\nAgent-run: https://example.com\n' >"${WORK}/message"|has an Agent-run trailer
1001|composefs/composefs-rs|-|:|has no safe-outputs artifact
1002|composefs/composefs-rs|echo x >>src/lib.rs|:|agent result is failure, not success
1004|containers/composefs|echo x >>src/lib.rs|:|run 1004 is failure, not success
EOF
}

# With BOT_RUNS_REAL_CHECKER set to a checkout of the devspace repository:
# gh-aw's validation, end to end, on the artifact the agent step writes.
test_apply_real_checker() {
    if test -z "${BOT_RUNS_REAL_CHECKER:-}"; then
        echo "skipped: BOT_RUNS_REAL_CHECKER is not set" 1>&2
        return 0
    fi
    export BOT_RUNS_SAFE_OUTPUTS_DIR=${BOT_RUNS_REAL_CHECKER}
    local out dir=${XDG_CACHE_HOME}/bot-work/fsck-sb/composefs-rs
    make_change 1001 >/dev/null
    out=$(apply_run 1001 --json)
    expect_eq "$(jq -r .pull_request.title <<<"${out}")" "fsck: Check the superblock first" "title, validated by gh-aw's collector"
    expect_eq "$(git -C "${dir}" show HEAD:src/lib.rs | tail -n1)" 'pub fn g() {}' "applied content"
    # What the real checker refuses (the full table is in the devspace repository).
    local edit want
    while IFS='|' read -r edit want; do
        rm -rf "${XDG_CACHE_HOME}/bot-runs/apply" "${XDG_CACHE_HOME}/bot-work"
        make_change 1001 "${edit}" >/dev/null
        out=$(apply_run 1001 2>&1) && fail "applied a change that ${want}"
        expect_lines "${out}" "${want}"
        test ! -e "${dir}" || fail "left a clone behind (${want})"
    done <<'EOF'
echo x >README.md|protected files.*README\.md
mkdir -p .github/workflows && echo x >.github/workflows/ci.yml|\.github
ln -s /etc/passwd leak|symlink
printf '\0\1\2' >blob.bin|binary
echo "t=ghp_$(printf 'a%.0s' $(seq 36))" >>src/lib.rs|secret-shaped string
echo x >run.sh && chmod +x run.sh|new symlink, submodule, executable
EOF
}

test_apply_branches() {
    local branch allowed out rc dispatch_ref
    make_change 1001 >/dev/null
    while IFS='|' read -r branch allowed; do
        rm -rf "${XDG_CACHE_HOME}/bot-runs/apply" "${XDG_CACHE_HOME}/bot-work"
        jq -n --arg b "${branch}" '".head_branch = " + ($b | tojson)' -r >"${FAKE_GH}/filter-run.jq"
        rc=0
        dispatch_ref=${branch}
        test "${allowed}" != yes || dispatch_ref=untrusted-dispatch-ref
        out=$(BOT_RUNS_REF="${dispatch_ref}" apply_run 1001 --json 2>&1) || rc=$?
        if test "${allowed}" = yes; then
            expect_eq "${rc}" 0 "trusted branch ${branch}: ${out}"
        else
            test "${rc}" -ne 0 || fail "trusted branch ${branch} via BOT_RUNS_REF"
            expect_lines "${out}" 'not a trusted agent branch'
        fi
    done <<'EOF'
bot/agent-run-praxis|yes
bot/agent-run-another|yes
bot/agent-run-|no
main|no
bot/agent-yml|no
evil|no
EOF
    echo '.head_branch = "bot/agent-run-praxis"' >"${FAKE_GH}/filter-run.jq"
    out=$(BOT_RUNS_REPO=other/devspace apply_run 1001 2>&1) && fail "trusted another workflow repository"
    expect_lines "${out}" 'not in the configured devspace repository'
}

test_apply_dir() {
    make_change 1001 >/dev/null
    local name supplied dir out
    while IFS='|' read -r name supplied; do
        dir=${WORK}/custom/${name}
        supplied=${supplied/WORK/${WORK}}
        out=$(cd "${WORK}" && apply_run 1001 --slug "${name}" --dir "${supplied}" --json)
        expect_eq "$(jq -r .dir <<<"${out}")" "${dir}" "custom apply directory"
        test -f "${dir}/.git" || fail "custom directory is not a worktree"
        git -C "${dir}" worktree list --porcelain | grep -qF "worktree ${dir}" || fail "custom worktree not registered"
    done <<'EOF'
absolute|WORK/custom/absolute
relative|custom/relative
EOF
    "${TESTS}/../bin/bot-work" worktree rm absolute
    test ! -e "${WORK}/custom/absolute" || fail "manager left absolute custom apply worktree"
    test -f "${WORK}/custom/relative/.git" || fail "manager removed sibling custom apply worker"
    "${TESTS}/../bin/bot-work" worktree rm relative
    test ! -e "${WORK}/custom/relative" || fail "manager left relative custom apply worktree"
}

test_apply_dir_refused() {
    make_change 1001 'echo x >.gitmodules' >/dev/null
    local out dir=${WORK}/custom/refused
    git clone -q "${WORK}/target" "${WORK}/sibling"
    "${TESTS}/../bin/bot-work" worktree add "${WORK}/sibling" fsck-sb >/dev/null
    local sibling=${XDG_CACHE_HOME}/bot-work/fsck-sb/sibling
    echo 'sibling edits' >>"${sibling}/src/lib.rs"
    out=$(apply_run 1001 --dir "${dir}" 2>&1) && fail "accepted protected path in custom worktree"
    expect_lines "${out}" 'touches what a run may not change'
    test ! -e "${dir}" || fail "refusal left custom worktree"
    test ! -e "${XDG_CACHE_HOME}/bot-work/fsck-sb/composefs-rs" || fail "refusal left custom destination registration"
    test -f "${sibling}/.git" || fail "refusal removed sibling worktree"
    expect_eq "$(tail -n1 "${sibling}/src/lib.rs")" 'sibling edits' "refusal preserved sibling edits"
}

test_apply_isolation() {
    make_change 1001 >/dev/null
    local first second common
    echo 'local edits' >>"${WORK}/target/src/lib.rs"
    echo 'untracked' >"${WORK}/target/notes"
    first=$(apply_run 1001 --json)
    second=$(apply_run 1001 --slug second --json)
    first=$(jq -r .dir <<<"${first}")
    second=$(jq -r .dir <<<"${second}")
    common=$(git -C "${first}" rev-parse --git-common-dir)
    test "${common}" != "$(git -C "${second}" rev-parse --git-common-dir)" || fail "apply worktrees share configuration"
    git -C "${first}" config example.isolation first
    test -z "$(git -C "${second}" config --get example.isolation || true)" || fail "configuration leaked to another worker"
    expect_eq "$(tail -n1 "${WORK}/target/src/lib.rs")" 'local edits' "source edits preserved"
    expect_eq "$(cat "${WORK}/target/notes")" untracked "source untracked file preserved"
    "${TESTS}/../bin/bot-work" worktree rm fsck-sb
    test ! -e "${first}" || fail "managed apply worktree not removed"
    test -f "${second}/.git" || fail "removed another apply worker"
}

test_apply_git_environment() {
    make_change 1001 >/dev/null
    local out
    out=$(GIT_DIR="${WORK}/target/.git" GIT_WORK_TREE="${WORK}/target" \
        GIT_INDEX_FILE="${WORK}/target/.git/index" GIT_CONFIG_COUNT=1 \
        GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="${WORK}/bad-hooks" \
        GIT_CONFIG_PARAMETERS="'core.hooksPath'='${WORK}/bad-hooks'" apply_run 1001 --json)
    expect_eq "$(git -C "$(jq -r .dir <<<"${out}")" branch --show-current)" bot/fsck-sb "isolated Git environment"
    expect_eq "$(git -C "${WORK}/target" branch --show-current)" main "source Git environment untouched"
}

# --- diff, stats -------------------------------------------------------------

test_diff_json() {
    local out
    out=$("${BOT_RUNS}" diff 1001 1002 --json)
    expect_json "$(jq -c '.metrics' <<<"${out}")" '{
        "duration_s": {"a": 2520, "b": 1800, "delta": -720, "pct": -28.6},
        "turns": {"a": 37, "b": 50, "delta": 13, "pct": 35.1},
        "tokens_input": {"a": 1200000, "b": 2000000, "delta": 800000, "pct": 66.7},
        "tokens_output": {"a": 40000, "b": 60000, "delta": 20000, "pct": 50},
        "tokens_cache_read": {"a": 900000, "b": 0, "delta": -900000, "pct": -100},
        "tokens_cache_write": {"a": 50000, "b": 0, "delta": -50000, "pct": -100},
        "aic": {"a": 123.5, "b": 200, "delta": 76.5, "pct": 61.9}}' "diff metrics"
    expect_json "$(jq -c '.tools' <<<"${out}")" '[
        {"tool": "Bash", "a_calls": 12, "b_calls": 20, "a_errors": 1, "b_errors": 3, "delta_calls": 8, "delta_errors": 2},
        {"tool": "Edit", "a_calls": 5, "b_calls": 5, "a_errors": 0, "b_errors": 0, "delta_calls": 0, "delta_errors": 0},
        {"tool": "Grep", "a_calls": 0, "b_calls": 4, "a_errors": 0, "b_errors": 0, "delta_calls": 4, "delta_errors": 0},
        {"tool": "Read", "a_calls": 20, "b_calls": 0, "a_errors": 0, "b_errors": 0, "delta_calls": -20, "delta_errors": 0}]' "diff tools"
    expect_json "$(jq -c '{result, failures, files, tests, outcome: [.outcome.a.status, .outcome.b.status]}' <<<"${out}")" '{
        "result": {"a": "success", "b": "failure", "changed": true},
        "failures": {"only_a": [], "only_b": ["timeout: cargo test exceeded 20m"]},
        "files": {"only_a": ["src/lib.rs"], "only_b": ["src/repo.rs"], "common": 1},
        "tests": [{"command": "cargo test -p composefs", "a_exit": 0, "b_exit": 101}],
        "outcome": ["Draft", "Needs human"]}' "diff outcomes"
}

test_diff_text() {
    local out
    out=$("${BOT_RUNS}" diff 1001 1002)
    expect_lines "${out}" \
        '^Run A 1001: claude/claude-sonnet-4-5, success$' \
        '^Run B 1002: opencode/gpt-5-codex, failure$' \
        '^duration +42m +30m +-12m \(-28.6%\)$' \
        '^turns +37 +50 +\+13 \(\+35.1%\)$' \
        '^tokens in +1.2M +2M +\+800k \(\+66.7%\)$' \
        '^cache read +900k +0 +-900k \(-100%\)$' \
        '^AIC +124 +200 +\+76.5 \(\+61.9%\)$' \
        '^  Bash  12/1 -> 20/3  \+8 calls$' \
        '^  Read  20/0 -> 0/0  -20 calls$' \
        '^Failure only in B: timeout: cargo test exceeded 20m$' \
        '^Files: 1 in both, 1 only in A, 1 only in B$' \
        '^Test cargo test -p composefs: exit 0 -> 101$' \
        '^Outcome: Draft https://github.com/cgwalters-forge/composefs-rs/pull/7 -> Needs human$'
    ! grep -q '  Edit' <<<"${out}" || fail "listed an unchanged tool"
    # A partial (footer) run: what's known is compared, the rest says so.
    out=$("${BOT_RUNS}" diff 1001 1003)
    expect_lines "${out}" '^Run B 1003: .*\(from the PR footer; partial\)$' '^duration +42m +10m +-32m' \
        '^Tools: not known for both runs' '^Tests: not known for both runs'
    out=$("${BOT_RUNS}" diff 1001 2>&1) && fail "diffed one run"
    expect_lines "${out}" 'diff takes two RUNs'
}

test_stats_json() {
    local out
    out=$("${BOT_RUNS}" stats --since 2026-09-01 --json)
    expect_json "$(jq -c '.total | .aic.mean |= (. * 100 | round)' <<<"${out}")" '{
        "runs": 4, "with_summary": 3, "success": 2, "failed": 2, "other": 0, "success_rate": 50,
        "failure_kinds": {"timeout": 1, "tool_error": 2},
        "duration_s": {"total": 6720, "mean": 1680},
        "tokens": {"input": 3500000, "output": 110000, "cache_read": 900000, "cache_write": 50000},
        "aic": {"total": 353.5, "mean": 11783, "known": 3},
        "divergence": {"failed_mean_tokens": 2060000, "success_mean_tokens": 775000, "flagged": true}}' "stats total"
    expect_json "$(jq -c '[.since, .by, .groups]' <<<"${out}")" '["2026-09-01T00:00:00Z",null,null]' "stats header"
    # The in-progress run isn't counted.
    expect_eq "$(calls 'runs\?.*status=completed')" 1 "listings of completed runs"
    out=$("${BOT_RUNS}" stats --since 2026-09-01 --by agent --json)
    expect_json "$(jq -c '.groups | map({key, runs, success, failed, aic: .aic.total})' <<<"${out}")" '[
        {"key": "-", "runs": 1, "success": 0, "failed": 1, "aic": null},
        {"key": "claude", "runs": 2, "success": 2, "failed": 0, "aic": 153.5},
        {"key": "opencode", "runs": 1, "success": 0, "failed": 1, "aic": 200}]' "stats --by agent"
    out=$("${BOT_RUNS}" stats --since 2026-09-21 --json)
    expect_eq "$(jq .total.runs <<<"${out}")" 2 "stats --since"
}

test_stats_text() {
    local out
    out=$("${BOT_RUNS}" stats --since 2026-09-01 --by result)
    expect_lines "${out}" \
        '^Agent runs of bootc-dev/cgwalters-devspace-sandbox agent.yml since 2026-09-01T00:00:00Z: 4 finished, 3 with a summary$' \
        '^ +RUNS +OK +FAILED +OTHER +SUCCESS +MEAN TIME +TOKENS IN/OUT +AIC +AIC/RUN$' \
        '^all +4 +2 +2 +0 +50% +28m +3.5M/110k +354 +118$' \
        '^failure +2 +0 +2 +0 +0% +30m +2M/60k +200 +200$' \
        '^Failures by kind: tool_error 2, timeout 1$' \
        '^Resource divergence: failed runs used 2.1M tokens on average, successful ones 775k$' \
        '^AIC known for 3 of 4 runs$'
    out=$("${BOT_RUNS}" stats --by color 2>&1) && fail "accepted --by color"
    expect_lines "${out}" '--by must be agent, model, repo, item or result'
}

# --- dispatch ----------------------------------------------------------------

test_dispatch() {
    local out
    printf 'Fix the fsck bug.\n' >"${WORK}/brief.md"
    out=$("${BOT_RUNS}" dispatch --item PVTI_item1 --repo composefs/composefs-rs --cores 16 --budget 250 "${WORK}/brief.md")
    expect_eq "${out}" "Dispatched run 1006: https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1006" "dispatch output"
    expect_json "$(jq -c '.inputs.brief = null' "${FAKE_GH}/dispatch-body.json")" '{"ref": "bot/agent-run-praxis", "return_run_details": true, "inputs": {
        "item": "PVTI_item1", "repo": "composefs/composefs-rs", "base": "main", "agent": "opencode", "model": "praxis/gpt-6.1-sol",
        "cores": "16", "timeout": "120", "budget": "250", "workflow": "branch",
        "outputs": "create_pull_request,noop,missing_tool", "max_outputs": "3", "brief": null}}' "dispatch request"
    # The runner brief, the run's target, then the task.
    jq -e --rawfile p "${TESTS}/../dotfiles/.agents/skills/coordinator/runner-preamble.md" \
        '.inputs.brief == $p + "\n---\n\nThis run: a `branch` run on composefs/composefs-rs at `main`.\n\nThe task:\n\nFix the fsck bug."' \
        "${FAKE_GH}/dispatch-body.json" >/dev/null || fail "dispatch brief: $(jq .inputs.brief "${FAKE_GH}/dispatch-body.json")"
    out=$(echo "Write up the bisect." | "${BOT_RUNS}" dispatch --json --item PVTI_item2 --repo bootc-dev/bootc \
        --agent opencode --model gpt-5-codex --workflow analysis --timeout 330 --no-preamble -)
    expect_json "${out}" '{"run_id": 1006, "url": "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1006",
        "api_url": "https://api.github.com/repos/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1006"}' "dispatch --json"
    expect_json "$(jq -c '.inputs | {agent, model, workflow, timeout, outputs, max_outputs, brief}' "${FAKE_GH}/dispatch-body.json")" \
        '{"agent": "opencode", "model": "gpt-5-codex", "workflow": "analysis", "timeout": "330", "outputs": "noop,missing_tool,missing_data",
          "max_outputs": "3", "brief": "Write up the bisect."}' "dispatch from stdin"
    out=$("${BOT_RUNS}" dispatch --dry-run --item PVTI_item1 --repo composefs/composefs-rs --outputs create_pull_request,add_comment \
        --max-outputs 5 --no-preamble "${WORK}/brief.md")
    expect_json "$(jq -c '.inputs | {outputs, max_outputs}' <<<"$(sed 1d <<<"${out}")")" \
        '{"outputs": "create_pull_request,add_comment", "max_outputs": "5"}' "dispatch with outputs"
    # Each dispatch put its run on its item.
    local run=${RUNS_URL}/1006
    expect_eq "$(cat "${FAKE_GH}/board-calls")" "field-ensure Run
set PVTI_item1 --status In Progress --field Run ${run} --news Dispatched devspace agent run ${run} (opencode, 16 cores)
pace budget PVTI_item1
list --json
field-ensure Run
set PVTI_item2 --status In Progress --field Run ${run} --news Dispatched devspace agent run ${run} (opencode, 4 cores)
pace budget PVTI_item2
list --json" "board calls"
    # The default model is opencode's only: --model overrides it, and the
    # fake agent has none.
    out=$("${BOT_RUNS}" dispatch --dry-run --item PVTI_item1 --repo composefs/composefs-rs --agent fake "${WORK}/brief.md")
    expect_eq "$(jq -r .inputs.model <<<"$(sed 1d <<<"${out}")")" "" "fake agent's model"
    # --dry-run sends nothing.
    : >"${FAKE_GH}/calls"
    : >"${FAKE_GH}/board-calls"
    out=$("${BOT_RUNS}" dispatch --dry-run --item PVTI_item1 --repo composefs/composefs-rs "${WORK}/brief.md")
    expect_lines "${out}" '^POST repos/bootc-dev/cgwalters-devspace-sandbox/actions/workflows/agent.yml/dispatches$' '"return_run_details": true'
    expect_eq "$(calls .)" 0 "calls of a dry run"
    expect_eq "$(cat "${FAKE_GH}/board-calls")" "" "board calls of a dry run"
}

# The run is dispatched but the board can't record it: say how to fix
# that by hand, rather than dispatching again.
test_dispatch_board_failed() {
    printf 'x\n' >"${WORK}/brief.md"
    touch "${FAKE_GH}/board-fails"
    local out
    out=$("${BOT_RUNS}" dispatch --item PVTI_item1 --repo composefs/composefs-rs "${WORK}/brief.md" 2>&1) &&
        fail "succeeded without recording the run"
    expect_lines "${out}" '^Dispatched run 1006' \
        "recording it on the board failed; run: bot-board set PVTI_item1 --status 'In Progress' --field Run ${RUNS_URL}/1006"
}

test_dispatch_invalid() {
    printf 'x\n' >"${WORK}/brief.md"
    head -c 70000 /dev/zero | tr '\0' a >"${WORK}/long.md"
    : >"${WORK}/empty.md"
    local ok=(--item PVTI_item1 --repo composefs/composefs-rs)
    # Data driven: extra arguments, then the expected error.
    local cases=(
        "--cores 8|--cores must be one of"
        "--timeout 331|--timeout must be 1 to 330 minutes"
        "--timeout 0|--timeout must be 1 to 330 minutes"
        "--budget -5|--budget must be a positive number"
        "--budget 0|--budget must be a positive number"
        "--agent gemini|--agent must be one of"
        "--workflow pr|--workflow must be one of"
        "--outputs create_pull_request;rm|--outputs must be output types separated by commas"
        "--max-outputs many|--max-outputs must be a number"
        "--item nope|--item must be a board item id"
        "--repo nope|--repo must be OWNER/REPO"
        "BRIEF=${WORK}/long.md|over GitHub's 65535; shorten the brief"
        "BRIEF=${WORK}/empty.md|the brief is empty"
        "BRIEF=${WORK}/missing.md|cannot read"
        "--repo private-org/secret|private-org/secret is not public (private)"
        "--repo gone/away|cannot confirm that gone/away is public"
        "PREAMBLE=${WORK}/missing.md|cannot read the runner brief"
    )
    local c args want brief out
    for c in "${cases[@]}"; do
        want=${c#*|}
        brief=${WORK}/brief.md
        args=()
        local preamble=""
        if [[ "${c%%|*}" == BRIEF=* ]]; then
            brief=${c%%|*}
            brief=${brief#BRIEF=}
        elif [[ "${c%%|*}" == PREAMBLE=* ]]; then
            preamble=${c%%|*}
            preamble=${preamble#PREAMBLE=}
        else
            read -ra args <<<"${c%%|*}"
        fi
        out=$(BOT_RUNS_PREAMBLE=${preamble:-${BOT_RUNS_PREAMBLE:-}} "${BOT_RUNS}" dispatch "${ok[@]}" "${args[@]}" "${brief}" 2>&1) &&
            fail "dispatched with ${c%%|*}"
        grep -qF -- "${want}" <<<"${out}" || fail "${c%%|*}: expected '${want}', got: ${out}"
    done
    test ! -e "${FAKE_GH}/dispatch-body.json" || fail "an invalid dispatch was sent"
}

test_dispatch_no_run_id() {
    printf 'x\n' >"${WORK}/brief.md"
    touch "${FAKE_GH}/dispatch-204"
    local out
    out=$("${BOT_RUNS}" dispatch --item PVTI_item1 --repo composefs/composefs-rs "${WORK}/brief.md" 2>&1) &&
        fail "succeeded without a run id"
    expect_lines "${out}" "GitHub returned no run id; find it with 'bot-runs list --item PVTI_item1' instead of dispatching again"
}

# --- reconcile ---------------------------------------------------------------

# reconcile_board: a board of items with a Run in each state, and one
# without. Run 1001's summary gets a patch.
reconcile_board() {
    jq '.patch = {base: "abc", bytes: 1234}' "${FAKE_GH}/artifacts/1001/agent-run/summary.json" >"${WORK}/s.json"
    mv "${WORK}/s.json" "${FAKE_GH}/artifacts/1001/agent-run/summary.json"
    jq -n --arg r "${RUNS_URL}" '[
        {id: "PVTI_running", title: "Running", status: "In Progress", run: "\($r)/1005"},
        {id: "PVTI_failed", title: "Failed", status: "In Progress", run: "\($r)/1004"},
        {id: "PVTI_patch", title: "Patch", status: "In Progress", run: "\($r)/1001"},
        {id: "PVTI_nochange", title: "No change", status: "In Progress", run: "\($r)/1003"},
        {id: "PVTI_moved", title: "Moved", status: "Done", run: "\($r)/1002"},
        {id: "PVTI_bad", title: "Bad", status: "In Progress", run: "https://example.com/1"},
        {id: "PVTI_local", title: "Local", status: "In Progress"}]' >"${FAKE_GH}/board.json"
}

test_reconcile() {
    reconcile_board
    local out want
    # Without --apply: report only.
    out=$("${BOT_RUNS}" reconcile)
    expect_eq "${out}" "Running [In Progress] PVTI_running: run 1005 is in_progress
Failed [In Progress] PVTI_failed: run 1004 ended (failure): set Todo (with --apply)
Patch [In Progress] PVTI_patch: run 1001 succeeded, patch ready: set Draft (with --apply)
No change [In Progress] PVTI_nochange: run 1003 ended (success): set Todo (with --apply)
Moved [Done] PVTI_moved: run 1002 ended (failure) after the item left In Progress: clear Run (with --apply)
Bad [In Progress] PVTI_bad: Run is not a run URL of bootc-dev/cgwalters-devspace-sandbox: https://example.com/1" "report"
    expect_eq "$(grep -c '^set' "${FAKE_GH}/board-calls")" 0 "board changes without --apply"
    # --dry-run prints the changes instead.
    out=$("${BOT_RUNS}" reconcile --dry-run 2>&1 >/dev/null)
    expect_lines "${out}" "^bot-board set PVTI_failed --status Todo --field Run '' --why "
    expect_eq "$(grep -c '^set' "${FAKE_GH}/board-calls")" 0 "board changes of a dry run"
    out=$("${BOT_RUNS}" reconcile --apply --json)
    expect_json "$(jq -c 'map({item, result, applied})' <<<"${out}")" '[
        {"item": "PVTI_running", "result": null, "applied": null},
        {"item": "PVTI_failed", "result": "failure", "applied": "applied"},
        {"item": "PVTI_patch", "result": "success", "applied": "applied"},
        {"item": "PVTI_nochange", "result": "success", "applied": "applied"},
        {"item": "PVTI_moved", "result": "failure", "applied": "applied"},
        {"item": "PVTI_bad", "result": null, "applied": null}]' "reconcile --apply"
    want=$(jq -c --arg r "${RUNS_URL}" '[
        {id: "PVTI_running", status: "In Progress", run: "\($r)/1005"},
        {id: "PVTI_failed", status: "Todo", run: null, why: "Agent run \($r)/1004 ended: failure",
         news: "Devspace agent run 1004 ended (failure): \($r)/1004"},
        {id: "PVTI_patch", status: "Draft", run: null,
         why: "Agent run \($r)/1001 succeeded with a patch (1234 bytes): ready for bot-runs apply 1001 --slug SLUG --message FILE, then bot-pr fork-pr",
         news: "Devspace agent run 1001 succeeded; patch ready"},
        {id: "PVTI_nochange", status: "Todo", run: null, why: "Agent run \($r)/1003 succeeded without a change",
         news: "Devspace agent run 1003 ended (success): \($r)/1003"},
        {id: "PVTI_moved", status: "Done", run: null},
        {id: "PVTI_bad", status: "In Progress", run: "https://example.com/1"},
        {id: "PVTI_local", status: "In Progress", run: null}]' <<<null)
    expect_json "$(jq -c 'map({id, status, run, why, news} | with_entries(select(.value != null or .key == "run")))' "${FAKE_GH}/board.json")" \
        "${want}" "board after --apply"
    # Level-triggered: a second pass changes nothing.
    : >"${FAKE_GH}/board-calls"
    out=$("${BOT_RUNS}" reconcile --apply)
    expect_eq "${out}" "Running [In Progress] PVTI_running: run 1005 is in_progress
Bad [In Progress] PVTI_bad: Run is not a run URL of bootc-dev/cgwalters-devspace-sandbox: https://example.com/1" "second pass"
    expect_eq "$(grep -c '^set' "${FAKE_GH}/board-calls")" 0 "board changes of a second pass"
}

# A run that can't be read fails the reconcile, but not the other items.
test_reconcile_unreadable() {
    jq -n --arg r "${RUNS_URL}" '[{id: "PVTI_gone", title: "Gone", status: "In Progress", run: "\($r)/999"},
        {id: "PVTI_failed", title: "Failed", status: "In Progress", run: "\($r)/1004"}]' >"${FAKE_GH}/board.json"
    local out
    out=$("${BOT_RUNS}" reconcile --board-file "${FAKE_GH}/board.json" --apply 2>&1) && fail "succeeded with an unreadable run"
    expect_lines "${out}" 'reading the run of item PVTI_gone failed' '^Failed .*: set Todo \(done\)$'
}

# A finished run whose files can't be read yet is left for a later pass:
# its patch would look like no change.
test_reconcile_files_unreadable() {
    reconcile_board
    jq '[.[] | select(.id == "PVTI_patch")]' "${FAKE_GH}/board.json" >"${WORK}/b.json"
    mv "${WORK}/b.json" "${FAKE_GH}/board.json"
    touch "${FAKE_GH}/artifacts-fail"
    local out
    out=$("${BOT_RUNS}" reconcile --apply 2>&1) && fail "succeeded without the run's files"
    expect_lines "${out}" 'the files of run 1001 could not be read'
    expect_eq "$(grep -c '^set' "${FAKE_GH}/board-calls")" 0 "board changes without the run's files"
    rm "${FAKE_GH}/artifacts-fail"
    out=$("${BOT_RUNS}" reconcile --apply)
    expect_eq "${out}" "Patch [In Progress] PVTI_patch: run 1001 succeeded, patch ready: set Draft (done)" "reconcile once readable"
}

# --- runner -------------------------------------------------------------------

all_tests() {
    declare -F | awk '$3 ~ /^test_/ { sub(/^test_/, "", $3); print $3 }'
}

# run_test NAME: runs test_NAME in a fresh fake world. Called in a
# separate process per test, so that set -e holds inside it.
run_test() {
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-runs-test.XXXXXX")
    trap 'rm -rf "${WORK}"' EXIT
    FAKE_GH=${WORK}/gh-store
    cp -r "${FIXTURES}" "${FAKE_GH}"
    mkdir -p "${WORK}/bin" "${WORK}/home"
    write_fake_gh "${WORK}/bin"
    write_fake_board "${WORK}/bin"
    echo "[]" >"${FAKE_GH}/board.json"
    # The fake bot-pace logs its calls with the board's.
    printf '#!/usr/bin/env bash\necho "pace $*" >>"${FAKE_GH:?}/board-calls"\n' >"${WORK}/bin/bot-pace"
    chmod +x "${WORK}/bin/bot-pace"
    export BOT_RUNS_BOT_BOARD=${WORK}/bin/bot-board BOT_RUNS_BOT_PACE=${WORK}/bin/bot-pace
    export FAKE_GH WORK
    # Every test applies with the stand-in checker unless it says otherwise.
    make_checker "${WORK}/checker"
    export BOT_RUNS_SAFE_OUTPUTS_DIR=${WORK}/checker
    export PATH=${WORK}/bin:${PATH}
    export HOME=${WORK}/home XDG_STATE_HOME=${WORK}/home/state XDG_CACHE_HOME=${WORK}/home/cache
    unset GH_TOKEN GITHUB_TOKEN BOT_RUNS_REPO BOT_RUNS_WORKFLOW BOT_RUNS_REF BOT_RUNS_AGE_IDENTITY
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

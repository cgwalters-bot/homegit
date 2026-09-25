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
repo=bootc-dev/cgwalters-devspace-sandbox
runs=${store}/runs.json
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
        id=${path#repos/"${repo}"/actions/runs/}
        id=${id%%/*}
        # Artifacts are uploaded at the end of the run (its latest attempt).
        created=$(jq -r --argjson id "${id}" '.workflow_runs[] | select(.id == $id) | .updated_at' "${runs}")
        reply "$(for a in agent-run agent-transcript; do
                n=$(( id * 10 + $(test "${a}" = agent-run && echo 1 || echo 2) ))
                if grep -qx "${id} ${a}" "${store}/expired.txt"; then
                    jq -nc --argjson n "${n}" --arg a "${a}" --arg c "${created}" '{id: $n, name: $a, expired: true, created_at: $c, expires_at: "2026-09-24T10:45:00Z"}'
                elif test -d "${store}/artifacts/${id}/${a}"; then
                    jq -nc --argjson n "${n}" --arg a "${a}" --arg c "${created}" '{id: $n, name: $a, expired: false, created_at: $c, expires_at: "2026-12-19T10:45:00Z"}'
                fi
            done | jq -sc '{total_count: length, artifacts: .}')"
        ;;
    "GET repos/${repo}/actions/runs/"*/jobs)
        id=${path#repos/"${repo}"/actions/runs/}
        reply "$(jq -nc --argjson id "${id%%/*}" '{total_count: 1, jobs: [{id: $id, name: "agent"}]}')"
        ;;
    "GET repos/${repo}/actions/runs/"*)
        id=${path#repos/"${repo}"/actions/runs/}
        body=$(jq -c --argjson id "${id}" '.workflow_runs[] | select(.id == $id)' "${runs}")
        test -n "${body}" || fail_http 404 "Not Found"
        reply "${body}"
        ;;
    "GET repos/${repo}/actions/artifacts/"*/zip)
        n=${path#repos/"${repo}"/actions/artifacts/}
        n=${n%/zip}
        id=$((n / 10))
        a=$(test $((n % 10)) -eq 1 && echo agent-run || echo agent-transcript)
        ! grep -qx "${id} ${a}" "${store}/expired.txt" || fail_http 410 "Artifact has expired"
        test -d "${store}/artifacts/${id}/${a}" || fail_http 404 "Not Found"
        cd "${store}/artifacts/${id}/${a}"
        zip -q -r -y - .
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
    expect_json "$(cat "${FAKE_GH}/dispatch-body.json")" '{"ref": "main", "return_run_details": true, "inputs": {
        "item": "PVTI_item1", "repo": "composefs/composefs-rs", "base": "main", "agent": "claude", "model": "",
        "cores": "16", "timeout": "120", "budget": "250", "workflow": "branch", "brief": "Fix the fsck bug."}}' "dispatch request"
    out=$(echo "Write up the bisect." | "${BOT_RUNS}" dispatch --json --item PVTI_item2 --repo bootc-dev/bootc \
        --agent opencode --model gpt-5-codex --workflow analysis --timeout 330 -)
    expect_json "${out}" '{"run_id": 1006, "url": "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1006",
        "api_url": "https://api.github.com/repos/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1006"}' "dispatch --json"
    expect_json "$(jq -c '.inputs | {agent, model, workflow, timeout, brief}' "${FAKE_GH}/dispatch-body.json")" \
        '{"agent": "opencode", "model": "gpt-5-codex", "workflow": "analysis", "timeout": "330", "brief": "Write up the bisect."}' "dispatch from stdin"
    # --dry-run sends nothing.
    : >"${FAKE_GH}/calls"
    out=$("${BOT_RUNS}" dispatch --dry-run --item PVTI_item1 --repo composefs/composefs-rs "${WORK}/brief.md")
    expect_lines "${out}" '^POST repos/bootc-dev/cgwalters-devspace-sandbox/actions/workflows/agent.yml/dispatches$' '"return_run_details": true'
    expect_eq "$(calls .)" 0 "calls of a dry run"
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
        "--item nope|--item must be a board item id"
        "--repo nope|--repo must be OWNER/REPO"
        "BRIEF=${WORK}/long.md|over GitHub's 65535; shorten the brief"
        "BRIEF=${WORK}/empty.md|the brief is empty"
        "BRIEF=${WORK}/missing.md|cannot read"
        "--repo private-org/secret|private-org/secret is not public (private)"
        "--repo gone/away|cannot confirm that gone/away is public"
    )
    local c args want brief out
    for c in "${cases[@]}"; do
        want=${c#*|}
        brief=${WORK}/brief.md
        args=()
        if [[ "${c%%|*}" == BRIEF=* ]]; then
            brief=${c%%|*}
            brief=${brief#BRIEF=}
        else
            read -ra args <<<"${c%%|*}"
        fi
        out=$("${BOT_RUNS}" dispatch "${ok[@]}" "${args[@]}" "${brief}" 2>&1) && fail "dispatched with ${c%%|*}"
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
    export FAKE_GH WORK
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

#!/usr/bin/env bash
# Offline tests of bin/bot-poll-loop against a fake sweep directory, a
# fake gh (the operator's events feed) and fake bot-reconcile,
# bot-signoff-due and bot-promote-due. No network, no sleeping.
#   tests/bot-poll-loop.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly LOOP=${TESTS}/../bin/bot-poll-loop

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-poll-loop-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export HOME=${WORK}/home XDG_CONFIG_HOME=${WORK}/config FAKE=${WORK}/fake
unset BOT_OPERATOR_CONFIG GH_TOKEN GITHUB_TOKEN
mkdir -p "${HOME}" "${WORK}/bin" "${WORK}/tools"
export PATH=${WORK}/bin:${PATH}

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# The fake gh answers a PR's author read with $FAKE/author-OWNER-REPO-N
# (else "someone"), and otherwise prints $FAKE/events-N on its Nth call
# of the events feed (the last one after that), as its --jq filter would.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$2" =~ ^repos/([^/]+)/([^/]+)/pulls/([0-9]+)$ ]]; then
    cat "${FAKE}/author-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}" 2>/dev/null || echo someone
    exit 0
fi
n=$(($(cat "${FAKE}/gh-calls" 2>/dev/null || echo 0) + 1))
echo "${n}" >"${FAKE}/gh-calls"
f=${FAKE}/events-${n}
test -e "${f}" || f=$(find "${FAKE}" -name 'events-*' | sort | tail -n1)
test -z "${f}" || cat "${f}"
EOF
# The fake bot-reconcile prints $FAKE/reconcile.txt (and exits with
# $FAKE/reconcile.rc, else 0), the fake bot-heartbeat prints
# $FAKE/heartbeat.err to stderr (and exits with $FAKE/heartbeat.rc), both
# logging to $FAKE/order; the fake bot-board
# lists $FAKE/board.json; the others log, and print $FAKE/NAME.out.
cat >"${WORK}/tools/bot-reconcile" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"${FAKE}/reconcile-calls"
echo reconcile >>"${FAKE}/order"
cat "${FAKE}/reconcile.txt"
exit "$(cat "${FAKE}/reconcile.rc" 2>/dev/null || echo 0)"
EOF
cat >"${WORK}/tools/bot-heartbeat" <<'EOF'
#!/usr/bin/env bash
echo "heartbeat $*" >>"${FAKE}/order"
cat "${FAKE}/heartbeat.err" 1>&2 2>/dev/null
exit "$(cat "${FAKE}/heartbeat.rc" 2>/dev/null || echo 0)"
EOF
cat >"${WORK}/tools/bot-board" <<'EOF'
#!/usr/bin/env bash
cat "${FAKE}/board.json" 2>/dev/null || echo '[]'
EOF
for t in bot-signoff-due bot-promote-due; do
    # shellcheck disable=SC2016 # expanded by the fake
    printf '#!/usr/bin/env bash\necho "%s $*" >>"${FAKE}/due-calls"\ncat "${FAKE}/%s.out" 2>/dev/null\n' "${t}" "${t}" >"${WORK}/tools/${t}"
done
chmod +x "${WORK}/bin/gh" "${WORK}/tools/"*

QUIET_REPORT='Observed: 4 of 4 agents busy
Actions: none (converged)'

# reset: a fresh world: no loop state, no sweeps, a converged reconcile.
reset() {
    rm -rf "${FAKE}" "${WORK}/state" "${WORK}/sweep"
    mkdir -p "${FAKE}" "${WORK}/sweep/runs"
    printf '%s\n' "${QUIET_REPORT}" >"${FAKE}/reconcile.txt"
    : >"${FAKE}/events-1"
}

# sweep RUN WATCH [INBOX] [ENDED]: a complete run, and the status naming it.
sweep() {
    local d=${WORK}/sweep/runs/$1 ended=${4:-$(date -u +%FT%TZ)}
    mkdir -p "${d}"
    printf '%s\nSwept 3 URLs of 2 board items: 0 failed.\n' "$2" >"${d}/watch.txt"
    printf '%s\n' "${3:-}" >"${d}/inbox.txt"
    : >"${d}/notify.txt"
    echo '{"git": 0, "watch": 0}' >"${d}/status.json"
    jq -n --arg run "$1" --arg ended "${ended}" '{run: $run, ended_at: $ended, problems: [], complete: true, last_complete: {run: $run, ended_at: $ended}}' \
        >"${WORK}/sweep/status.json"
}

# loop [CYCLES]: runs the loop with no wait between cycles.
loop() {
    BOT_POLL_LOOP_STATE=${WORK}/state BOT_POLL_LOOP_SWEEP_DIR=${WORK}/sweep BOT_POLL_LOOP_BIN_DIR=${WORK}/tools \
        BOT_POLL_LOOP_CYCLES=${1:-0} BOT_POLL_LOOP_FAST_S=0 "${LOOP}"
}

# expect_first OUT RE: the first line of OUT matches RE.
expect_first() {
    [[ "$(head -n1 <<<"$1")" =~ $2 ]] || fail "expected a first line matching '$2', got: $(head -n1 <<<"$1")"
}

DRIVE1='P0 drive:
  conflict https://github.com/o/r/pull/1 aaaaaaaaaaaa: conflicts with main; a worker resolves it
'
DRIVE2='P0 drive:
  conflict https://github.com/o/r/pull/1 aaaaaaaaaaaa: conflicts with main; a worker resolves it
  needs-regen https://github.com/o/r/pull/2 bbbbbbbbbbbb: generated files conflict
  ci-pending https://github.com/o/r/pull/3 cccccccccccc: still running
'

# A fresh state primes the seen-sets on the newest run: nothing is news.
reset
sweep 20261002-100000-000 "${DRIVE1}"
out=$(loop)
expect_first "${out}" '^QUIET: no news in this window$'
grep -qx 'Observed: 4 of 4 agents busy' <<<"${out}" || fail "QUIET without the Observed line: ${out}"
grep -q -- "--state ${WORK}/state/actions.json --resync 120" "${FAKE}/reconcile-calls" || fail "reconcile args: $(cat "${FAKE}/reconcile-calls")"

# A new run with a new P0 drive blocker wakes it once, with the report;
# ci-pending is not a blocker to wake for.
sweep 20261002-101000-000 "${DRIVE2}"
out=$(loop)
expect_first "${out}" "^ACTIONS \\(drive-P0\\) at [0-9]{4}: see ${WORK}/sweep/runs/20261002-101000-000/\\{watch,notify,inbox\\}.txt$"
grep -qx 'Actions: none (converged)' <<<"${out}" || fail "no reconcile report after the wake line: ${out}"
expect_first "$(loop)" '^QUIET'
sweep 20261002-102000-000 "${DRIVE2}"
expect_first "$(loop)" '^QUIET'

# Item news by a human wakes it; by the bot or a [bot], or CI passing, it doesn't.
n=0
for c in "@alice:news" "@cgwalters-bot:" "@renovate[bot]:"; do
    n=$((n + 1))
    sweep "20261002-11${n}000-000" "Some item  [Draft]  PVTI_x
  o/r#1
    comment by ${c%%:*}: hello
      https://github.com/o/r/pull/1#issuecomment-1
"
    out=$(loop)
    if test -n "${c#*:}"; then expect_first "${out}" "^ACTIONS \\(news\\)"; else expect_first "${out}" '^QUIET'; fi
done

# Fired reconcile actions wake it, with their kinds; the report says which.
printf '%s\n' 'Observed: 2 of 4 agents busy' 'Actions (2):' \
    '* capacity https://github.com/o/r/issues/9: harness 0 of 2 busy: dispatch up to 2' \
    '  lead-orphan https://github.com/o/r/issues/8: no worker' >"${FAKE}/reconcile.txt"
out=$(loop)
expect_first "${out}" '^ACTIONS \(actions: capacity\) at [0-9]{4}: '
grep -q '^\* capacity https://github.com/o/r/issues/9' <<<"${out}" || fail "the fired action is not in the output: ${out}"
printf '%s\n' "${QUIET_REPORT}" >"${FAKE}/reconcile.txt"

# A failing reconcile doesn't wake it, but QUIET says so.
printf '%s\n' 'Observed: nothing' '  unread: the board: bot-board: quota' 'Actions: none (converged)' >"${FAKE}/reconcile.txt"
echo 1 >"${FAKE}/reconcile.rc"
out=$(loop)
expect_first "${out}" '^QUIET'
test "$(tail -n+2 <<<"${out}")" = 'Observed: nothing
  unread: the board: bot-board: quota
(bot-reconcile exited 1)' || fail "QUIET after a failing reconcile: ${out}"
rm "${FAKE}/reconcile.rc"
printf '%s\n' "${QUIET_REPORT}" >"${FAKE}/reconcile.txt"

# Each cycle refreshes the heartbeat before reconciling; the report says
# why when it didn't refresh it.
reset
sweep 20261002-100000-000 ""
out=$(loop 1)
test "$(cat "${FAKE}/order")" = 'heartbeat refresh
reconcile
heartbeat refresh
reconcile' || fail "refresh and reconcile order: $(cat "${FAKE}/order")"
if grep -q '^Heartbeat' <<<"${out}"; then fail "a refreshed heartbeat was reported: ${out}"; fi
# [heartbeat refresh's exit status, its stderr, the report's last line]
hb_cases=(
    "0|bot-heartbeat: fresh: published 3 min ago|Observed: 4 of 4 agents busy"
    "4|bot-heartbeat: not refreshed: someone published since|Heartbeat not refreshed: bot-heartbeat: not refreshed: someone published since (exit 4)"
    "1|bot-heartbeat: cannot edit the heartbeat comment: HTTP 502|Heartbeat not refreshed: bot-heartbeat: cannot edit the heartbeat comment: HTTP 502 (exit 1)"
)
for c in "${hb_cases[@]}"; do
    IFS='|' read -r rc err want <<<"${c}"
    echo "${rc}" >"${FAKE}/heartbeat.rc"
    echo "${err}" >"${FAKE}/heartbeat.err"
    out=$(loop)
    expect_first "${out}" '^QUIET'
    test "$(tail -n1 <<<"${out}")" = "${want}" || fail "refresh exit ${rc}: QUIET ends: $(tail -n1 <<<"${out}")"
done
# A wake carries it too.
printf '%s\n' 'Observed: 2 of 4 agents busy' 'Actions (1):' '* heartbeat: the heartbeat is 20 min old' >"${FAKE}/reconcile.txt"
out=$(loop)
expect_first "${out}" '^ACTIONS \(actions: heartbeat\)'
test "$(tail -n1 <<<"${out}")" = "${want}" || fail "the wake doesn't say why the heartbeat wasn't refreshed: ${out}"

# A stale sweep is a problem, reported at most hourly.
reset
sweep 20261002-100000-000 "" "" "$(date -u -d '2 hours ago' +%FT%TZ)"
out=$(loop)
expect_first "${out}" '^ACTIONS \(sweep-problem\) at [0-9]{4}: no sweep completed in 1[12][0-9] min$'
expect_first "$(loop)" '^QUIET'

# A new approval in the events feed between cycles runs the sign-off and
# promotion steps at once, and wakes it when the PR is one the bot tracks
# or a step did something.
REVIEW1=https://github.com/o/r/pull/1#pullrequestreview-1
# fast_case NAME REVIEW WANT [SETUP]: a fresh world where REVIEW is new
# in the second read of the feed, after running SETUP; WANT is wake or
# quiet.
fast_case() {
    reset
    sweep 20261002-100000-000 ""
    echo "${REVIEW1}" >"${FAKE}/events-1"
    printf '%s\n' "${REVIEW1}" "$2" >"${FAKE}/events-2"
    eval "${4:-}"
    out=$(loop 1)
    test "$(cat "${FAKE}/due-calls")" = "bot-signoff-due --apply
bot-promote-due --apply" || fail "$1: due calls: $(cat "${FAKE}/due-calls")"
    if test "$3" = wake; then
        [[ "$(head -n1 <<<"${out}")" == "ACTIONS (approval, fast) at "????": $2 "* ]] || fail "$1: expected a wake for $2, got: ${out}"
        # Seen now: another window is quiet.
        expect_first "$(loop 1)" '^QUIET'
    else
        expect_first "${out}" '^QUIET'
    fi
}
fast_case "someone else's PR" https://github.com/up/proj/pull/7#pullrequestreview-2 quiet
# shellcheck disable=SC2016 # the setups are eval'ed
{
    fast_case "the bot's PR" https://github.com/up/proj/pull/8#pullrequestreview-3 wake 'echo cgwalters-bot >"${FAKE}/author-up-proj-8"'
    fast_case "a fork PR" https://github.com/cgwalters-forge/proj/pull/2#pullrequestreview-4 wake
    fast_case "on the board, in a Branch" https://github.com/up/proj/pull/9#pullrequestreview-5 wake \
        'jq -n "[{id: \"PVTI_1\", content: {url: \"https://github.com/o/r/issues/1\"}, branch: \"https://github.com/up/proj/pull/9\"}]" >"${FAKE}/board.json"'
    fast_case "a promotion that happened" https://github.com/up/proj/pull/7#pullrequestreview-6 wake \
        'echo "Promoted: https://github.com/cgwalters-forge/x/pull/1 -> https://github.com/up/x/pull/3" >"${FAKE}/bot-promote-due.out"'
    fast_case "only standing lines" https://github.com/up/proj/pull/7#pullrequestreview-7 quiet \
        'echo "Needs your text: https://github.com/cgwalters-forge/x/pull/1 (up/x is human-text): ..." >"${FAKE}/bot-promote-due.out"'
}

test "$("${LOOP}" --help | head -n1)" = "Usage: bot-poll-loop" || fail "--help"

if test "${failures}" -gt 0; then
    echo "${failures} failure(s)" 1>&2
    exit 1
fi
echo "bot-poll-loop: all tests passed"

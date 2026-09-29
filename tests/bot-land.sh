#!/usr/bin/env bash
# Offline tests of bin/bot-land: it opens (or reuses) the pull request,
# enables auto-merge, waits, rebases when main moved on, stops on a
# failed ci check or a closed pull request, and fast-forwards the shared
# clone once merged; with --no-auto, it opens a review ask for cgwalters
# (--ask), notes stale ones, and warns when nothing asks. A local bare
# repository is origin, and a fake gh and bot-board answer from files.
# No network.
#   tests/bot-land.sh
set -euo pipefail
shopt -s inherit_errexit

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly TOOL=${TESTS}/../bin/bot-land BOT_GIT=${TESTS}/../bin/bot-git
readonly REPO=acme/proj BRANCH=bot/topic URL=https://github.com/acme/proj/pull/5
readonly BLOCKS=https://github.com/cgwalters-forge/tracker/issues/57
readonly EX_USAGE=2 EX_FAILED=3 EX_TIMEOUT=4

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-land-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh BOT_LAND_POLL_SECONDS=0 BOT_LAND_BOT_BOARD=${WORK}/bin/bot-board
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
export PATH=${WORK}/bin:${PATH}
git config --global user.name nobody
git config --global user.email nobody@example.com
git config --global init.defaultBranch main
git config --global commit.gpgSign false
# The shared clone is one bot-git refuses to commit in; bot-land still
# rebases the worktree and fast-forwards the shared clone.
export BOT_GIT_SHARED_CLONES=${WORK}/shared-clones
unset BOT_GIT_ALLOW_SHARED_CLONE
echo "${WORK}/shared" >"${BOT_GIT_SHARED_CLONES}"

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# The fake gh. $FAKE_GH holds: open.json (the open pull requests for the
# branch), polls/ (the successive answers for pull request 5, the last
# one repeating; a poll whose answer is merged runs on-merge first),
# checks.json (the ci check runs), asks.json (the open review asks in the
# tracker), body (the body of the pull request opened) and calls (every
# call).
mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GH}/calls"
case "$*" in
    "api repos/acme/proj") echo '{"default_branch": "main"}' ;;
    "api repos/acme/proj/pulls?state=open&base=main&head=acme%3Abot%2Ftopic") cat "${FAKE_GH}/open.json" ;;
    "api -X POST repos/acme/proj/pulls -f title="*" -f head=bot/topic -f base=main -F body=@-")
        cat >"${FAKE_GH}/body"
        echo '{"number": 5, "html_url": "https://github.com/acme/proj/pull/5", "title": "topic: Change 1"}' ;;
    "pr merge 5 --repo acme/proj --auto --rebase") ;;
    "api repos/acme/proj/pulls/5")
        mapfile -t polls < <(ls "${FAKE_GH}/polls")
        f=${FAKE_GH}/polls/${polls[0]}
        sed "s/@HEAD@/$(git rev-parse HEAD)/" "${f}" >"${FAKE_GH}/answer"
        test "${#polls[@]}" -eq 1 || rm "${f}"
        if jq -e .merged "${FAKE_GH}/answer" >/dev/null; then "${FAKE_GH}/on-merge"; fi
        cat "${FAKE_GH}/answer" ;;
    "api repos/acme/proj/commits/"*"/check-runs?check_name=ci") cat "${FAKE_GH}/checks.json" ;;
    "api --paginate repos/cgwalters-forge/tracker/issues?labels=review&state=open&per_page=100 --jq "*)
        jq -r "${!#}" "${FAKE_GH}/asks.json" ;;
    *) echo "fake gh: unexpected: $*" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

# The fake bot-board: writes its arguments, one per line, to
# $FAKE_GH/board and prints the new ask's URL; fails when
# $FAKE_GH/board-fails exists.
cat >"${WORK}/bin/bot-board" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test ! -e "${FAKE_GH}/board-fails" || { echo "fake bot-board: failing" 1>&2; exit 1; }
printf '%s\n' "$@" >"${FAKE_GH}/board"
echo https://github.com/cgwalters-forge/tracker/issues/200
EOF
chmod +x "${WORK}/bin/bot-board"

# open_pr: pull request 5 is already open for the branch.
open_pr() {
    echo "[{\"number\": 5, \"html_url\": \"${URL}\", \"title\": \"topic: Change 1\"}]" >"${FAKE_GH}/open.json"
}

# poll N STATE [MERGEABLE]: the Nth answer about pull request 5, for the
# current head: merged, open or closed.
poll() {
    jq -n --arg s "$2" --arg m "${3:-clean}" \
        '{merged: ($s == "merged"), state: (if $s == "open" then "open" else "closed" end),
          mergeable_state: $m, head: {sha: "@HEAD@"}}' >"${FAKE_GH}/polls/$1.json"
}

# commit MESSAGE: a bot commit in the worktree.
commit() {
    (cd "${WORKTREE}" && "${BOT_GIT}" commit -q --allow-empty -m "$1" -m "Generated-by: AI")
}

# setup [COMMITS]: a fresh origin with one commit on main, the shared
# clone on main, and its worktree on the topic branch with COMMITS
# (default 1) bot commits. Merging (on-merge) pushes the branch to main,
# as a rebase merge of an up-to-date branch leaves the same tree.
setup() {
    rm -rf "${WORK}/origin.git" "${WORK}/shared" "${WORK}/worktree" "${FAKE_GH}"
    mkdir -p "${FAKE_GH}/polls"
    echo '[]' >"${FAKE_GH}/open.json"
    echo '{"check_runs": []}' >"${FAKE_GH}/checks.json"
    echo '[]' >"${FAKE_GH}/asks.json"
    printf '#!/bin/sh\ngit -C "%s" push -q origin HEAD:main\n' "${WORK}/worktree" >"${FAKE_GH}/on-merge"
    chmod +x "${FAKE_GH}/on-merge"
    git init -q --bare "${WORK}/origin.git"
    git clone -q "${WORK}/origin.git" "${WORK}/shared" 2>/dev/null
    git -C "${WORK}/shared" commit -q --allow-empty -m init
    git -C "${WORK}/shared" push -q origin main
    git -C "${WORK}/shared" worktree add -q -b "${BRANCH}" "${WORK}/worktree" main
    local i
    for i in $(seq "${1:-1}"); do commit "topic: Change ${i}"; done
}
readonly WORKTREE=${WORK}/worktree

# run NAME STATUS PATTERN ARGS...: run the tool in the worktree, its output
# in $out; fail NAME unless it exits with STATUS and $out matches PATTERN.
run() {
    local name=$1 expected=$2 pattern=$3 status=0
    shift 3
    out=$(cd "${WORKTREE}" && "${TOOL}" --repo "${REPO}" "$@" 2>&1) || status=$?
    test "${status}" -eq "${expected}" || fail "${name}: exit status ${status}, expected ${expected}; output:"$'\n'"${out}"
    grep -qE -- "${pattern}" <<<"${out}" || fail "${name}: output lacks '${pattern}':"$'\n'"${out}"
}

called() {
    grep -qF -- "$1" "${FAKE_GH}/calls"
}

# Opened, auto-merged, waited for and the shared clone fast-forwarded.
setup
poll 1 open
poll 2 merged
run "merged" 0 "fast-forwarded ${WORK}/shared" --timeout 1
test "$(cat "${FAKE_GH}/body")" = $'- topic: Change 1\n\nGenerated-by: AI' || fail "body: $(cat "${FAKE_GH}/body")"
called "title=topic: Change 1" || fail "title: $(cat "${FAKE_GH}/calls")"
called "pr merge 5 --repo acme/proj --auto --rebase" || fail "no auto-merge"
test "$(git -C "${WORK}/shared" rev-parse main)" = "$(git -C "${WORKTREE}" rev-parse HEAD)" || fail "shared clone not fast-forwarded"
test "$(git --git-dir="${WORK}/origin.git" rev-parse "${BRANCH}")" = "$(git -C "${WORKTREE}" rev-parse HEAD)" || fail "branch not pushed"
"${BOT_GIT}" -C "${WORK}/shared" commit -q --allow-empty -m x 2>/dev/null && fail "bot-git committed in the shared clone"

# The shared clone is left alone when it has changes.
setup
poll 1 merged
echo dirty >"${WORK}/shared/file" && git -C "${WORK}/shared" add file
run "shared clone dirty" 0 "not updating ${WORK}/shared: it has main checked out with changes"

# Main moved on: rebased onto it and pushed again, then merged.
setup
git -C "${WORK}/shared" commit -q --allow-empty -m "elsewhere"
git -C "${WORK}/shared" push -q origin main
ELSEWHERE=$(git -C "${WORK}/shared" rev-parse HEAD)
poll 1 open behind
poll 2 merged
run "behind" 0 "main moved on; rebasing onto it"
git --git-dir="${WORK}/origin.git" merge-base --is-ancestor "${ELSEWHERE}" "${BRANCH}" || fail "behind: the pushed branch lacks main"

# Stops, and waits no longer, on a failed ci, a closed pull request, or
# the timeout; ci runs of another head don't count.
while read -r name status pattern polls checks; do
    setup
    i=0
    for p in ${polls}; do i=$((i + 1)); poll "${i}" "${p}"; done
    test "${checks}" = - || echo "{\"check_runs\": [{\"status\": \"completed\", \"conclusion\": \"${checks}\", \"html_url\": \"https://ci/1\"}]}" >"${FAKE_GH}/checks.json"
    run "${name}" "${status}" "${pattern}" --timeout 0.001
done <<EOF
failed ${EX_FAILED} ci.failed.on.${URL}:.https://ci/1 open failure
cancelled ${EX_FAILED} ci.failed.on open cancelled
closed ${EX_FAILED} ${URL}.was.closed.without.merging closed -
timeout ${EX_TIMEOUT} still.open.after open success
EOF

# An open pull request for the branch is reused; --no-auto only opens,
# and warns that nothing asks cgwalters, unless --no-ask.
setup
open_pr
run "reused" 0 "reusing ${URL}" --no-auto
! called "POST" || fail "reused: opened another"
! called "pr merge" || fail "--no-auto: enabled auto-merge"
run "no ask warns" 0 "warning: nothing puts ${URL} in cgwalters' review queue" --no-auto
run "--no-ask" 0 "reusing ${URL}" --no-auto --no-ask
! grep -q "warning" <<<"${out}" || fail "--no-ask: warned:"$'\n'"${out}"
test ! -e "${FAKE_GH}/board" || fail "no ask: bot-board ran"

# --ask opens a review ask pinning the pushed head, and implies --no-auto.
setup
run "ask" 0 "asked cgwalters to review it: https://github.com/cgwalters-forge/tracker/issues/200" --ask "Approve it" --blocks "${BLOCKS}"
HEAD=$(git -C "${WORKTREE}" rev-parse HEAD)
test "$(cat "${FAKE_GH}/board")" = "question
${BLOCKS}
Approve it
--review
${URL}@${HEAD}
--title
Review acme/proj#5: topic: Change 1" || fail "ask: bot-board ran with:"$'\n'"$(cat "${FAKE_GH}/board")"
! called "pr merge" || fail "--ask: enabled auto-merge"
! called "tracker/issues" || fail "--ask: looked for the asks of a new pull request"

# ask_at SHA: pull request 5 is open, with an open review ask pinning SHA
# (and another pull request has one too).
ask_at() {
    open_pr
    jq -n --arg body "Blocks: ${BLOCKS}"$'\n\n'"Ask: x"$'\n'"Review: \`${URL}\` at $1"$'\n' \
        '[{html_url: "https://github.com/cgwalters-forge/tracker/issues/199", body: $body},
          {html_url: "https://github.com/cgwalters-forge/tracker/issues/198",
           body: "Review: `https://github.com/acme/proj/pull/55` at 0000000000000000000000000000000000000000"}]' \
        >"${FAKE_GH}/asks.json"
}
readonly OLD=1111111111111111111111111111111111111111

# On a reused pull request, an ask at the head is kept...
setup
ask_at "$(git -C "${WORKTREE}" rev-parse HEAD)"
run "ask kept" 0 "in cgwalters' review queue: https://github.com/cgwalters-forge/tracker/issues/199$" --ask "Approve it" --blocks "${BLOCKS}"
test ! -e "${FAKE_GH}/board" || fail "ask kept: opened another"
! grep -qE "stale|issues/198" <<<"${out}" || fail "ask kept:"$'\n'"${out}"
# ... and one at an older head is stale; --ask opens a new one.
setup
ask_at "${OLD}"
run "ask stale" 0 "issues/199 is stale: it pins 111111111111, .* a new one follows" --ask "Approve it" --blocks "${BLOCKS}"
test -e "${FAKE_GH}/board" || fail "ask stale: no new ask"
setup
ask_at "${OLD}"
run "ask stale, --no-ask" 0 "issues/199 is stale: .* ask again with --ask" --no-auto --no-ask
test ! -e "${FAKE_GH}/board" || fail "ask stale, --no-ask: opened an ask"

# A failed ask says what to retry.
setup
touch "${FAKE_GH}/board-fails"
run "ask fails" 1 "opened ${URL}, but not its review ask; retry: bot-land --repo acme/proj --ask 'Approve it' --blocks ${BLOCKS}$" --ask "Approve it" --blocks "${BLOCKS}"

# Without --no-auto, a pull request waiting for cgwalters isn't auto-merged.
setup
ask_at "${OLD}"
run "auto with an ask" "${EX_USAGE}" "${URL} waits for cgwalters' approval \\(https://github.com/cgwalters-forge/tracker/issues/199\\), so not enabling auto-merge"
! called "pr merge" || fail "auto with an ask: enabled auto-merge"

# Refusals: several commits without a title, main itself, nothing to land.
setup 2
run "no title" "${EX_USAGE}" "2 commits: pass --title"
setup
git -C "${WORK}/shared" checkout -q --detach && git -C "${WORKTREE}" checkout -q main
run "on main" "${EX_USAGE}" "on main itself"
setup 0
run "empty" "${EX_USAGE}" "has no commits over origin/main"
run "usage" "${EX_USAGE}" "unexpected argument" --bogus
run "--ask without --blocks" "${EX_USAGE}" "--ask and --blocks go together" --ask x
run "--ask and --no-ask" "${EX_USAGE}" "contradict" --ask x --blocks "${BLOCKS}" --no-ask
run "--no-ask with auto-merge" "${EX_USAGE}" "--no-ask goes with --no-auto" --no-ask

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-land opens or reuses the pull request, auto-merges and waits, rebases when main moves, stops on failures, fast-forwards the shared clone, and asks cgwalters to review"

#!/usr/bin/env bash
# Offline tests of bin/bot-land: it opens (or reuses) the pull request,
# enables auto-merge, waits, rebases when main moved on, stops on a
# failed ci check or a closed pull request, and fast-forwards the shared
# clone once merged; with --no-auto, it requests cgwalters' review
# instead, unless he approved the head. A local bare repository is
# origin, and a fake gh answers from files. No network.
#   tests/bot-land.sh
set -euo pipefail
shopt -s inherit_errexit

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_GIT=${TESTS}/../bin/bot-git
readonly REPO=acme/proj BRANCH=bot/topic URL=https://github.com/acme/proj/pull/5
readonly EX_USAGE=2 EX_FAILED=3 EX_TIMEOUT=4

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-land-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh BOT_LAND_POLL_SECONDS=0
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

# bot-land runs the bot-board next to it: a copy of it sits next to a
# fake one, which logs its calls to $FAKE_GH/board and fails if
# $FAKE_GH/board-fails exists.
readonly TOOL=${WORK}/land/bot-land
mkdir -p "${WORK}/land"
cp "${TESTS}/../bin/bot-land" "${TOOL}"
# It loads the operator config (the default one here) from ../lib.
mkdir -p "${WORK}/lib" && cp "${TESTS}/../lib/operator.js" "${WORK}/lib/"
ln -s "$(cd "${TESTS}/../bin" && pwd)/bot-git" "${WORK}/land/bot-git"
cat >"${WORK}/land/bot-board" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test ! -e "${FAKE_GH}/board-fails" || { echo "error: rate limited" 1>&2; exit 75; }
printf '%s\n' "$*" >>"${FAKE_GH}/board"
test "$1" != add || echo PVTI_land
EOF
chmod +x "${WORK}/land/bot-board"

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# The fake gh. $FAKE_GH holds: open.json (the open pull requests for the
# branch), polls/ (the successive answers for pull request 5, the last
# one repeating; a poll whose answer is merged runs on-merge first),
# rules.json (the rules of main), checks-NAME.json (the runs of check
# NAME, none if missing), reviews.json (the reviews of pull request 5),
# body (the body of the pull request opened) and calls (every call);
# requesting a review fails when request-fails exists.
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
        echo '{"number": 5, "html_url": "https://github.com/acme/proj/pull/5"}' ;;
    "pr merge 5 --repo acme/proj --auto --rebase") ;;
    "api repos/acme/proj/pulls/5")
        mapfile -t polls < <(ls "${FAKE_GH}/polls")
        f=${FAKE_GH}/polls/${polls[0]}
        sed "s/@HEAD@/$(git rev-parse HEAD)/" "${f}" >"${FAKE_GH}/answer"
        test "${#polls[@]}" -eq 1 || rm "${f}"
        if jq -e .merged "${FAKE_GH}/answer" >/dev/null; then "${FAKE_GH}/on-merge"; fi
        cat "${FAKE_GH}/answer" ;;
    "api repos/acme/proj/rules/branches/main") cat "${FAKE_GH}/rules.json" ;;
    "api repos/acme/proj/commits/"*"/check-runs?check_name="*)
        f=${FAKE_GH}/checks-${2##*check_name=}.json
        if test -e "${f}"; then cat "${f}"; else echo '{"check_runs": []}'; fi ;;
    "api --paginate repos/acme/proj/pulls/5/reviews?per_page=100 --jq "*) jq -r "${!#}" "${FAKE_GH}/reviews.json" ;;
    "api --silent -X POST repos/acme/proj/pulls/5/requested_reviewers -f reviewers[]=cgwalters")
        test ! -e "${FAKE_GH}/request-fails" || { echo "Reviews may only be requested from collaborators." 1>&2; exit 1; } ;;
    *) echo "fake gh: unexpected: $*" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

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
    echo '[]' >"${FAKE_GH}/reviews.json"
    # Like homegit's: the required-checks gate, besides other rules.
    jq -n '[{type: "pull_request"}, {type: "required_status_checks",
        parameters: {required_status_checks: [{context: "required-checks", integration_id: 15368}]}}]' >"${FAKE_GH}/rules.json"
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

# run NAME STATUS PATTERN ARGS...: run the tool in the worktree; fail NAME
# unless it exits with STATUS and its output matches PATTERN.
run() {
    local name=$1 expected=$2 pattern=$3 status=0 out
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

# Stops, and waits no longer, on a failed required check (ci when the
# rules require none), a closed pull request, or the timeout; checks the
# rules don't require don't count, nor runs of another head.
while read -r name status pattern polls check conclusion rules; do
    setup
    i=0
    for p in ${polls}; do i=$((i + 1)); poll "${i}" "${p}"; done
    test "${conclusion}" = - || echo "{\"check_runs\": [{\"status\": \"completed\", \"conclusion\": \"${conclusion}\", \"html_url\": \"https://ci/1\"}]}" >"${FAKE_GH}/checks-${check}.json"
    test "${rules}" = - || echo "${rules}" >"${FAKE_GH}/rules.json"
    run "${name}" "${status}" "${pattern}" --timeout 0.001
done <<EOF
failed ${EX_FAILED} required.check.failed.on.${URL}:.required-checks.https://ci/1 open required-checks failure -
cancelled ${EX_FAILED} required.check.failed.on open required-checks cancelled -
not-required ${EX_TIMEOUT} still.open.after open lint failure -
no-rules ${EX_FAILED} required.check.failed.on.${URL}:.ci.https://ci/1 open ci failure []
closed ${EX_FAILED} ${URL}.was.closed.without.merging closed - - -
timeout ${EX_TIMEOUT} still.open.after open required-checks success -
EOF

# --no-auto opens without auto-merge and requests cgwalters' review...
readonly REQUEST="requested_reviewers -f reviewers[]=cgwalters"
setup
run "no-auto" 0 "requested cgwalters' review of ${URL}" --no-auto
called "POST repos/acme/proj/pulls -f" || fail "no-auto: didn't open"
called "${REQUEST}" || fail "no-auto: no review request"
! called "pr merge" || fail "--no-auto: enabled auto-merge"
test "$(cat "${FAKE_GH}/board")" = "add ${URL}"$'\n'"set PVTI_land --status Draft" ||
    fail "--no-auto: board calls: $(cat "${FAKE_GH}/board")"
# The board failing only warns: the pull request is open.
setup
touch "${FAKE_GH}/board-fails"
run "board fails" 0 "warning: cannot add ${URL} to the board: error: rate limited; put it on the board by hand" --no-auto
# Auto-merged ones stay off the board.
setup
poll 1 merged
run "merged, off the board" 0 "merged ${URL}"
test ! -e "${FAKE_GH}/board" || fail "auto-merge: board calls: $(cat "${FAKE_GH}/board")"

# open_pr [LOGIN]: pull request 5 is already open for the branch, with
# LOGIN's review requested.
open_pr() {
    jq -n --arg url "${URL}" --arg r "${1:-}" \
        '[{number: 5, html_url: $url, requested_reviewers: [$r | select(. != "") | {login: .}]}]' >"${FAKE_GH}/open.json"
}
# reviewed STATE@SHA...: cgwalters' reviews of pull request 5, oldest
# first (SHA "head" is the worktree's HEAD), plus one by someone else.
reviewed() {
    local r head
    head=$(git -C "${WORKTREE}" rev-parse HEAD)
    for r in "$@"; do
        jq -n --arg s "${r%@*}" --arg c "${r#*@}" --arg head "${head}" \
            '{user: {login: "cgwalters"}, state: $s, commit_id: (if $c == "head" then $head else $c end)}'
    done | jq -s '. + [{user: {login: "someone"}, state: "APPROVED", commit_id: "x"}]' >"${FAKE_GH}/reviews.json"
}
readonly OLD=1111111111111111111111111111111111111111

# ... on a reused pull request too, again after a push: GitHub dropped
# the request when he reviewed an older head or asked for changes, ...
while read -r name reviews; do
    setup
    open_pr
    # shellcheck disable=SC2086 # several reviews, or none
    reviewed ${reviews}
    run "reused, ${name}" 0 "reusing ${URL}" --no-auto
    ! called "POST repos/acme/proj/pulls -f" || fail "reused, ${name}: opened another"
    called "${REQUEST}" || fail "reused, ${name}: no review request"
done <<EOF
unreviewed
approved-older APPROVED@${OLD}
changes-requested-older CHANGES_REQUESTED@${OLD}
dismissed APPROVED@head DISMISSED@head
EOF
# ... but not once he approved the head (a later comment doesn't count),
setup
open_pr
reviewed APPROVED@head COMMENTED@head
run "approved" 0 "cgwalters already approved [0-9a-f]{12}; not requesting their review" --no-auto
! called "${REQUEST}" || fail "approved: requested a review"
# ... or asked for changes on it (the bot's turn),
setup
open_pr
reviewed APPROVED@${OLD} CHANGES_REQUESTED@head
run "changes requested" 0 "cgwalters requested changes on [0-9a-f]{12}; not requesting their review" --no-auto
! called "${REQUEST}" || fail "changes requested: requested a review"
# ... nor with --no-review.
setup
open_pr
run "--no-review" 0 "reusing ${URL}" --no-auto --no-review
! called "${REQUEST}" || fail "--no-review: requested a review"

# A failed request says why and what to retry.
setup
touch "${FAKE_GH}/request-fails"
run "request fails" 1 "is open, but couldn't request cgwalters' review \(are they a collaborator on acme/proj\?\): Reviews may only be requested from collaborators.\. Retry: bot-land --repo acme/proj --no-auto$" --no-auto

# Without --no-auto, a pull request waiting for his review isn't auto-merged.
setup
open_pr cgwalters
run "auto, review requested" "${EX_USAGE}" "${URL} waits for cgwalters' review, so not enabling auto-merge"
! called "pr merge" || fail "auto, review requested: enabled auto-merge"
# ... nor one he asked changes on, at any head (GitHub dropped the request),
setup
open_pr
reviewed CHANGES_REQUESTED@${OLD}
run "auto, changes requested" "${EX_USAGE}" "${URL} has changes requested in cgwalters' review, so not enabling auto-merge"
! called "pr merge" || fail "auto, changes requested: enabled auto-merge"
# ... while one he approved, or never reviewed, auto-merges.
while read -r name reviews; do
    setup
    open_pr
    # shellcheck disable=SC2086 # several reviews, or none
    reviewed ${reviews}
    poll 1 merged
    run "auto, ${name}" 0 "merged ${URL}"
done <<EOF
unreviewed
approved CHANGES_REQUESTED@${OLD} APPROVED@head
EOF

# Refusals: several commits without a title, main itself, nothing to land.
setup 2
run "no title" "${EX_USAGE}" "2 commits: pass --title"
setup
git -C "${WORK}/shared" checkout -q --detach && git -C "${WORKTREE}" checkout -q main
run "on main" "${EX_USAGE}" "on main itself"
setup 0
run "empty" "${EX_USAGE}" "has no commits over origin/main"
run "usage" "${EX_USAGE}" "unexpected argument" --bogus
run "--no-review with auto-merge" "${EX_USAGE}" "--no-review goes with --no-auto" --no-review

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-land opens or reuses the pull request, auto-merges and waits, rebases when main moves, stops on failures, fast-forwards the shared clone, and requests cgwalters' review"

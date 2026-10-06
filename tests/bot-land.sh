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
mkdir -p "${WORK}/lib" && cp "${TESTS}/../lib/operator.js" "${TESTS}/../lib/midstream.js" "${WORK}/lib/"
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
# parent.json (the pull requests of bot/parent, the branch stacked on),
# body (the body of the pull request opened) and calls (every call);
# requesting a review fails when request-fails exists.
mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GH}/calls"
case "$*" in
    "api repos/acme/proj") if test -e "${FAKE_GH}/repo.json"; then cat "${FAKE_GH}/repo.json"; else echo '{"default_branch": "main"}'; fi ;;
    "api repos/acme/proj/pulls?state=open&head=acme%3Abot%2Ftopic") cat "${FAKE_GH}/open.json" ;;
    "api repos/acme/proj/pulls?state=all&head=acme%3Abot%2Fparent") cat "${FAKE_GH}/parent.json" ;;
    "api --silent -X PATCH repos/acme/proj/pulls/5 -f base="*) ;;
    "api -X POST repos/acme/proj/pulls -f title="*" -f head=bot/topic -f base="*" -F body=@-")
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
    echo '[]' >"${FAKE_GH}/parent.json"
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
called "title=topic: Change 1 -f head=bot/topic -f base=main -F" || fail "title: $(cat "${FAKE_GH}/calls")"
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
test "$(cat "${FAKE_GH}/board")" = "add ${URL}"$'\n'"set PVTI_land --status Draft"$'\n'"assign ${URL} operator" ||
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

# open_pr [LOGIN [BASE [BASE_SHA]]]: pull request 5 is already open for
# the branch, into BASE (default main), with LOGIN's review requested.
open_pr() {
    jq -n --arg url "${URL}" --arg r "${1:-}" --arg base "${2:-main}" --arg sha "${3:-${OLD}}" \
        '[{number: 5, html_url: $url, base: {ref: $base, sha: $sha},
           requested_reviewers: [$r | select(. != "") | {login: .}]}]' >"${FAKE_GH}/open.json"
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

# stack: the branch stacked on bot/parent, pushed to origin, whose one
# commit adds the file parent; prints that commit.
readonly PARENT=bot/parent
stack() {
    setup 0
    echo 1 >"${WORKTREE}/parent"
    git -C "${WORKTREE}" add parent
    (cd "${WORKTREE}" && "${BOT_GIT}" commit -q -m "parent: Add it" -m "Generated-by: AI")
    git -C "${WORKTREE}" push -q origin "HEAD:${PARENT}"
    git -C "${WORKTREE}" fetch -q origin
    commit "topic: Change 1"
    git -C "${WORKTREE}" rev-parse HEAD~
}
# parent_pr STATE: bot/parent's pull request 4 is open or merged.
parent_pr() {
    jq -n --arg s "$1" '[{state: (if $s == "open" then "open" else "closed" end),
        merged_at: (if $s == "merged" then "2026-10-01T00:00:00Z" else null end),
        html_url: "https://github.com/acme/proj/pull/4"}]' >"${FAKE_GH}/parent.json"
}

# Stacked on an unmerged branch: into it (one commit over it, so no
# --title needed), never auto-merged; an open pull request is reused
# whatever its base, or retargeted to --base.
while read -r name status pattern parent pr want args; do
    stack >/dev/null
    test "${parent}" = none || parent_pr "${parent}"
    test "${pr}" = none || open_pr "" "${pr}"
    test "${args}" != - || args=
    # shellcheck disable=SC2086 # several arguments, or none
    run "stacked, ${name}" "${status}" "${pattern}" ${args}
    test "${want}" = - || grep -qE -- "${want}" "${FAKE_GH}/calls" || fail "stacked, ${name}: no '${want}' in: $(cat "${FAKE_GH}/calls")"
    if test "${pr}" = none && test "${status}" = 0; then
        called "POST repos/acme/proj/pulls -f" || fail "stacked, ${name}: not opened"
    else
        ! called "POST repos/acme/proj/pulls -f" || fail "stacked, ${name}: opened another"
    fi
    case "${want}" in *PATCH*) ;; *) ! called "PATCH" || fail "stacked, ${name}: retargeted" ;; esac
    ! called "pr merge" || fail "stacked, ${name}: enabled auto-merge"
done <<EOF
opened 0 requested.cgwalters..review open none title=topic:.Change.1.-f.head=bot/topic.-f.base=bot/parent.-F --base ${PARENT} --no-auto
opened-no-parent-pr 0 requested.cgwalters..review none none base=bot/parent.-F --base ${PARENT} --no-auto
auto-refused ${EX_USAGE} stacked.on.bot/parent,.so.not.enabling.auto-merge.*pass.--no-auto open none - --base ${PARENT}
reused 0 reusing.${URL}.\(into.bot/parent\) open ${PARENT} - --no-auto
reused-auto-refused ${EX_USAGE} stacked.on.bot/parent.\(the.base.of.${URL}\) open ${PARENT} - -
retargeted-to-base 0 retargeted.${URL}.from.bot/parent.to.main open ${PARENT} PATCH.repos/acme/proj/pulls/5.-f.base=main --base main --no-auto
EOF

# Once the parent merged (its commit fixed on the way) or its branch is
# gone, retargeted to main, rebased without the parent's commit (from
# the fork point with origin/bot/parent, or with the pull request's base
# when that ref was pruned too), and auto-merged as usual.
while read -r name landed pr args; do
    PARENT_COMMIT=$(stack)
    echo "1 fixed" >"${WORK}/shared/parent"
    git -C "${WORK}/shared" add parent
    git -C "${WORK}/shared" commit -q -m "parent: Add it"
    git -C "${WORK}/shared" push -q origin main
    MERGED=$(git -C "${WORK}/shared" rev-parse HEAD)
    case "${landed}" in
        merged) parent_pr merged; pattern="bot/parent is merged in https://github.com/acme/proj/pull/4: retargeting to main" ;;
        gone | pruned) git --git-dir="${WORK}/origin.git" branch -q -D "${PARENT}"; pattern="bot/parent is gone from origin: retargeting to main" ;;
    esac
    test "${landed}" != pruned || git -C "${WORKTREE}" update-ref -d "refs/remotes/origin/${PARENT}"
    test "${pr}" = none || open_pr "" "${PARENT}" "${PARENT_COMMIT}"
    poll 1 merged
    # shellcheck disable=SC2086 # several arguments, or none
    run "landed, ${name}" 0 "${pattern}" ${args}
    if test "${pr}" = none; then
        called "-f head=bot/topic -f base=main -F" || fail "landed, ${name}: not opened into main"
    else
        called "PATCH repos/acme/proj/pulls/5 -f base=main" || fail "landed, ${name}: not retargeted"
    fi
    called "pr merge 5 --repo acme/proj --auto --rebase" || fail "landed, ${name}: no auto-merge"
    git --git-dir="${WORK}/origin.git" merge-base --is-ancestor "${MERGED}" "${BRANCH}" || fail "landed, ${name}: not rebased onto main"
    test "$(git --git-dir="${WORK}/origin.git" rev-list --count "${MERGED}..${BRANCH}")" = 1 || fail "landed, ${name}: the parent's commit wasn't dropped"
    ! git --git-dir="${WORK}/origin.git" merge-base --is-ancestor "${PARENT_COMMIT}" "${BRANCH}" || fail "landed, ${name}: still on the parent"
done <<EOF
merged merged ${PARENT}
gone gone ${PARENT}
pruned pruned ${PARENT}
explicit-base merged none --base ${PARENT}
EOF

# A midstream (the topic, or a GitHub fork with no topic) never takes a
# merge; a repository that is neither, or a real fork, does.
while read -r name status repo; do
    setup
    echo "${repo}" >"${FAKE_GH}/repo.json"
    poll 1 merged
    if test "${status}" -eq 0; then
        run "midstream ${name}" 0 "." --timeout 1
        called "pr merge 5" || fail "midstream ${name}: not landed"
    else
        run "midstream ${name}" "${status}" "is a midstream" --timeout 1
        ! called "pr merge" || fail "midstream ${name}: enabled a merge"
        ! called "-X POST repos/acme/proj/pulls" || fail "midstream ${name}: opened a PR"
    fi
done <<EOF
topic ${EX_USAGE} {"default_branch":"main","topics":["bot-midstream"]}
untagged-fork ${EX_USAGE} {"default_branch":"main","fork":true,"owner":{"login":"cgwalters-forge"}}
bot-own-fork 0 {"default_branch":"main","fork":true,"owner":{"login":"cgwalters-bot"}}
real-fork 0 {"default_branch":"main","fork":true,"topics":["bot-fork"]}
own-repo 0 {"default_branch":"main","fork":false}
EOF

# Refusals: several commits without a title, main itself, nothing to land.
setup 2
run "no title" "${EX_USAGE}" "2 commits: pass --title"
setup
git -C "${WORK}/shared" checkout -q --detach && git -C "${WORKTREE}" checkout -q main
run "on main" "${EX_USAGE}" "on main itself"
setup
run "on the base" "${EX_USAGE}" "on bot/topic itself" --base "${BRANCH}"
setup 0
run "empty" "${EX_USAGE}" "has no commits over origin/main"
run "usage" "${EX_USAGE}" "unexpected argument" --bogus
run "--no-review with auto-merge" "${EX_USAGE}" "--no-review goes with --no-auto" --no-review

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-land opens or reuses the pull request, auto-merges and waits, rebases when main moves, stops on failures, fast-forwards the shared clone, requests cgwalters' review, and stacks on and retargets off a parent branch"

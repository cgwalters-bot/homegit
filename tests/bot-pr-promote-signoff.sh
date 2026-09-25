#!/usr/bin/env bash
# Offline tests of how 'bot-pr promote' and 'bot-pr signoff' add
# cgwalters' DCO sign-off on his approval: local bare repositories stand
# in for GitHub's (acme/proj, which requires DCO, acme/dcoapp, which runs
# the DCO app without requiring its check, acme/nodco, which has neither,
# and their cgwalters-forge forks), and a fake gh answers the REST calls
# they make from fixtures and from those repositories, and records what
# they write. No network.
#   tests/bot-pr-promote-signoff.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_PR=${TESTS}/../bin/bot-pr
readonly BOT_NAME="Colin Walters" BOT_EMAIL=walters+llm@verbum.org
# The name of the bot's older commits, which promote replaces with BOT_NAME
# where it rewrites them.
readonly BOT_LEGACY_NAME=cgwalters-bot
readonly HUMAN_NAME="Colin Walters" HUMAN_EMAIL=walters@verbum.org
readonly OTHER_NAME="Other Person" OTHER_EMAIL=other@example.com
readonly SOB="Signed-off-by: ${HUMAN_NAME} <${HUMAN_EMAIL}>"
readonly TRAILER='Generated-by: https://github.com/cgwalters/#llms'

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-promote-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
readonly REMOTES=${WORK}/remotes SRC=${WORK}/src
export FAKE_GH=${WORK}/gh REMOTES
export BOT_PR_GIT_URL=file://${REMOTES}/
export XDG_CACHE_HOME=${WORK}/cache XDG_STATE_HOME=${WORK}/state
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_DATE
REAL_GIT=$(command -v git)
export REAL_GIT
export PATH=${WORK}/bin:${PATH}

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${FAKE_GH}/rest" "${FAKE_GH}/opened" "${WORK}/hooks"
# The fake gh. GETs are answered from $FAKE_GH/rest/PATH.json (query
# string ignored), except for what follows the repositories in $REMOTES:
# branches, compare, and fork PR heads (the fixture's head.sha is replaced
# by its branch's commit, frozen when it's closed, as GitHub does). Issue
# comments default to none, and POSTs to them add one by the bot. POST
# .../pulls opens an upstream PR (listed by GET .../pulls, filtered by
# head if given, and read with its commits by GET .../pulls/N), unless $FAKE_GH/fail-open exists, which it
# removes; PATCH .../pulls/N closes a fork PR. Anything else fails. Every
# call is logged to $FAKE_GH/calls.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter="" input="" fields=()
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f|-F) fields+=("$2"); shift 2 ;;
        -H) shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        --input) input=$2; shift 2 ;;
        -*) shift ;;
        *) path=${1%%\?*}; shift ;;
    esac
done
field() { local f; for f in "${fields[@]}"; do test "${f%%=*}" != "$1" || { echo "${f#*=}"; return; }; done; }
notfound() { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
# GitHub's git, not the user's hooks.
git() { command "${REAL_GIT}" -c core.hooksPath=/dev/null "$@"; }
sha() { git -C "${REMOTES}/$1" rev-parse -q --verify "refs/heads/$2" || true; }
# fork_pr FILE: a fork PR's fixture, with its head and state.
fork_pr() {
    local closed=${store}/closed_$(jq -r '"repos/\(.head.repo.full_name)/pulls/\(.number)"' "$1" | tr / _) s
    if test -e "${closed}"; then
        s=$(cat "${closed}")
    else
        s=$(sha "$(jq -r .head.repo.full_name "$1")" "$(jq -r .head.ref "$1")")
    fi
    jq --arg s "${s}" --arg state "$(test -e "${closed}" && echo closed || echo open)" \
        '.head.sha = $s | .state = $state' "$1"
}
json=""
case "${method} ${path}" in
    "GET user") json='{"login": "cgwalters-bot"}' ;;
    GET\ repos/*/git/ref/heads/*)
        repo=${path#repos/}; repo=${repo%%/git/*}
        s=$(sha "${repo}" "${path#*/git/ref/heads/}")
        test -n "${s}" || notfound
        json=$(jq -n --arg s "${s}" '{object: {sha: $s}}') ;;
    GET\ repos/*/compare/*)
        repo=${path#repos/}; repo=${repo%%/compare/*}
        spec=${path#*/compare/}; base=${spec%%...*}; head=${spec#*...}
        fork=${head%%:*}/${repo#*/}
        scratch=${store}/compare.git
        test -d "${scratch}" || git init -q --bare "${scratch}"
        git -C "${scratch}" fetch -q "${REMOTES}/${repo}" "+refs/heads/${base}:refs/b"
        git -C "${scratch}" fetch -q "${REMOTES}/${fork}" "+refs/heads/${head#*:}:refs/h"
        json=$(jq -n --argjson a "$(git -C "${scratch}" rev-list --count refs/b..refs/h)" \
            --argjson b "$(git -C "${scratch}" rev-list --count refs/h..refs/b)" '{ahead_by: $a, behind_by: $b}') ;;
    GET\ repos/*/issues/*/comments)
        json=$(cat "${store}/${path//\//_}.json" 2>/dev/null || echo '[]') ;;
    POST\ repos/*/issues/*/comments)
        f=${store}/${path//\//_}.json
        n=$(jq length "${f}" 2>/dev/null || echo 0)
        jq -n --arg body "$(field body)" --arg url "https://github.com/${path#repos/}#c${n}" \
            '{user: {login: "cgwalters-bot"}, body: $body, html_url: $url, created_at: "2026-09-25T12:00:00Z"}' |
            jq -s --slurpfile old <(cat "${f}" 2>/dev/null || echo '[]') '$old[0] + .' >"${f}.new"
        mv "${f}.new" "${f}" ;;
    GET\ repos/*/actions/runs) json='{"workflow_runs": []}' ;;
    POST\ repos/*/pulls)
        if test -e "${store}/fail-open"; then
            rm -f "${store}/fail-open"
            echo "gh: Validation Failed (HTTP 422)" 1>&2
            exit 1
        fi
        repo=${path#repos/}; repo=${repo%/pulls}
        req=$(cat "${input/#-//dev/stdin}")
        head=$(jq -r .head <<<"${req}")
        s=$(sha "${head%%:*}/${repo#*/}" "${head#*:}")
        mkdir -p "${store}/opened"
        n=$(find "${store}/opened" -name '*.json' | wc -l)
        json=$(jq --arg repo "${repo}" --arg n "$((n + 1))" --arg s "${s}" \
            '. + {repo: $repo, html_url: "https://github.com/\($repo)/pull/\($n)", head_sha: $s}' <<<"${req}")
        printf '%s\n' "${json}" >"${store}/opened/$((n + 1)).json" ;;
    GET\ repos/acme/*/pulls)
        repo=${path#repos/}; repo=${repo%/pulls}
        json=$(find "${store}/opened" -name '*.json' -exec cat {} + 2>/dev/null |
            jq -s --arg repo "${repo}" --arg head "$(field head)" '[.[] | select(.repo == $repo and ($head == "" or .head == $head)) | {html_url, head: {sha: .head_sha}}]') ;;
    GET\ repos/acme/*/pulls/*/commits)
        n=${path%/commits}; n=${n##*/}
        test -e "${store}/opened/${n}.json" || notfound
        head=$(jq -r .head "${store}/opened/${n}.json")
        fork=${head%%:*}/$(jq -r '.repo | sub(".*/"; "")' "${store}/opened/${n}.json")
        json=$(git -C "${REMOTES}/${fork}" log --reverse -z --format='%H%x00%an%x00%ae%x00%B' "main..refs/heads/${head#*:}" |
            jq -Rs 'split("\u0000") | [recurse(.[4:]; length >= 4) | select(length >= 4) | .[:4]
                | {sha: .[0], commit: {author: {name: .[1], email: .[2]}, message: .[3]}}]') ;;
    GET\ repos/acme/*/pulls/*)
        n=${path##*/}
        test -e "${store}/opened/${n}.json" || notfound
        req=$(cat "${store}/opened/${n}.json")
        head=$(jq -r .head <<<"${req}")
        fork=${head%%:*}/$(jq -r '.repo | sub(".*/"; "")' <<<"${req}")
        json=$(jq --arg s "$(sha "${fork}" "${head#*:}")" --arg fork "${fork}" '
            {user: {login: (.user // "cgwalters-bot")}, state: "open", html_url, base: {ref: .base},
             head: {ref: (.head | sub("^[^:]*:"; "")), sha: $s, repo: {full_name: $fork}}}' <<<"${req}") ;;
    PATCH\ repos/*/pulls/*)
        f=${store}/rest/${path}.json
        sha "$(jq -r .head.repo.full_name "${f}")" "$(jq -r .head.ref "${f}")" >"${store}/closed_${path//\//_}" ;;
    GET\ repos/cgwalters-forge/*/pulls/*/*)
        test -e "${store}/rest/${path}.json" || notfound
        json=$(cat "${store}/rest/${path}.json") ;;
    GET\ repos/cgwalters-forge/*/pulls/*)
        test -e "${store}/rest/${path}.json" || notfound
        json=$(fork_pr "${store}/rest/${path}.json") ;;
    GET\ repos/cgwalters-forge/*/pulls)
        head=$(field head)
        json=$(for f in "${store}/rest/${path}"/*.json; do test ! -e "${f}" || fork_pr "${f}"; done |
            jq -s --arg ref "${head#*:}" '[.[] | select(.head.ref == $ref)]') ;;
    GET\ *)
        test -e "${store}/rest/${path}.json" || notfound
        json=$(cat "${store}/rest/${path}.json") ;;
    *) echo "fake gh: refusing ${method} ${path}" 1>&2; exit 1 ;;
esac
if test -n "${filter}"; then
    jq -r "${filter}" <<<"${json}"
elif test -n "${json}"; then
    printf '%s\n' "${json}"
fi
EOF
# A git that, when $WORK/move-on-push exists, first pushes a new commit to
# the lease test's fork branch, as if someone pushed between promote's
# fetch and its own push.
cat >"${WORK}/bin/git" <<EOF
#!/usr/bin/env bash
if test -e "${WORK}/move-on-push" && [[ " \$* " == *" push "* ]]; then
    rm -f "${WORK}/move-on-push"
    "\${REAL_GIT}" -C "${SRC}" -c core.hooksPath=/dev/null switch -q bot/lease
    echo moved >>"${SRC}/lease"
    "\${REAL_GIT}" -C "${SRC}" -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -q -am moved
    "\${REAL_GIT}" -C "${SRC}" -c core.hooksPath=/dev/null push -q forge bot/lease
fi
exec "\${REAL_GIT}" "\$@"
EOF
chmod +x "${WORK}/bin/gh" "${WORK}/bin/git"

# The user's git configuration must not leak into the rewrite: failing
# hooks, and commit signing without a key.
cat >"${WORK}/hooks/pre-push" <<EOF
#!/bin/sh
touch "${WORK}/hook-ran"; exit 1
EOF
cp "${WORK}/hooks/pre-push" "${WORK}/hooks/reference-transaction"
chmod +x "${WORK}/hooks/"*
git config --global init.defaultBranch main
git config --global user.name nobody
git config --global user.email nobody@example.com

# fixture PATH: store stdin as the answer to 'gh api PATH'.
fixture() {
    mkdir -p "$(dirname "${FAKE_GH}/rest/$1")"
    cat >"${FAKE_GH}/rest/$1.json"
}

# commit_as bot|legacy|human|other[-by-human] FILE MESSAGE: commit a
# change to FILE in SRC, authored and committed by that person (legacy:
# the bot under its old name; -by-human: committed by the human, as
# promote signs off), and print its id.
commit_as() {
    local name email cname cemail
    case "${1%-by-human}" in
        bot) name=${BOT_NAME} email=${BOT_EMAIL} ;;
        legacy) name=${BOT_LEGACY_NAME} email=${BOT_EMAIL} ;;
        human) name=${HUMAN_NAME} email=${HUMAN_EMAIL} ;;
        other) name=${OTHER_NAME} email=${OTHER_EMAIL} ;;
    esac
    cname=${name} cemail=${email}
    test "$1" = "${1%-by-human}" || cname=${HUMAN_NAME} cemail=${HUMAN_EMAIL}
    echo "$3" >>"${SRC}/$2"
    git -C "${SRC}" add "$2"
    GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} GIT_COMMITTER_NAME=${cname} GIT_COMMITTER_EMAIL=${cemail} \
        git -C "${SRC}" -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -q --cleanup=verbatim -m "$3"
    git -C "${SRC}" rev-parse HEAD
}

remote_ref() {
    git -C "${REMOTES}/$1" rev-parse "refs/heads/$2"
}

all_refs() {
    local r
    for r in "${REMOTES}"/*/*; do
        git -C "${r}" for-each-ref --format="${r} %(refname) %(objectname)"
    done
}

# fork_pr REPO N BRANCH APPROVED_SHA: the fixtures of fork PR
# cgwalters-forge/REPO#N from BRANCH, into acme/REPO main, with an
# approving review by cgwalters of APPROVED_SHA.
fork_pr() {
    local fork=cgwalters-forge/$1
    jq -n --arg repo "$1" --argjson n "$2" --arg ref "$3" --arg trailer "${TRAILER}" '
        {number: $n, state: "open", title: "Change \($n)", user: {login: "cgwalters-bot"},
         html_url: "https://github.com/cgwalters-forge/\($repo)/pull/\($n)",
         base: {ref: "main"}, head: {ref: $ref, repo: {full_name: "cgwalters-forge/\($repo)"}},
         body: "Why it matters.\n\n\($trailer)\n\n<!-- bot-meta -->\n---\n- Upstream: `acme/\($repo)`, base `main`\n<!-- /bot-meta -->"}' |
        fixture "repos/${fork}/pulls/$2"
    jq -n --arg repo "$1" --argjson n "$2" --arg sha "$4" '
        [{user: {login: "someone"}, state: "APPROVED", id: 1, commit_id: $sha, submitted_at: "2026-09-25T10:00:00Z",
          html_url: "https://github.com/cgwalters-forge/\($repo)/pull/\($n)#pullrequestreview-1", body: ""},
         {user: {login: "cgwalters"}, state: "APPROVED", id: ($n * 100), commit_id: $sha, submitted_at: "2026-09-25T11:00:00Z",
          html_url: "https://github.com/cgwalters-forge/\($repo)/pull/\($n)#pullrequestreview-\($n * 100)", body: "Nice"}]' |
        fixture "repos/${fork}/pulls/$2/reviews"
    echo '[]' | fixture "repos/${fork}/pulls/$2/comments"
}

# --- The repositories and fork PRs ---
for r in acme/proj acme/nodco acme/dcoapp cgwalters-forge/proj cgwalters-forge/nodco cgwalters-forge/dcoapp; do
    git init -q --bare "${REMOTES}/${r}"
    # The failing hooks are the local user's, not GitHub's.
    git -C "${REMOTES}/${r}" config core.hooksPath /dev/null
    git -C "${REMOTES}/${r}" config uploadpack.allowFilter true
done
git init -q "${SRC}"
git -C "${SRC}" remote add up "file://${REMOTES}/acme/proj"
git -C "${SRC}" remote add forge "file://${REMOTES}/cgwalters-forge/proj"
git -C "${SRC}" remote add nodco "file://${REMOTES}/cgwalters-forge/nodco"
git -C "${SRC}" remote add app "file://${REMOTES}/cgwalters-forge/dcoapp"
BASE=$(commit_as other README base)
for r in up forge nodco app; do
    git -C "${SRC}" push -q "${r}" HEAD:main
done
git -C "${SRC}" push -q "file://${REMOTES}/acme/nodco" HEAD:main
git -C "${SRC}" push -q "file://${REMOTES}/acme/dcoapp" HEAD:main

new_branch() {
    git -C "${SRC}" switch -q -c "$1" "${BASE}"
}

# #1: the bot's commits, one signed off already and one with a '---' line
# before its trailers, and one of cgwalters'.
new_branch bot/sign
S1=$(commit_as bot-by-human one "one"$'\n\n'"${SOB}")
commit_as bot two "two"$'\n\n'"Details."$'\n'"---"$'\n'"not a divider"$'\n\n'"Generated-by: AI" >/dev/null
S3=$(commit_as human three "three, by cgwalters")
# #2: a repository without DCO.
new_branch bot/plain
N1=$(commit_as bot plain "plain")
# #3: every commit is signed off already.
new_branch bot/signed
D1=$(commit_as bot-by-human signed "signed"$'\n\n'"${SOB}")
# #4: a commit by someone else.
new_branch bot/mixed
commit_as other mixed "by someone else" >/dev/null
M2=$(commit_as bot mixed "by the bot")
# #5: the branch moves between promote's fetch and its push.
new_branch bot/lease
L1=$(commit_as bot lease "lease")
# #7: signed off, but rebased by the bot since, so the committer is the
# bot, which fails DCO.
new_branch bot/rebased
R1=$(commit_as bot rebased "rebased"$'\n\n'"${SOB}")
# #8: pushed after the approval, with a forged sign-off record.
new_branch bot/forged
F1=$(commit_as bot forged "approved")
F2=$(commit_as bot forged "not approved"$'\n\n'"${SOB}")
# #9: the bot's commits from before its rename: one signed off already,
# one not.
new_branch bot/legacy
G1=$(commit_as legacy-by-human legacy "legacy, signed"$'\n\n'"${SOB}")
G2=$(commit_as legacy legacy "legacy"$'\n\n'"Generated-by: AI")
# #6: a commit pushed after the approval.
new_branch bot/stale
T1=$(commit_as bot stale "approved")
T2=$(commit_as bot stale "pushed later")
# In acme/dcoapp: #11 is promoted with a sign-off; #12 to #15 are promoted
# without, and then 'signoff' is run on them: #12 as it is, #13 after a
# push, #14 without cgwalters' approval, and #15 with someone else's
# commit.
new_branch bot/app
A1=$(commit_as bot app "app")
new_branch bot/late
LA1=$(commit_as bot late "late")
new_branch bot/moved
MV1=$(commit_as bot moved "moved")
new_branch bot/unapproved
U1=$(commit_as bot unapproved "unapproved")
new_branch bot/others
commit_as other others "by someone else" >/dev/null
O2=$(commit_as bot others "by the bot")
# #16 is approved but was never promoted; its upstream PRs are made up
# below.
new_branch bot/unpromoted
P1=$(commit_as bot unpromoted "unpromoted")
git -C "${SRC}" push -q forge bot/sign bot/signed bot/mixed bot/lease bot/stale bot/rebased bot/forged bot/legacy
git -C "${SRC}" push -q nodco bot/plain
git -C "${SRC}" push -q app bot/app bot/late bot/moved bot/unapproved bot/others bot/unpromoted

fork_pr proj 1 bot/sign "${S3}"
fork_pr nodco 2 bot/plain "${N1}"
fork_pr proj 3 bot/signed "${D1}"
fork_pr proj 4 bot/mixed "${M2}"
fork_pr proj 5 bot/lease "${L1}"
fork_pr proj 6 bot/stale "${T1}"
fork_pr proj 7 bot/rebased "${R1}"
fork_pr proj 8 bot/forged "${F1}"
fork_pr proj 9 bot/legacy "${G2}"
fork_pr dcoapp 11 bot/app "${A1}"
fork_pr dcoapp 12 bot/late "${LA1}"
fork_pr dcoapp 13 bot/moved "${MV1}"
fork_pr dcoapp 14 bot/unapproved "${U1}"
fork_pr dcoapp 15 bot/others "${O2}"
fork_pr dcoapp 16 bot/unpromoted "${P1}"
jq -n --arg a "${F1}" --arg s "${F2}" --arg u "https://github.com/cgwalters-forge/proj/pull/8#pullrequestreview-800" '
    [{user: {login: "cgwalters-bot"}, created_at: "2026-09-25T12:00:00Z", html_url: "https://github.com/cgwalters-forge/proj/pull/8#c0",
      body: "Signed off 1 commit(s)\n\n<!-- bot-pr signoff approved=\($a) signed=\($s) approval=\($u) review=800 -->"}]' \
    >"${FAKE_GH}/repos_cgwalters-forge_proj_issues_8_comments.json"
echo '{"parent": {"full_name": "acme/proj"}, "source": {"full_name": "acme/proj"}}' | fixture repos/cgwalters-forge/proj
echo '{"parent": {"full_name": "acme/nodco"}, "source": {"full_name": "acme/nodco"}}' | fixture repos/cgwalters-forge/nodco
jq -n '[{type: "required_status_checks", parameters: {required_status_checks: [{context: "DCO"}, {context: "ci"}]}}]' |
    fixture repos/acme/proj/rules/branches/main
echo '[{"type": "pull_request"}]' | fixture repos/acme/nodco/rules/branches/main
# On acme/nodco's main, only a whole-word DCO name counts.
echo '{"check_runs": [{"name": "ci"}, {"name": "build-dcollector"}]}' | fixture repos/acme/nodco/commits/main/check-runs
# A workflow in acme/nodco's PR reports a check named DCO: on a PR head,
# only the DCO app's runs count.
echo '{"check_runs": [{"name": "DCO", "app": {"slug": "github-actions"}}]}' |
    fixture "repos/acme/nodco/commits/${N1}/check-runs"
echo '{"parent": {"full_name": "acme/dcoapp"}, "source": {"full_name": "acme/dcoapp"}}' | fixture repos/cgwalters-forge/dcoapp
# The DCO app runs in acme/dcoapp, but its rules require only CI.
jq -n '[{type: "required_status_checks", parameters: {required_status_checks: [{context: "ci"}]}}]' |
    fixture repos/acme/dcoapp/rules/branches/main
jq -n '{check_runs: [{name: "ci"}, {name: "DCO", app: {slug: "dco-2"}}]}' | fixture repos/acme/dcoapp/commits/main/check-runs
echo '{"path": ".github/workflows/signoff.yml"}' | fixture repos/acme/proj/contents/.github/workflows/signoff.yml

# run NAME EXPECTED_STATUS ARGS...: run bot-pr with the failing hooks and
# signing configured, output in $OUT; fail NAME if the exit status isn't
# as expected.
run() {
    local name=$1 expected=$2 status=0
    shift 2
    git config --global core.hooksPath "${WORK}/hooks"
    git config --global commit.gpgSign true
    OUT=$("${BOT_PR}" "$@" 2>&1) || status=$?
    git config --global --unset core.hooksPath
    git config --global --unset commit.gpgSign
    if test "${expected}" = ok && test "${status}" -ne 0 || test "${expected}" = fail && test "${status}" -eq 0; then
        fail "${name}: exit status ${status}, expected ${expected}; output:"$'\n'"${OUT}"
        return 1
    fi
}

# expect NAME PATTERN...: $OUT has lines matching each (extended)
# PATTERN, or with a leading '!', none.
expect() {
    local name=$1 p
    shift
    for p in "$@"; do
        if [[ "${p}" == '!'* ]]; then
            ! grep -qE -- "${p#!}" <<<"${OUT}" || fail "${name}: output matches '${p#!}':"$'\n'"${OUT}"
        else
            grep -qE -- "${p}" <<<"${OUT}" || fail "${name}: output lacks '${p}':"$'\n'"${OUT}"
        fi
    done
}

# opened HEAD: the upstream PR opened from cgwalters-forge:HEAD, if any.
opened() {
    find "${FAKE_GH}/opened" -name '*.json' -exec cat {} + 2>/dev/null | jq -sc --arg h "cgwalters-forge:$1" '[.[] | select(.head == $h)] | first // empty'
}

# author_of DIR COMMIT: its author and date, the bot's old name replaced
# by its new one.
author_of() {
    local a legacy="${BOT_LEGACY_NAME} <${BOT_EMAIL}> "
    a=$(git -C "$1" show -s --format='%an <%ae> %ad' --date=raw "$2")
    test "${a}" = "${a#"${legacy}"}" || a="${BOT_NAME} <${BOT_EMAIL}> ${a#"${legacy}"}"
    echo "${a}"
}

# same_but_signed NAME OLD NEW [FORK]: NEW is OLD, commit by commit since
# BASE in FORK (default: cgwalters-forge/proj), with the same trees,
# authors (but for the bot's old name, see author_of) and messages plus
# the sign-off, committed by cgwalters where the sign-off is new.
same_but_signed() {
    local name=$1 dir=${REMOTES}/${4:-cgwalters-forge/proj} old new i o n om nm rest
    mapfile -t old < <(git -C "${dir}" rev-list --reverse "${BASE}..$2")
    mapfile -t new < <(git -C "${dir}" rev-list --reverse "${BASE}..$3")
    test "${#old[@]}" -eq "${#new[@]}" || { fail "${name}: ${#old[@]} commits became ${#new[@]}"; return; }
    for i in "${!old[@]}"; do
        o=${old[i]} n=${new[i]}
        test "$(git -C "${dir}" rev-parse "${o}^{tree}")" = "$(git -C "${dir}" rev-parse "${n}^{tree}")" ||
            fail "${name}: the tree of commit ${i} changed"
        test "$(author_of "${dir}" "${o}")" = "$(author_of "${dir}" "${n}")" ||
            fail "${name}: the author of commit ${i} changed"
        om=$(git -C "${dir}" cat-file commit "${o}" | sed '1,/^$/d'; echo x)
        nm=$(git -C "${dir}" cat-file commit "${n}" | sed '1,/^$/d'; echo x)
        # The DCO check wants the sign-off from the author or committer.
        test "$(git -C "${dir}" show -s --format='%ae' "${n}")" = "${HUMAN_EMAIL}" ||
            test "$(git -C "${dir}" show -s --format='%cn <%ce>' "${n}")" = "${HUMAN_NAME} <${HUMAN_EMAIL}>" ||
            fail "${name}: commit ${i} is neither authored nor committed by ${HUMAN_NAME}"
        if grep -qFx "${SOB}" <<<"${om}"; then
            test "${om}" = "${nm}" || fail "${name}: the signed-off commit ${i}'s message changed"
        else
            # The old message's bytes, then only newlines and the sign-off.
            om=${om%$'\n'x} nm=${nm%x}
            rest=${nm#"${om}"}
            if test "${rest}" = "${nm}" || test "${rest//$'\n'/}" != "${SOB}"; then
                fail "${name}: commit ${i}'s message is not the old one plus the sign-off:"$'\n'"${nm}"
            fi
        fi
    done
}

readonly FORGE=cgwalters-forge/proj
readonly URL=https://github.com/cgwalters-forge

# --- Stale approval: a commit pushed after it ---
REFS_BEFORE=$(all_refs)
if run "stale" fail promote "${URL}/proj/pull/6"; then
    expect "stale" 'has commits pushed after cgwalters approved it'
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "stale: the remotes changed"
test -z "$(opened bot/stale)" || fail "stale: an upstream PR was opened"
test "$(remote_ref "${FORGE}" bot/stale)" = "${T2}" || fail "stale: the branch moved"

# --- Dry run ---
if run "dry run" ok promote "${URL}/proj/pull/1" --dry-run; then
    expect "dry run" "add '${SOB}' to the commits lacking it" \
        "on cgwalters's approval of the review draft: ${URL}/proj/pull/1#pullrequestreview-100" '!/signoff'
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "dry run: the remotes changed"

# --- Sign-off and push; opening the PR fails, then a rerun finishes ---
touch "${FAKE_GH}/fail-open"
if run "sign #1" fail promote "${URL}/proj/pull/1"; then
    expect "sign #1" "Added cgwalters's sign-off to 2 commit\(s\)" 'opening the PR in acme/proj failed'
fi
signed=$(remote_ref "${FORGE}" bot/sign)
test "${signed}" != "${S3}" || fail "sign #1: not pushed"
same_but_signed "sign #1" "${S3}" "${signed}"
test "$(git -C "${REMOTES}/${FORGE}" rev-parse "${signed}~2")" = "${S1}" || fail "sign #1: the signed-off first commit was rewritten"
test -e "${WORK}/hook-ran" && fail "sign #1: a git hook ran"
record=$(jq -r '.[-1].body' "${FAKE_GH}/repos_${FORGE//\//_}_issues_1_comments.json" 2>/dev/null || true)
grep -qF "<!-- bot-pr signoff approved=${S3} signed=${signed} approval=${URL}/proj/pull/1#pullrequestreview-100 review=100 -->" <<<"${record}" ||
    fail "sign #1: no sign-off record: ${record}"
test -z "$(opened bot/sign)" || fail "sign #1: opened despite the failure"
if run "rerun #1" ok promote "${URL}/proj/pull/1"; then
    expect "rerun #1" '!Added' 'plus his sign-off, per the bot.s record; checking that' '^https://github.com/acme/proj/pull/[0-9]+$'
fi
test "$(remote_ref "${FORGE}" bot/sign)" = "${signed}" || fail "rerun #1: pushed again"
pr=$(opened bot/sign)
test "$(jq -r .head_sha <<<"${pr}")" = "${signed}" || fail "rerun #1: the upstream PR is not from the signed-off head"
body=$(jq -r .body <<<"${pr}")
grep -qFx "The \`${SOB}\` on these commits was added on cgwalters's approval of the review draft: ${URL}/proj/pull/1#pullrequestreview-100" <<<"${body}" ||
    fail "rerun #1: the body doesn't name the approval:"$'\n'"${body}"
grep -qF '/signoff' <<<"${body}" && fail "rerun #1: the body still asks maintainers for /signoff"
test -e "${FAKE_GH}/closed_repos_${FORGE//\//_}_pulls_1" || fail "rerun #1: the fork PR wasn't closed"

# --- No DCO: nothing to sign off ---
if run "no DCO" ok promote "${URL}/nodco/pull/2"; then
    expect "no DCO" '!Added'
fi
test "$(remote_ref cgwalters-forge/nodco bot/plain)" = "${N1}" || fail "no DCO: the branch was rewritten"
body=$(opened bot/plain | jq -r .body)
test -n "${body}" || fail "no DCO: no upstream PR"
grep -qE 'Signed-off-by|DCO' <<<"${body}" && fail "no DCO: the body mentions DCO:"$'\n'"${body}"

# --- Already signed off ---
if run "signed" ok promote "${URL}/proj/pull/3"; then
    expect "signed" '!Added'
fi
test "$(remote_ref "${FORGE}" bot/signed)" = "${D1}" || fail "signed: the branch was rewritten"
test "$(opened bot/signed | jq -r .head_sha)" = "${D1}" || fail "signed: no upstream PR from the original head"
opened bot/signed | jq -r .body | grep -qE 'Signed-off-by|DCO|/signoff' && fail "signed: the body has a DCO line, though nothing was signed off"

# --- Signed off, but the bot's rebase made it fail DCO ---
if run "rebased" ok promote "${URL}/proj/pull/7"; then
    expect "rebased" "Added cgwalters's sign-off to 1 commit"
fi
rebased=$(remote_ref "${FORGE}" bot/rebased)
test "${rebased}" != "${R1}" || fail "rebased: not recommitted"
same_but_signed "rebased" "${R1}" "${rebased}"
opened bot/rebased | jq -r .body | grep -qF "approval of the review draft: ${URL}/proj/pull/7#pullrequestreview-700" ||
    fail "rebased: the body doesn't name the approval"

# --- The bot's old name: normalized where rewritten, and the record of
# that rewrite still checks out on a rerun ---
touch "${FAKE_GH}/fail-open"
if run "legacy name" fail promote "${URL}/proj/pull/9"; then
    expect "legacy name" "Added cgwalters's sign-off to 1 commit" 'opening the PR in acme/proj failed'
fi
legacy=$(remote_ref "${FORGE}" bot/legacy)
test "${legacy}" != "${G2}" || fail "legacy name: not pushed"
same_but_signed "legacy name" "${G2}" "${legacy}"
test "$(git -C "${REMOTES}/${FORGE}" rev-parse "${legacy}~1")" = "${G1}" || fail "legacy name: the signed-off commit was rewritten"
test "$(git -C "${REMOTES}/${FORGE}" show -s --format='%an <%ae>' "${legacy}")" = "${BOT_NAME} <${BOT_EMAIL}>" ||
    fail "legacy name: the rewritten commit's author wasn't normalized"
if run "legacy name, rerun" ok promote "${URL}/proj/pull/9"; then
    expect "legacy name, rerun" '!Added' 'plus his sign-off, per the bot.s record; checking that'
fi
test "$(opened bot/legacy | jq -r .head_sha)" = "${legacy}" || fail "legacy name: no upstream PR from the signed-off head"

# --- A forged record: the head isn't the approved one plus the sign-off ---
REFS_BEFORE=$(all_refs)
if run "forged record" fail promote "${URL}/proj/pull/8"; then
    expect "forged record" "is not ${F1:0:12}, which cgwalters approved, plus his sign-off"
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "forged record: the remotes changed"
test -z "$(opened bot/forged)" || fail "forged record: an upstream PR was opened"

# --- Someone else's commit ---
if run "mixed" fail promote "${URL}/proj/pull/4"; then
    expect "mixed" 'by someone else \(Other Person' 'rerun with --include-others'
fi
test "$(remote_ref "${FORGE}" bot/mixed)" = "${M2}" || fail "mixed: the branch was rewritten"
test -z "$(opened bot/mixed)" || fail "mixed: an upstream PR was opened"
if run "mixed, --include-others" ok promote "${URL}/proj/pull/4" --include-others; then
    same_but_signed "mixed, --include-others" "${M2}" "$(remote_ref "${FORGE}" bot/mixed)"
    test "$(opened bot/mixed | jq -r .head_sha)" = "$(remote_ref "${FORGE}" bot/mixed)" ||
        fail "mixed, --include-others: no upstream PR from the signed-off head"
fi

# --- The lease: the branch moves before promote's push ---
touch "${WORK}/move-on-push"
if run "lease" fail promote "${URL}/proj/pull/5"; then
    expect "lease" 'was refused: it is no longer at the approved'
fi
moved=$(git -C "${SRC}" rev-parse bot/lease)
test "${moved}" != "${L1}" || fail "lease: the branch didn't move"
test "$(remote_ref "${FORGE}" bot/lease)" = "${moved}" || fail "lease: the moved branch was overwritten"
test -z "$(opened bot/lease)" || fail "lease: an upstream PR was opened"

readonly APP=cgwalters-forge/dcoapp

# --- The DCO app runs, though the rules don't require its check ---
if run "DCO app" ok promote "${URL}/dcoapp/pull/11"; then
    expect "DCO app" "Added cgwalters's sign-off to 1 commit"
fi
same_but_signed "DCO app" "${A1}" "$(remote_ref "${APP}" bot/app)" "${APP}"
test "$(opened bot/app | jq -r .head_sha)" = "$(remote_ref "${APP}" bot/app)" ||
    fail "DCO app: no upstream PR from the signed-off head"

# --- signoff: an upstream PR promote opened without the sign-off ---
# upstream_url BRANCH: the upstream PR promote opened from BRANCH, after
# promoting it with --no-signoff, as promote did before it looked for DCO
# check runs.
upstream_url() {
    opened "$1" | jq -r '.html_url // empty'
}
for pr in 12:bot/late 13:bot/moved 14:bot/unapproved 15:bot/others; do
    if run "promote ${pr#*:}" ok promote "${URL}/dcoapp/pull/${pr%%:*}" --no-signoff; then
        test -n "$(upstream_url "${pr#*:}")" || fail "promote ${pr#*:}: no upstream PR"
    fi
done
LATE=$(upstream_url bot/late)
comments=${FAKE_GH}/repos_${APP//\//_}_issues_12_comments.json
ncomments=$(jq length "${comments}")
if run "signoff" ok signoff "${LATE}"; then
    expect "signoff" "Added cgwalters's sign-off to 1 commit\(s\) of ${LATE}" "^$(remote_ref "${APP}" bot/late)\$"
fi
late=$(remote_ref "${APP}" bot/late)
test "${late}" != "${LA1}" || fail "signoff: not pushed"
same_but_signed "signoff" "${LA1}" "${late}" "${APP}"
test "$(jq length "${comments}")" -eq "$((ncomments + 1))" || fail "signoff: expected one comment on the fork PR"
jq -r '.[-1].body' "${comments}" |
    grep -qF "<!-- bot-pr signoff approved=${LA1} signed=${late} approval=${URL}/dcoapp/pull/12#pullrequestreview-1200 review=1200 -->" ||
    fail "signoff: no sign-off record on the fork PR"
ls "${FAKE_GH}"/repos_acme_* >/dev/null 2>&1 && fail "signoff: commented upstream"
if run "signoff, rerun" ok signoff "${LATE}"; then
    expect "signoff, rerun" 'plus his sign-off, per the bot.s record; checking that' 'has cgwalters.s sign-off already'
fi
test "$(remote_ref "${APP}" bot/late)" = "${late}" || fail "signoff, rerun: pushed again"

# signoff_refused NAME PATTERN ARGS...: signoff ARGS fails with PATTERN,
# changing no branch.
signoff_refused() {
    local name=$1 pattern=$2 before
    shift 2
    before=$(all_refs)
    if run "${name}" fail signoff "$@"; then
        expect "${name}" "${pattern}"
    fi
    test "$(all_refs)" = "${before}" || fail "${name}: the remotes changed"
}

git -C "${SRC}" switch -q bot/moved
MV2=$(commit_as bot moved "pushed after promote")
git -C "${SRC}" push -q app bot/moved
signoff_refused "signoff, moved" "head ${MV2:0:12} is not ${MV1:0:12}, which promote opened it with" "$(upstream_url bot/moved)"
echo '[]' | fixture "repos/${APP}/pulls/14/reviews"
signoff_refused "signoff, unapproved" "has no approval by cgwalters of ${U1:0:12}" "$(upstream_url bot/unapproved)"
signoff_refused "signoff, others" "commits that aren't cgwalters-bot's" "$(upstream_url bot/others)"
test "$(opened bot/plain | jq -r .head_sha)" = "${N1}" || fail "no DCO: the spoofed check isn't on the upstream PR's head"
signoff_refused "signoff, no DCO" "neither requires nor runs a DCO check" "$(upstream_url bot/plain)"

# upstream_pr N LOGIN BRANCH: make up acme/dcoapp#N, opened by LOGIN from
# cgwalters-forge:BRANCH without promote.
upstream_pr() {
    jq -n --argjson n "$1" --arg user "$2" --arg head "cgwalters-forge:$3" '
        {repo: "acme/dcoapp", html_url: "https://github.com/acme/dcoapp/pull/\($n)", head: $head, base: "main", user: $user}' \
        >"${FAKE_GH}/opened/$1.json"
}
upstream_pr 90 cgwalters-bot bot/unpromoted
# Only the bot's word counts for what promote opened.
jq -n '[{user: {login: "someone"}, created_at: "2026-09-25T12:00:00Z", html_url: "https://github.com/x#c0",
         body: "Opened upstream as https://github.com/acme/dcoapp/pull/90. Closing this review draft."}]' \
    >"${FAKE_GH}/repos_${APP//\//_}_issues_16_comments.json"
signoff_refused "signoff, not promoted" "no PR in ${APP} says 'bot-pr promote' opened" https://github.com/acme/dcoapp/pull/90
upstream_pr 91 someone bot/unpromoted
signoff_refused "signoff, not the bot's PR" "was opened by someone, not cgwalters-bot" https://github.com/acme/dcoapp/pull/91

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: promote signs off on approval where DCO is required or runs, keeps the approval, normalizes the bot's old name, skips no-DCO and signed PRs, refuses others' commits and stale heads, and leases; signoff signs off promoted PRs only on that approval, with the same refusals"

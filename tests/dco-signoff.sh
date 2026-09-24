#!/usr/bin/env bash
# Offline tests of bin/dco-signoff: local bare repositories stand in for
# the GitHub repositories it fetches and pushes (acme/proj upstream, which
# requires DCO, acme/nodco, which doesn't, and their cgwalters-forge
# forks), and a fake gh serves REST fixtures generated from them. No
# network.
#   tests/dco-signoff.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly DCO_SIGNOFF=${TESTS}/../bin/dco-signoff
readonly BOT_NAME=cgwalters-bot BOT_EMAIL=walters+llm@verbum.org
readonly HUMAN_NAME="Test Human" HUMAN_EMAIL=human@example.com HUMAN_LOGIN=cgwalters
readonly OTHER_NAME="Other Person" OTHER_EMAIL=other@example.com
readonly SOB="Signed-off-by: ${HUMAN_NAME} <${HUMAN_EMAIL}>"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dco-signoff-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
readonly REMOTES=${WORK}/remotes SRC=${WORK}/src
export FAKE_GH=${WORK}/gh
export FAKE_GH_LOGIN=${HUMAN_LOGIN}
export XDG_CACHE_HOME=${WORK}/cache
export DCO_SIGNOFF_GIT_URL=file://${REMOTES}/
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_DATE
export PATH=${WORK}/bin:${PATH}

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${FAKE_GH}/rest" "${FAKE_GH}/hooks" "${WORK}/hooks"
# The fake gh: 'gh api PATH' answers GETs with $FAKE_GH/rest/PATH.json
# (query string ignored), filtered by --jq like gh; 'user' is
# $FAKE_GH_LOGIN. Anything else fails. $FAKE_GH/hooks/PATH (slashes as
# underscores) runs once, before PATH is answered.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter=""
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f|-F|-H) shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        -*) shift ;;
        *) test -n "${path}" || path=${1%%\?*}; shift ;;
    esac
done
test "${method}" = GET || { echo "fake gh: refusing ${method} ${path}" 1>&2; exit 1; }
hook=${store}/hooks/${path//\//_}
if test -x "${hook}"; then
    "${hook}"
    rm -f "${hook}"
fi
if test "${path}" = user; then
    json=$(jq -n --arg l "${FAKE_GH_LOGIN}" '{login: $l}')
elif test -e "${store}/rest/${path}.json"; then
    json=$(cat "${store}/rest/${path}.json")
else
    echo "gh: Not Found (HTTP 404)" 1>&2
    exit 1
fi
if test -n "${filter}"; then
    jq -r "${filter}" <<<"${json}"
else
    printf '%s\n' "${json}"
fi
EOF
chmod +x "${WORK}/bin/gh"

# The user's own git configuration must not leak into the rewrite: hooks
# that would fail, and autosquash, which would squash the 'fixup!' commit.
cat >"${WORK}/hooks/pre-push" <<EOF
#!/bin/sh
touch "${WORK}/hook-ran"; exit 1
EOF
cp "${WORK}/hooks/pre-push" "${WORK}/hooks/post-rewrite"
cp "${WORK}/hooks/pre-push" "${WORK}/hooks/reference-transaction"
chmod +x "${WORK}/hooks/"*
git config --global user.name "${HUMAN_NAME}"
git config --global user.email "${HUMAN_EMAIL}"
git config --global init.defaultBranch main
git config --global rebase.autoSquash true

# fixture PATH: store stdin as the answer to 'gh api PATH'.
fixture() {
    mkdir -p "$(dirname "${FAKE_GH}/rest/$1")"
    cat >"${FAKE_GH}/rest/$1.json"
}

# commit_as bot|human|other FILE MESSAGE: commit a change to FILE in SRC,
# authored and committed by that person, and print its id.
commit_as() {
    local name email
    case "$1" in
        bot) name=${BOT_NAME} email=${BOT_EMAIL} ;;
        human) name=${HUMAN_NAME} email=${HUMAN_EMAIL} ;;
        other) name=${OTHER_NAME} email=${OTHER_EMAIL} ;;
    esac
    echo "$3" >>"${SRC}/$2"
    git -C "${SRC}" add "$2"
    GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email} \
        git -C "${SRC}" -c core.hooksPath=/dev/null commit -q -m "$3"
    git -C "${SRC}" rev-parse HEAD
}

remote_ref() {
    git -C "${REMOTES}/$1.git" rev-parse "refs/heads/$2"
}

all_refs() {
    local r
    for r in "${REMOTES}"/*/*.git; do
        git -C "${r}" for-each-ref --format="${r} %(refname) %(objectname)"
    done
}

# pr_fixtures N BRANCH TITLE LOGIN DCO_CONCLUSION: the fixtures of PR
# acme/proj#N from cgwalters-forge:BRANCH, as they are now in REMOTES.
pr_fixtures() {
    local n=$1 branch=$2 head base c
    head=$(remote_ref cgwalters-forge/proj "${branch}")
    git -C "${SRC}" fetch -q forge
    base=$(git -C "${SRC}" merge-base "${head}" "$(remote_ref acme/proj main)")
    jq -n --argjson n "${n}" --arg ref "${branch}" --arg sha "${head}" --arg title "$3" --arg login "$4" '
        {number: $n, html_url: "https://github.com/acme/proj/pull/\($n)", title: $title,
         user: {login: $login}, maintainer_can_modify: true, base: {ref: "main"},
         head: {ref: $ref, sha: $sha, repo: {full_name: "cgwalters-forge/proj", owner: {login: "cgwalters-forge"}}}}' |
        fixture "repos/acme/proj/pulls/${n}"
    for c in $(git -C "${SRC}" rev-list --reverse "${base}..${head}"); do
        jq -n --arg sha "${c}" --arg name "$(git -C "${SRC}" show -s --format=%an "${c}")" \
            --arg email "$(git -C "${SRC}" show -s --format=%ae "${c}")" \
            --arg message "$(git -C "${SRC}" show -s --format=%B "${c}")" \
            --arg bot "${BOT_EMAIL}" --arg human "${HUMAN_EMAIL}" --arg human_login "${HUMAN_LOGIN}" '
            {sha: $sha, parents: [{}], commit: {author: {name: $name, email: $email}, message: $message},
             author: (if $email == $bot then {login: "cgwalters-bot"} elif $email == $human then {login: $human_login} else null end)}'
    done | jq -s . | fixture "repos/acme/proj/pulls/${n}/commits"
    jq -n --arg c "$5" '{check_runs: [{name: "DCO", status: "completed", conclusion: $c}]}' |
        fixture "repos/acme/proj/commits/${head}/check-runs"
}

# --- The repositories and PRs ---
for r in acme/proj acme/nodco cgwalters-forge/proj cgwalters-forge/nodco; do
    git init -q --bare "${REMOTES}/${r}.git"
    # The failing hooks are the local user's, not GitHub's.
    git -C "${REMOTES}/${r}.git" config core.hooksPath /dev/null
done
git init -q "${SRC}"
git -C "${SRC}" remote add up "file://${REMOTES}/acme/proj.git"
git -C "${SRC}" remote add forge "file://${REMOTES}/cgwalters-forge/proj.git"
BASE_A=$(commit_as human README base)
git -C "${SRC}" push -q up HEAD:main
git -C "${SRC}" push -q forge HEAD:main

# new_branch BRANCH: start BRANCH in SRC at BASE_A.
new_branch() {
    git -C "${SRC}" switch -q -c "$1" "${BASE_A}"
}

# #1: three bot commits; main then moves ahead of their base.
new_branch bot/three
commit_as bot one "one" >/dev/null
commit_as bot one "fixup! one" >/dev/null
PR1_OLD=$(commit_as bot three "three")
git -C "${SRC}" push -q forge bot/three
git -C "${SRC}" switch -q main
BASE_B=$(commit_as human README "base moves on")
git -C "${SRC}" push -q up main
# #2: already signed off.
new_branch bot/signed
commit_as bot two "two"$'\n\n'"${SOB}" >/dev/null
# #4: mixed authors, opened by cgwalters from the forge.
new_branch bot/mixed
commit_as other four "four by someone else" >/dev/null
commit_as bot four "four by the bot" >/dev/null
# #5: the remote moves between fetch and push.
new_branch bot/lease
PR5_OLD=$(commit_as bot five "five")
# #6: the first commit is already signed off, the second isn't.
new_branch bot/partial
PR6_FIRST=$(commit_as bot six "six-a"$'\n\n'"${SOB}")
PR6_OLD=$(commit_as bot six "six-b")
git -C "${SRC}" push -q forge bot/signed bot/mixed bot/lease bot/partial

pr_fixtures 1 bot/three "Three commits" cgwalters-bot action_required
pr_fixtures 2 bot/signed "Already signed" cgwalters-bot success
pr_fixtures 4 bot/mixed "Mixed authors" "${HUMAN_LOGIN}" action_required
pr_fixtures 5 bot/lease "Lease" cgwalters-bot action_required
pr_fixtures 6 bot/partial "Partly signed" cgwalters-bot action_required
jq -n '{number: 3, html_url: "https://github.com/acme/nodco/pull/3", title: "No DCO here", base: {ref: "main"},
        head: {ref: "bot/x", sha: "0000000000000000000000000000000000000000", repo: {full_name: "cgwalters-forge/nodco"}}}' |
    fixture repos/acme/nodco/pulls/3
jq -n '[{type: "required_status_checks", parameters: {required_status_checks: [{context: "DCO"}, {context: "ci"}]}}]' |
    fixture repos/acme/proj/rules/branches/main
echo '[{"type": "pull_request"}]' | fixture repos/acme/nodco/rules/branches/main
# The search finds the bot's PRs, including a fork PR inside the forge
# (never merged, so never looked at); #4 is only found as a PR from the
# forge, and #1 both ways.
jq -n '{items: ([["acme/proj", 1], ["acme/proj", 2], ["acme/nodco", 3], ["acme/proj", 5], ["acme/proj", 6],
                 ["cgwalters-forge/proj", 9]]
                | map({repository_url: "https://api.github.com/repos/\(.[0])", number: .[1]}))}' |
    fixture search/issues
echo '[{"name": "proj", "fork": true}, {"name": "nodco", "fork": true}, {"name": "notes", "fork": false}]' |
    fixture orgs/cgwalters-forge/repos
echo '{"parent": {"full_name": "acme/proj"}, "permissions": {"push": true}}' | fixture repos/cgwalters-forge/proj
echo '{"parent": {"full_name": "acme/nodco"}, "permissions": {"push": true}}' | fixture repos/cgwalters-forge/nodco
jq -s . "${FAKE_GH}/rest/repos/acme/proj/pulls/1.json" "${FAKE_GH}/rest/repos/acme/proj/pulls/4.json" |
    fixture repos/acme/proj/pulls
echo '[]' | fixture repos/acme/nodco/pulls

# run NAME EXPECTED_STATUS ARGS...: run dco-signoff with stdin from
# $INPUT, output in $OUT; fail NAME if the exit status isn't as expected.
run() {
    local name=$1 expected=$2 status=0
    shift 2
    OUT=$(git config --global core.hooksPath "${WORK}/hooks" &&
        "${DCO_SIGNOFF}" "$@" <<<"${INPUT:-}" 2>&1) || status=$?
    git config --global --unset core.hooksPath
    if test "${expected}" = ok && test "${status}" -ne 0 || test "${expected}" = fail && test "${status}" -eq 0; then
        fail "${name}: exit status ${status}, expected ${expected}; output:"$'\n'"${OUT}"
        return 1
    fi
}

# expect NAME PATTERN...: $OUT, with blanks squeezed, has lines matching
# each (extended) PATTERN, or with a leading '!', none.
expect() {
    local name=$1 p squeezed
    squeezed=$(tr -s ' ' <<<"${OUT}")
    shift
    for p in "$@"; do
        if [[ "${p}" == '!'* ]]; then
            ! grep -qE -- "${p#!}" <<<"${squeezed}" || fail "${name}: output matches '${p#!}':"$'\n'"${OUT}"
        else
            grep -qE -- "${p}" <<<"${squeezed}" || fail "${name}: output lacks '${p}':"$'\n'"${OUT}"
        fi
    done
}

# --- Discovery ---
if FAKE_GH_LOGIN=cgwalters-bot run "list-only as the bot" ok --list-only; then
    expect "list-only" \
        '^5 open PRs need DCO \(1 others don.t\)' \
        '^acme/proj#1 failure 3/3 sign cgwalters-forge:bot/three Three commits$' \
        '^acme/proj#2 success 0/1 signed ' \
        '^acme/proj#4 failure 2/2 1 by others: --include-others ' \
        '^acme/proj#5 failure 1/1 sign ' \
        '^acme/proj#6 failure 1/2 sign ' \
        '!nodco' '!#9'
fi
grep -q 'cgwalters-forge/proj/pulls/9' "${FAKE_GH}/calls" && fail "looked at a fork PR inside the forge"
if run "list-only --repo" ok --list-only --repo acme/nodco; then
    expect "list-only --repo" '^0 open PRs need DCO \(1 others don.t\)' '!acme/proj#'
fi
if run "list-only, explicit PRs" ok --list-only https://github.com/acme/proj/pull/6 acme/proj#2; then
    expect "list-only, explicit PRs" '^2 open PRs need DCO' '^acme/proj#6 ' '^acme/proj#2 ' '!#1 '
fi

# --- The bot must never sign off ---
REFS_BEFORE=$(all_refs)
if FAKE_GH_LOGIN=cgwalters-bot run "guard: gh login" fail --dry-run; then
    expect "guard: gh login" 'gh is logged in as cgwalters-bot'
fi
if GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=${BOT_EMAIL} run "guard: git email" fail --yes; then
    expect "guard: git email" "user.email is the bot's"
fi
if GIT_COMMITTER_NAME=${BOT_NAME} GIT_COMMITTER_EMAIL=${BOT_EMAIL} run "guard: committer" fail --yes; then
    expect "guard: committer" "git would commit as 'cgwalters-bot"
fi

# --- --dry-run changes nothing, and #4 is refused ---
if run "dry run" fail --dry-run; then
    expect "dry run" 'dry run: would push [0-9a-f]+ to cgwalters-forge/proj bot/three' \
        'bot/lease' 'bot/partial' '^acme/proj#4: skipped, 1 by others: --include-others' '!push .*\[y/N\]' \
        '^error: 1 PRs not signed off'
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "--dry-run changed the remotes"

# --- Mixed authors ---
if run "mixed" fail --yes acme/proj#4; then
    expect "mixed" 'skipped, 1 by others: --include-others'
fi
if run "mixed, --include-others" ok --dry-run --include-others acme/proj#4; then
    expect "mixed, --include-others" '^ \* [0-9a-f]+ four by someone else \(Other Person' 'would push'
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "the mixed PR was pushed"

# --- The lease: the branch moves after the fetch ---
cat >"${FAKE_GH}/hooks/repos_cgwalters-forge_proj" <<EOF
#!/bin/sh
set -e
git -C "${SRC}" -c core.hooksPath=/dev/null switch -q bot/lease
echo moved >>"${SRC}/five"
git -C "${SRC}" -c core.hooksPath=/dev/null commit -q -am moved
git -C "${SRC}" -c core.hooksPath=/dev/null push -q forge bot/lease
EOF
chmod +x "${FAKE_GH}/hooks/repos_cgwalters-forge_proj"
if run "lease" fail --yes https://github.com/acme/proj/pull/5; then
    expect "lease" 'push refused: cgwalters-forge/proj bot/lease changed'
fi
moved=$(git -C "${SRC}" rev-parse bot/lease)
if test "$(remote_ref cgwalters-forge/proj bot/lease)" != "${moved}" || test "${moved}" = "${PR5_OLD}"; then
    fail "lease: the moved branch was overwritten"
fi

# --- Three commits, base moved ahead ---
if run "sign #1" ok --yes https://github.com/acme/proj/pull/1; then
    expect "sign #1" '^ \* [0-9a-f]+ fixup! one \(cgwalters-bot' 'main is at' '^ pushed: https://github.com/acme/proj/pull/1'
fi
readonly FORGE=${REMOTES}/cgwalters-forge/proj.git
new=$(remote_ref cgwalters-forge/proj bot/three)
test "${new}" != "${PR1_OLD}" || fail "sign #1: not pushed"
test "$(git -C "${FORGE}" rev-parse "${new}~3")" = "${BASE_A}" || fail "sign #1: not based on the merge-base"
git -C "${FORGE}" merge-base --is-ancestor "${BASE_B}" "${new}" 2>/dev/null && fail "sign #1: rebased onto the new base tip"
for i in 0 1 2; do
    o=$(git -C "${FORGE}" rev-parse "${PR1_OLD}~${i}")
    n=$(git -C "${FORGE}" rev-parse "${new}~${i}")
    test "$(git -C "${FORGE}" rev-parse "${o}^{tree}")" = "$(git -C "${FORGE}" rev-parse "${n}^{tree}")" ||
        fail "sign #1: tree of ${new}~${i} changed"
    fmt='%an <%ae> %ad'
    test "$(git -C "${FORGE}" show -s --format="${fmt}" --date=raw "${o}")" = \
        "$(git -C "${FORGE}" show -s --format="${fmt}" --date=raw "${n}")" || fail "sign #1: author of ${new}~${i} changed"
    test "$(git -C "${FORGE}" show -s --format='%cn <%ce>' "${n}")" = "${HUMAN_NAME} <${HUMAN_EMAIL}>" ||
        fail "sign #1: ${new}~${i} not committed by the human"
    test "$(git -C "${FORGE}" show -s --format=%B "${n}")" = "$(git -C "${FORGE}" show -s --format=%B "${o}")"$'\n\n'"${SOB}" ||
        fail "sign #1: message of ${new}~${i}: $(git -C "${FORGE}" show -s --format=%B "${n}")"
done
test -e "${WORK}/hook-ran" && fail "a git hook ran"

# --- Rerunning is a no-op once the PR is signed ---
pr_fixtures 1 bot/three "Three commits" cgwalters-bot success
REFS_BEFORE=$(all_refs)
if run "rerun #1" ok --yes acme/proj#1; then
    expect "rerun #1" '^acme/proj#1 success 0/3 signed ' '!pushed'
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "rerun #1 changed the remotes"

# --- Asking; a commit already signed off is kept ---
if INPUT=n run "#6, answered no" fail acme/proj#6; then
    expect "#6, answered no" '\[y/N\] skipped' '^ [0-9a-f]+ six-a' '^ \* [0-9a-f]+ six-b'
fi
test "$(all_refs)" = "${REFS_BEFORE}" || fail "#6 was pushed when answered no"
if INPUT=y run "#6, answered yes" ok acme/proj#6; then
    new=$(remote_ref cgwalters-forge/proj bot/partial)
    test "$(git -C "${FORGE}" rev-parse "${new}~1")" = "${PR6_FIRST}" || fail "#6: the signed-off commit was rewritten"
    if test "${new}" = "${PR6_OLD}" || test "$(git -C "${FORGE}" show -s --format=%B "${new}" | grep -cFx "${SOB}")" != 1; then
        fail "#6: the second commit is not signed off once"
    fi
fi

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: dco-signoff discovery, guards, dry run, lease, mixed authors and sign-off"

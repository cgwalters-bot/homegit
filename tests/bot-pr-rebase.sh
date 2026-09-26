#!/usr/bin/env bash
# Offline tests of 'bot-pr rebase': local bare repositories stand in for
# GitHub's (acme/proj upstream, its cgwalters-forge fork and the bot's
# own), and a fake gh answers the REST calls rebase makes from fixtures
# and from those repositories, and records the comments it posts. No
# network.
#   tests/bot-pr-rebase.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_PR=${TESTS}/../bin/bot-pr
readonly BOT_NAME="Colin Walters" BOT_EMAIL=walters+llm@verbum.org
readonly HUMAN_NAME="Colin Walters" HUMAN_EMAIL=walters@verbum.org
readonly OTHER_NAME="Other Person" OTHER_EMAIL=other@example.com
readonly SOB="Signed-off-by: ${HUMAN_NAME} <${HUMAN_EMAIL}>"
readonly AI="Generated-by: AI"
readonly TRAILER='Generated-by: https://github.com/cgwalters/#llms'
readonly EX_CONFLICT=10

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-rebase-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
readonly REMOTES=${WORK}/remotes SRC=${WORK}/src
export FAKE_GH=${WORK}/gh REMOTES
export BOT_PR_GIT_URL=file://${REMOTES}/
export XDG_CACHE_HOME=${WORK}/cache XDG_STATE_HOME=${WORK}/state
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_DATE
export PATH=${WORK}/bin:${PATH}
git config --global init.defaultBranch main
git config --global user.name nobody
git config --global user.email nobody@example.com

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${FAKE_GH}/rest"
# The fake gh. GETs of PRs are answered from $FAKE_GH/rest/PATH.json with
# head.sha set to its branch's commit; their commits and compare from the
# repositories in $REMOTES; reviews and comments default to none, and
# anything else from a fixture. POST .../merge-upstream syncs a fork's
# main with acme/proj's, and POSTed issue comments are kept in
# $FAKE_GH/comments. Anything else fails. Every call is logged to
# $FAKE_GH/calls.
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
        --jq) filter=$2; shift 2 ;;
        -*) shift ;;
        *) path=${1%%\?*}; shift ;;
    esac
done
field() { local f; for f in "${fields[@]}"; do test "${f%%=*}" != "$1" || { echo "${f#*=}"; return; }; done; }
notfound() { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
git() { command git -c core.hooksPath=/dev/null "$@"; }
sha() { git -C "${REMOTES}/$1" rev-parse -q --verify "refs/heads/$2" || true; }
# fetch_pair BASE_REPO BASE HEAD_REPO HEAD: both into a scratch repository,
# as refs/b and refs/h.
fetch_pair() {
    local scratch=${store}/scratch.git
    test -d "${scratch}" || git init -q --bare "${scratch}"
    git -C "${scratch}" fetch -q "${REMOTES}/$1" "+refs/heads/$2:refs/b"
    git -C "${scratch}" fetch -q "${REMOTES}/$3" "+refs/heads/$4:refs/h"
    echo "${scratch}"
}
json=""
case "${method} ${path}" in
    "GET user") json='{"login": "cgwalters-bot"}' ;;
    GET\ repos/*/git/ref/heads/*)
        repo=${path#repos/}; repo=${repo%%/git/*}
        s=$(sha "${repo}" "${path#*/git/ref/heads/}")
        test -n "${s}" || notfound
        json=$(jq -n --arg s "${s}" '{object: {sha: $s}}') ;;
    POST\ repos/*/merge-upstream)
        repo=${path#repos/}; repo=${repo%/merge-upstream}
        git -C "${REMOTES}/acme/proj" push -q "${REMOTES}/${repo}" "main:refs/heads/$(field branch)"
        json='{}' ;;
    GET\ repos/*/compare/*)
        repo=${path#repos/}; repo=${repo%%/compare/*}
        spec=${path#*/compare/}; base=${spec%%...*}; head=${spec#*...}
        scratch=$(fetch_pair "${repo}" "${base}" "${head%%:*}/${repo#*/}" "${head#*:}")
        json=$(jq -n --argjson a "$(git -C "${scratch}" rev-list --count refs/b..refs/h)" \
            --argjson b "$(git -C "${scratch}" rev-list --count refs/h..refs/b)" '{ahead_by: $a, behind_by: $b}') ;;
    GET\ repos/*/pulls/*/commits)
        f=${store}/rest/${path%/commits}.json
        test -e "${f}" || notfound
        scratch=$(fetch_pair "$(jq -r .base.repo.full_name "${f}")" "$(jq -r .base.ref "${f}")" \
            "$(jq -r .head.repo.full_name "${f}")" "$(jq -r .head.ref "${f}")")
        json=$(git -C "${scratch}" log --reverse -z --format='%H%x00%an%x00%ae%x00%B' refs/b..refs/h |
            jq -Rs 'split("\u0000") | [recurse(.[4:]; length >= 4) | select(length >= 4) | .[:4]
                | {sha: .[0], commit: {author: {name: .[1], email: .[2]}, message: .[3]}}]') ;;
    GET\ repos/*/pulls/*/reviews|GET\ repos/*/pulls/*/comments|GET\ repos/*/issues/*/comments)
        json=$(cat "${store}/rest/${path}.json" 2>/dev/null || echo '[]') ;;
    GET\ repos/*/pulls/*)
        f=${store}/rest/${path}.json
        test -e "${f}" || notfound
        json=$(jq --arg s "$(sha "$(jq -r .head.repo.full_name "${f}")" "$(jq -r .head.ref "${f}")")" '.head.sha = $s' "${f}") ;;
    POST\ repos/*/issues/*/comments)
        printf '%s %s\n' "${path}" "$(printf '%s' "$(field body)" | jq -Rsc .)" >>"${store}/comments"
        json='{}' ;;
    GET\ repos/*/actions/runs) json='{"workflow_runs": []}' ;;
    GET\ repos/*/pulls) json='[]' ;;
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
chmod +x "${WORK}/bin/gh"

# fixture PATH: store stdin as the answer to 'gh api PATH'.
fixture() {
    mkdir -p "$(dirname "${FAKE_GH}/rest/$1")"
    cat >"${FAKE_GH}/rest/$1.json"
}

# commit_as WHO FILE MESSAGE [CONTENT]: commits CONTENT (default: MESSAGE,
# appended) to FILE in SRC as WHO: bot, human, other, or bot-by-human (the
# bot's commit committed by cgwalters, as promote signs off).
commit_as() {
    local name email cname cemail
    case "${1%-by-human}" in
        bot) name=${BOT_NAME} email=${BOT_EMAIL} ;;
        human) name=${HUMAN_NAME} email=${HUMAN_EMAIL} ;;
        other) name=${OTHER_NAME} email=${OTHER_EMAIL} ;;
    esac
    cname=${name} cemail=${email}
    test "$1" = "${1%-by-human}" || cname=${HUMAN_NAME} cemail=${HUMAN_EMAIL}
    if test $# -ge 4; then
        printf '%s\n' "$4" >"${SRC}/$2"
    else
        echo "$3" >>"${SRC}/$2"
    fi
    git -C "${SRC}" add "$2"
    GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} GIT_COMMITTER_NAME=${cname} GIT_COMMITTER_EMAIL=${cemail} \
        git -C "${SRC}" -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -q --cleanup=verbatim -m "$3"
}

for r in acme/proj cgwalters-forge/proj cgwalters-bot/proj; do
    git init -q --bare "${REMOTES}/${r}"
    git -C "${REMOTES}/${r}" config uploadpack.allowFilter true
done
git init -q "${SRC}"
readonly CTX_OLD=$'a\nb\nc\nd\ne\nf\ng\nh'
commit_as other README "base"
commit_as other ctx "context" "${CTX_OLD}"
BASE=$(git -C "${SRC}" rev-parse HEAD)
readonly BASE
for r in acme/proj cgwalters-forge/proj cgwalters-bot/proj; do
    git -C "${SRC}" push -q "file://${REMOTES}/${r}" HEAD:main
done

# pr REPO N HEAD_REPO BRANCH [AUTHOR]: the fixture of PR REPO#N from
# HEAD_REPO:BRANCH into REPO's main; a PR inside a fork (REPO is
# HEAD_REPO) gets a bot-meta section naming acme/proj.
pr() {
    jq -n --arg repo "$1" --argjson n "$2" --arg head_repo "$3" --arg ref "$4" --arg author "${5:-cgwalters-bot}" --arg trailer "${TRAILER}" '
        {number: $n, state: "open", title: "Change \($n)", user: {login: $author},
         html_url: "https://github.com/\($repo)/pull/\($n)",
         base: {ref: "main", repo: {full_name: $repo}}, head: {ref: $ref, repo: {full_name: $head_repo}},
         body: ("Why it matters.\n\n\($trailer)"
                + if $repo == $head_repo then "\n\n<!-- bot-meta -->\n---\n- Upstream: `acme/proj`, base `main`\n<!-- /bot-meta -->" else "" end)}' |
        fixture "repos/$1/pulls/$2"
}

# NAME|HEAD_REPO|WHO|FILE|MESSAGE|CONTENT: one commit per line on the
# branch bot/NAME off BASE, which its first line starts, pushed to
# HEAD_REPO (see commit_as; MESSAGE and CONTENT with \n escapes).
readonly F=cgwalters-forge/proj B=cgwalters-bot/proj
while IFS='|' read -r name repo who file msg content; do
    test -n "${name}" || continue
    git -C "${SRC}" rev-parse -q --verify "refs/heads/bot/${name}" >/dev/null ||
        git -C "${SRC}" branch -q "bot/${name}" "${BASE}"
    git -C "${SRC}" switch -q "bot/${name}"
    if test -n "${content}"; then
        commit_as "${who}" "${file}" "$(printf '%b' "${msg}")" "$(printf '%b' "${content}")"
    else
        commit_as "${who}" "${file}" "$(printf '%b' "${msg}")"
    fi
    git -C "${SRC}" push -q -f "file://${REMOTES}/${repo}" "HEAD:refs/heads/bot/${name}"
done <<EOF
plain|${F}|bot|plain|plain\n\n${AI}|
signed|${F}|bot-by-human|signed|signed\n\n${AI}\n${SOB}|
signed|${F}|bot|signed2|second\n\n${AI}|
own|${B}|human|own|own, rewritten by cgwalters\n\nAssisted-by: AI\n\n${AI}\n${SOB}|
conflict|${F}|bot|README|touches README\n\n${AI}|
others|${F}|other|others|by someone else|
others|${F}|bot|others|by the bot\n\n${AI}|
notbots|${F}|bot|notbots|notbots\n\n${AI}|
context|${F}|bot|ctx|changes line c\n\n${AI}|a\nb\nC\nd\ne\nf\ng\nh
dry|${F}|bot|dry|dry\n\n${AI}|
upstreamed|${F}|bot|upstreamed|already upstream\n\n${AI}|same
fork|${F}|bot|fork|fork\n\n${AI}|
approved|${F}|bot|approved|approved\n\n${AI}|
noai|${F}|bot|noai|no trailer|
changes|${F}|bot|changes|changes asked\n\n${AI}|
EOF
pr acme/proj 1 "${F}" bot/plain
pr acme/proj 2 "${F}" bot/signed
pr acme/proj 3 "${B}" bot/own
pr acme/proj 4 "${F}" bot/conflict
pr acme/proj 5 "${F}" bot/others
pr acme/proj 6 "${F}" bot/notbots someone
pr acme/proj 7 "${F}" bot/context
pr acme/proj 8 "${F}" bot/dry
pr acme/proj 9 "${F}" bot/upstreamed
pr "${F}" 10 "${F}" bot/fork
pr "${F}" 11 "${F}" bot/approved
pr acme/proj 12 "${F}" bot/noai
pr acme/proj 14 "${F}" bot/changes
echo '[{"user": {"login": "cgwalters"}, "state": "APPROVED"}, {"user": {"login": "cgwalters"}, "state": "CHANGES_REQUESTED"},
       {"user": {"login": "someone"}, "state": "APPROVED"}]' | fixture repos/acme/proj/pulls/14/reviews
jq -n --arg sha "$(git -C "${REMOTES}/${F}" rev-parse bot/approved)" \
    '[{user: {login: "cgwalters"}, state: "APPROVED", id: 7, commit_id: $sha, submitted_at: "2026-09-25T11:00:00Z",
       html_url: "https://github.com/cgwalters-forge/proj/pull/11#pullrequestreview-7", body: ""}]' |
    fixture "repos/${F}/pulls/11/reviews"
echo '{"default_branch": "main"}' | fixture repos/acme/proj

# Upstream moves on: a change to README (which #4 conflicts with), one to
# a line of ctx near #7's (its context changes), and #9's change.
git -C "${SRC}" switch -q -C main "${BASE}"
commit_as other README "upstream README change"
commit_as other ctx "upstream ctx change" $'a\nb\nc\nd\nE\nf\ng\nh'
commit_as other upstreamed "the same change, merged" "same"
git -C "${SRC}" push -q "file://${REMOTES}/acme/proj" HEAD:main
MAIN=$(git -C "${SRC}" rev-parse HEAD)
readonly MAIN
# The PR that's up to date: #13, based on the new main.
git -C "${SRC}" switch -q -C bot/current "${MAIN}"
commit_as bot current "current"$'\n\n'"${AI}"
git -C "${SRC}" push -q "file://${REMOTES}/${F}" HEAD:refs/heads/bot/current
pr acme/proj 13 "${F}" bot/current

# NAME|PR URL|OPTIONS|EXPECT|COMMITTERS: EXPECT is 'rebased SUMMARY'
# (pushed onto upstream main, and on an upstream PR the comment
# 'Rebased onto main; SUMMARY.'), 'dry SUMMARY' (nothing pushed or
# posted), 'uptodate', 'conflict PATHS' (exit status EX_CONFLICT), or a
# REGEX of the refusal. COMMITTERS are the rebased commits' committers
# (b: the bot, h: cgwalters), oldest first.
readonly U=https://github.com/acme/proj/pull
while IFS='|' read -r name url opts expect committers; do
    test -n "${name}" || continue
    [[ "${url}" =~ /([^/]+/[^/]+)/pull/([0-9]+)$ ]]
    repo=${BASH_REMATCH[1]} n=${BASH_REMATCH[2]}
    head_repo=$(jq -r .head.repo.full_name "${FAKE_GH}/rest/repos/${repo}/pulls/${n}.json")
    ref=$(jq -r .head.ref "${FAKE_GH}/rest/repos/${repo}/pulls/${n}.json")
    before=$(git -C "${REMOTES}/${head_repo}" rev-parse "refs/heads/${ref}")
    : >"${FAKE_GH}/comments"
    read -ra argv <<<"${opts}"
    status=0
    out=$("${BOT_PR}" rebase "${url}" "${argv[@]}" 2>&1) || status=$?
    after=$(git -C "${REMOTES}/${head_repo}" rev-parse "refs/heads/${ref}")
    comments=$(cat "${FAKE_GH}/comments")
    case "${expect}" in
        rebased\ *)
            test "${status}" -eq 0 || { fail "${name}: exit status ${status}: ${out}"; continue; }
            summary=${expect#rebased }
            git -C "${REMOTES}/${head_repo}" merge-base --is-ancestor "${MAIN}" "${after}" || fail "${name}: not on upstream main"
            test "$(git -C "${REMOTES}/${head_repo}" rev-list --count "${MAIN}..${after}")" = \
                "$(git -C "${REMOTES}/${head_repo}" rev-list --count "${BASE}..${before}")" || fail "${name}: commit count changed"
            test "$(git -C "${REMOTES}/${head_repo}" log --reverse --format=%an%ae%B "${MAIN}..${after}")" = \
                "$(git -C "${REMOTES}/${head_repo}" log --reverse --format=%an%ae%B "${BASE}..${before}")" ||
                fail "${name}: authors or messages changed"
            got=$(git -C "${REMOTES}/${head_repo}" log --reverse --format=%ce "${MAIN}..${after}" |
                sed -e "s/^${BOT_EMAIL}\$/b/" -e "s/^${HUMAN_EMAIL}\$/h/" | paste -sd' ')
            test "${got}" = "${committers}" || fail "${name}: committers '${got}', expected '${committers}'"
            if test "${repo}" = acme/proj; then
                want="repos/acme/proj/issues/${n}/comments $(printf 'Rebased onto main; %s.\n\n%s' "${summary}" "${TRAILER}" | jq -Rsc .)"
                test "${comments}" = "${want}" || fail "${name}: comment '${comments}', expected '${want}'"
            else
                test -z "${comments}" || fail "${name}: commented on a fork PR: ${comments}"
                test "$(git -C "${REMOTES}/${repo}" rev-parse main)" = "${MAIN}" || fail "${name}: the fork's main wasn't synced"
            fi ;;
        dry\ *)
            test "${status}" -eq 0 || { fail "${name}: exit status ${status}: ${out}"; continue; }
            grep -qF "Would push ${ref} rebased onto acme/proj:main" <<<"${out}" || fail "${name}: ${out}"
            grep -qF "${expect#dry }" <<<"${out}" || fail "${name}: no summary: ${out}"
            test "${after}" = "${before}" || fail "${name}: pushed in a dry run"
            test -z "${comments}" || fail "${name}: commented in a dry run" ;;
        uptodate)
            test "${status}" -eq 0 || fail "${name}: exit status ${status}: ${out}"
            grep -q 'is up to date with acme/proj:main; nothing to do' <<<"${out}" || fail "${name}: ${out}"
            test "${after}" = "${before}" || fail "${name}: pushed" ;;
        conflict\ *)
            test "${status}" -eq "${EX_CONFLICT}" || fail "${name}: exit status ${status}, expected ${EX_CONFLICT}: ${out}"
            grep -qF "conflicts with acme/proj:main in: ${expect#conflict }; nothing was pushed" <<<"${out}" || fail "${name}: ${out}"
            test "${after}" = "${before}" || fail "${name}: pushed"
            test -z "${comments}" || fail "${name}: commented" ;;
        *)
            test "${status}" -ne 0 || fail "${name}: not refused: ${out}"
            grep -qE -- "${expect}" <<<"${out}" || fail "${name}: output lacks '${expect}': ${out}"
            test "${after}" = "${before}" || fail "${name}: pushed anyway"
            test -z "${comments}" || fail "${name}: commented" ;;
    esac
done <<EOF
the bot's commit|${U}/1||rebased 1 commit, no content change|b
dry run first|${U}/2|--dry-run|dry 2 commits, no content change|
cgwalters' sign-off is kept|${U}/2||rebased 2 commits, no content change|h b
his own commit, from the bot's fork|${U}/3||rebased 1 commit, no content change|b
conflicts|${U}/4||conflict README|
someone else's commit|${U}/5||has commits by others than cgwalters-bot and cgwalters|
someone else's PR|${U}/6||was opened by someone, not cgwalters-bot|
changed context|${U}/7||rebased 1 commit, no conflicts (diff context changed in 1)|b
a dry run|${U}/8|--dry-run|dry 1 commit, no content change|
a commit that is upstream already|${U}/9||left 0 commits of 1: some are upstream already|
a fork PR|https://github.com/${F}/pull/10||rebased 1 commit, no content change|b
an approved fork PR|https://github.com/${F}/pull/11||cgwalters approved .* a push would void that|
no AI trailer|${U}/12||'bot-git check' found problems|
no AI trailer, allowed|${U}/12|--no-ai-trailer|rebased 1 commit, no content change|b
up to date|${U}/13||uptodate|
changes requested|${U}/14||cgwalters requested changes on|
up to date after the rebase|${U}/1||uptodate|
EOF

out=$("${BOT_PR}" rebase https://github.com/acme/proj/issues/1 2>&1) && fail "an issue URL: not refused: ${out}"
grep -q 'expected a PR URL' <<<"${out}" || fail "an issue URL: ${out}"

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-pr rebase rebases the bot's own PRs, keeps cgwalters' sign-off, and refuses conflicts and others' work"

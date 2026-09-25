#!/usr/bin/env bash
# Offline tests of bin/bot-git: the identity it commits with, its refusal
# to sign off, and 'bot-git check', in a scratch repository.
#   tests/bot-git.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_GIT=${TESTS}/../bin/bot-git
# Written out rather than sourced from bot-git, so that a change to the
# identity there has to change this too.
readonly BOT="Colin Walters <walters+llm@verbum.org>"
readonly LEGACY="cgwalters-bot <walters+llm@verbum.org>"
readonly HUMAN="Colin Walters <walters@verbum.org>"
readonly OTHER="Other Person <other@example.com>"
readonly SOB="Signed-off-by: ${HUMAN}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-git-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
readonly REPO=${WORK}/repo
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_DATE
# The machine's own identity is the human's; bot-git must override it.
git config --global user.name "${HUMAN% <*}"
git config --global user.email walters@verbum.org
git config --global init.defaultBranch main
git config --global commit.gpgSign false

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# who KEY: the identity for bot, legacy, human or other.
who() {
    case "$1" in
        bot) echo "${BOT}" ;;
        legacy) echo "${LEGACY}" ;;
        human) echo "${HUMAN}" ;;
        other) echo "${OTHER}" ;;
        *) echo "unknown identity key '$1'" 1>&2; exit 1 ;;
    esac
}

# commit_as AUTHOR COMMITTER MESSAGE: an empty commit in REPO by those
# identity keys, with MESSAGE's escapes (\n) expanded.
commit_as() {
    local a c ae ce
    a=$(who "$1") c=$(who "$2")
    ae=${a##*<} ce=${c##*<}
    GIT_AUTHOR_NAME=${a% <*} GIT_AUTHOR_EMAIL=${ae%>} GIT_COMMITTER_NAME=${c% <*} GIT_COMMITTER_EMAIL=${ce%>} \
        git -C "${REPO}" commit -q --allow-empty --cleanup=verbatim -F <(printf '%b\n' "$3")
}

git init -q "${REPO}"
commit_as human human "base"
BASE=$(git -C "${REPO}" rev-parse HEAD)
readonly BASE

# --- The wrapper ---
# NAME|EXPECT|ARGS (words; the message is always the last word)
#   EXPECT: refuse, or AUTHOR/COMMITTER keys of the resulting HEAD.
# Each case starts from a commit by the human.
while IFS='|' read -r name expect args; do
    test -n "${name}" || continue
    git -C "${REPO}" reset -q --hard "${BASE}"
    read -ra argv <<<"${args}"
    status=0
    out=$("${BOT_GIT}" -C "${REPO}" "${argv[@]}" 2>&1) || status=$?
    if test "${expect}" = refuse; then
        test "${status}" -ne 0 || fail "${name}: not refused"
        grep -q 'never adds a Signed-off-by\|never adds one' <<<"${out}" || fail "${name}: no explanation: ${out}"
        test "$(git -C "${REPO}" rev-parse HEAD)" = "${BASE}" || fail "${name}: committed anyway"
        continue
    fi
    test "${status}" -eq 0 || { fail "${name}: exit status ${status}: ${out}"; continue; }
    got=$(git -C "${REPO}" show -s --format='%an <%ae>/%cn <%ce>' HEAD)
    want="$(who "${expect%/*}")/$(who "${expect#*/}")"
    test "${got}" = "${want}" || fail "${name}: HEAD is '${got}', expected '${want}'"
    git -C "${REPO}" show -s --format=%B HEAD | grep -q '^Signed-off-by' && fail "${name}: HEAD has a Signed-off-by"
done <<'EOF'
commit|bot/bot|commit --allow-empty -m msg
-m's value is not an option|bot/bot|commit --allow-empty -m -s
-ms is a message 's'|bot/bot|commit --allow-empty -ms
global options first|bot/bot|-c core.hooksPath=/dev/null commit --allow-empty -m msg
amend keeps the author|human/bot|commit --amend --allow-empty --no-edit
rebase keeps the author|human/bot|rebase -q --force-rebase --root
rebase -s is a strategy|human/bot|rebase -q -s ort --force-rebase --root
status -s is not refused|human/human|status -s
commit -s|refuse|commit --allow-empty -s -m msg
commit --signoff|refuse|commit --allow-empty --signoff -m msg
commit --sign, abbreviated|refuse|commit --allow-empty --sign -m msg
commit --trai, abbreviated|refuse|commit --allow-empty --trai Signed-off-by:x -m msg
other trailers are fine|bot/bot|commit --allow-empty --trailer Generated-by:AI -m msg
commit -as cluster|refuse|commit --allow-empty -as -m msg
commit -sm cluster|refuse|commit --allow-empty -sm msg
after global options|refuse|-c core.hooksPath=/dev/null commit --allow-empty -s -m msg
--trailer Signed-off-by|refuse|commit --allow-empty --trailer Signed-off-by:x -m msg
--trailer=signed-off-by|refuse|commit --allow-empty --trailer=signed-off-by:x -m msg
rebase --signoff|refuse|rebase --signoff --root
cherry-pick -s|refuse|cherry-pick -s HEAD
EOF

# --- check ---
# NAME|AUTHOR|COMMITTER|MESSAGE|OPTIONS|EXPECT: one commit on BASE by those
# identity keys, checked with 'check OPTIONS BASE..HEAD'. EXPECT is ok, or
# an extended regex its problem list must match.
readonly AI=Generated-by:\ AI
while IFS='|' read -r name author committer msg opts expect; do
    test -n "${name}" || continue
    git -C "${REPO}" reset -q --hard "${BASE}"
    commit_as "${author}" "${committer}" "${msg}"
    read -ra argv <<<"${opts}"
    status=0
    out=$(cd "${REPO}" && "${BOT_GIT}" check "${argv[@]}" "${BASE}..HEAD" 2>&1) || status=$?
    if test "${expect}" = ok; then
        if test "${status}" -ne 0 || ! grep -q '^ok: 1 commits' <<<"${out}"; then
            fail "${name}: expected ok, got ${status}: ${out}"
        fi
    else
        test "${status}" -eq 1 || fail "${name}: exit status ${status}, expected 1: ${out}"
        grep -qE -- "${expect}" <<<"${out}" || fail "${name}: output lacks '${expect}': ${out}"
        grep -q '1 of 1 commits .* need fixing' <<<"${out}" || fail "${name}: no summary: ${out}"
    fi
done <<EOF
bot commit|bot|bot|x\n\n${AI}||ok
Assisted-by|bot|bot|x\n\nAssisted-by: AI||ok
old bot name|legacy|legacy|x\n\n${AI}||ok
someone else's commit|other|other|x||ok
someone else's, rebased by the bot|other|bot|x||ok
cgwalters' own|human|human|x\n\n${SOB}||ok
promoted by bot-pr|bot|human|x\n\n${AI}\n${SOB}||ok
no AI trailer|bot|bot|x||no Generated-by: AI
no AI trailer, allowed|bot|bot|x|--no-ai-trailer|ok
fixup!|bot|bot|fixup! x\n\n${AI}||'fixup!' commit
squash! by anyone|human|human|squash! x||'squash!' commit
committed as cgwalters|bot|human|x\n\n${AI}||committed as 'Colin Walters <walters@verbum.org>'
bot sign-off, as cgwalters|bot|bot|x\n\n${AI}\n${SOB}||has Signed-off-by: Colin Walters <walters@verbum.org>
bot sign-off, as itself|bot|bot|x\n\n${AI}\nSigned-off-by: ${BOT}||has Signed-off-by
EOF

# The author name check, which the table's identity keys can't express.
git -C "${REPO}" reset -q --hard "${BASE}"
GIT_AUTHOR_NAME=Someone GIT_AUTHOR_EMAIL=walters+llm@verbum.org GIT_COMMITTER_NAME="${BOT% <*}" GIT_COMMITTER_EMAIL=walters+llm@verbum.org \
    git -C "${REPO}" commit -q --allow-empty -m "x" -m "${AI}"
out=$(cd "${REPO}" && "${BOT_GIT}" check "${BASE}..HEAD" 2>&1) && fail "author name: not flagged"
grep -q "authored as 'Someone <walters+llm@verbum.org>'" <<<"${out}" || fail "author name: ${out}"

# The default range is @{upstream}..HEAD: only the commits not pushed.
git -C "${REPO}" reset -q --hard "${BASE}"
commit_as bot bot "fixup! pushed already"
git -C "${REPO}" branch -q pushed
git -C "${REPO}" branch -q --set-upstream-to=pushed
commit_as bot bot "new\n\n${AI}"
out=$(cd "${REPO}" && "${BOT_GIT}" check 2>&1) || fail "default range: ${out}"
grep -q '^ok: 1 commits in @{upstream}..HEAD' <<<"${out}" || fail "default range: ${out}"

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-git commits as the bot, refuses to sign off, and checks commits"

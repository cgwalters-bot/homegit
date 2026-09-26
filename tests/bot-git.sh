#!/usr/bin/env bash
# Offline tests of bin/bot-git: the identity it commits with, its refusal
# to sign off, 'bot-git rework' and 'bot-git check', in a scratch
# repository.
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
# NAME|EXPECT|ARGS (comma-separated)
#   EXPECT: refuse, or AUTHOR/COMMITTER keys of the resulting HEAD.
# Each case starts from a commit by the human.
printf 'x\n\nSigned-off-by: %s\n' "${BOT}" >"${WORK}/sob-message"
while IFS='|' read -r name expect args; do
    test -n "${name}" || continue
    git -C "${REPO}" reset -q --hard "${BASE}"
    IFS=, read -ra argv <<<"${args}"
    status=0
    out=$("${BOT_GIT}" -C "${REPO}" "${argv[@]}" 2>&1) || status=$?
    if test "${expect}" = refuse; then
        test "${status}" -ne 0 || fail "${name}: not refused"
        grep -q 'the bot never adds a Signed-off-by' <<<"${out}" || fail "${name}: no explanation: ${out}"
        test "$(git -C "${REPO}" rev-parse HEAD)" = "${BASE}" || fail "${name}: committed anyway"
        continue
    fi
    test "${status}" -eq 0 || { fail "${name}: exit status ${status}: ${out}"; continue; }
    got=$(git -C "${REPO}" show -s --format='%an <%ae>/%cn <%ce>' HEAD)
    want="$(who "${expect%/*}")/$(who "${expect#*/}")"
    test "${got}" = "${want}" || fail "${name}: HEAD is '${got}', expected '${want}'"
    git -C "${REPO}" show -s --format=%B HEAD | grep -q '^Signed-off-by' && fail "${name}: HEAD has a Signed-off-by"
done <<CASES
commit|bot/bot|commit,--allow-empty,-m,msg
-m's value is not an option|bot/bot|commit,--allow-empty,-m,-s
--message's value is not an option|bot/bot|commit,--allow-empty,--message,-s
-ms is a message 's'|bot/bot|commit,--allow-empty,-ms
global options first|bot/bot|-c,core.hooksPath=/dev/null,commit,--allow-empty,-m,msg
amend keeps the author|human/bot|commit,--amend,--allow-empty,--no-edit
rebase keeps the author|human/bot|rebase,-q,--force-rebase,--root
rebase -s is a strategy|human/bot|rebase,-q,-s,ort,--force-rebase,--root
status -s is not refused|human/human|status,-s
format-patch -o takes a value|human/human|format-patch,-q,-1,-o,${WORK}/patches
other trailers are fine|bot/bot|commit,--allow-empty,--trailer,Generated-by: AI,-m,msg
commit -s|refuse|commit,--allow-empty,-s,-m,msg
commit --signoff|refuse|commit,--allow-empty,--signoff,-m,msg
commit --sign, abbreviated|refuse|commit,--allow-empty,--sign,-m,msg
commit -as cluster|refuse|commit,--allow-empty,-as,-m,msg
commit -sm cluster|refuse|commit,--allow-empty,-sm,msg
commit -vs: -v takes no value for commit|refuse|commit,--allow-empty,-vs,-m,msg
commit -os: -o takes no value for commit|refuse|commit,--allow-empty,-os,-m,msg
after global options|refuse|-c,core.hooksPath=/dev/null,commit,--allow-empty,-s,-m,msg
--trailer Signed-off-by|refuse|commit,--allow-empty,--trailer,Signed-off-by: x,-m,msg
--trailer=signed-off-by|refuse|commit,--allow-empty,--trailer=signed-off-by:x,-m,msg
--trai, abbreviated|refuse|commit,--allow-empty,--trai,Signed-off-by:x,-m,msg
--trailer with a leading blank|refuse|commit,--allow-empty,--trailer, Signed-off-by: x,-m,msg
--trailer with a blank before the colon|refuse|commit,--allow-empty,--trailer,Signed-off-by : x,-m,msg
Signed-off-by in -m|refuse|commit,--allow-empty,-m,x,-m,Signed-off-by: ${BOT}
Signed-off-by in --message=|refuse|commit,--allow-empty,--message=Signed-off-by: ${BOT}
Signed-off-by in -F|refuse|commit,--allow-empty,-F,${WORK}/sob-message
Signed-off-by in -F attached|refuse|commit,--allow-empty,-F${WORK}/sob-message
rebase --signoff|refuse|rebase,--signoff,--root
cherry-pick -s|refuse|cherry-pick,-s,HEAD
format-patch -s|refuse|format-patch,-1,-s,-o,${WORK}/patches
CASES

# --- check ---
# NAME|AUTHOR|COMMITTER|MESSAGE|OPTIONS|EXPECT: one commit on BASE by those
# identity keys, checked with 'check OPTIONS BASE..HEAD'. EXPECT is ok,
# 'warning: REGEX' for a pass with that warning, or a REGEX of an error.
readonly AI=Generated-by:\ AI
while IFS='|' read -r name author committer msg opts expect; do
    test -n "${name}" || continue
    git -C "${REPO}" reset -q --hard "${BASE}"
    commit_as "${author}" "${committer}" "${msg}"
    read -ra argv <<<"${opts}"
    status=0
    out=$(cd "${REPO}" && "${BOT_GIT}" check "${argv[@]}" "${BASE}..HEAD" 2>&1) || status=$?
    if test "${expect}" = ok; then
        if test "${status}" -ne 0 || ! grep -q '^ok: 1 commits' <<<"${out}" || grep -q 'warning:' <<<"${out}"; then
            fail "${name}: expected ok, got ${status}: ${out}"
        fi
    elif [[ "${expect}" == "warning: "* ]]; then
        if test "${status}" -ne 0 || ! grep -qE -- "${expect}" <<<"${out}" || ! grep -q '^ok: 1 commits.*1 with warnings' <<<"${out}"; then
            fail "${name}: expected '${expect}', got ${status}: ${out}"
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
promoted by bot-pr|bot|human|x\n\n${AI}\n${SOB}|--promoted|ok
promoted, or 'git commit --amend -s' here|bot|human|x\n\n${AI}\n${SOB}||error: has Signed-off-by: Colin Walters <walters@verbum.org>
bot work made with plain git|human|human|x\n\n${AI}||error: has a Generated-by trailer but was made as cgwalters
bot work amended with plain git|other|human|x\n\n${AI}||error: has a Generated-by trailer but was made as cgwalters
cgwalters' own, AI-assisted|human|human|x\n\nAssisted-by: AI||warning: authored by cgwalters with an AI trailer
someone else's, committed by cgwalters|other|human|x||warning: someone else's commit, committed by cgwalters
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

# A merge commit.
git -C "${REPO}" reset -q --hard "${BASE}"
commit_as bot bot "side\n\n${AI}"
SIDE=$(git -C "${REPO}" rev-parse HEAD)
git -C "${REPO}" reset -q --hard "${BASE}"
commit_as bot bot "main\n\n${AI}"
GIT_AUTHOR_NAME="${BOT% <*}" GIT_AUTHOR_EMAIL=walters+llm@verbum.org GIT_COMMITTER_NAME="${BOT% <*}" GIT_COMMITTER_EMAIL=walters+llm@verbum.org \
    git -C "${REPO}" merge -q --no-ff -m "merge" -m "${AI}" "${SIDE}"
out=$(cd "${REPO}" && "${BOT_GIT}" check "${BASE}..HEAD" 2>&1) && fail "merge: not flagged"
grep -q "error: a merge commit" <<<"${out}" || fail "merge: ${out}"

# The default range is @{upstream}..HEAD: only the commits not pushed.
git -C "${REPO}" reset -q --hard "${BASE}"
commit_as bot bot "fixup! pushed already"
git -C "${REPO}" branch -q pushed
git -C "${REPO}" branch -q --set-upstream-to=pushed
commit_as bot bot "new\n\n${AI}"
out=$(cd "${REPO}" && "${BOT_GIT}" check 2>&1) || fail "default range: ${out}"
if ! grep -q '^checking @{upstream}..HEAD$' <<<"${out}" || ! grep -q '^ok: 1 commits in @{upstream}..HEAD' <<<"${out}"; then
    fail "default range: ${out}"
fi
git -C "${REPO}" branch -q -f pushed HEAD
out=$(cd "${REPO}" && "${BOT_GIT}" check 2>&1) && fail "empty default range: passed"
grep -q 'no commits in @{upstream}..HEAD' <<<"${out}" || fail "empty default range: ${out}"

# --- rework ---
# build WORD SPEC...: resets REPO to BASE and commits each SPEC,
# AUTHOR:COMMITTER:SUBJECT:SIGNED[:FILE:CONTENT] (identity keys; SIGNED
# is y for cgwalters' sign-off), writing CONTENT (default WORD, - to
# delete it) to FILE (default SUBJECT), so that an old and a reworked
# branch have different trees and bodies unless the spec says otherwise.
build() {
    local word=$1 spec a c subj signed file content msg
    shift
    git -C "${REPO}" reset -q --hard "${BASE}"
    for spec in "$@"; do
        IFS=: read -r a c subj signed file content <<<"${spec}"
        file=${file:-${subj}} content=${content:-${word}}
        msg="${subj}\n\n${word} body\n\n${AI}"
        test "${signed}" = n || msg+="\n${SOB}"
        if test "${content}" = -; then
            git -C "${REPO}" rm -q "${file}"
        else
            echo "${content}" >"${REPO}/${file}"
            git -C "${REPO}" add "${file}"
        fi
        commit_as "${a}" "${c}" "${msg}"
    done
}

# sans_sob COMMIT: COMMIT's message without cgwalters' sign-off.
sans_sob() {
    git -C "${REPO}" show -s --format=%B "$1" | grep -vxF "${SOB}"
}

# NAME|OLD SPECS|NEW SPECS|EXPECT: 'rework --was OLD' on NEW, both built
# with build. EXPECT is 'kept N', 'nothing', or a REGEX of the refusal.
# A kept commit must be the reworked one of the subject of a bot commit
# that cgwalters signed off and committed, now committed by him with one
# sign-off; every other commit must keep its committer and sign-off (or
# lack of one); all keep their trees, authors and messages otherwise.
while IFS='|' read -r name olds news expect; do
    test -n "${name}" || continue
    read -ra ospecs <<<"${olds}"
    read -ra nspecs <<<"${news}"
    build old "${ospecs[@]}"
    OLD=$(git -C "${REPO}" rev-parse HEAD)
    build new "${nspecs[@]}"
    before=$(git -C "${REPO}" rev-parse HEAD)
    status=0
    out=$(cd "${REPO}" && "${BOT_GIT}" rework --was "${OLD}" 2>&1) || status=$?
    after=$(git -C "${REPO}" rev-parse HEAD)
    case "${expect}" in
        nothing)
            if test "${status}" -ne 0 || ! grep -q '^nothing to do' <<<"${out}"; then
                fail "${name}: expected nothing to do, got ${status}: ${out}"
            fi
            test "${after}" = "${before}" || fail "${name}: HEAD changed"
            continue ;;
        kept\ *)
            test "${status}" -eq 0 || { fail "${name}: exit status ${status}: ${out}"; continue; }
            test "$(grep -c "^kept cgwalters' sign-off on [0-9a-f]* (was on [0-9a-f]*); name it in your reply$" <<<"${out}")" -eq "${expect#kept }" ||
                fail "${name}: expected ${expect}: ${out}" ;;
        *)
            test "${status}" -ne 0 || fail "${name}: not refused: ${out}"
            grep -qE -- "${expect}" <<<"${out}" || fail "${name}: output lacks '${expect}': ${out}"
            test "${after}" = "${before}" || fail "${name}: HEAD changed anyway"
            continue ;;
    esac
    # The old spec of each subject, for the reworked commit of that subject.
    declare -A old_spec=()
    for spec in "${ospecs[@]}"; do
        subj=${spec#*:*:}
        old_spec[${subj%:*}]=${spec}
    done
    mapfile -t b < <(git -C "${REPO}" rev-list --reverse "${BASE}..${before}")
    mapfile -t a < <(git -C "${REPO}" rev-list --reverse "${BASE}..${after}")
    for i in "${!b[@]}"; do
        fmt='%T %an <%ae>'
        test "$(git -C "${REPO}" show -s --format="${fmt}" "${a[i]}")" = "$(git -C "${REPO}" show -s --format="${fmt}" "${b[i]}")" ||
            fail "${name}: commit $((i + 1)): tree or author changed"
        test "$(sans_sob "${a[i]}")" = "$(sans_sob "${b[i]}")" || fail "${name}: commit $((i + 1)): message changed"
        sobs=$(git -C "${REPO}" show -s --format=%B "${a[i]}" | grep -cxF "${SOB}" || true)
        subj=${nspecs[i]#*:*:}
        ospec=${old_spec[${subj%:*}]:-}
        if [[ "${ospec}" == bot:human:*:y && "${nspecs[i]}" == bot:* ]]; then
            test "$(git -C "${REPO}" show -s --format='%cn <%ce>' "${a[i]}")" = "${HUMAN}" || fail "${name}: commit $((i + 1)) is not committed by cgwalters"
            test "${sobs}" -eq 1 || fail "${name}: commit $((i + 1)) has ${sobs} sign-offs"
        else
            test "$(git -C "${REPO}" show -s --format='%cn <%ce> %cd' "${a[i]}")" = "$(git -C "${REPO}" show -s --format='%cn <%ce> %cd' "${b[i]}")" ||
                fail "${name}: commit $((i + 1))'s committer changed"
            test "${sobs}" -eq "$(git -C "${REPO}" show -s --format=%B "${b[i]}" | grep -cxF "${SOB}" || true)" ||
                fail "${name}: commit $((i + 1))'s sign-off changed"
        fi
    done
    # What rework made passes check against the old head.
    out=$(cd "${REPO}" && "${BOT_GIT}" check --was "${OLD}" "${BASE}..HEAD" 2>&1) || fail "${name}: check: ${out}"
    test "$(grep -c "^    note: kept cgwalters' sign-off" <<<"${out}")" -eq "${expect#kept }" || fail "${name}: check notes: ${out}"
done <<EOF
rework dropped the trailer|bot:human:a:y|bot:bot:a:n|kept 1
rebase kept the trailer text|bot:human:a:y|bot:bot:a:y|kept 1
only the signed one of two|bot:bot:a:n bot:human:b:y|bot:bot:a:n bot:bot:b:n|kept 1
a later unsigned commit stays unsigned|bot:human:a:y bot:bot:b:n|bot:bot:a:n bot:bot:b:n|kept 1
both signed|bot:human:a:y bot:human:b:y|bot:bot:a:y bot:bot:b:n|kept 2
never signed|bot:bot:a:n|bot:bot:a:n|nothing
trailer without cgwalters committing|bot:bot:a:y|bot:bot:a:n|nothing
someone else's signed commit|other:human:a:y|other:bot:a:n|nothing
cgwalters' own commit|human:human:a:y|human:bot:a:y|nothing
already kept|bot:human:a:y|bot:human:a:y|nothing
adding a sign-off|bot:bot:a:n|bot:bot:a:y|has cgwalters' sign-off, but its pair .* had none
a trailer whose committer a rebase dropped|bot:bot:a:y|bot:bot:a:y|nothing
the pair is no longer the bot's|bot:human:a:y|other:bot:a:n|is not the bot's commit
a commit added after|bot:human:a:y|bot:bot:a:n bot:bot:b:n|kept 1
a prep commit inserted|bot:human:a:y bot:human:b:y|bot:bot:a:n bot:bot:p:n bot:bot:b:n|kept 2
an inserted commit with a sign-off|bot:human:a:y|bot:bot:p:y bot:bot:a:n|has cgwalters' sign-off, but is new since
a commit squashed away|bot:human:a:y bot:bot:b:n|bot:bot:a:n|'b' of .* is gone from
a subject changed|bot:human:a:y|bot:bot:c:n|'a' of .* is gone from
commits reordered|bot:human:a:y bot:human:b:y|bot:bot:b:n bot:bot:a:n|'a' moved before an earlier commit
a subject twice, old|bot:human:a:y bot:bot:a:n|bot:bot:a:n|'a' is the subject of two commits
a subject twice, new|bot:human:a:y|bot:bot:a:n bot:bot:a:n|'a' is the subject of two commits
EOF

# --- rework and check with --pair and --patch-id ---
# sha_of TIP SUBJECT: the commit of BASE..TIP with SUBJECT.
sha_of() {
    git -C "${REPO}" log --format='%H %s' "${BASE}..$1" | awk -v s="$2" '$2 == s { print $1 }'
}

# NAME|OLD SPECS|NEW SPECS|OPTIONS|EXPECT: 'rework --was OLD OPTIONS' on
# NEW, both built with build; in OPTIONS, o:SUBJECT and n:SUBJECT name the
# commit with that subject on OLD and NEW. EXPECT is 'kept N' (then
# 'check' passes with the same OPTIONS, and fails without them), or a
# REGEX of the refusal.
while IFS='|' read -r name olds news opts expect; do
    test -n "${name}" || continue
    read -ra ospecs <<<"${olds}"
    read -ra nspecs <<<"${news}"
    build old "${ospecs[@]}"
    OLD=$(git -C "${REPO}" rev-parse HEAD)
    build new "${nspecs[@]}"
    NEW=$(git -C "${REPO}" rev-parse HEAD)
    argv=()
    for o in ${opts}; do
        while [[ "${o}" =~ ([on]):([a-z]+) ]]; do
            tip=${OLD}
            test "${BASH_REMATCH[1]}" = o || tip=${NEW}
            o=${o/"${BASH_REMATCH[0]}"/$(sha_of "${tip}" "${BASH_REMATCH[2]}")}
        done
        argv+=("${o}")
    done
    status=0
    out=$(cd "${REPO}" && "${BOT_GIT}" rework --was "${OLD}" "${argv[@]}" 2>&1) || status=$?
    after=$(git -C "${REPO}" rev-parse HEAD)
    if [[ "${expect}" != kept\ * ]]; then
        test "${status}" -ne 0 || fail "${name}: not refused: ${out}"
        grep -qE -- "${expect}" <<<"${out}" || fail "${name}: output lacks '${expect}': ${out}"
        test "${after}" = "${NEW}" || fail "${name}: HEAD changed anyway"
        continue
    fi
    test "${status}" -eq 0 || { fail "${name}: exit status ${status}: ${out}"; continue; }
    test "$(grep -c "^kept cgwalters' sign-off on" <<<"${out}")" -eq "${expect#kept }" || fail "${name}: expected ${expect}: ${out}"
    # The check it says to run, with the same pairs.
    hint=$(sed -n 's/^check it with the same pairs: bot-git check //p' <<<"${out}")
    test -n "${hint}" || { fail "${name}: no check hint: ${out}"; continue; }
    test "$(git -C "${REPO}" rev-parse "HEAD^{tree}")" = "$(git -C "${REPO}" rev-parse "${NEW}^{tree}")" || fail "${name}: tree changed"
    test "$(git -C "${REPO}" log --format='%cn <%ce>' "${BASE}..HEAD" | grep -cxF "${HUMAN}")" -eq "${expect#kept }" ||
        fail "${name}: not ${expect#kept } commits by cgwalters"
    read -ra hint <<<"${hint}"
    out=$(cd "${REPO}" && "${BOT_GIT}" check "${hint[@]}" 2>&1) || fail "${name}: check: ${out}"
    test "$(grep -c "^    note: kept cgwalters' sign-off" <<<"${out}")" -eq "${expect#kept }" || fail "${name}: check notes: ${out}"
    out=$(cd "${REPO}" && "${BOT_GIT}" check --was "${OLD}" "${BASE}..HEAD" 2>&1) && fail "${name}: check passed without the pairs: ${out}"
    grep -q "is gone from .*pair it with --pair [0-9a-f]*=NEW" <<<"${out}" || fail "${name}: check without the pairs: ${out}"
done <<EOF
retitled|bot:human:a:y|bot:bot:c:n|--pair o:a=n:c|kept 1
retitled, --pair=|bot:human:a:y|bot:bot:c:y|--pair=o:a=n:c|kept 1
one of two retitled|bot:human:a:y bot:human:b:y|bot:bot:a:n bot:bot:c:n|--pair o:b=n:c|kept 2
two retitled|bot:human:a:y bot:human:b:y|bot:bot:c:n bot:bot:d:n|--pair o:a=n:c --pair o:b=n:d|kept 2
without a pair|bot:human:a:y|bot:bot:c:n||'a' of .* is gone from .*pair it with --pair [0-9a-f]*=NEW
not signed|bot:bot:a:n|bot:bot:c:n|--pair o:a=n:c|not a bot commit that cgwalters signed off and committed
signed, not committed by him|bot:bot:a:y|bot:bot:c:n|--pair o:a=n:c|not a bot commit that cgwalters signed off and committed
someone else's signed commit|other:human:a:y|other:bot:c:n|--pair o:a=n:c|not a bot commit that cgwalters signed off and committed
the new commit is not the bot's|bot:human:a:y|other:bot:c:n|--pair o:a=n:c|'c' of --pair .* is not the bot's commit
the old subject is still there|bot:human:a:y|bot:bot:a:n bot:bot:c:n|--pair o:a=n:c|ambiguous: 'a' of OLD is still the subject
the new subject is another old commit's|bot:human:a:y bot:human:b:y|bot:bot:b:n|--pair o:a=n:b|ambiguous: 'b' is the subject of another commit
paired twice|bot:human:a:y|bot:bot:c:n bot:bot:d:n|--pair o:a=n:c --pair o:a=n:d|already paired
OLD not on the old branch|bot:human:a:y|bot:bot:c:n|--pair n:c=n:c|OLD of --pair .* is not a commit of
NEW's subject not on the new branch|bot:human:a:y|bot:bot:c:n|--pair o:a=o:a|no commit of .* has the subject 'a'
not OLD=NEW|bot:human:a:y|bot:bot:c:n|--pair o:a|--pair takes OLD=NEW
reordered|bot:human:a:y bot:human:b:y|bot:bot:c:n bot:bot:a:n|--pair o:b=n:c|'a' moved before an earlier commit
patch-id|bot:human:a:y:f:x|bot:bot:c:n:f:x|--patch-id|kept 1
patch-id next to a subject pair|bot:human:a:y bot:human:b:y:f:x|bot:bot:a:n bot:bot:c:n:f:x|--patch-id|kept 2
patch-id of a changed commit|bot:human:a:y:f:x|bot:bot:c:n:f:y|--patch-id|'a' of .* is gone from
patch-id twice|bot:human:a:y:f:x|bot:bot:c:n:f:x bot:bot:e:n:f:- bot:bot:d:n:f:x|--patch-id|'a' of .* is gone from
patch-id, not signed|bot:bot:a:n:f:x|bot:bot:c:n:f:x|--patch-id|'a' of .* is gone from
patch-id, not the bot's|bot:human:a:y:f:x|other:bot:c:n:f:x|--patch-id|'a' of .* is gone from
EOF
out=$(cd "${REPO}" && "${BOT_GIT}" check --pair a=b "${BASE}..HEAD" 2>&1) && fail "--pair without --was: check passed"
grep -q -- '--pair needs the published head' <<<"${out}" || fail "--pair without --was: ${out}"

# The main case end to end: a local fixup squashed into the signed commit
# with 'bot-git rebase', then rework and check against @{upstream}.
build old bot:bot:a:n bot:human:b:y
git -C "${REPO}" branch -q -f published HEAD
git -C "${REPO}" branch -q --set-upstream-to=published
echo fix >"${REPO}/b"
git -C "${REPO}" add b
commit_as bot bot "fixup! b\n\n${AI}"
(cd "${REPO}" && GIT_SEQUENCE_EDITOR=: "${BOT_GIT}" rebase -q -i --autosquash "${BASE}") || fail "autosquash failed"
out=$(cd "${REPO}" && "${BOT_GIT}" check 2>&1) && fail "squashed: check passed before rework: ${out}"
grep -q "has Signed-off-by: ${HUMAN}" <<<"${out}" || fail "squashed: check before rework: ${out}"
out=$(cd "${REPO}" && "${BOT_GIT}" rework 2>&1) || fail "squashed: rework: ${out}"
test "$(git -C "${REPO}" show HEAD:b)" = fix || fail "squashed: lost the fix"
out=$(cd "${REPO}" && "${BOT_GIT}" check 2>&1) || fail "squashed: check: ${out}"
grep -q "^ok: 1 commits in @{upstream}..HEAD, 1 with cgwalters' sign-off kept" <<<"${out}" || fail "squashed: check: ${out}"

# check refuses his sign-off without a published head, or where it had none.
out=$(cd "${REPO}" && "${BOT_GIT}" check "${BASE}..HEAD" 2>&1) && fail "no --was: check passed"
grep -q 'no published head to compare with (pass --was OLD-HEAD)' <<<"${out}" || fail "no --was: ${out}"
build old bot:bot:a:n
OLD=$(git -C "${REPO}" rev-parse HEAD)
build new bot:human:a:y
out=$(cd "${REPO}" && "${BOT_GIT}" check --was "${OLD}" "${BASE}..HEAD" 2>&1) && fail "new sign-off: check passed"
grep -q "has Signed-off-by: ${HUMAN}" <<<"${out}" || fail "new sign-off: ${out}"
build old bot:human:a:y bot:bot:b:n
OLD=$(git -C "${REPO}" rev-parse HEAD)
build new bot:human:a:y
out=$(cd "${REPO}" && "${BOT_GIT}" check --was "${OLD}" "${BASE}..HEAD" 2>&1) && fail "count changed: check passed"
grep -q "but 'b' of .* is gone from" <<<"${out}" || fail "count changed: ${out}"

# A kept commit with another sign-off next to his: rework and check refuse.
build old bot:human:a:y
OLD=$(git -C "${REPO}" rev-parse HEAD)
build new bot:bot:a:y
GIT_COMMITTER_NAME="${BOT% <*}" GIT_COMMITTER_EMAIL=walters+llm@verbum.org \
    git -C "${REPO}" commit -q --amend --allow-empty -m "a" -m "new body" -m "${AI}
${SOB}
Signed-off-by: ${BOT}"
out=$(cd "${REPO}" && "${BOT_GIT}" rework --was "${OLD}" 2>&1) && fail "extra sign-off: rework passed: ${out}"
grep -q "has a Signed-off-by other than cgwalters'" <<<"${out}" || fail "extra sign-off: rework: ${out}"
GIT_COMMITTER_NAME="${HUMAN% <*}" GIT_COMMITTER_EMAIL=walters@verbum.org \
    git -C "${REPO}" commit -q --amend --allow-empty --no-edit
out=$(cd "${REPO}" && "${BOT_GIT}" check --was "${OLD}" "${OLD}..HEAD" 2>&1) && fail "extra sign-off: check passed: ${out}"
grep -q "has Signed-off-by: ${HUMAN}, ${BOT}" <<<"${out}" || fail "extra sign-off: check: ${out}"

# Reworked and rebased onto a newer base: the base's commits are not
# rewritten, and without UPSTREAM rework says to pass it.
build old bot:human:a:y
OLD=$(git -C "${REPO}" rev-parse HEAD)
git -C "${REPO}" reset -q --hard "${BASE}"
commit_as other other "upstream\n"
git -C "${REPO}" branch -q -f newbase HEAD
echo new >"${REPO}/a"
git -C "${REPO}" add a
commit_as bot bot "a\n\nnew body\n\n${AI}"
out=$(cd "${REPO}" && "${BOT_GIT}" rework --was "${OLD}" 2>&1) && fail "rebased: rework without UPSTREAM passed: ${out}"
grep -q 'is new since .* pass it as UPSTREAM' <<<"${out}" || fail "rebased: ${out}"
out=$(cd "${REPO}" && "${BOT_GIT}" rework --was "${OLD}" newbase 2>&1) || fail "rebased: rework: ${out}"
test "$(git -C "${REPO}" rev-parse HEAD^)" = "$(git -C "${REPO}" rev-parse newbase)" || fail "rebased: the base was rewritten"
test "$(git -C "${REPO}" show -s --format='%cn <%ce>' HEAD)" = "${HUMAN}" || fail "rebased: not committed by cgwalters"
out=$(cd "${REPO}" && "${BOT_GIT}" check --was "${OLD}" newbase..HEAD 2>&1) || fail "rebased: check: ${out}"
grep -q "^ok: 1 commits in newbase..HEAD, 1 with cgwalters' sign-off kept" <<<"${out}" || fail "rebased: check: ${out}"

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-git commits as the bot, refuses to sign off, keeps cgwalters' on reworked commits, and checks commits"

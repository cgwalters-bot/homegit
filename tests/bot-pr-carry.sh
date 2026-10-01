#!/usr/bin/env bash
# Offline tests of 'bot-pr carry-note' and 'bot-pr no-carry', end to end
# with 'bot-git carry-signoff': local bare repositories stand in for
# GitHub's (acme/proj upstream and its cgwalters-forge fork), and the fake
# gh of tests/fixtures answers the REST calls and records the comments
# posted. No network.
#   tests/bot-pr-carry.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_PR=${TESTS}/../bin/bot-pr BOT_GIT=${TESTS}/../bin/bot-git
readonly BOT_NAME="Colin Walters" BOT_EMAIL=walters+llm@verbum.org
readonly HUMAN_NAME="Colin Walters" HUMAN_EMAIL=walters@verbum.org
readonly SOB="Signed-off-by: ${HUMAN_NAME} <${HUMAN_EMAIL}>"
readonly AI="Generated-by: AI"
readonly F=cgwalters-forge/proj
readonly URL=https://github.com/acme/proj/pull/7
readonly COMMENTS_FIXTURE=repos/acme/proj/issues/7/comments

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-carry-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
readonly REMOTES=${WORK}/remotes SRC=${WORK}/src
export FAKE_GH=${WORK}/gh REMOTES
export BOT_PR_GIT_URL=file://${REMOTES}/
export XDG_CACHE_HOME=${WORK}/cache XDG_STATE_HOME=${WORK}/state
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
export BOT_GIT_SHARED_CLONES=${WORK}/no-shared-clones
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
install -m 0755 "${TESTS}/fixtures/bot-pr-fake-gh" "${WORK}/bin/gh"

# fixture PATH: store stdin as the answer to 'gh api PATH'.
fixture() {
    mkdir -p "$(dirname "${FAKE_GH}/rest/$1")"
    cat >"${FAKE_GH}/rest/$1.json"
}

# commit_as WHO FILE MESSAGE: writes MESSAGE's subject to FILE in SRC and
# commits it as WHO: bot, or bot-by-human (committed by cgwalters, as
# promote signs off).
commit_as() {
    local cname=${BOT_NAME} cemail=${BOT_EMAIL}
    test "$1" = bot || cname=${HUMAN_NAME} cemail=${HUMAN_EMAIL}
    echo "${3%%$'\n'*} $1" >"${SRC}/$2"
    git -C "${SRC}" add "$2"
    GIT_AUTHOR_NAME=${BOT_NAME} GIT_AUTHOR_EMAIL=${BOT_EMAIL} GIT_COMMITTER_NAME=${cname} GIT_COMMITTER_EMAIL=${cemail} \
        git -C "${SRC}" -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -q --cleanup=verbatim -m "$3"
}

# sha_of TIP SUBJECT: the commit of main..TIP with SUBJECT.
sha_of() {
    git -C "${SRC}" log --format='%H %s' "main..$1" | awk -v s="$2" '$2 == s { print $1 }'
}

# signed_subjects REF: the subjects of the fork's commits on REF that
# cgwalters signed off and committed, sorted, comma-separated.
signed_subjects() {
    local r=${REMOTES}/${F}
    git -C "${r}" log --format='%H %s' "main..$1" | while read -r c s; do
        git -C "${r}" show -s --format='%cn <%ce>%n%B' "${c}" | grep -qxF "${SOB}" &&
            test "$(git -C "${r}" show -s --format='%ce' "${c}")" = "${HUMAN_EMAIL}" && echo "${s}"
    done | sort | paste -sd, -
}

# comment ID WHO BODY: a conversation comment as GitHub lists it.
comment() {
    jq -nc --argjson id "$1" --arg who "$2" --arg body "$3" \
        '{id: $id, user: {login: $who}, body: $body, html_url: "https://github.com/acme/proj/pull/7#issuecomment-\($id)"}'
}

# posted: the bodies of the comments posted so far, as a JSON array.
posted() {
    { cut -d' ' -f2- "${FAKE_GH}/comments" 2>/dev/null || true; } | jq -s .
}

for r in acme/proj "${F}"; do
    git init -q --bare "${REMOTES}/${r}"
    git -C "${REMOTES}/${r}" config uploadpack.allowFilter true
done
git init -q "${SRC}"
echo base >"${SRC}/README"
git -C "${SRC}" add README
git -C "${SRC}" -c user.name=Other -c user.email=other@example.com commit -q -m base
for r in acme/proj "${F}"; do
    git -C "${SRC}" push -q "file://${REMOTES}/${r}" main:main
done
jq -n '{number: 7, state: "open", title: "Change", user: {login: "cgwalters-bot"},
        html_url: "https://github.com/acme/proj/pull/7",
        base: {ref: "main", repo: {full_name: "acme/proj"}},
        head: {ref: "bot/x", repo: {full_name: "cgwalters-forge/proj"}}, body: "Why."}' |
    fixture repos/acme/proj/pulls/7

# H0, as promote signed it off: a and b.
git -C "${SRC}" switch -q -c bot/x
commit_as bot-by-human a "a"$'\n\n'"${AI}"$'\n'"${SOB}"
commit_as bot-by-human b "b"$'\n\n'"${AI}"$'\n'"${SOB}"
H0=$(git -C "${SRC}" rev-parse HEAD)
git -C "${SRC}" push -q "file://${REMOTES}/${F}" HEAD:refs/heads/bot/x

# H1: a changed (the rebase kept its trailer text), a new commit p, and b
# rewritten.
git -C "${SRC}" reset -q --hard main
commit_as bot a "a"$'\n\n'"${AI}"$'\n'"${SOB}"
commit_as bot p "p"$'\n\n'"${AI}"
commit_as bot b "b"$'\n\nrewritten\n\n'"${AI}"
H1=$(git -C "${SRC}" rev-parse HEAD)
jq -n --arg was "${H0}" --arg head "${H1}" --arg a0 "$(sha_of "${H0}" a)" --arg a1 "$(sha_of "${H1}" a)" \
    --arg b0 "$(sha_of "${H0}" b)" --arg b1 "$(sha_of "${H1}" b)" \
    '{version: 1, pr: "https://github.com/acme/proj/pull/7", reviewer: "attest subagent", was: $was, head: $head,
      commits: [{old: $a0, new: $a1, class: "conflict-resolution", reason: "kept both sides of a context conflict"},
                {old: $b0, new: $b1, class: "substantive", reason: "rewrote the approach"}]}' >"${WORK}/att.json"
out=$(cd "${SRC}" && "${BOT_GIT}" carry-signoff --was "${H0}" --attestation "${WORK}/att.json" 2>&1) || fail "carry-signoff: ${out}"
H1C=$(git -C "${SRC}" rev-parse HEAD)
readonly RECORD=${WORK}/att.carried.json
jq -e --arg h "${H1C}" '.head == $h' "${RECORD}" >/dev/null || fail "carry-signoff: no record of ${H1C}"

# --- carry-note ---
out=$("${BOT_PR}" carry-note "${URL}" "${RECORD}" 2>&1) && fail "carry-note before the push: not refused"
grep -q "head is ${H0:0:12}, not ${H1C:0:12} that .* names: push that first" <<<"${out}" || fail "carry-note before the push: ${out}"
test "$(posted)" = "[]" || fail "carry-note before the push: commented"
git -C "${SRC}" push -q -f "file://${REMOTES}/${F}" HEAD:refs/heads/bot/x
test "$(signed_subjects bot/x)" = a || fail "pushed: signed are '$(signed_subjects bot/x)', expected a"
out=$("${BOT_PR}" carry-note "${URL}" "${RECORD}" 2>&1) || fail "carry-note: ${out}"
body=$(posted | jq -r '.[0] // ""')
for want in "Kept cgwalters' \`Signed-off-by\` on 1 commit(s) since \`${H0:0:12}\`" \
    "- \`$(git -C "${SRC}" rev-parse --short=12 "$(sha_of "${H1C}" a)")\` a: " \
    "a: (b) mechanical conflict resolution. kept both sides of a context conflict" \
    "b: (e) substantively different. rewrote the approach" \
    "New since then, so never signed this way" \
    "Attested by: attest subagent." \
    "To check: \`git range-diff " \
    "cgwalters replies \`/no-carry\`" \
    "<!-- bot-pr carry was=${H0} head=${H1C} carried=$(sha_of "${H1C}" a) -->"; do
    grep -qF -- "${want}" <<<"${body}" || fail "carry-note: the comment lacks '${want}': ${body}"
done
grep -qF -- "- \`$(git -C "${SRC}" rev-parse --short=12 "$(sha_of "${H1C}" p)")\` p" <<<"${body}" || fail "carry-note: p is not listed as new: ${body}"
# Once only: the comment is there now.
comment 100 cgwalters-bot "${body}" | jq -s . | fixture "${COMMENTS_FIXTURE}"
out=$("${BOT_PR}" carry-note "${URL}" "${RECORD}" 2>&1) || fail "carry-note again: ${out}"
test "$(posted | jq length)" -eq 1 || fail "carry-note again: commented twice"
# A record for another PR.
jq '.pr = "https://github.com/acme/proj/pull/8"' "${RECORD}" >"${WORK}/other.json"
out=$("${BOT_PR}" carry-note "${URL}" "${WORK}/other.json" 2>&1) && fail "carry-note, another PR's record: not refused"
grep -q "is for https://github.com/acme/proj/pull/8, not ${URL}" <<<"${out}" || fail "carry-note, another PR's record: ${out}"

# A carry from the head an earlier carry pushed is refused: each one
# compares with the head he approved.
jq --arg was "${H1C}" --arg head "${H1C}" '.was = $was | .head = $head' "${RECORD}" >"${WORK}/chained.json"
out=$("${BOT_PR}" carry-note "${URL}" "${WORK}/chained.json" 2>&1) && fail "carry-note, a chained carry: not refused"
grep -q "which an earlier carry on ${URL} made: redo 'bot-git carry-signoff' from ${H0:0:12}" <<<"${out}" || fail "carry-note, a chained carry: ${out}"
test "$(posted | jq length)" -eq 1 || fail "carry-note, a chained carry: commented"
# A record with a class it doesn't know.
jq '.commits[0].class = "fine"' "${RECORD}" >"${WORK}/badclass.json"
out=$("${BOT_PR}" carry-note "${URL}" "${WORK}/badclass.json" 2>&1) && fail "carry-note, an unknown class: not refused"
grep -q "is not a record of 'bot-git carry-signoff'" <<<"${out}" || fail "carry-note, an unknown class: ${out}"

# --- no-carry ---
CARRY=$(comment 100 cgwalters-bot "${body}")
readonly CARRY
# NAME|COMMENTS|EXPECT: no-carry with the comments after the carry
# comment (ID:WHO:BODY, ';'-separated, \n escapes; 'nocarry' before an
# ID puts it before the carry comment), from the carried head. EXPECT
# is 'nothing' (no push, no comment) or 'dropped SUBJECTS' (left signed:
# none).
while IFS='|' read -r name comments expect; do
    test -n "${name}" || continue
    git -C "${SRC}" push -q -f "file://${REMOTES}/${F}" "${H1C}:refs/heads/bot/x"
    : >"${FAKE_GH}/comments"
    {
        echo "${CARRY}"
        IFS=';' read -ra cs <<<"${comments}"
        for c in "${cs[@]}"; do
            IFS=: read -r id who text <<<"${c}"
            comment "${id}" "${who}" "$(printf '%b' "${text}")"
        done
    } | jq -s . | fixture "${COMMENTS_FIXTURE}"
    status=0
    out=$("${BOT_PR}" no-carry "${URL}" 2>&1) || status=$?
    test "${status}" -eq 0 || { fail "no-carry: ${name}: exit status ${status}: ${out}"; continue; }
    head=$(git -C "${REMOTES}/${F}" rev-parse bot/x)
    if test "${expect}" = nothing; then
        test "${head}" = "${H1C}" || fail "no-carry: ${name}: pushed"
        test "$(posted)" = "[]" || fail "no-carry: ${name}: commented: $(posted)"
        continue
    fi
    test "${head}" != "${H1C}" || { fail "no-carry: ${name}: nothing pushed: ${out}"; continue; }
    test "$(tail -n1 <<<"${out}")" = "${head}" || fail "no-carry: ${name}: printed '$(tail -n1 <<<"${out}")', not the new head"
    test -z "$(signed_subjects bot/x)" || fail "no-carry: ${name}: still signed: $(signed_subjects bot/x)"
    test "$(git -C "${REMOTES}/${F}" rev-parse "bot/x^{tree}")" = "$(git -C "${SRC}" rev-parse "${H1C}^{tree}")" || fail "no-carry: ${name}: tree changed"
    reply=$(posted | jq -r '.[0] // ""')
    grep -qF "Dropped cgwalters' \`Signed-off-by\` from \`" <<<"${reply}" || fail "no-carry: ${name}: reply: ${reply}"
    grep -qF "<!-- bot-pr no-carry ask=" <<<"${reply}" || fail "no-carry: ${name}: no record in the reply: ${reply}"
    # shellcheck disable=SC2016 # backquotes, not an expansion
    test "$(grep -o '`[0-9a-f]*`' <<<"${reply%%per *}" | wc -l)" -eq "${expect#dropped }" || fail "no-carry: ${name}: expected ${expect}: ${reply}"
done <<'EOF'
no /no-carry||nothing
someone else's /no-carry|101:someone:/no-carry|nothing
/no-carry quoted|101:cgwalters:> /no-carry|nothing
/no-carry inline|101:cgwalters:please no-carry this|nothing
/no-carry|101:cgwalters:/no-carry|dropped 1
/no-carry among other lines|101:cgwalters:Hmm, not so small.\n  /no-carry  \nThanks|dropped 1
already answered|101:cgwalters:/no-carry;102:cgwalters-bot:Dropped it.\n<!-- bot-pr no-carry ask=101 head=x -->|nothing
asked again after the answer|101:cgwalters:/no-carry;102:cgwalters-bot:Dropped it.\n<!-- bot-pr no-carry ask=101 head=x -->;103:cgwalters:/no-carry|nothing
EOF

# A /no-carry with no carry comment before it is nothing to act on.
: >"${FAKE_GH}/comments"
{ comment 99 cgwalters /no-carry; echo "${CARRY}"; } | jq -s . | fixture "${COMMENTS_FIXTURE}"
out=$("${BOT_PR}" no-carry "${URL}" 2>&1) || fail "no-carry before the carry: ${out}"
test "$(git -C "${REMOTES}/${F}" rev-parse bot/x)" = "${H1C}" || fail "no-carry before the carry: pushed"

# After a later push the carried commits aren't known: all of the bot's
# commits lose his sign-off, here a whose carry comment named another head.
git -C "${SRC}" switch -q --detach "${H1C}"
(cd "${SRC}" && "${BOT_GIT}" -c core.hooksPath=/dev/null commit -q --allow-empty -m "later" -m "${AI}")
git -C "${SRC}" push -q -f "file://${REMOTES}/${F}" HEAD:refs/heads/bot/x
: >"${FAKE_GH}/comments"
{ echo "${CARRY}"; comment 101 cgwalters /no-carry; } | jq -s . | fixture "${COMMENTS_FIXTURE}"
out=$("${BOT_PR}" no-carry "${URL}" 2>&1) || fail "no-carry after a later push: ${out}"
grep -q "all of the bot's commits, since the head moved after the carry" <<<"${out}" || fail "no-carry after a later push: ${out}"
test -z "$(signed_subjects bot/x)" || fail "no-carry after a later push: still signed: $(signed_subjects bot/x)"

# --dry-run pushes and posts nothing.
git -C "${SRC}" push -q -f "file://${REMOTES}/${F}" "${H1C}:refs/heads/bot/x"
: >"${FAKE_GH}/comments"
{ echo "${CARRY}"; comment 101 cgwalters /no-carry; } | jq -s . | fixture "${COMMENTS_FIXTURE}"
out=$("${BOT_PR}" no-carry "${URL}" --dry-run 2>&1) || fail "no-carry --dry-run: ${out}"
test "$(git -C "${REMOTES}/${F}" rev-parse bot/x)" = "${H1C}" || fail "no-carry --dry-run: pushed"
test "$(posted)" = "[]" || fail "no-carry --dry-run: commented"
grep -q '^Would push' <<<"${out}" || fail "no-carry --dry-run: ${out}"

# Neither touches a fork PR.
out=$("${BOT_PR}" no-carry "https://github.com/${F}/pull/3" 2>&1) && fail "no-carry on a fork PR: not refused"
grep -q 'is not an upstream PR' <<<"${out}" || fail "no-carry on a fork PR: ${out}"

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: bot-pr carry-note comments once on a carried head, and no-carry drops the carried sign-offs on /no-carry"

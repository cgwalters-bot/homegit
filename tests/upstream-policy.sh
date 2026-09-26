#!/usr/bin/env bash
# Offline tests of bin/upstream-policy, the contribution policy gate of
# 'bot-pr promote' and 'bot-pr signoff': records in a local git
# repository, and a fake gh that answers the REST calls from fixtures of
# acme/proj and acme/.github. No network.
#   tests/upstream-policy.sh
set -euo pipefail
shopt -s inherit_errexit

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly TOOL=${TESTS}/../bin/upstream-policy
readonly EX_ERROR=1 EX_MISSING=3 EX_STALE=4 EX_HUMAN_TEXT=5 EX_REFUSED=6 EX_INVALID=7 EX_RATELIMIT=75

WORK=$(mktemp -d "${TMPDIR:-/tmp}/upstream-policy-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh UPSTREAM_POLICY_DIR=${WORK}/homegit/upstream-policy XDG_STATE_HOME=${WORK}/state XDG_CACHE_HOME=${WORK}/cache
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
# Fixed commit dates, so that runs don't depend on how fast they are:
# commits with the same parent, tree and message are then the same commit.
export GIT_AUTHOR_DATE=2026-09-25T12:00:00Z GIT_COMMITTER_DATE=2026-09-25T12:00:00Z
export PATH=${WORK}/bin:${PATH}

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# The fake gh: 'gh api PATH' prints $FAKE_GH/rest/PATH.json, or fails
# with the message in $FAKE_GH/rest/PATH.err, or with a 404; with
# $FAKE_GH/ratelimit, it fails as rate limited. Calls are logged to
# $FAKE_GH/calls.
mkdir -p "${WORK}/bin" "${FAKE_GH}/rest"
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GH}/calls"
test "$1 $#" = "api 2" || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
test ! -e "${FAKE_GH}/ratelimit" || { echo "gh: API rate limit exceeded (HTTP 403)" 1>&2; exit 1; }
f=${FAKE_GH}/rest/$2.json
test ! -e "${f%.json}.err" || { cat "${f%.json}.err" 1>&2; exit 1; }
test -e "${f}" || { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
cat "${f}"
EOF
chmod +x "${WORK}/bin/gh"

# fixture PATH: store stdin as the answer to 'gh api PATH'.
fixture() {
    mkdir -p "$(dirname "${FAKE_GH}/rest/$1")"
    cat >"${FAKE_GH}/rest/$1.json"
}

# tree REPO SHA_OR_BRANCH ENTRY...: the tree fixture, each ENTRY being
# "NAME TYPE SHA".
tree() {
    local repo=$1 id=$2 e
    shift 2
    for e in "$@"; do
        read -r name type sha <<<"${e}"
        jq -n --arg p "${name}" --arg t "${type}" --arg s "${sha}" '{path: $p, type: $t, sha: $s}'
    done | jq -s '{truncated: false, tree: .}' | fixture "repos/${repo}/git/trees/${id}"
}

sha() {
    printf '%040d' "$1"
}

# --- acme/proj and acme/.github on GitHub ---
CONTRIB=$(sha 1) TEMPLATE=$(sha 2) ORG_CONTRIB=$(sha 3) HACKING=$(sha 4)
GITHUB_DIR=$(sha 10) SRC_DIR=$(sha 11) ORG_GITHUB_DIR=$(sha 12) DOCS_DIR=$(sha 13)
readonly CONTRIB TEMPLATE ORG_CONTRIB HACKING GITHUB_DIR SRC_DIR ORG_GITHUB_DIR DOCS_DIR
readonly PROJ_INFO='{"full_name": "acme/proj", "default_branch": "main"}'
echo "${PROJ_INFO}" | fixture repos/acme/proj
echo '{"full_name": "acme/.github", "default_branch": "trunk"}' | fixture repos/acme/.github
# proj_tree [ENTRY...]: acme/proj's top, with more entries.
proj_tree() {
    tree acme/proj main "CONTRIBUTING.md blob ${CONTRIB}" "README.md blob $(sha 20)" "src tree ${SRC_DIR}" \
        ".github tree ${GITHUB_DIR}" "docs tree ${DOCS_DIR}" "vendor commit $(sha 21)" "$@"
}
proj_tree
tree acme/proj "${GITHUB_DIR}" "pull_request_template.md blob ${TEMPLATE}" "workflows tree $(sha 22)"
tree acme/proj "${SRC_DIR}" "HACKING.md blob ${HACKING}" "main.rs blob $(sha 23)"
# Not policy files: 'maintainers' has 'ai' only inside a word.
tree acme/proj "${DOCS_DIR}" "maintainers.md blob $(sha 24)" "email-setup.md blob $(sha 25)"
tree acme/.github trunk "CONTRIBUTING.md blob ${ORG_CONTRIB}" "profile tree $(sha 26)" ".github tree ${ORG_GITHUB_DIR}"
tree acme/.github "${ORG_GITHUB_DIR}" "FUNDING.yml blob $(sha 27)"

# --- The records, in a git repository like homegit, pushed to origin ---
git config --global init.defaultBranch main
git config --global user.name nobody
git config --global user.email nobody@example.com
readonly HOMEGIT=${WORK}/homegit
git init -q --bare "${WORK}/origin.git"
git init -q "${HOMEGIT}"
git -C "${HOMEGIT}" remote add origin "${WORK}/origin.git"
mkdir -p "${UPSTREAM_POLICY_DIR}/acme"
readonly RECORD=${UPSTREAM_POLICY_DIR}/acme/proj.md

# The sources block of a current record: what scan finds, plus src/HACKING.md.
readonly SOURCES="sources:
  - repo: acme/proj
    path: CONTRIBUTING.md
    sha: ${CONTRIB}
  - repo: acme/proj
    path: .github/pull_request_template.md
    sha: ${TEMPLATE}
  - repo: acme/.github
    path: CONTRIBUTING.md
    sha: ${ORG_CONTRIB}
  - path: src/HACKING.md
    sha: \"${HACKING}\""

# vouch [VERIFIED LOGIN [COMMIT]]: what GitHub says of homegit's COMMIT
# (default: HEAD; verified, by cgwalters), pushed directly: no pull
# request.
vouch() {
    local commit
    commit=$(git -C "${HOMEGIT}" rev-parse "${3:-HEAD}")
    jq -n --argjson v "${1:-true}" --arg l "${2:-cgwalters}" '{commit: {verification: {verified: $v}}, author: {login: $l}}' |
        fixture "repos/cgwalters-bot/homegit/commits/${commit}"
    echo '[]' | fixture "repos/cgwalters-bot/homegit/commits/${commit}/pulls"
}

# pulled COMMIT MERGED BASE HEAD TREE REVIEWS: homegit's COMMIT came from
# pull request #7 into BASE (merged if MERGED), whose HEAD has TREE and
# was merged as COMMIT, with REVIEWS as "LOGIN:STATE:COMMIT_ID ...".
pulled() {
    local r login state id reviews=()
    jq -n --arg c "$1" --argjson m "$2" --arg b "$3" --arg h "$4" \
        '[{number: 7, merged_at: (if $m then "2026-09-25T00:00:00Z" else null end),
           base: {ref: $b, repo: {full_name: "cgwalters-bot/homegit"}}, head: {sha: $h}, merge_commit_sha: $c}]' |
        fixture "repos/cgwalters-bot/homegit/commits/$1/pulls"
    jq -n --arg t "$5" '{tree: {sha: $t}}' | fixture "repos/cgwalters-bot/homegit/git/commits/$4"
    for r in $6; do
        IFS=: read -r login state id <<<"${r}"
        reviews+=("$(jq -n --arg l "${login}" --arg s "${state}" --arg i "${id}" '{user: {login: $l}, state: $s, commit_id: $i}')")
    done
    printf '%s\n' "${reviews[@]}" | jq -s . | fixture "repos/cgwalters-bot/homegit/pulls/7/reviews?per_page=100"
}

# publish MESSAGE: commit all of homegit, push it and vouch for it.
publish() {
    git -C "${HOMEGIT}" add -A
    git -C "${HOMEGIT}" commit -q -m "$1"
    git -C "${HOMEGIT}" push -q origin HEAD:main
    vouch
}

# record VERDICT [SOURCES] [MODE]: write, commit and push acme/proj's
# record, and vouch for the commit; MODE 'uncommitted' stops before the
# commit, 'unpushed' before the push, 'unvouched' before vouching.
record() {
    mkdir -p "$(dirname "${RECORD}")"
    cat >"${RECORD}" <<EOF
---
verdict: $1
ai-trailer: Assisted-by
dco: yes (required status check DCO on main)
${2:-${SOURCES}}
checked: 2026-09-25 by the policy-check subagent
---

> CONTRIBUTING.md: "Disclose AI assistance."

Rationale.
EOF
    test "${3:-}" != uncommitted || return 0
    git -C "${HOMEGIT}" add -A
    git -C "${HOMEGIT}" commit -q --allow-empty -m "record $1"
    test "${3:-}" != unpushed || return 0
    git -C "${HOMEGIT}" push -q origin HEAD:main
    test "${3:-}" != unvouched || return 0
    vouch
}

# run NAME STATUS PATTERN ARGS...: run the tool with ARGS; fail NAME
# unless it exits with STATUS and its output matches PATTERN.
run() {
    local name=$1 expected=$2 pattern=$3 status=0 out
    shift 3
    out=$("${TOOL}" "$@" 2>&1) || status=$?
    test "${status}" -eq "${expected}" || fail "${name}: exit status ${status}, expected ${expected}; output:"$'\n'"${out}"
    grep -qE -- "${pattern}" <<<"${out}" || fail "${name}: output lacks '${pattern}':"$'\n'"${out}"
}

run "missing record" "${EX_MISSING}" 'acme/proj has no policy record .*policy-check\.md' check acme/proj

# scan lists the policy files of the repository and its owner's .github
# (only its top and .github, docs, which are scanned), and nothing else.
run "scan" 0 . scan acme/proj
scanned=$("${TOOL}" scan acme/proj)
expected_scan="sources:
  - repo: acme/proj
    path: CONTRIBUTING.md
    sha: ${CONTRIB}
  - repo: acme/proj
    path: .github/pull_request_template.md
    sha: ${TEMPLATE}
  - repo: acme/.github
    path: CONTRIBUTING.md
    sha: ${ORG_CONTRIB}"
test "${scanned}" = "${expected_scan}" || fail "scan: got"$'\n'"${scanned}"

# Each verdict, with a current record.
while read -r verdict args status pattern; do
    record "${verdict}"
    test "${args}" != - || args=""
    # shellcheck disable=SC2086 # no args is '-'
    run "${verdict} ${args}" "${status}" "${pattern}" check acme/proj ${args}
done <<EOF
bot-ok - 0 ^bot-ok$
bot-ok --allow-human-text 0 ^bot-ok$
human-text - ${EX_HUMAN_TEXT} policy.is.human-text.*must.be.cgwalters'.own
human-text --allow-human-text 0 ^human-text$
human-only --allow-human-text ${EX_REFUSED} policy.is.human-only
no-go - ${EX_REFUSED} policy.is.no-go
EOF

# A record goes stale when a source changes or goes away, and when a
# policy file appears that it doesn't list.
record bot-ok
tree acme/proj "${GITHUB_DIR}" "pull_request_template.md blob $(sha 30)"
run "stale: changed" "${EX_STALE}" 'acme/proj:.github/pull_request_template.md changed' check acme/proj
run "stale: changed" "${EX_STALE}" "policy record is stale; re-check the policy" check acme/proj
tree acme/proj "${GITHUB_DIR}" "pull_request_template.md blob ${TEMPLATE}"
tree acme/proj "${SRC_DIR}" "main.rs blob $(sha 23)"
run "stale: gone" "${EX_STALE}" 'acme/proj:src/HACKING.md is gone' check acme/proj
tree acme/proj "${SRC_DIR}" "HACKING.md blob ${HACKING}"
for f in "AGENTS.md blob" "AI_POLICY.md blob" "llm-usage.rst blob" "PULL_REQUEST_TEMPLATE tree"; do
    proj_tree "${f} $(sha 31)"
    run "stale: new ${f%% *}" "${EX_STALE}" "acme/proj:${f%% *} is not in the record" check acme/proj
done
proj_tree
tree acme/.github trunk "CONTRIBUTING.md blob ${ORG_CONTRIB}" ".github tree ${ORG_GITHUB_DIR}" "CLAUDE.md blob $(sha 32)"
run "stale: new in the org" "${EX_STALE}" 'acme/.github:CLAUDE.md is not in the record' check acme/proj
tree acme/.github trunk "CONTRIBUTING.md blob ${ORG_CONTRIB}" ".github tree ${ORG_GITHUB_DIR}"
run "current again" 0 '^bot-ok$' check acme/proj

# Git is the source of truth: a record counts once it's on origin's main.
record bot-ok "" uncommitted
echo "edited" >>"${RECORD}"
run "uncommitted" "${EX_INVALID}" 'uncommitted changes; commit and push it first' check acme/proj
git -C "${HOMEGIT}" checkout -q -- .
record human-text "" unpushed
run "unpushed" "${EX_INVALID}" "differs from origin/main's; pull" check acme/proj
git -C "${HOMEGIT}" push -q origin HEAD:main
run "pushed" 0 '^human-text$' check acme/proj --allow-human-text
# A verdict tightened on origin counts before this checkout pulls it.
git clone -q "${WORK}/origin.git" "${WORK}/other"
sed -i 's/^verdict: human-text/verdict: human-only/' "${WORK}/other/upstream-policy/acme/proj.md"
git -C "${WORK}/other" commit -q -am tighten
git -C "${WORK}/other" push -q origin HEAD:main
run "tightened elsewhere" "${EX_INVALID}" "differs from origin/main's; pull" check acme/proj
git -C "${HOMEGIT}" pull -q --ff-only origin main
run "tightened elsewhere, pulled" "${EX_REFUSED}" 'policy is human-only' check acme/proj

# Only cgwalters loosens a verdict, in a commit GitHub verified; creating
# a record and tightening one need no one.
record bot-ok "" unvouched
run "loosened, unknown commit" "${EX_ERROR}" 'HTTP 404|Not Found' check acme/proj
while read -r verified login status; do
    vouch "${verified}" "${login}"
    run "loosened, verified=${verified} by ${login}" "${status}" "$(test "${status}" = 0 && echo '^bot-ok$' ||
        echo 'verdict went from human-only to bot-ok in .*not a commit by cgwalters that GitHub verified')" check acme/proj
done <<EOF
false cgwalters ${EX_INVALID}
true cgwalters-bot ${EX_INVALID}
true cgwalters 0
EOF
record no-go "" unvouched
run "tightened" "${EX_REFUSED}" 'policy is no-go' check acme/proj
# Deleting the record and adding it back looser is a loosening too.
git -C "${HOMEGIT}" rm -q "${RECORD}"
git -C "${HOMEGIT}" commit -q -m "drop"
record bot-ok "" unvouched
vouch false cgwalters-bot
run "loosened via a deletion" "${EX_INVALID}" 'from no-go to bot-ok' check acme/proj
vouch
run "loosened via a deletion, vouched" 0 '^bot-ok$' check acme/proj

# Every loosening counts, not only the last commit that touched the
# verdict line: a later edit doesn't hide one.
record human-text
record bot-ok "" unvouched
LOOSENED=$(git -C "${HOMEGIT}" rev-parse HEAD)
vouch false cgwalters-bot
sed -i 's/^verdict: bot-ok$/verdict: "bot-ok"/' "${RECORD}"
publish "quote the verdict"
run "hidden: quoted" "${EX_INVALID}" "from human-text to bot-ok in ${LOOSENED:0:12}" check acme/proj
echo "verdict: no-go, says the body" >>"${RECORD}"
publish "a body line like a verdict"
run "hidden: body line" "${EX_INVALID}" "from human-text to bot-ok in ${LOOSENED:0:12}" check acme/proj
vouch true cgwalters "${LOOSENED}"
run "hidden, vouched" 0 '^bot-ok$' check acme/proj

# Moving a record doesn't make it new: a rename, or a record deleted and
# added back under another case of the same name.
record no-go
mkdir -p "${UPSTREAM_POLICY_DIR}/elsewhere"
git -C "${HOMEGIT}" mv "${RECORD}" "${UPSTREAM_POLICY_DIR}/elsewhere/proj.md"
sed -i 's/^verdict: no-go$/verdict: bot-ok/' "${UPSTREAM_POLICY_DIR}/elsewhere/proj.md"
git -C "${HOMEGIT}" commit -q -am "move away, loosened"
MOVED=$(git -C "${HOMEGIT}" rev-parse HEAD)
git -C "${HOMEGIT}" mv "${UPSTREAM_POLICY_DIR}/elsewhere/proj.md" "${RECORD}"
publish "move back"
vouch false cgwalters-bot "${MOVED}"
run "moved" "${EX_INVALID}" "from no-go to bot-ok in ${MOVED:0:12}" check acme/proj
vouch true cgwalters "${MOVED}"
run "moved, vouched" 0 '^bot-ok$' check acme/proj
# The same repository's record under another case, never moved there by
# git: deleted, and added back looser under the usual name.
git -C "${HOMEGIT}" rm -q "${RECORD}"
publish "drop"
mkdir -p "${UPSTREAM_POLICY_DIR}/ACME"
git -C "${HOMEGIT}" show "HEAD~1:upstream-policy/acme/proj.md" | sed 's/^verdict: "bot-ok"$/verdict: no-go/; s/^verdict: bot-ok$/verdict: no-go/' \
    >"${UPSTREAM_POLICY_DIR}/ACME/Proj.md"
publish "other case, tighter"
git -C "${HOMEGIT}" rm -q "${UPSTREAM_POLICY_DIR}/ACME/Proj.md"
publish "drop the other case"
record bot-ok "" unvouched
vouch false cgwalters-bot
run "deleted, added back in another case" "${EX_INVALID}" "from no-go to bot-ok in $(git -C "${HOMEGIT}" rev-parse --short=12 HEAD)" check acme/proj
vouch true cgwalters
run "deleted, added back, vouched" 0 '^bot-ok$' check acme/proj

# A loosening that doesn't count is undone by tightening the verdict
# again; one by cgwalters sets a new baseline.
record human-text
record bot-ok "" unvouched
vouch false cgwalters-bot
run "bot loosened" "${EX_INVALID}" 'from human-text to bot-ok in .*still looser than human-text' check acme/proj
record human-only
run "bot loosened, tightened again" "${EX_REFUSED}" 'policy is human-only' check acme/proj
record human-text "" unvouched
vouch false cgwalters-bot
run "bot loosened, still within the baseline" "${EX_INVALID}" 'from human-only to human-text in .*still looser than human-only' check acme/proj
vouch true cgwalters
run "loosened by cgwalters" "${EX_HUMAN_TEXT}" 'policy is human-text' check acme/proj
record bot-ok "" unvouched
vouch false cgwalters-bot
run "bot loosened past his baseline" "${EX_INVALID}" 'still looser than human-text' check acme/proj
vouch true cgwalters
run "his baseline" 0 '^bot-ok$' check acme/proj

# Main takes changes through rebase-merged pull requests, unsigned: his
# approval vouches for a loosening in one, only as his last verdict and
# only on exactly what was merged. STATUS is 0, or the exit status and
# the pattern; '=' is the merged tree, '@' the merged head.
record human-text
record bot-ok "" unvouched
vouch false cgwalters-bot
LOOSENED=$(git -C "${HOMEGIT}" rev-parse HEAD)
TREE=$(git -C "${HOMEGIT}" rev-parse "HEAD^{tree}")
HEAD_SHA=$(sha 50)
while read -r status merged base tree reviews; do
    test "${tree}" != = || tree=${TREE}
    pulled "${LOOSENED}" "${merged}" "${base}" "${HEAD_SHA}" "${tree}" "${reviews//@/${HEAD_SHA}}"
    run "pull: ${merged} ${base} ${reviews}" "${status%%:*}" "$(test "${status}" = 0 && echo '^bot-ok$' || echo "${status#*:}")" \
        check acme/proj
done <<EOF
0 true main = cgwalters:APPROVED:@
0 true main = cgwalters:CHANGES_REQUESTED:@ cgwalters:APPROVED:@ cgwalters:COMMENTED:@
${EX_INVALID}:not.approved.by.cgwalters.at.its.merged.head true main = cgwalters:APPROVED:$(sha 51)
${EX_INVALID}:not.approved.by.cgwalters.at.its.merged.head true main = cgwalters:APPROVED:@ cgwalters:CHANGES_REQUESTED:@
${EX_INVALID}:not.approved.by.cgwalters.at.its.merged.head true main = cgwalters:APPROVED:@ cgwalters:DISMISSED:@
${EX_INVALID}:not.approved.by.cgwalters.at.its.merged.head true main = someone:APPROVED:@ cgwalters-bot:APPROVED:@
${EX_INVALID}:whose.tree.is.not.that.of.the.head.cgwalters.approved true main $(sha 52) cgwalters:APPROVED:@
${EX_INVALID}:not.merged.from.a.pull.request false main = cgwalters:APPROVED:@
${EX_INVALID}:not.merged.from.a.pull.request true other = cgwalters:APPROVED:@
EOF
record human-text

# A record must be a regular file, in git too: a symlink would make
# another file's history the record's.
mkdir -p "${UPSTREAM_POLICY_DIR}/zz"
sed 's/^verdict: .*/verdict: bot-ok/' "${RECORD}" >"${UPSTREAM_POLICY_DIR}/zz/fresh.md"
record human-text
ln -sf ../zz/fresh.md "${RECORD}"
publish "symlink the record"
run "symlinked record" "${EX_INVALID}" 'not a regular file \(a symlink\?\)' check acme/proj
rm "${RECORD}"
mv "${UPSTREAM_POLICY_DIR}/zz/fresh.md" "${UPSTREAM_POLICY_DIR}/zz/proj.md"
rmdir "${UPSTREAM_POLICY_DIR}/acme"
ln -s zz "${UPSTREAM_POLICY_DIR}/acme"
publish "symlink the directory"
run "symlinked directory" "${EX_INVALID}" 'upstream-policy/acme/proj.md is not a regular file in git at HEAD' check acme/proj
rm "${UPSTREAM_POLICY_DIR}/acme"
mkdir -p "${UPSTREAM_POLICY_DIR}/acme"
git -C "${HOMEGIT}" mv "${UPSTREAM_POLICY_DIR}/zz/proj.md" "${RECORD}"
sed -i 's/^verdict: .*/verdict: human-text/' "${RECORD}"
publish "a record again"
run "a record again" "${EX_HUMAN_TEXT}" 'policy is human-text' check acme/proj
record bot-ok
run "loosened again by cgwalters" 0 '^bot-ok$' check acme/proj

# Rewritten history: origin's main must descend from the one the last
# check accepted.
ACCEPTED=$(git -C "${HOMEGIT}" rev-parse HEAD)
git -C "${HOMEGIT}" reset -q --hard HEAD~1
record bot-ok "" uncommitted
git -C "${HOMEGIT}" commit -q -am "rewritten history"
test "$(git -C "${HOMEGIT}" rev-parse HEAD)" != "${ACCEPTED}" || fail "force-pushed: the rewrite is the accepted commit"
git -C "${HOMEGIT}" push -q -f origin HEAD:main
vouch
run "force-pushed" "${EX_INVALID}" "does not descend from ${ACCEPTED:0:12}, which the last check accepted" check acme/proj
rm -r "${XDG_STATE_HOME}/upstream-policy"
run "force-pushed, state removed" 0 '^bot-ok$' check acme/proj
git -C "${HOMEGIT}" reset -q --hard "${ACCEPTED}"
git -C "${HOMEGIT}" push -q -f origin HEAD:main
run "forward again" "${EX_INVALID}" "does not descend from" check acme/proj
rm -r "${XDG_STATE_HOME}/upstream-policy"
run "forward again, state removed" 0 '^bot-ok$' check acme/proj

# Invalid records.
while IFS='|' read -r name verdict sources pattern; do
    record "${verdict}" "$(printf '%b' "${sources}")"
    run "invalid: ${name}" "${EX_INVALID}" "${pattern}" check acme/proj
done <<EOF
verdict|maybe||unknown verdict 'maybe'
short sha|bot-ok|sources:\n  - path: CONTRIBUTING.md\n    sha: abc|has no 40-hex 'sha'
unknown key|bot-ok|sources:\n  - path: CONTRIBUTING.md\n    blob: ${CONTRIB}|unknown source key 'blob'
no sources|bot-ok|sources: CONTRIBUTING.md|followed by a list
duplicate key|bot-ok|sources:\n  - path: CONTRIBUTING.md\n    path: README.md\n    sha: ${CONTRIB}|the source's 'path' is set twice
EOF
record bot-ok
sed -i '/^dco:/d' "${RECORD}"
git -C "${HOMEGIT}" commit -q -am "no dco"
git -C "${HOMEGIT}" push -q origin HEAD:main
run "invalid: no dco" "${EX_INVALID}" "no 'dco'" check acme/proj

# An empty sources list is fine while scan finds nothing.
record bot-ok "sources: []"
run "no sources" "${EX_STALE}" 'CONTRIBUTING.md is not in the record' check acme/proj

record bot-ok
touch "${FAKE_GH}/ratelimit"
run "rate limited" "${EX_RATELIMIT}" 'rate limiting' check acme/proj
rm "${FAKE_GH}/ratelimit"

# GitHub failing, or answering without what the check needs, fails it
# rather than looking like a repository without policy files.
record bot-ok
run "current" 0 '^bot-ok$' check acme/proj
# fail_with NAME PATH PATTERN [CONTENT]: with PATH's fixture replaced by
# CONTENT (JSON, or an 'err:' message; default: a 404), check fails with
# EX_ERROR and PATTERN.
fail_with() {
    local f=${FAKE_GH}/rest/$2.json
    cp "${f}" "${WORK}/saved"
    rm "${f}"
    case "${4:-}" in
        err:*) printf '%s\n' "${4#err:}" >"${f%.json}.err" ;;
        ?*) printf '%s\n' "$4" >"${f}" ;;
    esac
    run "$1" 1 "$3" check acme/proj
    rm -f "${f%.json}.err"
    mv "${WORK}/saved" "${f}"
}
fail_with "tree 404" repos/acme/proj/git/trees/main 'Not Found'
fail_with "subtree 404" "repos/acme/proj/git/trees/${GITHUB_DIR}" 'Not Found'
fail_with "tree 409" repos/acme/proj/git/trees/main 'HTTP 409' 'err:gh: Git Repository is empty. (HTTP 409)'
fail_with "tree 502" repos/acme/proj/git/trees/main 'HTTP 502' 'err:gh: Bad Gateway (HTTP 502)'
fail_with "no tree" repos/acme/proj/git/trees/main 'no tree for the top of acme/proj' '{"message": "?"}'
fail_with "truncated tree" repos/acme/proj/git/trees/main 'tree of the top in acme/proj is truncated' \
    '{"truncated": true, "tree": []}'
fail_with "no default branch" repos/acme/proj 'no name or default branch for acme/proj' '{"full_name": "acme/proj"}'
fail_with "repo 404" repos/acme/proj 'Not Found'
fail_with "repo 503" repos/acme/proj 'HTTP 503' 'err:gh: Service Unavailable (HTTP 503)'
# Only the org's .github may be missing.
mv "${FAKE_GH}/rest/repos/acme/.github.json" "${WORK}/saved-org"
run "no org .github" "${EX_STALE}" 'acme/.github is gone|acme/.github:CONTRIBUTING.md is gone' check acme/proj
mv "${WORK}/saved-org" "${FAKE_GH}/rest/repos/acme/.github.json"

# A renamed repository: GitHub redirects, so its record would vouch for
# another name's policy. Case alone is the same repository.
echo '{"full_name": "acme/newproj", "default_branch": "main"}' | fixture repos/acme/proj
run "renamed" 1 'acme/proj was renamed to acme/newproj; the record belongs in upstream-policy/acme/newproj.md' check acme/proj
echo "${PROJ_INFO}" | fixture repos/acme/proj
echo "${PROJ_INFO}" | fixture repos/Acme/PROJ
run "case" 0 '^bot-ok$' check Acme/PROJ

# doc/ is scanned too.
proj_tree "doc tree $(sha 40)"
tree acme/proj "$(sha 40)" "AI-POLICY.md blob $(sha 41)"
run "stale: new in doc/" "${EX_STALE}" 'acme/proj:doc/AI-POLICY.md is not in the record' check acme/proj
proj_tree

# --- rebase: conflicts-only on a merge queue, or when the record says so ---
# workflows REPO ID FILE CONTENT: REPO's main has .github/workflows/FILE
# with CONTENT; ID keeps the tree and blob ids apart between repositories.
workflows() {
    tree "$1" main ".github tree $(sha "$2"1)"
    tree "$1" "$(sha "$2"1)" "workflows tree $(sha "$2"2)"
    tree "$1" "$(sha "$2"2)" "README.md blob $(sha "$2"3)" "$3 blob $(sha "$2"4)"
    jq -n --arg c "$(printf '%s' "$4" | base64 -w0)" '{content: $c, encoding: "base64"}' |
        fixture "repos/$1/git/blobs/$(sha "$2"4)"
}
# Mentions of merge_group that are no trigger: comments, a branch
# filter, a job, a condition, a script.
readonly PLAIN_WORKFLOW="on:  # merge_group, some day
  pull_request:
#  merge_group:
  push:
    branches:
      - merge_group
jobs:
  merge_group:
    if: github.event_name == 'merge_group'
    steps:
      - run: |
          echo merge_group
          merge_group: not YAML"
echo '[{"type": "required_status_checks"}]' | fixture repos/acme/plain/rules/branches/main
workflows acme/plain 50 ci.yml "${PLAIN_WORKFLOW}"
echo '[{"type": "merge_queue", "parameters": {}}]' | fixture repos/acme/ruled/rules/branches/main
workflows acme/ruled 51 ci.yml "${PLAIN_WORKFLOW}"
# No rules fixture (a 404) for the rest, as GitHub may show outsiders.
workflows acme/grouped 52 tests.yaml "on:
  pull_request:
  # for merge queue
  merge_group:
    types: [checks_requested]"
workflows acme/flow 53 ci.yml "on: [pull_request, merge_group]"
workflows acme/listed 54 ci.yml "on:
  - push
  - merge_group"
# A block sequence at column 0, and quoted.
workflows acme/quoted 55 ci.yml "'on':
- push
- 'merge_group'
jobs: {}"
# A flow sequence over several lines.
workflows acme/wrapped 56 ci.yml "on: [push,
  merge_group]
jobs: {}"
while read -r repo pattern; do
    run "rebase ${repo}" 0 "${pattern}" rebase "${repo}" main
done <<'EOF'
acme/plain ^any$
acme/ruled ^conflicts-only: a merge queue \(a merge_queue rule on main\)$
acme/grouped ^conflicts-only: a merge queue \(\.github/workflows/tests\.yaml on main runs on merge_group\)$
acme/flow ^conflicts-only: .*/ci\.yml on main runs on merge_group
acme/listed ^conflicts-only: .*/ci\.yml on main runs on merge_group
acme/quoted ^conflicts-only: .*/ci\.yml on main runs on merge_group
acme/wrapped ^conflicts-only: .*/ci\.yml on main runs on merge_group
EOF
# Cached, without calls, until a day has passed.
workflows acme/grouped 52 tests.yaml "${PLAIN_WORKFLOW}"
: >"${FAKE_GH}/calls"
run "rebase: cached" 0 '^conflicts-only: a merge queue' rebase acme/grouped main
test ! -s "${FAKE_GH}/calls" || fail "rebase: cached, but called: $(cat "${FAKE_GH}/calls")"
jq '.["acme/grouped@main"].at -= 86400000' "${XDG_CACHE_HOME}/upstream-policy/merge-queue.json" >"${WORK}/cache.json"
mv "${WORK}/cache.json" "${XDG_CACHE_HOME}/upstream-policy/merge-queue.json"
run "rebase: expired" 0 '^any$' rebase acme/grouped main
# GitHub failing fails it, rather than looking like no merge queue.
echo 'gh: Bad Gateway (HTTP 502)' >"${FAKE_GH}/rest/repos/acme/ruled/rules/branches/main.err"
rm -r "${XDG_CACHE_HOME}"
run "rebase: rules 502" "${EX_ERROR}" 'HTTP 502' rebase acme/ruled main
rm "${FAKE_GH}/rest/repos/acme/ruled/rules/branches/main.err"
# The record restricts on its own, read from the checkout without a
# call; the gate takes it, and validates it like the rest.
record bot-ok
sed -i 's/^checked:.*/&\nrebase: conflicts-only/' "${RECORD}"
: >"${FAKE_GH}/calls"
run "rebase: record" 0 "^conflicts-only: the policy record says 'rebase: conflicts-only' \(${RECORD}\)$" rebase acme/proj main
test ! -s "${FAKE_GH}/calls" || fail "rebase: record, but called: $(cat "${FAKE_GH}/calls")"
publish "rebase: conflicts-only"
run "rebase: record passes check" 0 '^bot-ok$' check acme/proj
sed -i 's/^rebase: conflicts-only$/rebase: always/' "${RECORD}"
run "rebase: invalid record" "${EX_INVALID}" "'rebase' can only be 'conflicts-only'" rebase acme/proj main
git -C "${HOMEGIT}" checkout -q -- .
# 'rebase: any' beats a merge queue (where cgwalters maintains), but only
# as pushed: uncommitted or unpushed, detection decides, unless HEAD's or
# origin/main's record still says conflicts-only.
echo '[{"type": "merge_queue", "parameters": {}}]' | fixture repos/acme/proj/rules/branches/main
record bot-ok
sed -i 's/^checked:.*/&\nrebase: any/' "${RECORD}"
rm -rf "${XDG_CACHE_HOME}"
run "rebase: any, uncommitted, detected" 0 '^conflicts-only: a merge queue \(a merge_queue rule on main\)$' rebase acme/proj main
git -C "${HOMEGIT}" checkout -q -- .
sed -i 's/^checked:.*/&\nrebase: conflicts-only/' "${RECORD}"
publish "rebase: conflicts-only"
echo '[]' | fixture repos/acme/proj/rules/branches/main
sed -i 's/^rebase: conflicts-only$/rebase: any/' "${RECORD}"
while IFS='|' read -r name step pattern; do
    case "${step}" in
        commit) git -C "${HOMEGIT}" commit -q -am "rebase: any" ;;
        push) git -C "${HOMEGIT}" push -q origin HEAD:main && vouch ;;
    esac
    rm -rf "${XDG_CACHE_HOME}"
    run "rebase: any, ${name}" 0 "${pattern}" rebase acme/proj main
done <<EOF
uncommitted||warning: ignoring 'rebase: any': .*has uncommitted changes
uncommitted, committed restriction||^conflicts-only: the policy record says 'rebase: conflicts-only' \(HEAD:upstream-policy/acme/proj\.md\)$
unpushed|commit|warning: ignoring 'rebase: any': .*differs from origin/main's
unpushed, pushed restriction||^conflicts-only: the policy record says 'rebase: conflicts-only' \(origin/main:upstream-policy/acme/proj\.md\)$
pushed|push|^any: the policy record says 'rebase: any' \(${RECORD}\)$
EOF
: >"${FAKE_GH}/calls"
run "rebase: any, no calls" 0 '^any: the policy record' rebase acme/proj main
test ! -s "${FAKE_GH}/calls" || fail "rebase: any, but called: $(cat "${FAKE_GH}/calls")"
run "rebase: any passes check" 0 '^bot-ok$' check acme/proj
# Both can't be set: a key once.
sed -i 's/^rebase: any$/&\nrebase: conflicts-only/' "${RECORD}"
run "rebase: both" "${EX_INVALID}" "'rebase' is set twice" rebase acme/proj main
sed -i '/^rebase: conflicts-only$/d; s/^rebase: any$/rebase: sometimes/' "${RECORD}"
run "rebase: invalid" "${EX_INVALID}" "'rebase' can only be 'conflicts-only' or 'any'" rebase acme/proj main
git -C "${HOMEGIT}" checkout -q -- .
rm "${FAKE_GH}/rest/repos/acme/proj/rules/branches/main.json"
run "rebase usage" 2 usage rebase acme/plain

run "usage" 2 usage check not-a-repo
for bad in ../x acme/.. ./proj acme/...; do
    run "usage: ${bad}" 2 usage check "${bad}"
done

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: upstream-policy check passes only a pushed, current bot-ok record (human-text with --allow-human-text) loosened only by cgwalters, and refuses missing, stale, unpushed, invalid, renamed and refusing records, and fails closed when GitHub does"

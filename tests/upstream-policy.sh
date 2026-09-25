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
export FAKE_GH=${WORK}/gh UPSTREAM_POLICY_DIR=${WORK}/homegit/upstream-policy
export GIT_CONFIG_GLOBAL=${WORK}/gitconfig GIT_CONFIG_NOSYSTEM=1
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

# vouch [VERIFIED LOGIN]: what GitHub says of homegit's HEAD commit
# (default: verified, by cgwalters).
vouch() {
    jq -n --argjson v "${1:-true}" --arg l "${2:-cgwalters}" '{commit: {verification: {verified: $v}}, author: {login: $l}}' |
        fixture "repos/cgwalters-bot/homegit/commits/$(git -C "${HOMEGIT}" rev-parse HEAD)"
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

run "usage" 2 usage check not-a-repo
for bad in ../x acme/.. ./proj acme/...; do
    run "usage: ${bad}" 2 usage check "${bad}"
done

test "${failures}" -eq 0 || { echo "${failures} checks failed" 1>&2; exit 1; }
echo "ok: upstream-policy check passes only a pushed, current bot-ok record (human-text with --allow-human-text) loosened only by cgwalters, and refuses missing, stale, unpushed, invalid, renamed and refusing records, and fails closed when GitHub does"

#!/usr/bin/env bash
# Offline tests of bot-work's local worktree manager, using disposable Git
# repositories. No network or compiler is needed.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_WORK=${TESTS}/../bin/bot-work
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-work-worktree-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export HOME=${WORK}/home XDG_CACHE_HOME=${WORK}/cache

failures=0

fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

make_repo() {
    local name=$1 repo=${WORK}/repos/$1
    git init -q -b main "${repo}"
    git -C "${repo}" config user.name test
    git -C "${repo}" config user.email test@example.com
    printf '%s base\n' "${name}" >"${repo}/file"
    git -C "${repo}" add file
    git -C "${repo}" commit -qm base
    git -C "${repo}" branch base
    printf '%s main\n' "${name}" >>"${repo}/file"
    git -C "${repo}" commit -am main -q
    printf '%s\n' "${repo}"
}

run() {
    "${BOT_WORK}" worktree "$@"
}

mkdir -p "${WORK}/repos" "${HOME}"
repo_one=$(make_repo one)
repo_two=$(make_repo two)

# Add both repositories for one worker: base commits and branches are right,
# while the shared clones remain on main.
for repo in "${repo_one}" "${repo_two}"; do
    run add "${repo}" item-77 --base base >/dev/null || fail "add ${repo} failed"
done
for repo in "${repo_one}" "${repo_two}"; do
    target=${XDG_CACHE_HOME}/bot-work/item-77/$(basename "${repo}")
    test "$(git -C "${target}" branch --show-current)" = bot/item-77 || fail "wrong branch for ${repo}"
    test "$(git -C "${target}" rev-parse HEAD)" = "$(git -C "${repo}" rev-parse base)" || fail "wrong base for ${repo}"
    test "$(git -C "${repo}" branch --show-current)" = main || fail "shared clone branch changed for ${repo}"
done

# A non-worktree directory beside the worktrees (bot-claude jobs leave one)
# is not an error and is left alone.
run add "${repo_one}" stray >/dev/null || fail "add stray failed"
mkdir "${XDG_CACHE_HOME}/bot-work/stray/s"
run rm stray >/dev/null || fail "removal failed beside a non-worktree directory"
test -d "${XDG_CACHE_HOME}/bot-work/stray/s" || fail "removal deleted a non-worktree directory"
test ! -e "${XDG_CACHE_HOME}/bot-work/stray/one" || fail "removal kept the worktree beside a stray directory"
rmdir "${XDG_CACHE_HOME}/bot-work/stray/s" "${XDG_CACHE_HOME}/bot-work/stray"

# One dirty tree prevents an all-or-nothing removal. --force removes both.
printf 'dirty\n' >>"${XDG_CACHE_HOME}/bot-work/item-77/one/file"
if run rm item-77 >/dev/null 2>"${WORK}/err"; then
    fail "removed dirty worktrees without --force"
fi
grep -q 'tracked or untracked changes' "${WORK}/err" || fail "dirty refusal lacked explanation"
test -d "${XDG_CACHE_HOME}/bot-work/item-77/two" || fail "clean sibling was removed after dirty refusal"
run rm item-77 --force >/dev/null || fail "force removal failed"
test ! -e "${XDG_CACHE_HOME}/bot-work/item-77" || fail "force removal left worker directory"
for repo in "${repo_one}" "${repo_two}"; do
    git -C "${repo}" show-ref --verify --quiet refs/heads/bot/item-77 || fail "removal deleted bot branch for ${repo}"
    if git -C "${repo}" worktree list --porcelain | grep -q "${XDG_CACHE_HOME}/bot-work/item-77"; then
        fail "removal did not prune ${repo}'s worktree metadata"
    fi
done

# Untracked files need the same explicit force decision.
run add "${repo_one}" untracked >/dev/null || fail "add for untracked test failed"
touch "${XDG_CACHE_HOME}/bot-work/untracked/one/new-file"
if run rm untracked >/dev/null 2>"${WORK}/err"; then
    fail "removed untracked worktree without --force"
fi
grep -q 'tracked or untracked changes' "${WORK}/err" || fail "untracked refusal lacked explanation"
run rm untracked --force >/dev/null || fail "force removal of untracked tree failed"
if git -C "${repo_one}" worktree list --porcelain | grep -q "${XDG_CACHE_HOME}/bot-work/untracked"; then
    fail "forced removal did not prune untracked worktree metadata"
fi

# A clean worktree is removed without --force and its registration is pruned.
run add "${repo_one}" clean >/dev/null || fail "add for clean removal test failed"
run rm clean >/dev/null || fail "clean removal failed"
if git -C "${repo_one}" worktree list --porcelain | grep -q "${XDG_CACHE_HOME}/bot-work/clean"; then
    fail "clean removal did not prune worktree metadata"
fi

# Config can hide untracked files from normal status output; removal must not.
run add "${repo_one}" hidden-untracked >/dev/null || fail "add for hidden untracked test failed"
git -C "${XDG_CACHE_HOME}/bot-work/hidden-untracked/one" config status.showUntrackedFiles no
touch "${XDG_CACHE_HOME}/bot-work/hidden-untracked/one/hidden-file"
if run rm hidden-untracked >/dev/null 2>"${WORK}/err"; then
    fail "removed config-hidden untracked worktree without --force"
fi
grep -q 'tracked or untracked changes' "${WORK}/err" || fail "hidden untracked refusal lacked explanation"
run rm hidden-untracked --force >/dev/null || fail "force removal of hidden untracked tree failed"

# Names and repository paths cannot escape the cache, and symlinked cache
# entries are never followed or removed.
for name in ../escape a/b . -bad a..b x.lock; do
    if run add "${repo_one}" "${name}" >/dev/null 2>&1; then
        fail "accepted unsafe name ${name}"
    fi
done
test ! -e "${XDG_CACHE_HOME}/bot-work/a..b" || fail "invalid branch name left a worker directory behind"
invalid_commands=(
    "add ${repo_one} malformed extra"
    "add ${repo_one} malformed --base"
    "add ${repo_one} malformed --unknown value"
)
for command in "${invalid_commands[@]}"; do
    read -r -a args <<<"${command}"
    if run "${args[@]}" >/dev/null 2>&1; then
        fail "accepted malformed arguments: ${command}"
    fi
done
if run add "${WORK}/not-a-repo" invalid >/dev/null 2>&1; then
    fail "accepted non-repository path"
fi
ln -s "${repo_one}" "${WORK}/repository-link"
if run add "${WORK}/repository-link" linked-repo >/dev/null 2>&1; then
    fail "accepted symlinked repository path"
fi
mkdir -p "${XDG_CACHE_HOME}/bot-work"
ln -s "${WORK}/missing-target" "${XDG_CACHE_HOME}/bot-work/symlinked"
if run rm symlinked >/dev/null 2>&1; then
    fail "accepted symlinked worker directory"
fi
test -L "${XDG_CACHE_HOME}/bot-work/symlinked" || fail "removed symlinked worker directory"

# The cache root itself and every entry below it must be real directories.
mkdir -p "${WORK}/symlinked-cache-target" "${WORK}/symlinked-cache-parent"
ln -s "${WORK}/symlinked-cache-target" "${WORK}/symlinked-cache-parent/bot-work"
if XDG_CACHE_HOME="${WORK}/symlinked-cache-parent" run rm root-link >/dev/null 2>&1; then
    fail "accepted symlinked cache root"
fi
test -L "${WORK}/symlinked-cache-parent/bot-work" || fail "removed symlinked cache root"

# Git records real paths, so a cache reached through a symlink still works.
mkdir -p "${WORK}/real-cache"
ln -s "${WORK}/real-cache" "${WORK}/cache-link"
XDG_CACHE_HOME="${WORK}/cache-link" run add "${repo_one}" via-link >/dev/null || fail "add through a symlinked cache failed"
XDG_CACHE_HOME="${WORK}/cache-link" run rm via-link >/dev/null || fail "rm through a symlinked cache failed"
test ! -e "${WORK}/real-cache/bot-work/via-link" || fail "rm through a symlinked cache left the worktree"

# A worktree below the cache must still be on this worker's bot branch.
foreign=${XDG_CACHE_HOME}/bot-work/foreign/one
mkdir -p "$(dirname "${foreign}")"
git -C "${repo_one}" branch foreign-branch
git -C "${repo_one}" worktree add -q "${foreign}" foreign-branch
if run rm foreign >/dev/null 2>"${WORK}/err"; then
    fail "removed registered non-bot worktree"
fi
grep -q 'not bot/foreign' "${WORK}/err" || fail "non-bot worktree refusal lacked explanation"
test -d "${foreign}" || fail "removed registered non-bot worktree directory"
git -C "${repo_one}" worktree remove "${foreign}"

# Default and custom destinations have the same cleanup ownership, with
# unrelated workers and adjacent custom directories preserved.
run add "${repo_two}" sibling >/dev/null || fail "add sibling failed"
mkdir -p "${WORK}/destinations/precious"
printf 'preserve me\n' >"${WORK}/destinations/precious/file"
while IFS='|' read -r name destination; do
    args=()
    target=${XDG_CACHE_HOME}/bot-work/${name}/one
    if test "${destination}" != default; then
        target=${WORK}/destinations/${destination}
        args=(--dir "${target}")
    fi
    run add "${repo_one}" "${name}" "${args[@]}" >/dev/null || fail "add ${name} failed"
    run rm "${name}" >/dev/null || fail "remove ${name} failed"
    test ! -e "${target}" || fail "remove ${name} left destination"
    test ! -e "${XDG_CACHE_HOME}/bot-work/${name}" || fail "remove ${name} left registration"
    test -f "${XDG_CACHE_HOME}/bot-work/sibling/two/.git" || fail "remove ${name} removed sibling worker"
    test "$(cat "${WORK}/destinations/precious/file")" = 'preserve me' || fail "remove ${name} altered adjacent directory"
done <<'EOF'
default-cleanup|default
custom-cleanup|custom
custom-spaces|custom with spaces
custom-nested|missing/parents/custom
EOF

# A normal worktree may contain a file with the registration's name. Clean
# tracked content removes normally; tracked edits and untracked content need
# force, but must never be interpreted as a destination registration.
while IFS='|' read -r kind clean; do
    name=collision-${kind}
    run add "${repo_one}" "${name}" >/dev/null || fail "add ${name} failed"
    target=${XDG_CACHE_HOME}/bot-work/${name}/one
    printf 'ordinary worktree content, not JSON\n' >"${target}/.destination.json"
    if test "${kind}" != untracked; then
        git -C "${target}" add .destination.json
        git -C "${target}" commit -qm 'Track ordinary destination file'
        test "${kind}" != tracked-dirty || printf 'edit\n' >>"${target}/.destination.json"
    fi
    if test "${clean}" = yes; then
        run rm "${name}" >/dev/null || fail "clean collision removal failed"
    else
        if run rm "${name}" >/dev/null 2>"${WORK}/err"; then
            fail "removed dirty ${kind} collision without force"
        fi
        grep -q 'tracked or untracked changes' "${WORK}/err" || fail "${kind} collision was treated as registration"
        test -f "${target}/.git" || fail "collision refusal removed worktree"
        run rm "${name}" --force >/dev/null || fail "forced ${kind} collision removal failed"
    fi
    test ! -e "${target}" || fail "${kind} collision removal left worktree"
    test ! -e "${XDG_CACHE_HOME}/bot-work/${name}" || fail "${kind} collision removal left worker entry"
    test -f "${XDG_CACHE_HOME}/bot-work/sibling/two/.git" || fail "collision removal removed sibling worker"
done <<'EOF'
tracked-clean|yes
tracked-dirty|no
untracked|no
EOF

# Custom registrations participate in preflight and targeted removal. A
# dirty custom destination blocks whole-worker removal before siblings change.
custom=${WORK}/destinations/mixed
run add "${repo_one}" mixed --dir "${custom}" --base base >/dev/null || fail "add mixed custom failed"
run add "${repo_two}" mixed >/dev/null || fail "add mixed default failed"
printf 'dirty\n' >>"${custom}/file"
if run rm mixed >/dev/null 2>"${WORK}/err"; then
    fail "removed dirty custom worktree without force"
fi
grep -q 'tracked or untracked changes' "${WORK}/err" || fail "dirty custom refusal lacked explanation"
test -f "${XDG_CACHE_HOME}/bot-work/mixed/two/.git" || fail "dirty custom refusal removed default sibling"
run rm mixed --dir "${XDG_CACHE_HOME}/bot-work/mixed/two" >/dev/null || fail "targeted default removal failed"
test -f "${custom}/.git" || fail "targeted default removal removed custom sibling"
repo_three=$(make_repo three)
run add "${repo_three}" mixed >/dev/null || fail "add mixed replacement sibling failed"
run rm mixed --dir "${custom}" --force >/dev/null || fail "targeted custom force removal failed"
test ! -e "${custom}" || fail "targeted custom removal left destination"
test -f "${XDG_CACHE_HOME}/bot-work/mixed/three/.git" || fail "targeted custom removal removed default sibling"
run rm mixed >/dev/null || fail "remove mixed sibling failed"
test ! -e "${XDG_CACHE_HOME}/bot-work/mixed" || fail "targeted custom removal left registration"
test -f "${XDG_CACHE_HOME}/bot-work/sibling/two/.git" || fail "targeted removal removed another worker"

# A custom destination deleted by hand must not wedge cleanup of its name.
stale=${WORK}/destinations/stale
run add "${repo_one}" stale --dir "${stale}" --base base >/dev/null || fail "add stale custom failed"
rm -rf "${stale}"
run rm stale >/dev/null || fail "removing a hand-deleted custom destination failed"
test ! -e "${XDG_CACHE_HOME}/bot-work/stale" || fail "hand-deleted custom destination left its registration"
git -C "${repo_one}" worktree list --porcelain | grep -qF "${stale}" && fail "hand-deleted custom destination left a Git registration"

# A registration cannot silently redirect cleanup to a replacement repository
# or symlink, even if that replacement has the expected bot branch.
custom=${WORK}/destinations/unsafe
run add "${repo_one}" unsafe --dir "${custom}" >/dev/null || fail "add unsafe destination failed"
mv "${custom}" "${custom}-saved"
ln -s "${custom}-saved" "${custom}"
if run rm unsafe --force >/dev/null 2>"${WORK}/err"; then
    fail "followed symlinked custom destination"
fi
grep -q 'not a regular directory' "${WORK}/err" || fail "custom symlink refusal lacked explanation"
test -L "${custom}" || fail "removed custom destination symlink"
rm "${custom}"
mv "${custom}-saved" "${custom}"
record=${XDG_CACHE_HOME}/bot-work/unsafe/one/.destination.json
cp "${record}" "${WORK}/registration.saved"
node -e 'const fs = require("fs"); const f = process.argv[1]; const r = JSON.parse(fs.readFileSync(f)); r.common_dir = "/wrong/repository"; fs.writeFileSync(f, JSON.stringify(r));' "${record}"
if run rm unsafe --force >/dev/null 2>"${WORK}/err"; then
    fail "accepted mismatched registered repository"
fi
grep -q 'belongs to another repository' "${WORK}/err" || fail "repository mismatch lacked explanation"
test -f "${custom}/.git" || fail "repository mismatch removed destination"
cp "${WORK}/registration.saved" "${record}"
run rm unsafe >/dev/null || fail "remove restored custom registration failed"

test "${failures}" -eq 0 || exit 1
echo "all bot-work worktree tests passed"

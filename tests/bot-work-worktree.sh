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

test "${failures}" -eq 0 || exit 1
echo "all bot-work worktree tests passed"

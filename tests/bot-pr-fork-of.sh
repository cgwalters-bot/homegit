#!/usr/bin/env bash
# Offline tests of how bot-pr finds the forge's fork of an upstream
# repository ('bot-pr fork-of', which fork-pr uses too): by its parent,
# whatever its name, since a fork may be renamed to free its name for a
# repository of the forge's own; and of the name a new fork gets. A fake
# gh answers REST GETs from files. No network.
#   tests/bot-pr-fork-of.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_PR=${TESTS}/../bin/bot-pr
readonly UPSTREAM=acme/widget

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-fork-of-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh
export PATH=${WORK}/bin:${PATH}
export XDG_CACHE_HOME=${WORK}/cache

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin"
# The fake gh: 'gh api [-X METHOD] PATH [-f/-F K=V]... [--jq F]' answers
# a GET of PATH (query string included) with $FAKE_GH/get/PATH, with its
# slashes as '%', or a 404 if there is no such file, applying --jq
# like gh. A POST to repos/OWNER/REPO/forks records its fields in
# $FAKE_GH/forked and answers with the new fork, cgwalters-forge/NAME.
# Every call is logged to $FAKE_GH/calls.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter=. fields=()
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f|-F) fields+=("$2"); shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        -*) shift ;;
        *) path=$1; shift ;;
    esac
done
case "${method}" in
    GET)
        file=${store}/get/${path//\//%}
        test -f "${file}" || { echo "gh: Not Found (HTTP 404)" 1>&2; exit 1; }
        jq -r "${filter}" "${file}" ;;
    POST)
        [[ "${path}" == repos/*/forks ]] || { echo "fake gh: unexpected POST ${path}" 1>&2; exit 1; }
        printf '%s\n' "${fields[@]}" >"${store}/forked"
        name=$(printf '%s\n' "${fields[@]}" | sed -n 's/^name=//p')
        full=cgwalters-forge/${name}
        # Forking is done at once here: the fork has its branch.
        echo '{"object": {"sha": "0123"}}' >"${store}/get/repos%${full//\//%}%git%ref%heads%main"
        jq -nr --arg full "${full}" "{full_name: \$full} | ${filter}" ;;
    *) echo "fake gh: unexpected ${method} ${path}" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"

# put PATH JSON: GET PATH answers JSON.
put() {
    printf '%s\n' "$2" >"${FAKE_GH}/get/${1//\//%}"
}
# reset: the world with no forge repositories, and acme/widget with one
# unrelated fork.
reset() {
    rm -rf "${FAKE_GH}" "${XDG_CACHE_HOME}"
    mkdir -p "${FAKE_GH}/get"
    put user '{"login": "cgwalters-bot"}'
    put repos/acme/widget '{"default_branch": "main"}'
    FORKS='[{"full_name": "someone/widget", "owner": {"login": "someone"}}]'
    put "repos/${UPSTREAM}/forks?per_page=100" "${FORKS}"
    : >"${FAKE_GH}/calls"
}
# fork NAME: cgwalters-forge/NAME is a fork of acme/widget.
fork() {
    put "repos/cgwalters-forge/$1" '{"full_name": "cgwalters-forge/'"$1"'", "fork": true, "parent": {"full_name": "acme/widget"}, "source": {"full_name": "acme/widget"}}'
    FORKS=$(jq -c --arg n "cgwalters-forge/$1" '. + [{full_name: $n, owner: {login: "cgwalters-forge"}}]' <<<"${FORKS}")
    put "repos/${UPSTREAM}/forks?per_page=100" "${FORKS}"
}
# own NAME: cgwalters-forge/NAME is a repository of the forge's own.
own() {
    put "repos/cgwalters-forge/$1" '{"full_name": "cgwalters-forge/'"$1"'", "fork": false}'
}
cache_file() {
    echo "${XDG_CACHE_HOME}/bot-pr/forks/${UPSTREAM/\//_}"
}
calls_matching() {
    grep -c -- "$1" "${FAKE_GH}/calls" || true
}

# check NAME WANT_STATUS WANT_OUTPUT ARGS...
check() {
    local name=$1 want_status=$2 want=$3 status=0 out
    shift 3
    out=$("${BOT_PR}" fork-of "$@" 2>"${WORK}/stderr") || status=$?
    test "${status}" -eq "${want_status}" || fail "${name}: exit ${status}, expected ${want_status}: $(<"${WORK}/stderr")"
    test "${out}" = "${want}" || fail "${name}: printed '${out}', expected '${want}'"
}

# Named after upstream: one read, no listing of forks.
reset
fork widget
check "named fork" 0 cgwalters-forge/widget "${UPSTREAM}"
test "$(calls_matching /forks)" -eq 0 || fail "named fork: listed the forks"

# Renamed, its old name now the forge's own repository: found among the
# forks, then cached, so the next lookup reads only the cached name.
reset
own widget
fork acme-widget
check "renamed fork" 0 cgwalters-forge/acme-widget "${UPSTREAM}"
test "$(calls_matching /forks)" -eq 1 || fail "renamed fork: expected one listing of the forks"
test "$(cat "$(cache_file)" 2>/dev/null)" = cgwalters-forge/acme-widget || fail "renamed fork: not cached"
: >"${FAKE_GH}/calls"
check "renamed fork, cached" 0 cgwalters-forge/acme-widget "${UPSTREAM}"
test "$(wc -l <"${FAKE_GH}/calls")" -eq 1 || fail "renamed fork, cached: expected one call, got $(<"${FAKE_GH}/calls")"

# Renamed, its old name not reused yet: GitHub redirects it to the
# fork, whose real name is printed and cached, with no listing.
reset
fork acme-widget
put repos/cgwalters-forge/widget "$(jq -c . "${FAKE_GH}/get/repos%cgwalters-forge%acme-widget")"
check "renamed fork, redirected" 0 cgwalters-forge/acme-widget "${UPSTREAM}"
test "$(calls_matching /forks)" -eq 0 || fail "renamed fork, redirected: listed the forks"
test "$(cat "$(cache_file)" 2>/dev/null)" = cgwalters-forge/acme-widget || fail "renamed fork, redirected: not cached"

# A stale cache entry (the fork was deleted) is checked and passed over.
reset
fork widget
mkdir -p "$(dirname "$(cache_file)")"
echo cgwalters-forge/gone >"$(cache_file)"
check "stale cache" 0 cgwalters-forge/widget "${UPSTREAM}"

# A same-named repository that is a fork of something else doesn't count.
reset
put repos/cgwalters-forge/widget '{"full_name": "cgwalters-forge/widget", "fork": true, "parent": {"full_name": "other/widget"}, "source": {"full_name": "other/widget"}}'
check "fork of another upstream" 1 "" "${UPSTREAM}"

# No fork at all.
reset
check "no fork" 1 "" "${UPSTREAM}"

# --create names a new fork after upstream...
reset
check "create" 0 cgwalters-forge/widget --create "${UPSTREAM}"
grep -qx name=widget "${FAKE_GH}/forked" || fail "create: forked with $(tr '\n' ' ' <"${FAKE_GH}/forked")"

# ... or OWNER-REPO if the forge has a repository of that name ...
reset
own widget
check "create, name taken" 0 cgwalters-forge/acme-widget --create "${UPSTREAM}"
grep -qx name=acme-widget "${FAKE_GH}/forked" || fail "create, name taken: forked with $(tr '\n' ' ' <"${FAKE_GH}/forked")"
test "$(cat "$(cache_file)" 2>/dev/null)" = cgwalters-forge/acme-widget || fail "create, name taken: new fork not cached"

# ... and refuses if both are taken.
reset
own widget
own acme-widget
check "create, both names taken" 1 "" --create "${UPSTREAM}"
test ! -e "${FAKE_GH}/forked" || fail "create, both names taken: forked anyway"

# An existing fork is reused, not forked again.
reset
own widget
fork acme-widget
check "create, existing renamed fork" 0 cgwalters-forge/acme-widget --create "${UPSTREAM}"
test ! -e "${FAKE_GH}/forked" || fail "create, existing renamed fork: forked again"

check "usage" 1 "" not-a-repo

if test "${failures}" -gt 0; then
    echo "${failures} failures" 1>&2
    exit 1
fi
echo "ok: bot-pr fork-of"

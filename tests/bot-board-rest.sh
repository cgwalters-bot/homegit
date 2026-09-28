#!/usr/bin/env bash
# Offline tests of how bot-board reads the item list: over REST, from the
# pages in tests/fixtures/bot-board/rest (GitHub's shapes, trimmed), with
# every read revalidated by ETag. Against a fake gh; no network, no quota.
#   tests/bot-board-rest.sh
# jq programs hold literal $variables.
# shellcheck disable=SC2016
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_BOARD=${TESTS}/../bin/bot-board
readonly FIXTURES=${TESTS}/fixtures/bot-board/rest

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh-store
mkdir -p "${FAKE_GH}" "${WORK}/bin"
cp "${FIXTURES}"/{fields,items-1,items-2}.json "${FAKE_GH}/"
export PATH=${WORK}/bin:${PATH} HOME=${WORK}/home XDG_CACHE_HOME=${WORK}/home/cache
unset GH_TOKEN GITHUB_TOKEN

# The fake gh: 'gh api -i PATH' serves board 1's fields and its items in
# two pages (the second behind a cursor, linked only if
# $FAKE_GH/items-2.json exists, as GitHub does), only with
# the fields asked for, with the checksum of the page as its ETag and
# 304 for a matching If-None-Match. Each answer is logged to
# $FAKE_GH/calls as "STATUS FILE" plus " inm" if it was conditional.
# With $FAKE_GH/rate-limited, it fails as GitHub does when out of quota.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
if test "$1 ${2:-}" = "api rate_limit"; then
    test "$3" = --jq || exit 1
    jq -r "$4" <<<'{"resources": {"core": {"remaining": 0, "limit": 5000, "reset": 0}}}'
    exit 0
fi
test "$1 $2" = "api -i" || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
path=$3 inm=""
test "${4:-}" != -H || inm=${5#If-None-Match: }
if test -e "${store}/rate-limited"; then
    printf 'HTTP/2.0 403 Forbidden\r\n\r\n{}'
    echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" 1>&2
    exit 1
fi
query=${path#*\?}
fields=$(sed -n 's/.*[?&]fields=\([^&]*\).*/\1/p' <<<"${query}")
link=""
case "${path%%\?*}" in
    users/cgwalters-bot/projectsV2/1/fields) file=fields ;;
    users/cgwalters-bot/projectsV2/1/items|user/17814078/projectsV2/1/items)
        if [[ "${query}" == *after=c2* ]]; then
            file=items-2
        else
            file=items-1
            if test -e "${store}/items-2.json"; then
                link="Link: <https://api.github.com/user/17814078/projectsV2/1/items?per_page=100&fields=${fields}&after=c2>; rel=\"next\""$'\r\n'
            fi
        fi
        ;;
    *) echo "fake gh: unexpected path ${path}" 1>&2; exit 1 ;;
esac
body=$(jq -c --arg fields "${fields}" '
    if $fields == "" then . else ($fields | split(",") | map(tonumber)) as $ids
        | map(.fields |= map(select(.id | IN($ids[])))) end' "${store}/${file}.json")
etag="W/\"$(sha256sum <<<"${body}" | cut -c1-16)\""
if test "${inm}" = "${etag}"; then
    echo "304 ${file} inm" >>"${store}/calls"
    printf 'HTTP/2.0 304 Not Modified\r\n\r\n'
    echo "gh: HTTP 304" 1>&2
    exit 1
fi
echo "200 ${file}${inm:+ inm}" >>"${store}/calls"
printf 'HTTP/2.0 200 OK\r\nEtag: %s\r\n%s\r\n%s\n' "${etag}" "${link}" "${body}"
EOF
chmod +x "${WORK}/bin/gh"

# list NAME [ARGS...]: runs 'bot-board ARGS list --json' into $out, with
# a fresh call log, once the listing's short TTL has passed.
list() {
    local name=$1
    shift
    rm -f "${XDG_CACHE_HOME}/bot-board/items.json"
    : >"${FAKE_GH}/calls"
    out=$("${BOT_BOARD}" "$@" list --json 2>"${WORK}/err") || { fail "${name}: $(cat "${WORK}/err")"; out='[]'; }
}

expect_calls() { # expect_calls NAME CALLS...: the fake's log, in order
    local want
    want=$(printf '%s\n' "${@:2}")
    test "$(cat "${FAKE_GH}/calls")" = "${want}" ||
        fail "$1: expected calls"$'\n'"${want}"$'\n'"got"$'\n'"$(cat "${FAKE_GH}/calls")"
}

expect_list() { # expect_list NAME JSON
    jq -ne --argjson a "${out}" --argjson b "$2" '$a == $b' >/dev/null ||
        fail "$1: expected $(jq -c . <<<"$2"), got $(jq -c . <<<"${out}")"
}

expected=$(cat "${FIXTURES}/list.json")

list "first read"
expect_list "first read" "${expected}"
expect_calls "first read" "200 fields" "200 items-1" "200 items-2"

list "unchanged board"
expect_list "unchanged board" "${expected}"
expect_calls "unchanged board" "304 fields inm" "304 items-1 inm" "304 items-2 inm"

# Only the changed page is sent again.
jq '.[0].content.title = "Renamed draft"' "${FIXTURES}/items-2.json" >"${FAKE_GH}/items-2.json"
list "changed page"
expect_list "changed page" "$(jq '.[1].title = "Renamed draft" | .[1].content.title = "Renamed draft"' <<<"${expected}")"
expect_calls "changed page" "304 fields inm" "304 items-1 inm" "200 items-2 inm"

# Within the TTL, nothing is asked; --refresh and writes skip it.
: >"${FAKE_GH}/calls"
"${BOT_BOARD}" list --json >/dev/null 2>"${WORK}/err" || fail "cached list: $(cat "${WORK}/err")"
expect_calls "within the TTL"
: >"${FAKE_GH}/calls"
"${BOT_BOARD}" --refresh list --json >/dev/null 2>"${WORK}/err" || fail "--refresh: $(cat "${WORK}/err")"
expect_calls "--refresh" "304 fields inm" "304 items-1 inm" "304 items-2 inm"

# GitHub links no next page from a full last page, and its ETag doesn't
# cover the link: so a full last page is refetched, else a page added
# since would stay hidden behind 304s.
jq --slurpfile item "${FIXTURES}/items-1.json" -n \
    '[range(100) as $i | $item[0][0] | .node_id = "PVTI_\($i)" | .content.number = $i]' >"${FAKE_GH}/items-1.json"
rm "${FAKE_GH}/items-2.json"
list "a full page"
test "$(jq length <<<"${out}")" -eq 100 || fail "a full page: $(jq length <<<"${out}") items, not 100"
expect_calls "a full page" "304 fields inm" "200 items-1 inm"
cp "${FIXTURES}/items-2.json" "${FAKE_GH}/"
list "board grew by a page"
test "$(jq length <<<"${out}")" -eq 101 || fail "board grew by a page: $(jq length <<<"${out}") items, not 101"
expect_calls "board grew by a page" "304 fields inm" "200 items-1" "200 items-2 inm"

out=$("${BOT_BOARD}" show PVTI_draft 2>&1) || fail "show: ${out}"
grep -qx $'draft id:\tDI_1' <<<"${out}" || fail "show lacks the draft id: ${out}"

touch "${FAKE_GH}/rate-limited"
rc=0
"${BOT_BOARD}" --refresh list >/dev/null 2>"${WORK}/err" || rc=$?
test "${rc}" -eq 75 || fail "rate limited: exit ${rc}, not 75"
grep -q 'rate limiting.*core: 0/5000' "${WORK}/err" || fail "rate limited: $(cat "${WORK}/err")"

test "${failures}" -eq 0 || { echo "${failures} failure(s)" 1>&2; exit 1; }
echo "ok: bot-board reads the board over REST with ETags"

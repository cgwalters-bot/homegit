#!/usr/bin/env bash
# Offline tests of bin/gh-http.sh, which bot-notify, bot-runs and
# bot-watch source to read 'gh api -i' output. No network.
#   tests/gh-http.sh
# The body is far over a pipe's size (64KiB), and split_http_response
# runs with errexit and pipefail live, as in bot-watch's background
# functions: a reader quitting after the headers used to fail there.
set -euo pipefail
shopt -s inherit_errexit

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
# shellcheck source=bin/gh-http.sh
source "${TESTS}/../bin/gh-http.sh"
readonly BODY_BYTES=2000000

WORK=$(mktemp -d "${TMPDIR:-/tmp}/gh-http-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

jq -nc --argjson n "${BODY_BYTES}" '{items: [{body: ("x" * $n)}]}' >"${WORK}/expected-body"
{
    printf 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nX-Poll-Interval: 60\r\n\r\n'
    cat "${WORK}/expected-body"
} >"${WORK}/raw"

# In a shell of its own, so that errexit stays on (a caller's || or if
# would turn it off inside): a failing pipeline ends it before "ok".
result=$(bash -c 'set -euo pipefail; shopt -s inherit_errexit; source "$1"
                  split_http_response "$2" "$3" "$4"; echo ok' \
    split "${TESTS}/../bin/gh-http.sh" "${WORK}/raw" "${WORK}/headers" "${WORK}/body" 2>&1) || true
test "${result}" = ok || fail "split_http_response failed on a $(wc -c <"${WORK}/raw")-byte response: ${result}"
printf 'HTTP/2.0 200 OK\nEtag: W/"abc"\nX-Poll-Interval: 60\n\n' | cmp -s - "${WORK}/headers" ||
    fail "wrong headers: $(cat -A "${WORK}/headers")"
cmp -s "${WORK}/expected-body" "${WORK}/body" || fail "the body differs from what was sent"

# A 304 has no body: an empty body file, not a stale one.
printf 'HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"\r\n\r\n' >"${WORK}/raw"
split_http_response "${WORK}/raw" "${WORK}/headers" "${WORK}/body"
test ! -s "${WORK}/body" || fail "a 304 left a body"
test "$(awk 'NR == 1 { print $2 }' "${WORK}/headers")" = 304 || fail "wrong 304 status: $(cat "${WORK}/headers")"

echo "ok: gh-http splits a ${BODY_BYTES}-byte body and a 304 as expected"

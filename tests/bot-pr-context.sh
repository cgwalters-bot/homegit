#!/usr/bin/env bash
# Offline tests of 'bot-pr context'. A fake gh supplies REST fixture pages;
# the command must request only the four context endpoints, paginate every
# collection, format deleted users and outdated comments, and print nothing
# when any later read fails.
#   tests/bot-pr-context.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_PR=${TESTS}/../bin/bot-pr
readonly FIXTURES=${TESTS}/fixtures/bot-pr-context
readonly URL=https://github.com/acme/widget/pull/7

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-pr-context-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE_GH=${WORK}/gh
export FIXTURES
export PATH=${WORK}/bin:${PATH}

failures=0
fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

mkdir -p "${WORK}/bin" "${FAKE_GH}"
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
store=${FAKE_GH:?}
printf '%s\n' "$*" >>"${store}/calls"
test "$1" = api || { echo "fake gh: unexpected: $*" >&2; exit 1; }
shift
paginate=false path=""
while test $# -gt 0; do
    case "$1" in
        --paginate) paginate=true ;;
        -*) if test "$1" = -X || test "$1" = -f || test "$1" = -F || test "$1" = -H || test "$1" = --jq; then shift; fi ;;
        *) path=$1 ;;
    esac
    shift
done
test ! -e "${store}/fail-${path//\//_}" || { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }
case "${path}" in
    repos/acme/widget/pulls/7) cat "${FIXTURES}/pull-request.json" ;;
    repos/acme/widget/pulls/7/reviews?per_page=100)
        ${paginate} || exit 1
        test ! -e "${store}/empty" || { printf '[]\n'; exit; }
        cat "${FIXTURES}/reviews-page-1.json" "${FIXTURES}/reviews-page-2.json" ;;
    repos/acme/widget/pulls/7/comments?per_page=100)
        ${paginate} || exit 1
        test ! -e "${store}/empty" || { printf '[]\n'; exit; }
        cat "${FIXTURES}/review-comments-page-1.json" "${FIXTURES}/review-comments-page-2.json" ;;
    repos/acme/widget/issues/7/comments?per_page=100)
        ${paginate} || exit 1
        test ! -e "${store}/empty" || { printf '[]\n'; exit; }
        ! test -e "${store}/big" || { jq -nc '[range(0; 4) | {id: ., user: {login: "talker"}, created_at: "2026-10-01T15:00:00Z", body: ("x" * 60000)}]'; exit; }
        cat "${FIXTURES}/issue-comments-page-1.json" "${FIXTURES}/issue-comments-page-2.json" ;;
    *) echo "fake gh: unexpected path ${path}" >&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"
: >"${FAKE_GH}/calls"

out=$("${BOT_PR}" context "${URL}") || fail "default context failed"
for want in \
    "Head: fork/widget:bot/context @ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "Base: acme/widget:main @ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
    "Reviews (2)" "deleted user COMMENTED" "lib/widget.js:42" \
    "lib/old.js:9 (outdated)" "Issue comments (1)"; do
    [[ "${out}" == *"${want}"* ]] || fail "default context lacks '${want}': ${out}"
done
test "$(grep -c -- '--paginate repos/acme/widget/pulls/7/reviews?per_page=100' "${FAKE_GH}/calls")" -eq 1 ||
    fail "reviews were not paginated"
test "$(grep -c -- '--paginate repos/acme/widget/pulls/7/comments?per_page=100' "${FAKE_GH}/calls")" -eq 1 ||
    fail "review comments were not paginated"
test "$(grep -c -- '--paginate repos/acme/widget/issues/7/comments?per_page=100' "${FAKE_GH}/calls")" -eq 1 ||
    fail "issue comments were not paginated"
test "$(wc -l <"${FAKE_GH}/calls")" -eq 4 || fail "context made calls beyond the four endpoints: $(<"${FAKE_GH}/calls")"

json=$("${BOT_PR}" context --json "${URL}") || fail "JSON context failed"
jq -e '.pull_request.title == "Teach the widget context" and (.reviews | length) == 2 and .reviews[1].user == null and (.review_comments | length) == 2 and .review_comments[1].original_line == 9 and (.issue_comments | length) == 1' <<<"${json}" >/dev/null ||
    fail "JSON context did not preserve all responses: ${json}"

: >"${FAKE_GH}/empty"
empty=$("${BOT_PR}" context "${URL}") || fail "empty context failed"
for want in "Reviews (0)" "Review comments (0)" "Issue comments (0)"; do
    [[ "${empty}" == *"${want}"* ]] || fail "empty context lacks '${want}': ${empty}"
done
rm "${FAKE_GH}/empty"

# A busy PR's comments together exceed the per-argument exec limit.
: >"${FAKE_GH}/big"
big=$("${BOT_PR}" context --json "${URL}") || fail "large context failed"
test "$(jq '.issue_comments | length' <<<"${big}")" -eq 4 || fail "large context lost comments"
rm "${FAKE_GH}/big"

: >"${FAKE_GH}/fail-repos_acme_widget_issues_7_comments?per_page=100"
if "${BOT_PR}" context "${URL}" >"${WORK}/failure.out" 2>"${WORK}/failure.err"; then
    fail "API failure succeeded"
else
    test ! -s "${WORK}/failure.out" || fail "API failure printed partial output: $(<"${WORK}/failure.out")"
    grep -q 'cannot list the comments' "${WORK}/failure.err" || fail "API failure was unclear: $(<"${WORK}/failure.err")"
fi

if "${BOT_PR}" context not-a-url >"${WORK}/invalid.out" 2>"${WORK}/invalid.err"; then
    fail "invalid URL succeeded"
else
    test ! -s "${WORK}/invalid.out" || fail "invalid URL printed output"
    grep -q 'expected a GitHub PR URL' "${WORK}/invalid.err" || fail "invalid URL was unclear"
fi

if test "${failures}" -gt 0; then
    echo "${failures} failure(s)" >&2
    exit 1
fi
echo "ok: bot-pr context"

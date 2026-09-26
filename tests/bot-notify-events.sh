#!/usr/bin/env bash
# Offline tests of what bot-notify's safety net makes of cgwalters' public
# events: 'bot-notify --event-threads' over tests/fixtures/events. No
# network.
#   tests/bot-notify-events.sh
# The fixture's first four events are real ones from
# users/cgwalters/events/public (payloads trimmed to the fields used),
# among them the review body on coreos/rpm-ostree#5635 that mentioned the
# bot without a notification; the rest are synthetic edge cases: a
# mention in other case, a longer login, another actor, an event older
# than the window, assignments to the bot and to someone else, a review
# request, a private repository, and comments in the tracker repository
# (his on an issue, which count; the bot's, and his on a PR, which don't;
# a mention there, which stays a mention) and in the review sandbox, which
# counts only when --tracker-repo stands it in for the tracker.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly FIXTURE=${TESTS}/fixtures/events/cgwalters-public-events.json
readonly BOT_NOTIFY=${TESTS}/../bin/bot-notify
readonly WINDOW=2026-09-23T12:00:00Z

# ID REASON PRIVATE SUBJECT_TYPE, one line per expected thread, sorted.
readonly EXPECTED='https://github.com/cgwalters-forge/tracker/issues/3	comment	false	Issue
https://github.com/cgwalters-forge/tracker/issues/6	mention	false	Issue
https://github.com/coreos/rpm-ostree/pull/5635	mention	false	PullRequest
https://github.com/example/private/pull/8	mention	true	PullRequest
https://github.com/example/repo/issues/1	mention	false	Issue
https://github.com/example/repo/issues/5	assign	false	Issue
https://github.com/example/repo/pull/7	review_requested	false	PullRequest'

actual=$("${BOT_NOTIFY}" --event-threads "${FIXTURE}" "${WINDOW}" |
    jq -r '[.id, .reason, .repository.private, .subject.type] | @tsv' | sort)
if test "${actual}" != "${EXPECTED}"; then
    printf 'FAIL: threads from %s:\nexpected:\n%s\nactual:\n%s\n' "${FIXTURE}" "${EXPECTED}" "${actual}" 1>&2
    exit 1
fi

# Every thread must look read at the window, so only later triggers count.
"${BOT_NOTIFY}" --event-threads "${FIXTURE}" "${WINDOW}" |
    jq -se --arg w "${WINDOW}" 'all(.[]; .last_read_at == $w and .unread and .source == "events")' >/dev/null ||
    { echo "FAIL: a thread is not read at ${WINDOW}, unread, from events" 1>&2; exit 1; }

# A window after everything leaves nothing.
none=$("${BOT_NOTIFY}" --event-threads "${FIXTURE}" 2026-09-25T00:00:00Z)
test -z "${none}" || { printf 'FAIL: threads after the last event:\n%s\n' "${none}" 1>&2; exit 1; }

# The sandbox standing in for the tracker: its comment counts instead.
sandbox=$("${BOT_NOTIFY}" --event-threads "${FIXTURE}" "${WINDOW}" --tracker-repo cgwalters-bot/review-sandbox |
    jq -r 'select(.reason == "comment") | .id')
test "${sandbox}" = https://github.com/cgwalters-bot/review-sandbox/issues/7 ||
    { printf 'FAIL: comment threads with --tracker-repo: %s\n' "${sandbox}" 1>&2; exit 1; }

echo "ok: $(wc -l <<<"${EXPECTED}") safety-net threads from $(jq length "${FIXTURE}") events as expected"

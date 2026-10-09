# shellcheck shell=bash
# bot-poll-loop owns the state lock. Node bounds each subprocess and the batch.
# shellcheck disable=SC2154,SC2034 # caller supplies config and consumes news
notifications() {
    local budget=10
    test -z "${until_actions}" || budget=$((max_wait_s - SECONDS))
    test "${budget}" -gt 0 || return 0
    notification_news=$(node "${BIN}/poll-notifications.js" "${S}" "${TOOLS}" "${OP_BOT_LOGIN}" "${OP_OPERATOR_LOGIN}" "${budget}")
}

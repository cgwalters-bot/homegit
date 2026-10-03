#!/usr/bin/env bash
# Offline command tests of board and heartbeat worker registration.
set -euo pipefail
exec node --test "$(dirname "$0")/heartbeat-register.test.js" "$(dirname "$0")/bot-pr-fork-board.test.js" "$(dirname "$0")/heartbeat-state.test.js"

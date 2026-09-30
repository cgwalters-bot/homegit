#!/usr/bin/env bash
# Offline tests of bin/bot-heartbeat's usage snapshot; the cases are in
# bot-heartbeat-usage.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-heartbeat-usage.test.js"

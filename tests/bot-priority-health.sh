#!/usr/bin/env bash
# Offline tests of bin/bot-priority-health; the cases are in
# bot-priority-health.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-priority-health.test.js"

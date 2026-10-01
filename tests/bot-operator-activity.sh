#!/usr/bin/env bash
# Offline tests of bin/bot-operator-activity; the cases are in bot-operator-activity.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-operator-activity.test.js"

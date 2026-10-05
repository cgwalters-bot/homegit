#!/usr/bin/env bash
# Offline tests of bin/bot-actuals; the cases are in bot-actuals.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-actuals.test.js"

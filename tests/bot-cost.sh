#!/usr/bin/env bash
# Offline tests of bin/bot-cost; the cases are in bot-cost.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-cost.test.js"

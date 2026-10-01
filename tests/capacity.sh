#!/usr/bin/env bash
# Offline tests of lib/capacity.js, bin/bot-actuals and bin/bot-capacity; the cases are in capacity.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/capacity.test.js"

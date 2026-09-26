#!/usr/bin/env bash
# Offline tests of bin/bot-tmt-number; the cases are in bot-tmt-number.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-tmt-number.test.js"

#!/usr/bin/env bash
# Offline tests of bin/bot-footer; the cases are in bot-footer.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-footer.test.js"

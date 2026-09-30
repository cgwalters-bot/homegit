#!/usr/bin/env bash
# Offline tests of bin/bot-signoff-due; the cases are in bot-signoff-due.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-signoff-due.test.js"

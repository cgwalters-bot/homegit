#!/usr/bin/env bash
# Offline tests of lib/pacing.js and bin/bot-pace; the cases are in pacing.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/pacing.test.js"

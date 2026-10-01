#!/usr/bin/env bash
# Offline tests of bin/bot-drive; the cases are in bot-drive.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-drive.test.js"

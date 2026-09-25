#!/usr/bin/env bash
# Offline tests of bin/bot-retro; the cases are in bot-retro.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-retro.test.js"

#!/usr/bin/env bash
# Offline tests of 'bot-devspace remaining' and the time check of 'bot-devspace
# ssh'; the cases are in bot-devspace-time.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-devspace-time.test.js"

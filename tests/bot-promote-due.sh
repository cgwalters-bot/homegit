#!/usr/bin/env bash
# Offline tests of bin/bot-promote-due; the cases are in bot-promote-due.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-promote-due.test.js"

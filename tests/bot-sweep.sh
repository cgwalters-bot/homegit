#!/usr/bin/env bash
# Offline tests of bin/bot-sweep; the cases are in bot-sweep.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-sweep.test.js"

#!/usr/bin/env bash
# Offline tests of bin/bot-priority-propagate; the cases are in
# bot-priority-propagate.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-priority-propagate.test.js"

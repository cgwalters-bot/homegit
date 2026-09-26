#!/usr/bin/env bash
# Offline tests of bin/bot-review-guide; the cases are in bot-review-guide.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-review-guide.test.js"

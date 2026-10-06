#!/usr/bin/env bash
# Offline tests of lib/budget.js; the cases are in budget.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/budget.test.js"

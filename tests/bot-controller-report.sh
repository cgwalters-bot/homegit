#!/usr/bin/env bash
# Offline tests of bin/bot-controller-report; the cases are in
# bot-controller-report.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-controller-report.test.js"

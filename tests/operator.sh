#!/usr/bin/env bash
# Offline tests of lib/operator.js and bin/bot-operator; the cases are in
# operator.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/operator.test.js"

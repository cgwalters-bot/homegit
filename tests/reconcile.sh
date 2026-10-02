#!/usr/bin/env bash
# Offline tests of lib/reconcile.js and bin/bot-reconcile; the cases are in reconcile.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/reconcile.test.js"

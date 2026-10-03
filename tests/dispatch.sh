#!/usr/bin/env bash
# Offline tests of lib/dispatch.js, the dispatch rule of lib/reconcile.js and
# bot-reconcile --apply's dispatch; the cases are in dispatch.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/dispatch.test.js"

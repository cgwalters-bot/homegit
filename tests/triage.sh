#!/usr/bin/env bash
# Offline tests of lib/triage.js, the triage rule of lib/reconcile.js and
# bot-reconcile --apply's triage; the cases are in triage.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/triage.test.js"

#!/usr/bin/env bash
# Offline tests of lib/assignees.js, the assignee turn and its hand-back; the cases are in assignees.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/assignees.test.js"

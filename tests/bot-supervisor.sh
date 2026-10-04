#!/usr/bin/env bash
# Offline supervisor tests; CI discovers this nonexecutable wrapper.
set -euo pipefail
exec node --test "$(dirname "$0")/bot-supervisor.test.js"

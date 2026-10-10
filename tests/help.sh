#!/usr/bin/env bash
# Offline, sandboxed --help coverage for all bin/ entrypoints.
set -euo pipefail
exec node --test "$(dirname "$0")/help.test.js"

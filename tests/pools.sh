#!/usr/bin/env bash
# Offline tests of lib/pools.js, the per-pool pace; the cases are in pools.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/pools.test.js"

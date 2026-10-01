#!/usr/bin/env bash
# Checks ci.yml's required-checks gate; the cases are in ci-gate.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/ci-gate.test.js"

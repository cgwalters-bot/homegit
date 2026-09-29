#!/usr/bin/env bash
# Offline tests of the builder agent's command guard; the cases are in builder-agent.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/builder-agent.test.js"

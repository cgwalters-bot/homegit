#!/usr/bin/env bash
# Offline run-health, watcher, sweep integration and shared-lock tests.
set -euo pipefail
exec node --test "$(dirname "$0")"/{run-health,run-watch,run-watch-sweep,run-watch-lock}.test.js

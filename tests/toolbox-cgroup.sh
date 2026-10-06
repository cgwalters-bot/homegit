#!/usr/bin/env bash
# Offline tests of lib/toolbox.js, which keeps the toolbox container out of the units' cgroups; the cases are in toolbox-cgroup.test.js.
set -euo pipefail
exec node --test "$(dirname "$0")/toolbox-cgroup.test.js"

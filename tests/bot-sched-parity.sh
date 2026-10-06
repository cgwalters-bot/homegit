#!/usr/bin/env bash
# bot-sched's rules against lib/reconcile.js's, on the board recorded in
# crates/sched/tests/fixtures: both must list the same actions while the
# two copies exist. Needs bot-sched on PATH (cargo build); no network.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
HOME=${WORK} XDG_CONFIG_HOME=${WORK} BOT_OPERATOR_CONFIG='' bot-sched parity --dir "${WORK}" --recorded crates/sched/tests/fixtures/board.json

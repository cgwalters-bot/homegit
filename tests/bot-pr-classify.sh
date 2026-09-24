#!/usr/bin/env bash
# Offline tests of how 'bot-pr fork-setup' classifies workflow files,
# which decides what it disables on forks: 'bot-pr fork-setup
# --classify-file' over tests/fixtures/workflows. No network.
#   tests/bot-pr-classify.sh
# The fixtures are real upstream workflows, unmodified unless their header
# says otherwise, from bootc-dev/bootc@41049ccada2b (bootc-*),
# bootc-dev/bcvk@5cbcdbb869f4 (bcvk-*) and bootc-dev/infra@effda4afbb9a
# (infra-*), plus a few synthetic-* edge cases.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly FIXTURES=${TESTS}/fixtures/workflows
readonly BOT_PR=${TESTS}/../bin/bot-pr

# FIXTURE CLASS TRIGGERS SECRETS ("-" for none)
readonly CASES='
bcvk-main.yml                   unscheduled merge_group,pull_request,push,workflow_dispatch -
bootc-auto-review.yml           secrets     pull_request_target(opened|ready_for_review) APP_ID,APP_PRIVATE_KEY
bootc-labeler.yml               unscheduled pull_request_target -
bootc-merge.yml                 secrets     pull_request(labeled) GH_AW_APP_PRIVATE_KEY
bootc-release.yml               secrets     pull_request(closed) APP_ID,APP_PRIVATE_KEY,GPG_PASSPHRASE,GPG_PRIVATE_KEY
bootc-review.lock.yml           agentic     pull_request(opened|synchronize) ANTHROPIC_API_KEY
bootc-scheduled-release.yml     scheduled   schedule,workflow_dispatch APP_ID,APP_PRIVATE_KEY,GPG_PASSPHRASE,GPG_PRIVATE_KEY
infra-renovate.yml              mixed       pull_request,schedule,workflow_dispatch APP_ID,APP_PRIVATE_KEY
infra-sync-labels.yml           unscheduled push,workflow_dispatch APP_ID,APP_PRIVATE_KEY
synthetic-manual.yml            unscheduled workflow_dispatch DEPLOY_TOKEN
synthetic-scheduled-bot.yml     secrets     pull_request_target,schedule BOT_KEY
'

failures=0 count=0
while read -r fixture class triggers secrets; do
    test -n "${fixture}" || continue
    count=$((count + 1))
    expected=${class}$'\t'${triggers}
    test "${secrets}" = - || expected+=$'\t'${secrets}
    if ! actual=$("${BOT_PR}" fork-setup --classify-file "${FIXTURES}/${fixture}" 2>&1); then
        echo "FAIL: ${fixture}: ${actual}" 1>&2
        failures=$((failures + 1))
    elif test "${actual}" != "${expected}"; then
        printf 'FAIL: %s:\n  expected: %s\n  actual:   %s\n' "${fixture}" "${expected}" "${actual}" 1>&2
        failures=$((failures + 1))
    fi
done <<<"${CASES}"

# Every fixture has a case, so none is silently untested.
for f in "${FIXTURES}"/*.yml; do
    grep -q "^$(basename "${f}") " <<<"${CASES}" || { echo "FAIL: no case for ${f}" 1>&2; failures=$((failures + 1)); }
done

test "${failures}" -eq 0 || { echo "${failures} of ${count} cases failed" 1>&2; exit 1; }
echo "ok: ${count} workflow files classified as expected"

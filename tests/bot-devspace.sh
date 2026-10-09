#!/usr/bin/env bash
# Offline tests of which SSH user 'bot-devspace start' settles on, and of
# what 'bot-devspace provision' then does. Devspaces admit the unprivileged
# 'runner-sandbox' (no sudo; the workflow installs the toolchain) or, from workflow
# revisions that predate it, only 'runner' (sudo; provision installs it).
# A fake gh keeps one dispatched run in a temporary directory, and a fake
# ssh admits the users in $FAKE_SSH_USERS and records what it was asked to
# run, and answers the CPU model probe with $FAKE_CPU. Then which runs of another start count as the same devspace, by
# their titles. Last, jobs, which the fake ssh runs locally: what wait
# reports and exits with for each way one can end. No network.
#   tests/bot-devspace.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_DEVSPACE=${TESTS}/../bin/bot-devspace
readonly RUN_ID=4242

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bot-devspace-test.XXXXXX")
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
export FAKE=${WORK}/fake
export PATH=${WORK}/bin:${PATH}
mkdir -p "${WORK}/bin" "${FAKE}"

failures=0
fail() {
    echo "FAIL: $*" 1>&2
    failures=$((failures + 1))
}

# The fake gh, for the REST calls bot-devspace makes. $FAKE/runs.json is
# the workflow's run listing: empty (or what a test seeds) until a
# dispatch adds run RUN_ID, titled like devspace.yml's run-name.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter="." name="" cores="" duration=""
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f)
            case "$2" in
                "inputs[session_name]="*) name=${2#*=} ;;
                "inputs[cores]="*) cores=${2#*=} ;;
                "inputs[duration]="*) duration=${2#*=} ;;
            esac
            shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        *) path=$1; shift ;;
    esac
done
runs=${FAKE}/runs.json
test -e "${runs}" || echo '{"workflow_runs": []}' >"${runs}"
# devspace.yml's run-name
title="Devspace ${name} (${cores}c, ${duration}m)"
case "${method} ${path%%\?*}" in
    "POST repos/"*/dispatches)
        jq --arg t "${title}" --argjson id "${RUN_ID}" \
            '.workflow_runs += [{id: $id, display_title: $t, status: "in_progress"}]' \
            "${runs}" >"${runs}.new"
        mv "${runs}.new" "${runs}" ;;
    "POST repos/"*"/runs/${RUN_ID}/cancel")
        jq '.workflow_runs[].status = "completed"' "${runs}" >"${runs}.new"
        mv "${runs}.new" "${runs}" ;;
    "GET repos/"*/workflows/devspace.yml/runs) jq -r "${filter}" "${runs}" ;;
    "GET repos/"*"/runs/${RUN_ID}")
        jq -r ".workflow_runs[] | select(.id == ${RUN_ID}) | {path: \".github/workflows/devspace.yml\", status,
            conclusion: (if .status == \"completed\" then \"cancelled\" else null end)} | ${filter}" "${runs}" ;;
    *) echo "fake gh: unexpected: ${method} ${path}" 1>&2; exit 1 ;;
esac
EOF
sed -i "s/\${RUN_ID}/${RUN_ID}/g" "${WORK}/bin/gh"

# The fake ssh. The user is -l's, else the config's User. A login that
# isn't in $FAKE_SSH_USERS is refused; a provision script is recorded in
# $FAKE/provision (its mode argument, then its stdin) and exits with
# $FAKE_CHECK_RC in check mode. The CPU model probe prints $FAKE_CPU,
# failing if it is empty.
cat >"${WORK}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
config="" user="" host=""
while test $# -gt 0; do
    case "$1" in
        -F) config=$2; shift 2 ;;
        -l) user=$2; shift 2 ;;
        -o) shift 2 ;;
        *) host=$1; shift; break ;;
    esac
done
test -n "${user}" || user=$(awk '$1 == "User" { print $2 }' "${config}")
grep -qw -- "${user}" <<<"${FAKE_SSH_USERS}" || exit 255
case "$*" in
    true) exit 0 ;;
    "awk "*/proc/cpuinfo) test -n "${FAKE_CPU:-}" && echo "${FAKE_CPU}" ;;
    # Jobs run here for real, in $FAKE/home as the devspace's home.
    "bash -s -- job "*)
        mkdir -p "${FAKE}/home"
        cd "${FAKE}/home"
        HOME=${FAKE}/home exec bash -c "$*" ;;
    "bash -s -- "*)
        { echo "$4"; cat; } >"${FAKE}/provision"
        test "$4" != check || exit "${FAKE_CHECK_RC:-0}" ;;
    *) echo "fake ssh: unexpected: $*" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh" "${WORK}/bin/ssh"

# Unsupported sizes must explain the choice within the worker's core limit,
# before attempting a dispatch.
rc=0
"${BOT_DEVSPACE}" start --cores 8 t-eight >/dev/null 2>"${WORK}/err" || rc=$?
test "${rc}" != 0 || fail "8 cores was accepted"
grep -q '8 is not supported; use 4 or 16 for a limit of 16 cores' "${WORK}/err" || fail "missing core limit guidance"
test ! -e "${FAKE}/runs.json" || fail "unsupported cores attempted a dispatch"

# (users the devspace admits, the user start must pick, provision's mode)
cases=(
    "runner-sandbox runner|runner-sandbox|check"
    "runner-sandbox|runner-sandbox|check"
    "runner|runner|install"
)
for case in "${cases[@]}"; do
    IFS='|' read -r admitted want mode <<<"${case}"
    export XDG_STATE_HOME=${WORK}/state FAKE_SSH_USERS=${admitted} FAKE_CPU="AMD EPYC 7763 64-Core Processor"
    rm -rf "${XDG_STATE_HOME}" "${FAKE:?}"/*
    name=t-${want}
    if ! host=$("${BOT_DEVSPACE}" start --duration 30 "${name}" 2>"${WORK}/err"); then
        fail "[${admitted}] start failed: $(cat "${WORK}/err")"
        continue
    fi
    test "${host}" = "cgwalters-devspace-${RUN_ID}" || fail "[${admitted}] start printed '${host}'"
    dir=${XDG_STATE_HOME}/bot-devspace/${name}
    test "$(cat "${dir}/ssh_user")" = "${want}" || fail "[${admitted}] recorded user $(cat "${dir}/ssh_user"), want ${want}"
    grep -qx "    User ${want}" "${dir}/ssh_config" || fail "[${admitted}] ssh_config lacks 'User ${want}'"
    test "$(head -1 "${FAKE}/provision")" = "${mode}" || fail "[${admitted}] provision ran in mode $(head -1 "${FAKE}/provision"), want ${mode}"
    # The CPU model is recorded, reported at start and listed.
    test "$(cat "${dir}/cpu" 2>/dev/null)" = "${FAKE_CPU}" || fail "[${admitted}] recorded CPU '$(cat "${dir}/cpu" 2>/dev/null)'"
    grep -qxF "CPU: ${FAKE_CPU}" "${WORK}/err" || fail "[${admitted}] start did not report the CPU: $(cat "${WORK}/err")"
    "${BOT_DEVSPACE}" list | grep -q "^${name} .*${FAKE_CPU}\$" || fail "[${admitted}] list lacks the CPU: $("${BOT_DEVSPACE}" list)"
    if test "${want}" = runner; then
        grep -q 'only admits runner' "${WORK}/err" || fail "[${admitted}] no note about the legacy user"
    fi

    # Without sudo, missing packages are an error that says where to add them.
    if test "${mode}" = check; then
        if FAKE_CHECK_RC=1 "${BOT_DEVSPACE}" provision "${name}" 2>"${WORK}/err"; then
            fail "[${admitted}] provision succeeded with packages missing"
        fi
        grep -q 'packages.txt' "${WORK}/err" || fail "[${admitted}] provision error lacks the hint: $(cat "${WORK}/err")"
    fi

    # State from before the user was recorded is a legacy devspace.
    rm "${dir}/ssh_user"
    "${BOT_DEVSPACE}" provision "${name}" 2>/dev/null || fail "[${admitted}] provision without ssh_user failed"
    test "$(head -1 "${FAKE}/provision")" = install || fail "[${admitted}] state without ssh_user was not treated as legacy"

    "${BOT_DEVSPACE}" stop "${name}" 2>/dev/null || fail "[${admitted}] stop failed"
done

# A devspace whose CPU model can't be read still starts, with a warning,
# and list shows '-' for it.
export XDG_STATE_HOME=${WORK}/state FAKE_SSH_USERS=runner-sandbox FAKE_CPU=
rm -rf "${XDG_STATE_HOME}" "${FAKE:?}"/*
if "${BOT_DEVSPACE}" start --no-provision --duration 30 t-nocpu >/dev/null 2>"${WORK}/err"; then
    grep -q 'could not read the CPU model' "${WORK}/err" || fail "[no cpu] no warning: $(cat "${WORK}/err")"
    "${BOT_DEVSPACE}" list | grep -q '^t-nocpu .* -$' || fail "[no cpu] list: $("${BOT_DEVSPACE}" list)"
    "${BOT_DEVSPACE}" stop t-nocpu 2>/dev/null || fail "[no cpu] stop failed"
else
    fail "[no cpu] start failed: $(cat "${WORK}/err")"
fi

# Which active runs start takes for another devspace of the same name:
# titles with and without the size, never a longer name that shares the
# prefix. (seeded title, whether start must refuse)
title_cases=(
    "Devspace t-title (16c, 120m)|refuse"
    "Devspace t-title|refuse"
    "Devspace t-title-2 (16c, 120m)|start"
    "Devspace t-title-2|start"
    "Devspace t-titl (4c, 30m)|start"
)
for case in "${title_cases[@]}"; do
    IFS='|' read -r title want <<<"${case}"
    export XDG_STATE_HOME=${WORK}/state FAKE_SSH_USERS=runner-sandbox
    rm -rf "${XDG_STATE_HOME}" "${FAKE:?}"/*
    jq -n --arg t "${title}" '{workflow_runs: [{id: 1, display_title: $t, status: "in_progress"}]}' >"${FAKE}/runs.json"
    if "${BOT_DEVSPACE}" start --no-provision --duration 30 t-title >/dev/null 2>"${WORK}/err"; then
        test "${want}" = start || fail "[${title}] start ignored the active run"
        "${BOT_DEVSPACE}" stop t-title 2>/dev/null || fail "[${title}] stop failed"
    else
        test "${want}" = refuse || fail "[${title}] start failed: $(cat "${WORK}/err")"
        grep -q 'already exists' "${WORK}/err" || fail "[${title}] start failed otherwise: $(cat "${WORK}/err")"
    fi
done

# Jobs: what wait reports and exits with for each way a job can end.
# (command, wait options, wait's exit status, a line its output must have)
export XDG_STATE_HOME=${WORK}/state FAKE_SSH_USERS=runner-sandbox BOT_DEVSPACE_JOB_POLL=1
rm -rf "${XDG_STATE_HOME}" "${FAKE:?}"/*
"${BOT_DEVSPACE}" start --no-provision --duration 30 t-jobs >/dev/null 2>&1 || fail "[jobs] start failed"
mkdir -p "${FAKE}/home/src/repo"
job_cases=(
    "echo built; exit 0||0|built"
    "echo broke; exit 3||1|exited with 3"
    "printf '%s\n' 'a  b' \"\$HOME\"||0|a  b"
    "seq 50||0|50"
    "seq 50|--tail 2|0|49"
    "pwd|--cd src/repo|0|${FAKE}/home/src/repo"
    "sleep 30|--timeout 1|124|still running after 1s"
)
for case in "${job_cases[@]}"; do
    IFS='|' read -r cmd opts want line <<<"${case}"
    run_opts=() wait_opts=()
    case "${opts}" in
        --cd*) read -ra run_opts <<<"${opts}" ;;
        ?*) read -ra wait_opts <<<"${opts}" ;;
    esac
    "${BOT_DEVSPACE}" run "${run_opts[@]}" t-jobs job1 "${cmd}" >/dev/null 2>"${WORK}/err" ||
        { fail "[${cmd}] run failed: $(cat "${WORK}/err")"; continue; }
    rc=0
    "${BOT_DEVSPACE}" wait "${wait_opts[@]}" t-jobs job1 >"${WORK}/out" 2>&1 || rc=$?
    test "${rc}" = "${want}" || fail "[${cmd}] wait exited ${rc}, want ${want}: $(cat "${WORK}/out")"
    grep -qF -- "${line}" "${WORK}/out" ||
        fail "[${cmd}] wait output lacks '${line}': $(cat "${WORK}/out")"
    if test "${opts}" = "--tail 2"; then
        grep -qx 48 "${WORK}/out" && fail "[${cmd}] --tail 2 printed more than 2 lines"
    fi
    # Starting a job that is still running is refused.
    if test "${want}" = 124; then
        "${BOT_DEVSPACE}" run t-jobs job1 true 2>/dev/null && fail "[${cmd}] run replaced a running job"
        kill "$(cat "${FAKE}/home/.bot-devspace/jobs/job1/pid")"
    fi
done

# The errors, all exit 2: no such job, a job killed before it could record
# its status, and a devspace whose run has finished. (setup, job, message)
kill_job2() {
    "${BOT_DEVSPACE}" run t-jobs job2 sleep 30 >/dev/null 2>&1 || fail "[lost job] run failed"
    pkill -KILL -s "$(cat "${FAKE}/home/.bot-devspace/jobs/job2/pid")" || true
}
finish_run() {
    jq '.workflow_runs[].status = "completed"' "${FAKE}/runs.json" >"${FAKE}/runs.json.new"
    mv "${FAKE}/runs.json.new" "${FAKE}/runs.json"
    export FAKE_SSH_USERS=nobody
}
error_cases=(
    "true|nosuchjob|no job named 'nosuchjob'"
    "kill_job2|job2|died without recording"
    "finish_run|job1|devspace t-jobs is gone"
)
for case in "${error_cases[@]}"; do
    IFS='|' read -r setup job message <<<"${case}"
    "${setup}"
    rc=0
    "${BOT_DEVSPACE}" wait t-jobs "${job}" 2>"${WORK}/err" || rc=$?
    test "${rc}" = 2 || fail "[${setup}] wait exited ${rc}, want 2: $(cat "${WORK}/err")"
    grep -qF -- "${message}" "${WORK}/err" || fail "[${setup}] wait error lacks '${message}': $(cat "${WORK}/err")"
done
export FAKE_SSH_USERS=runner-sandbox
"${BOT_DEVSPACE}" stop t-jobs 2>/dev/null || fail "[jobs] stop failed"

if test "${failures}" -ne 0; then
    echo "${failures} failure(s)" 1>&2
    exit 1
fi
echo "ok: bot-devspace SSH user detection, provision modes, CPU model, run titles and jobs"

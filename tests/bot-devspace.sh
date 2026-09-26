#!/usr/bin/env bash
# Offline tests of which SSH user 'bot-devspace start' settles on, and of
# what 'bot-devspace provision' then does. Devspaces admit the unprivileged
# 'runner-sandbox' (no sudo; the workflow installs the toolchain) or, from workflow
# revisions that predate it, only 'runner' (sudo; provision installs it).
# A fake gh keeps one dispatched run in a temporary directory, and a fake
# ssh admits the users in $FAKE_SSH_USERS and records what it was asked to
# run. No network.
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
# the workflow's run listing: empty until a dispatch adds run RUN_ID.
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api || { echo "fake gh: unexpected: $*" 1>&2; exit 1; }
shift
method=GET path="" filter="." title=""
while test $# -gt 0; do
    case "$1" in
        -X) method=$2; shift 2 ;;
        -f) [[ "$2" == "inputs[session_name]="* ]] && title="Devspace ${2#*=}"; shift 2 ;;
        --jq) filter=$2; shift 2 ;;
        *) path=$1; shift ;;
    esac
done
runs=${FAKE}/runs.json
test -e "${runs}" || echo '{"workflow_runs": []}' >"${runs}"
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
        jq -r ".workflow_runs[0] | {path: \".github/workflows/devspace.yml\", status,
            conclusion: (if .status == \"completed\" then \"cancelled\" else null end)} | ${filter}" "${runs}" ;;
    *) echo "fake gh: unexpected: ${method} ${path}" 1>&2; exit 1 ;;
esac
EOF
sed -i "s/\${RUN_ID}/${RUN_ID}/g" "${WORK}/bin/gh"

# The fake ssh. The user is -l's, else the config's User. A login that
# isn't in $FAKE_SSH_USERS is refused; a provision script is recorded in
# $FAKE/provision (its mode argument, then its stdin) and exits with
# $FAKE_CHECK_RC in check mode.
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
    "bash -s -- "*)
        { echo "$4"; cat; } >"${FAKE}/provision"
        test "$4" != check || exit "${FAKE_CHECK_RC:-0}" ;;
    *) echo "fake ssh: unexpected: $*" 1>&2; exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh" "${WORK}/bin/ssh"

# (users the devspace admits, the user start must pick, provision's mode)
cases=(
    "runner-sandbox runner|runner-sandbox|check"
    "runner-sandbox|runner-sandbox|check"
    "runner|runner|install"
)
for case in "${cases[@]}"; do
    IFS='|' read -r admitted want mode <<<"${case}"
    export XDG_STATE_HOME=${WORK}/state FAKE_SSH_USERS=${admitted}
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

if test "${failures}" -ne 0; then
    echo "${failures} failure(s)" 1>&2
    exit 1
fi
echo "ok: bot-devspace SSH user detection and provision modes"

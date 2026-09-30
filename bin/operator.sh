# shellcheck shell=bash
# The operator config for the bot's shell tools, which source this file
# (it is not executable, so install-bin.sh leaves it out): sets the OP_*
# variables that 'bot-operator --shell' prints (see lib/operator.js).
_op_vars=$("$(dirname "${BASH_SOURCE[0]}")/bot-operator" --shell) || {
    echo "error: ${0##*/}: cannot load the operator config (see bot-operator --help)" 1>&2
    exit 1
}
eval "${_op_vars}"
unset _op_vars

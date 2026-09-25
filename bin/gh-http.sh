# shellcheck shell=bash
# Reading 'gh api -i' output, shared by bot-notify, bot-runs and
# bot-watch, which source this file (it is not executable, so
# install-bin.sh leaves it out).

# split_http_response RAW HEADERS BODY: splits the 'gh api -i' output in
# the file RAW, without carriage returns, into the status line and
# headers (up to and including the empty line after them) in the file
# HEADERS, and the body in the file BODY. It reads RAW to the end: a
# reader that quits after the headers (like "sed '/^$/q'") makes the
# writer before it die of SIGPIPE once the body outgrows a pipe, which
# pipefail turns into a failure.
split_http_response() {
    : >"$2"
    : >"$3"
    tr -d '\r' <"$1" | awk -v headers="$2" -v body="$3" '
        in_body { print >body; next }
        { print >headers }
        /^$/ { in_body = 1 }'
}

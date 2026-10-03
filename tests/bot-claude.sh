#!/usr/bin/env bash
# Offline tests of bot-claude, against a fake `claude -p` (a stream-json
# emitter driven by the brief) in a scratch state directory.
#   tests/bot-claude.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_CLAUDE=${TESTS}/../bin/bot-claude
WORK=$(mktemp -d)
readonly WORK
cleanup() {
    # A job left running by a failed test must not outlive it.
    pkill -f "${WORK}" 2>/dev/null || true
    rm -rf "${WORK}"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

# expect_eq NAME GOT WANT
expect_eq() {
    test "$2" = "$3" || fail "$1: got '$2', want '$3'"
}

mkdir "${WORK}/bin" "${WORK}/dir" "${WORK}/state"
# The fake claude: the brief (stdin) names the scenario on a 'Scenario:'
# line. It records its arguments, working directory and environment, then
# emits stream-json like the real one.
cat >"${WORK}/bin/claude" <<'JS'
#!/usr/bin/env node
const fs = require("fs");
const brief = fs.readFileSync(0, "utf8");
const scenario = (/^Scenario: (\S+)/m.exec(brief) || [])[1];
fs.writeFileSync(`${process.env.FAKE_OUT}/${scenario}.invocation`, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), brief,
  env: Object.fromEntries(["CLAUDE_CODE_SHELL", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "GIT_AUTHOR_EMAIL"].map((k) => [k, process.env[k] || null])),
}));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-fake" });
if (scenario === "hang") {
  // A child of its own, which must die with the process group.
  const child = require("child_process").spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(`${process.env.FAKE_OUT}/hang.sleep.pid`, String(child.pid));
  setInterval(() => {}, 1000);
  return;
}
if (scenario === "die") process.exit(3);
if (scenario === "straggler") {
  // A background process holding stdout open past the worker's exit.
  const child = require("child_process").spawn("sleep", ["300"], { stdio: ["ignore", "inherit", "ignore"] });
  fs.writeFileSync(`${process.env.FAKE_OUT}/straggler.sleep.pid`, String(child.pid));
}
if (scenario === "utf8") {
  // A multibyte character split across two writes.
  const line = Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "caf\u00e9 \u2713 done", num_turns: 1, total_cost_usd: 0 }) + "\n");
  const cut = line.indexOf(0xc3) + 1;
  process.stdout.write(line.subarray(0, cut));
  setTimeout(() => { process.stdout.write(line.subarray(cut)); process.exit(0); }, 300);
  return;
}
emit({ type: "assistant", message: { content: [{ type: "text", text: "working on it" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
const bad = scenario === "fail";
emit({ type: "result", subtype: bad ? "error_during_execution" : "success", is_error: bad, result: `final report for ${scenario}`,
  num_turns: 2, total_cost_usd: 0.25, session_id: "sess-1",
  usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } });
process.exit(bad ? 1 : 0);
JS
chmod +x "${WORK}/bin/claude"
# Fakes for the actuals sweep and the heartbeat's publish (which saves what
# it was given as the state the registration reads next).
cat >"${WORK}/bin/actuals" <<'JS'
#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(`${process.env.FAKE_OUT}/actuals.calls`, process.argv.slice(2).join(" ") + "\n");
const mode = fs.existsSync(`${process.env.FAKE_OUT}/actuals.mode`) ? fs.readFileSync(`${process.env.FAKE_OUT}/actuals.mode`, "utf8") : "ok";
if (mode === "block") {
  const child = require("child_process").spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(`${process.env.FAKE_OUT}/actuals.sleep.pid`, String(child.pid));
  setInterval(() => {}, 1000);
}
else if (mode === "delay") setTimeout(() => {}, 11000);
else if (mode === "fail") { process.stderr.write("actuals failed\n"); process.exitCode = 7; }
fs.writeFileSync(`${process.env.FAKE_OUT}/actuals.started`, String(process.pid));
JS
cat >"${WORK}/bin/heartbeat" <<JS
#!/usr/bin/env node
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const hb = require("${TESTS}/../bin/bot-heartbeat").validate(input, Date.now()).hb;
fs.writeFileSync(process.env.XDG_STATE_HOME + "/bot-heartbeat/last-publish.json", JSON.stringify({ session: "s", input, published: hb }));
fs.appendFileSync(process.env.FAKE_OUT + "/heartbeat.calls", input.workers.map((w) => w.name).join(",") + "\n");
JS
chmod +x "${WORK}/bin/actuals" "${WORK}/bin/heartbeat"
mkdir -p "${WORK}/state/bot-heartbeat" "${WORK}/out"
node -e '
const now = Date.now();
const updated = new Date(now - 600000).toISOString();
process.stdout.write(JSON.stringify({ session: "s", input: { updated_at: updated, coordinator: { session: "c", loop_state: "sleeping" }, workers: [] }, published: { updated_at: updated } }));
' >"${WORK}/state/bot-heartbeat/last-publish.json"
echo '{"bot": {"git_name": "Test Bot", "git_email": "bot+llm@example.org"}}' >"${WORK}/operator.json"

export PATH=${WORK}/bin:${PATH}
export XDG_STATE_HOME=${WORK}/state
export BOT_OPERATOR_CONFIG=${WORK}/operator.json
export FAKE_OUT=${WORK}/out
export BOT_CLAUDE_ACTUALS=${WORK}/bin/actuals
export BOT_CLAUDE_HEARTBEAT=${WORK}/bin/heartbeat
# The coordinator session's variables, which a job must not see.
export CLAUDE_CODE_SESSION_ID=coordinator-session CLAUDECODE=1 CLAUDE_CODE_OAUTH_TOKEN=oauth-kept
bc() { "${BOT_CLAUDE}" "$@"; }
status_of() { bc status --json "$1" | jq -r "$2"; }

# Scenarios: NAME  JOB-STATE  WAIT-EXIT
#   ok     the worker ends well                     succeeded  0
#   fail   an error result and a non-zero exit      failed     1
#   die    exits without any result                 failed     1
#   hang   never ends: the 0.02 minute timeout     timeout    3
#   utf8   a character split across two chunks     succeeded  0
#   straggler  leaves a process holding stdout     succeeded  0
while read -r name state want_rc; do
    echo "Scenario: ${name}" >"${WORK}/${name}.brief"
    extra=()
    test "${name}" != hang || extra=(--timeout 0.02)
    job=$(bc start --dir "${WORK}/dir" --job "j-${name}" --item https://github.com/o/r/issues/7 "${extra[@]}" "${WORK}/${name}.brief" 2>/dev/null)
    expect_eq "${name}: job id" "${job}" "j-${name}"
    rc=0
    bc wait --timeout 30 "${job}" >"${WORK}/${name}.wait" 2>&1 || rc=$?
    expect_eq "${name}: wait exit" "${rc}" "${want_rc}"
    expect_eq "${name}: state" "$(status_of "${job}" .state)" "${state}"
    test -s "${XDG_STATE_HOME}/bot-claude/${job}/stream.jsonl" || fail "${name}: no stream.jsonl"
done <<'TABLE'
ok succeeded 0
fail failed 1
die failed 1
hang timeout 3
utf8 succeeded 0
straggler succeeded 0
TABLE

# The result event's data lands in status.json and on wait's stdout.
expect_eq "result" "$(status_of j-ok .result)" "final report for ok"
expect_eq "tokens" "$(status_of j-ok '.tokens | [.input, .output, .cache_read, .cache_creation] | join(",")')" "11,22,33,44"
expect_eq "cost" "$(status_of j-ok .cost_usd)" "0.25"
expect_eq "turns" "$(status_of j-ok .num_turns)" "2"
expect_eq "session" "$(status_of j-ok .session_id)" "sess-1"
expect_eq "exit code" "$(status_of j-die .exit_code)" "3"
grep -q '^final report for ok$' "${WORK}/ok.wait" || fail "wait did not print the result"
bc status j-ok | grep -q 'job j-ok: succeeded, exit 0, 2 turns, 11 in / 22 out tokens' || fail "status summary: $(bc status j-ok)"
bc status | grep -q '^j-hang.timeout' || fail "status list lacks the job"

expect_eq "multibyte result" "$(status_of j-utf8 .result)" "café ✓ done"
sleep_pid=$(cat "${WORK}/out/straggler.sleep.pid")
! kill -0 "${sleep_pid}" 2>/dev/null || fail "the worker's straggler survived its exit"

# What the process was given: cwd, model, rules, the bot's environment and
# none of the coordinator session's.
inv=${WORK}/out/ok.invocation
expect_eq "cwd" "$(jq -r .cwd "${inv}")" "${WORK}/dir"
expect_eq "model default" "$(jq -r '.args | index("--model") as $i | .[$i + 1]' "${inv}")" "opus"
expect_eq "stream-json" "$(jq -r '.args | index("--output-format") as $i | .[$i + 1]' "${inv}")" "stream-json"
expect_eq "permission mode" "$(jq -r '.args | index("--permission-mode") as $i | .[$i + 1]' "${inv}")" "bypassPermissions"
expect_eq "settings" "$(jq -r '.args | index("--settings") as $i | .[$i + 1] | endswith("dotfiles/.claude/settings.json")' "${inv}")" "true"
expect_eq "shell" "$(jq -r .env.CLAUDE_CODE_SHELL "${inv}")" "/bin/bash"
expect_eq "session var dropped" "$(jq -r '.env.CLAUDE_CODE_SESSION_ID, .env.CLAUDECODE | tostring' "${inv}" | tr '\n' ' ')" "null null "
expect_eq "oauth kept" "$(jq -r .env.CLAUDE_CODE_OAUTH_TOKEN "${inv}")" "oauth-kept"
expect_eq "identity" "$(jq -r .env.GIT_AUTHOR_EMAIL "${inv}")" "bot+llm@example.org"
expect_eq "item line" "$(jq -r .brief "${inv}" | head -1)" "Item: https://github.com/o/r/issues/7"

# Options pass through, and a brief already naming its item keeps its line.
printf 'Item: https://github.com/o/r/issues/9\nScenario: opts\n' >"${WORK}/opts.brief"
bc run --dir "${WORK}/dir" --job j-opts --model sonnet --max-turns 5 --effort low --add-dir "${WORK}/bin" \
    --permission-mode plan --item https://github.com/o/r/issues/9 "${WORK}/opts.brief" >/dev/null 2>&1 || fail "run failed"
inv=${WORK}/out/opts.invocation
expect_eq "model" "$(jq -r '.args | index("--model") as $i | .[$i + 1]' "${inv}")" "sonnet"
expect_eq "max-turns" "$(jq -r '.args | index("--max-turns") as $i | .[$i + 1]' "${inv}")" "5"
expect_eq "effort" "$(jq -r '.args | index("--effort") as $i | .[$i + 1]' "${inv}")" "low"
expect_eq "add-dir" "$(jq -r '.args | index("--add-dir") as $i | .[$i + 1]' "${inv}")" "${WORK}/bin"
expect_eq "mode" "$(jq -r '.args | index("--permission-mode") as $i | .[$i + 1]' "${inv}")" "plan"
expect_eq "no duplicate item line" "$(jq -r .brief "${inv}" | grep -c '^Item:')" "1"

# The heartbeat: each job with an item was registered, then dropped.
grep -q 'j-ok' "${WORK}/out/heartbeat.calls" || fail "j-ok was not registered"
workers=$(jq -r '.input.workers | length' "${XDG_STATE_HOME}/bot-heartbeat/last-publish.json")
expect_eq "heartbeat workers left" "${workers}" "0"
# ... and the actual tokens were recorded.
grep -q -- '--open' "${WORK}/out/actuals.calls" || fail "actuals not run"
expect_eq "actuals status" "$(status_of j-ok .actuals)" "recorded"

# A timed-out job's whole process group is gone, children included.
sleep_pid=$(cat "${WORK}/out/hang.sleep.pid")
! kill -0 "${sleep_pid}" 2>/dev/null || fail "the hung worker's child survived the timeout"

# kill stops a running job, children included.
echo "Scenario: hang" >"${WORK}/hang.brief"
job=$(bc start --dir "${WORK}/dir" --job j-kill "${WORK}/hang.brief" 2>/dev/null)
for _ in $(seq 50); do test -s "${WORK}/out/hang.sleep.pid" && test "$(status_of "${job}" .claude_pid)" != null && break; sleep 0.1; done
sleep 0.3
sleep_pid=$(cat "${WORK}/out/hang.sleep.pid")
expect_eq "running" "$(status_of "${job}" .state)" "running"
rc=0
bc wait --timeout 0.5 "${job}" >/dev/null 2>&1 || rc=$?
expect_eq "wait timeout exit" "${rc}" "124"
bc kill "${job}" >/dev/null
expect_eq "killed state" "$(status_of "${job}" .state)" "killed"
! kill -0 "${sleep_pid}" 2>/dev/null || fail "kill left the worker's child running"
rc=0
bc wait --timeout 5 "${job}" >/dev/null 2>&1 || rc=$?
expect_eq "wait on a killed job" "${rc}" "4"

# A supervisor that vanished makes the job 'lost'.
mkdir -p "${XDG_STATE_HOME}/bot-claude/j-lost"
echo '{"job": "j-lost", "state": "running", "pid": 999999, "model": "m", "started_at": "2026-01-01T00:00:00Z"}' >"${XDG_STATE_HOME}/bot-claude/j-lost/status.json"
rc=0
bc wait --timeout 5 j-lost >/dev/null 2>&1 || rc=$?
expect_eq "lost wait exit" "${rc}" "4"
expect_eq "lost state" "$(status_of j-lost .state)" "lost"

# Legacy status has no verifiable identity: even a matching job name must
# not authorize signaling a potentially reused pid.
setsid bash -c 'sleep 300; :' j-lost2 &
worker=$!
disown
mkdir -p "${XDG_STATE_HOME}/bot-claude/j-lost2"
echo '{"job": "j-lost2", "state": "running", "pid": 999999, "claude_pid": '"${worker}"', "model": "m", "started_at": "2026-01-01T00:00:00Z"}' >"${XDG_STATE_HOME}/bot-claude/j-lost2/status.json"
bc status j-lost2 >/dev/null
# (A killed child of this shell may stay a zombie until waited for.)
alive() { [[ -n $(ps -o stat= -p "$1") && $(ps -o stat= -p "$1") != Z* ]]; }
for _ in $(seq 20); do alive "${worker}" || break; sleep 0.1; done
alive "${worker}" || fail "an unverified legacy worker was signaled"
kill -- "-${worker}"

node "${TESTS}/bot-claude-lifecycle.test.js" "${BOT_CLAUDE}" "${WORK}"

# log: the digest names the text and the tool call; --raw is the stream.
bc log j-ok | grep -q '^tool: Bash ls$' || fail "log digest: $(bc log j-ok)"
bc log --raw j-ok | head -1 | jq -e '.type == "system"' >/dev/null || fail "log --raw"

# Bad usage: exit 2 with a message, and no job left behind.
usage_fails() {
    local rc=0
    "${BOT_CLAUDE}" "$@" >/dev/null 2>"${WORK}/usage.err" </dev/null || rc=$?
    expect_eq "usage exit of '$*'" "${rc}" "2"
}
usage_fails start "${WORK}/ok.brief"
usage_fails start --dir "${WORK}/nope" "${WORK}/ok.brief"
usage_fails start --dir "${WORK}/dir" --permission-mode bogus "${WORK}/ok.brief"
usage_fails start --dir "${WORK}/dir" --item not-an-item "${WORK}/ok.brief"
usage_fails start --dir "${WORK}/dir" --timeout 0 "${WORK}/ok.brief"
usage_fails start --dir "${WORK}/dir" --job ../x "${WORK}/ok.brief"
usage_fails start --dir "${WORK}/dir" "${WORK}/missing.brief"
usage_fails wait nosuchjob
usage_fails status nosuchjob
usage_fails frobnicate
rc=0
bc start --dir "${WORK}/dir" --job j-ok "${WORK}/ok.brief" >/dev/null 2>&1 || rc=$?
expect_eq "existing job" "${rc}" "1"
echo "all tests passed"

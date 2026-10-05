#!/usr/bin/env bash
# Offline tests of bot-opencode, against a fake `opencode acp` (an ACP
# server on stdio that writes a file, or hangs) in a scratch repository.
#   tests/bot-opencode.sh
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
readonly TESTS
readonly BOT_OPENCODE=${TESTS}/../bin/bot-opencode
WORK=$(mktemp -d)
readonly WORK
cleanup() {
    node "${TESTS}/bot-opencode-processes.js" cleanup "${WORK}/cache/bot-work/opencode/escape/escaped.json"
    rm -rf "${WORK}"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" 1>&2
    exit 1
}

# expect_has NAME OUTPUT PATTERN: a line of OUTPUT matches the ERE PATTERN.
expect_has() {
    grep -qE -- "$3" <<<"$2" || fail "$1: no line matching '$3' in:
$2"
}

mkdir "${WORK}/bin" "${WORK}/repo"
# The fake agent: the model option holds praxis/m and other/m; the prompt
# "hang" never answers, anything else writes out.txt and replies.
cat >"${WORK}/bin/opencode" <<'JS'
#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawn } = require("child_process");
// The wrapper owns profile selection; inherited config injections must go.
assert.equal(process.env.OPENCODE_CONFIG, fs.realpathSync(path.join(process.env.HOME, ".config/opencode/opencode-runner.json")));
assert.equal(process.env.OPENCODE_CONFIG_CONTENT, undefined);
assert.equal(process.env.OPENCODE_CONFIG_DIR, undefined);
assert.equal(process.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
assert.equal(process.env.OPENCODE_DISABLE_MODELS_FETCH, "1");
const profile = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
assert.equal(profile.$schema, "https://opencode.ai/config.json");
assert.equal(profile.default_agent, "build");
assert.equal(profile.agent.build.options.reasoningEffort, "low");
assert.equal(profile.agent.general.options.reasoningEffort, "medium");
assert.equal(profile.agent.architect.disable, true);
assert.match(profile.agent.build.prompt, /at most one optional general/);
assert.match(profile.agent.general.prompt, /without editing source or delegating further/);
assert.equal(profile.agent.build.permission.task["*"], "deny");
for (const name of ["general", "explore", "fast"]) {
  assert.equal(profile.agent.build.permission.task[name], "allow");
  assert.equal(profile.agent[name].permission.edit, "deny");
  assert.equal(profile.agent[name].permission.task, "deny");
}
assert.equal(profile.agent.general.permission.bash, "allow");
for (const name of ["explore", "fast"]) {
  assert.equal(profile.agent[name].model, "praxis/gpt-6-luna");
  assert.equal(profile.agent[name].permission.bash, "deny");
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const result = {
    initialize: { protocolVersion: 1 },
    "session/new": { sessionId: "s1", configOptions: [{ id: "model", category: "model", currentValue: "praxis/m",
      options: [{ value: "praxis/m" }, { value: "other/m" }] }] },
    "session/set_config_option": {},
  }[m.method];
  if (m.method === "session/cancel") process.exit(0);
  if (result) return send({ id: m.id, result });
  if (m.method === "session/prompt") {
    const text = m.params.prompt[0].text;
    if (/Task:\nhang/.test(text)) return;
    if (/Task:\nescape/.test(text)) {
      const child = spawn("setsid", ["sleep", "300"], { stdio: "ignore" });
      const identity = (pid) => {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        return { pid, starttime: fields[19], pgrp: Number(fields[2]), session: Number(fields[3]),
          boot_id: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
      };
      // Wait for setsid to exec: recording only the PID would hide a race.
      const timer = setInterval(() => {
        const sleeper = identity(child.pid);
        if (sleeper.session !== child.pid) return;
        fs.writeFileSync("escaped.json", JSON.stringify({ agent: identity(process.pid), sleeper }));
        clearInterval(timer);
      }, 10);
      return;
    }
    if (/Task:\ndie/.test(text)) process.exit(3);
    fs.writeFileSync("out.txt", text);
    fs.writeFileSync("env.txt", [process.env.GIT_AUTHOR_EMAIL, process.env.GIT_COMMITTER_NAME, process.env.GH_TOKEN || "no-token",
      process.env.GIT_CONFIG_VALUE_0.includes("hooks") ? "hooks" : "nohooks",
      process.env.SSH_AUTH_SOCK || "no-ssh", process.env.XDG_CONFIG_HOME || "no-xdg",
      fs.readFileSync(process.env.HOME + "/.config/opencode/AGENTS.md", "utf8").split("\n")[0],
      fs.existsSync(process.env.HOME + "/.agents/skills/coordinator/SKILL.md") ? "skills" : "noskills"].join(" ") + "\n");
    const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
    update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "write out.txt" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrote " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "it" } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
JS
chmod +x "${WORK}/bin/opencode"
git -C "${WORK}/repo" init -q
git -C "${WORK}/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
export PATH=${WORK}/bin:${PATH}
export XDG_CACHE_HOME=${WORK}/cache
echo '{"bot": {"git_name": "Test Bot", "git_email": "bot+llm@example.org"}}' >"${WORK}/operator.json"
export BOT_OPERATOR_CONFIG=${WORK}/operator.json
export GH_TOKEN=secret-token-value SSH_AUTH_SOCK=/run/ssh-agent XDG_CONFIG_HOME=${WORK}/xdg
export OPENCODE_CONFIG=${WORK}/operator-profile.json
export OPENCODE_CONFIG_CONTENT='{"agent":{"architect":{"disable":false}}}'
export OPENCODE_CONFIG_DIR=${WORK}/operator-config
export OPENCODE_DISABLE_PROJECT_CONFIG=0 OPENCODE_DISABLE_MODELS_FETCH=0
# The operator's own opencode configuration, which must not be seen.
mkdir -p "${WORK}/xdg/opencode"
echo "OPERATOR AGENTS" >"${WORK}/xdg/opencode/AGENTS.md"
export HOME=${WORK}/operator-home
mkdir -p "${HOME}/.config/opencode"
echo "OPERATOR AGENTS" >"${HOME}/.config/opencode/AGENTS.md"
run() { "${BOT_OPENCODE}" --repo "${WORK}/repo" --model praxis/m "$@"; }

echo "task text" >"${WORK}/brief"
out=$(run --task ok --out "${WORK}/out" "${WORK}/brief" 2>"${WORK}/err") || fail "run failed: $(cat "${WORK}/err")"
expect_has "final message" "${out}" '^wrote it$'
expect_has "diff" "${out}" '^\+\+\+ i/out.txt$|^\+task text$'
grep -q '^+task text$' "${WORK}/out/changes.patch" || fail "changes.patch lacks the change"
expect_has "progress" "$(cat "${WORK}/err")" 'tool: write out.txt'
test -f "${XDG_CACHE_HOME}/bot-work/opencode/ok/out.txt" || fail "no worktree"
# The agent was told the worker rules, runs as the bot, has no token and
# can't commit.
grep -q '^+- Do not build' "${WORK}/out/changes.patch" || fail "the worker rules were not sent"
grep -q '^+bot+llm@example.org Test Bot no-token hooks no-ssh no-xdg You are an agent that will be helping a human. The following principles are important: skills$' "${WORK}/out/changes.patch" || fail "agent environment: $(grep '^+bot' "${WORK}/out/changes.patch")"
git -C "${WORK}/repo" status --short | grep -q . && fail "the repository itself changed"

# --rm removes the worktree; a model off the broker is refused.
echo "again" | run --task rm --rm - >/dev/null 2>&1
test ! -e "${XDG_CACHE_HOME}/bot-work/opencode/rm" || fail "--rm kept the worktree"
echo x | run --model other/m - >/dev/null 2>&1 && fail "accepted a model off the broker"
echo x | run --task bad/name - >/dev/null 2>&1 && fail "accepted a bad task name"

# A checkout without its overlay fails before worktree creation or agent launch.
mkdir -p "${WORK}/checkout/bin" "${WORK}/checkout/lib"
cp "${BOT_OPENCODE}" "${WORK}/checkout/bin/bot-opencode"
cp "${TESTS}/../lib/process-identity.js" "${WORK}/checkout/lib/"
rc=0
node "${WORK}/checkout/bin/bot-opencode" --repo "${WORK}/repo" --task no-profile "${WORK}/brief" >"${WORK}/no-profile.out" 2>&1 || rc=$?
test "${rc}" -eq 1 || fail "missing profile exit status ${rc}"
expect_has "missing profile" "$(cat "${WORK}/no-profile.out")" 'cannot read the runner profile .*/opencode-runner.json'
test ! -e "${XDG_CACHE_HOME}/bot-work/opencode/no-profile" || fail "missing profile created a worktree"

# The timeout cancels the agent and exits 124.
cat >"${WORK}/timers.cjs" <<JS
const fs = require('fs');
const original = global.setTimeout, clear = global.clearTimeout;
let escalation;
global.setTimeout = (fn, ms, ...args) => {
  const timer = original(fn, ms, ...args);
  if (ms === 5000) {
    escalation = timer;
    fs.appendFileSync('${WORK}/timers.log', 'armed\\n');
  }
  return timer;
};
global.clearTimeout = (timer) => {
  if (timer && timer === escalation) fs.appendFileSync('${WORK}/timers.log', 'cleared\\n');
  return clear(timer);
};
JS
rc=0
echo "hang" | NODE_OPTIONS="${NODE_OPTIONS:-} --require=${WORK}/timers.cjs" run --task hang --timeout 0.02 - >"${WORK}/hang.out" 2>&1 || rc=$?
test "${rc}" -eq 124 || fail "timeout exit status ${rc}"
expect_has "timeout result" "$(cat "${WORK}/hang.out")" '\(timeout\) ----'
test "$(cat "${WORK}/timers.log")" = $'armed\ncleared' || fail "SIGKILL timer was not cleared"
# A descendant in a different session/group must also be reaped on timeout.
rc=0
echo "escape" | run --task escape --timeout 0.02 - >"${WORK}/escape.out" 2>&1 || rc=$?
test "${rc}" -eq 124 || fail "escaped descendant timeout exit status ${rc}"
expect_has "escaped timeout result" "$(cat "${WORK}/escape.out")" '\(timeout\) ----'
node "${TESTS}/bot-opencode-processes.js" assert "${XDG_CACHE_HOME}/bot-work/opencode/escape/escaped.json"
# An agent that dies mid-prompt, and one that isn't installed, fail cleanly.
rc=0
echo "die" | run --task die - >"${WORK}/die.out" 2>&1 || rc=$?
test "${rc}" -eq 1 || fail "dead agent exit status ${rc}"
expect_has "dead agent" "$(cat "${WORK}/die.out")" 'opencode exited'
rc=0
# (node by its full path: it need not be in the stripped PATH, as in CI.)
echo x | PATH=/usr/bin:/bin "$(command -v node)" "${BOT_OPENCODE}" --repo "${WORK}/repo" --model praxis/m --task missing - >"${WORK}/missing.out" 2>&1 || rc=$?
test "${rc}" -eq 1 || fail "missing agent exit status ${rc}"
expect_has "missing agent" "$(cat "${WORK}/missing.out")" 'cannot run opencode'
echo "all tests passed"

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
trap 'rm -rf "${WORK}"' EXIT

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

# The timeout cancels the agent and exits 124.
rc=0
echo "hang" | run --task hang --timeout 0.02 - >"${WORK}/hang.out" 2>&1 || rc=$?
test "${rc}" -eq 124 || fail "timeout exit status ${rc}"
expect_has "timeout result" "$(cat "${WORK}/hang.out")" '\(timeout\) ----'
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

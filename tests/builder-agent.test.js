// Offline tests of the builder agent's PreToolUse guard in
// dotfiles/.claude/agents/builder.md: it must refuse commands that commit,
// push or write to GitHub or the board, and let build and read commands
// through. Run with tests/builder-agent.sh, or
// node --test tests/builder-agent.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const AGENT = path.join(__dirname, "..", "dotfiles", ".claude", "agents", "builder.md");

// The hook's `command: |` block from the frontmatter, dedented.
function guardScript() {
  const lines = fs.readFileSync(AGENT, "utf8").split("\n");
  const start = lines.findIndex((l) => /^\s+command: \|$/.test(l));
  assert.ok(start >= 0, `${AGENT} has no 'command: |' hook`);
  const indent = lines[start].search(/\S/);
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(strip)).join("\n");
}

const SCRIPT = guardScript();
const guard = (command, env = process.env) =>
  spawnSync("/bin/sh", ["-c", SCRIPT], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8", env });

const BLOCKED = [
  "git commit -am fix",
  "cd repo && git -c user.name=x commit -q -m t",
  "git -C src/x push -f origin HEAD:work",
  "git cherry-pick abc123",
  "git rebase -i origin/main",
  "git revert HEAD",
  "git pull --rebase",
  "git commit-tree HEAD^{tree} -m x",
  "git update-ref refs/heads/main abc123",
  "gh pr create --fill",
  "gh issue comment 1 --body hi",
  "gh gist create x.md",
  "gh run rerun 123",
  "gh run delete 123",
  "gh pr merge 38",
  "gh pr view 38 && gh pr merge 38",
  "gh repo fork o/r",
  "gh project item-edit --id X",
  "gh workflow run devspace.yml",
  "gh label create x",
  "gh secret set X",
  "gh variable set X",
  "gh api -XPOST repos/o/r/forks",
  "gh api repos/o/r/issues/1/comments -fbody=x",
  "gh api -X POST repos/o/r/forks",
  "gh api repos/o/r/issues/1/comments -f body=hi",
  "~/src/github/cgwalters-bot/homegit/bin/bot-git commit -m x",
  "bin/bot-land --no-auto",
  "bot-pr fork-pr",
  "bot-board set ITEM Status Done",
  "bot-review-guide post 38",
  "bot-retro",
];
const ALLOWED = [
  "cargo build -p composefs",
  "git diff --stat",
  "git status --short && git log --oneline -3",
  "git -C repo bisect run cargo check",
  "gh api repos/o/r/actions/jobs/1/logs > job.log",
  "gh run view 123 --log-failed",
  "bot-devspace ssh sonnet-eval 'cd src/x && cargo test'",
  "echo gitcommit; rg -n commit src/",
  "bot-cost --since today",
  "cd ~/.cache/bot-work/task1 && git diff",
  "echo ~/.cache/bot-work/task1/log.txt",
  "gh pr view 38 --json files",
  "gh pr checks 38",
  "gh pr diff 38 > pr.diff",
  "gh repo view o/r",
  "gh api repos/o/r/actions/runs --paginate -H 'Accept: x' | tail -f",
];

for (const cmd of BLOCKED) {
  test(`blocks: ${cmd}`, () => {
    const r = guard(cmd);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /not allowed/);
  });
}
test("fails closed without jq", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "builder-agent-test-"));
  try {
    for (const t of ["sed", "grep"]) fs.symlinkSync(execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim(), path.join(bin, t));
    const r = guard("cargo build", { PATH: bin });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /jq is missing/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

for (const cmd of ALLOWED) {
  test(`allows: ${cmd}`, () => assert.equal(guard(cmd).status, 0));
}

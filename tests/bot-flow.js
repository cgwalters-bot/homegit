"use strict";

// Offline subprocess-boundary tests, like bot-land.sh's fake gh.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const config = { bot: { login: "robot" }, forge_org: "forge", devspace: { repo: "runner/jobs" } };
const body = "VERDICT: CHANGES\nREASON: The input is not validated.\nPrivate detailed finding.";

function harness(handler, clock = Date) {
  const calls = [], lines = [];
  const module = { exports: {} };
  const context = {
    module, __dirname: path.resolve(__dirname, "../bin"), process, console: { log: (line) => lines.push(line) },
    SharedArrayBuffer, Int32Array, Atomics, Date: clock,
    require: (name) => {
      if (name === "node:child_process") return { execFileSync: (cmd, args, opts) => {
        calls.push({ cmd, args, ...opts });
        const result = handler(cmd, args, opts);
        return typeof result === "string" ? result : JSON.stringify(result);
      } };
      if (name === "../lib/operator.js") return { load: () => config };
      if (name === "../lib/midstream.js") return { kind: () => "own" };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../bin/bot-flow"), "utf8"), context);
  return { tool: module.exports, calls, lines };
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("strict verdict and bounded single-line reviewer reason", () => {
  const { tool } = harness(() => null);
  assert.equal(tool.reviewHeader(body).verdict, "CHANGES");
  for (const invalid of ["", "VERDICT: APPROVE", body.replace("CHANGES", "MAYBE"), body.replace("The input is not validated.", "x".repeat(201)), body.replace("The input", "The\tinput"), `prefix\n${body}`]) {
    assert.equal(tool.reviewHeader(invalid), null);
  }
});

test("argument validation", () => {
  const { tool } = harness(() => null);
  for (const args of [[], ["collect"], ["land", "--repo", "a/b", "--prs", "1,x"], ["collect", "--reviews", "f", "--poll", "0"], ["collect", "--reviews", "f", "--reviews", "g"]]) assert.throws(() => tool.parse(args));
  assert.equal(tool.parse(["collect", "--reviews", "f"]).reviews, "f");
  for (const [option, maximum] of [["timeout", 330], ["poll", 300]]) {
    for (const value of ["9".repeat(400), String(maximum + 1), "0", "Infinity"]) {
      assert.throws(() => tool.parse(["collect", "--reviews", "f", `--${option}`, value]));
    }
    assert.equal(tool.parse(["collect", "--reviews", "f", `--${option}`, String(maximum)])[option], String(maximum));
  }
});

test("review and fix fetch PR and named comment without printing bodies", () => {
  for (const command of ["review", "fix"]) {
    const h = harness((cmd, args) => {
      if (cmd.endsWith("bot-runs")) return { run_id: 12, url: "https://github.com/runner/jobs/actions/runs/12" };
      if (args[1].includes("issues/comments")) return { issue_url: "https://api.github.com/repos/forge/proj/issues/3", body };
      return { state: "open", head: { ref: "topic", sha: "abc", repo: { full_name: "forge/proj" } }, base: { ref: "main" } };
    });
    const result = h.tool.dispatch({ command, repo: "forge/proj", pr: "3", comment: "9", issue: "https://github.com/forge/tracker/issues/1", item: "PVTI_item" });
    assert.equal(result, "12 https://github.com/runner/jobs/actions/runs/12");
    const dispatch = h.calls.at(-1);
    assert.ok(dispatch.args.includes("--base"));
    assert.ok(dispatch.args.includes("topic"));
    assert.ok(dispatch.input.includes(command === "review" ? "Prefer rustix" : body));
    if (command === "review") assert.ok(dispatch.input.includes("at most 200 characters"));
  }
});

test("collect posts only successful validated reviews and exposes no body", (t) => {
  const dir = scratch(t), file = path.join(dir, "reviews");
  fs.writeFileSync(file, "forge/proj\t3\t12\n");
  for (const variant of ["success", "failure", "empty", "malformed", "wrong-target", "foreign-target", "stale", "validation-failed", "posting-failed"]) {
    const h = harness((cmd, args) => {
      if (cmd.endsWith("bot-runs")) {
        if (variant === "validation-failed") throw new Error("private log");
        return { base: "topic", base_commit: variant === "stale" ? "old" : "abc", outputs: variant === "empty" ? [] : [{ type: "add_comment", target: variant === "foreign-target" ? "other/repo" : null, issue_number: variant === "wrong-target" ? 4 : 3, text: variant === "malformed" ? "no verdict" : body }] };
      }
      if (args.includes("--slurp")) return [[]];
      if (args.includes("POST")) {
        if (variant === "posting-failed") throw new Error("private log");
        return { id: 8 };
      }
      if (args[1].includes("pulls")) return { state: "open", head: { sha: "abc", ref: "topic" } };
      return { status: "completed", conclusion: variant === "failure" ? "failure" : "success", run_attempt: 1 };
    });
    h.tool.collect({ reviews: file }, dir, config);
    assert.equal(h.lines.length, 1);
    assert.ok(!h.lines[0].includes("Private detailed finding"));
    assert.ok(!h.lines[0].includes("private log"));
    assert.ok(h.lines[0].includes(variant === "success" ? "CHANGES The input is not validated." : "none not posted:"));
    const posts = h.calls.filter((c) => c.args.includes("POST"));
    assert.equal(posts.length, ["success", "posting-failed"].includes(variant) ? 1 : 0);
    if (variant === "success") assert.ok(posts[0].input.includes(body.replaceAll("\n", "\\n")));
  }
});

test("collect retries do not duplicate an identical bot comment", (t) => {
  const dir = scratch(t), file = path.join(dir, "reviews");
  fs.writeFileSync(file, "forge/proj\t3\t12\n");
  const posted = `<!-- bot-flow-review:runner/jobs:12:1 -->\n${body}\n\nReview by an LLM, not a human review. Run: https://github.com/runner/jobs/actions/runs/12\nGenerated-by: AI`;
  const h = harness((cmd, args) => {
    if (cmd.endsWith("bot-runs")) return { base: "topic", base_commit: "abc", outputs: [{ type: "add_comment", issue_number: 3, text: body }] };
    if (args.includes("--slurp")) return [[{ user: { login: "robot" }, body: posted }]];
    if (args[1].includes("pulls")) return { state: "open", head: { sha: "abc", ref: "topic" } };
    return { status: "completed", conclusion: "success" };
  });
  h.tool.collect({ reviews: file }, dir, config);
  assert.equal(h.calls.filter((c) => c.args.includes("POST")).length, 0);
  assert.ok(h.lines[0].includes("CHANGES"));
});

test("apply refuses stale head before pushing", () => {
  const h = harness((cmd, args) => {
    if (cmd.endsWith("bot-runs")) return { head: "new", base_commit: "stale", dir: "/unused" };
    if (args[1].includes("pulls")) return { state: "open", head: { sha: "current", ref: "topic", repo: { full_name: "forge/proj" } }, base: { ref: "main" } };
    return { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" };
  });
  assert.throws(() => h.tool.apply({ repo: "forge/proj", pr: "3", run: "12", slug: "fix", message: "message" }, config), /current PR head/);
  assert.ok(!h.calls.some((c) => c.args.includes("push")));
});

test("land refuses unauthorized auto-merge, conflicts, closed and failed checks", () => {
  for (const current of [
    { state: "CLOSED" }, { state: "OPEN" },
    { state: "OPEN", autoMergeRequest: {}, mergeStateStatus: "DIRTY" },
    { state: "OPEN", autoMergeRequest: {}, statusCheckRollup: [{ state: "ERROR" }] },
  ]) {
    const h = harness((cmd, args) => args[0] === "api" ? { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" } : current);
    assert.throws(() => h.tool.land({ repo: "forge/proj", prs: "3" }, config));
    assert.ok(!h.calls.some((c) => c.args.includes("merge") || c.args.includes("update-branch")));
  }
});

test("canonical repository identity prevents transferred-repo writes", () => {
  const h = harness(() => ({ full_name: "stranger/proj", owner: { login: "stranger" } }));
  assert.throws(() => h.tool.land({ repo: "forge/proj", prs: "3" }, config), /refusing writes/);
  assert.equal(h.calls.length, 1);
});

test("stack apply uses explicit head lease and isolated git environment", () => {
  const pr = { state: "open", head: { sha: "old", ref: "topic", repo: { full_name: "forge/proj" } }, base: { ref: "main" } };
  const h = harness((cmd, args) => {
    if (cmd.endsWith("bot-runs")) return { head: "new", base_commit: "old", dir: "/worktree" };
    if (cmd === "gh") return args[1].includes("pulls") ? pr : { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" };
    return "";
  });
  assert.equal(h.tool.apply({ repo: "forge/proj", pr: "3", run: "12", slug: "fix", message: "message" }, config), "forge/proj#3 applied run 12");
  const push = h.calls.at(-1);
  assert.ok(push.args.includes("--force-with-lease=refs/heads/topic:old"));
  assert.equal(push.cwd, "/worktree");
  assert.equal(push.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(push.env.GIT_DIR, undefined);
});

test("squash apply preserves run provenance before lease push", () => {
  const pr = { state: "open", head: { sha: "old", ref: "topic", repo: { full_name: "forge/proj" } }, base: { ref: "release" } };
  const h = harness((cmd, args) => {
    if (cmd.endsWith("bot-runs")) return { head: "new", base_commit: "old", dir: "/worktree" };
    if (cmd === "gh") return args[1].includes("pulls") ? pr : { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" };
    if (args.includes("merge-base")) return "base";
    if (args.includes("log")) return "https://github.com/runner/jobs/actions/runs/12\nhttps://github.com/runner/jobs/actions/runs/11";
    return "";
  });
  h.tool.apply({ repo: "forge/proj", pr: "3", run: "12", slug: "fix", message: "message", mode: "squash" }, config);
  const commit = h.calls.find((c) => c.cmd.endsWith("bot-git") && c.args[0] === "commit");
  assert.ok(commit.args.includes("Agent-run: https://github.com/runner/jobs/actions/runs/11"));
  assert.ok(commit.args.includes("Agent-run: https://github.com/runner/jobs/actions/runs/12"));
  assert.ok(h.calls.some((c) => c.args.includes("+refs/heads/release:refs/remotes/origin/release")));
});

test("apply refuses default-branch heads before applying or pushing", () => {
  for (const defaultBranch of ["main", "trunk"]) {
    const h = harness((cmd, args) => {
      assert.equal(cmd, "gh");
      if (args[1].includes("pulls")) return { state: "open", head: { sha: "old", ref: defaultBranch, repo: { full_name: "forge/proj" } }, base: { ref: "topic" } };
      return { full_name: "forge/proj", owner: { login: "forge" }, default_branch: defaultBranch };
    });
    assert.throws(() => h.tool.apply({ repo: "forge/proj", pr: "3", run: "12", slug: "fix", message: "message" }, config), /not the default branch/);
    assert.equal(h.calls.length, 2);
    assert.ok(!h.calls.some((c) => c.cmd.endsWith("bot-runs") || c.args.includes("push")));
  }
});

test("land leases the inspected head and stops when a replacement wins the race", () => {
  let updated = false;
  const h = harness((cmd, args) => {
    if (args[1]?.includes("pulls")) return { state: "open", head: { sha: "inspected", ref: "topic", repo: { full_name: "forge/proj" } }, base: { ref: "main", repo: { full_name: "forge/proj" } } };
    if (args[0] === "api") return { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" };
    if (args[1] === "view") {
      assert.ok(args.at(-1).includes("headRefOid"));
      return { state: "OPEN", autoMergeRequest: {}, mergeStateStatus: "BEHIND", statusCheckRollup: [], headRefOid: "inspected" };
    }
    assert.equal(args[1], "update-branch");
    assert.equal(args[args.indexOf("--expected-head-sha") + 1], "inspected");
    const replacement = "replacement";
    if (args[args.indexOf("--expected-head-sha") + 1] !== replacement) throw new Error("head mismatch");
    updated = true;
    return "";
  });
  assert.throws(() => h.tool.land({ repo: "forge/proj", prs: "3" }, config), /failed/);
  assert.equal(updated, false);
  assert.equal(h.calls.length, 5);
});

test("land refuses unsafe rebase targets without updating a branch", () => {
  for (const variant of ["default-main", "default-trunk", "foreign-head", "missing-head-repo", "foreign-base", "same-ref", "missing-ref", "changed-head", "new-default", "transferred"]) {
    let repoReads = 0;
    const h = harness((cmd, args) => {
      if (args[1]?.includes("pulls")) {
        return {
          state: "open",
          head: { sha: variant === "changed-head" ? "replacement" : "inspected", ref: variant.startsWith("default-") ? variant.slice(8) : variant === "missing-ref" ? null : "topic", repo: variant === "missing-head-repo" ? null : { full_name: variant === "foreign-head" ? "stranger/proj" : "forge/proj" } },
          base: { ref: variant === "same-ref" ? "topic" : "release", repo: { full_name: variant === "foreign-base" ? "stranger/proj" : "forge/proj" } },
        };
      }
      if (args[0] === "api") {
        repoReads++;
        return { full_name: variant === "transferred" && repoReads === 2 ? "stranger/proj" : "forge/proj", owner: { login: "forge" }, default_branch: variant === "default-trunk" ? "trunk" : variant === "new-default" && repoReads === 2 ? "topic" : "main" };
      }
      assert.equal(args[1], "view");
      return { state: "OPEN", autoMergeRequest: {}, mergeStateStatus: "BEHIND", headRefOid: "inspected" };
    });
    assert.throws(() => h.tool.land({ repo: "forge/proj", prs: "3" }, config), /queue stopped|refusing writes/, variant);
    assert.ok(!h.calls.some((c) => c.args.includes("update-branch")), variant);
    assert.equal(repoReads, 2, variant);
  }
});

test("land rebases a same-repository topic then observes it merged", () => {
  let updated = false;
  const h = harness((cmd, args) => {
    if (args[1]?.includes("pulls")) return { state: "open", head: { sha: "inspected", ref: "topic", repo: { full_name: "forge/proj" } }, base: { ref: "main", repo: { full_name: "forge/proj" } } };
    if (args[0] === "api") return { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" };
    if (args[1] === "view") return updated ? { state: "MERGED" } : { state: "OPEN", autoMergeRequest: {}, mergeStateStatus: "BEHIND", headRefOid: "inspected" };
    assert.equal(args[1], "update-branch");
    assert.equal(args[args.indexOf("--expected-head-sha") + 1], "inspected");
    assert.ok(args.includes("--rebase"));
    updated = true;
    return "";
  });
  assert.equal(h.tool.land({ repo: "forge/proj", prs: "3", poll: "0.001" }, config), "forge/proj#3 MERGED");
  assert.equal(h.calls.filter((c) => c.args.includes("update-branch")).length, 1);
});

test("apply rechecks default-branch metadata before pushing", () => {
  let repoReads = 0;
  const pr = { state: "open", head: { sha: "old", ref: "topic", repo: { full_name: "forge/proj" } }, base: { ref: "main" } };
  const h = harness((cmd, args) => {
    if (cmd.endsWith("bot-runs")) return { head: "new", base_commit: "old", dir: "/worktree" };
    if (cmd === "gh") {
      if (args[1].includes("pulls")) return pr;
      return { full_name: "forge/proj", owner: { login: "forge" }, default_branch: ++repoReads === 1 ? "main" : "topic" };
    }
    return "";
  });
  assert.throws(() => h.tool.apply({ repo: "forge/proj", pr: "3", run: "12", slug: "fix", message: "message" }, config), /became the default branch/);
  assert.equal(repoReads, 2);
  assert.ok(!h.calls.some((c) => c.args.includes("push")));
});

test("collect caps subprocesses by its remaining deadline", (t) => {
  const dir = scratch(t), file = path.join(dir, "fixes");
  fs.writeFileSync(file, "forge/proj\t3\ttopic\t12\n");
  const h = harness(() => ({ status: "completed", conclusion: "success" }));
  h.tool.collect({ fixes: file, timeout: "0.01" }, dir, config);
  assert.ok(h.calls[0].timeout > 0 && h.calls[0].timeout <= 600);
  assert.equal(h.calls[0].killSignal, "SIGKILL");
  assert.throws(() => h.tool.dispatch({ command: "review", repo: "forge/proj", pr: "3" }));
  assert.equal(h.calls.at(-1).timeout, 120000);
});

test("land starts no subprocess after the deadline and restores the subprocess cap", () => {
  let now = 0;
  const h = harness(() => {
    now = 601;
    return { full_name: "forge/proj", owner: { login: "forge" }, default_branch: "main" };
  }, { now: () => now });
  assert.throws(() => h.tool.land({ repo: "forge/proj", prs: "3", timeout: "0.01" }, config), /deadline exceeded/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].timeout, 600);
  assert.throws(() => h.tool.dispatch({ command: "review", repo: "forge/proj", pr: "3" }));
  assert.equal(h.calls.at(-1).timeout, 120000);
});

// Offline fake-Claude completion and resume regressions; no credentials needed.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { promisesContinuation } = require("../lib/claude-completion.js");
const bot = path.resolve(__dirname, "../bin/bot-claude");
const work = fs.mkdtempSync(path.join(os.homedir(), "bot-claude-completion-"));
const state = path.join(work, "state", "bot-claude");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobs = [];
const env = { ...process.env, XDG_STATE_HOME: path.join(work, "state"),
  BOT_CLAUDE_CLAUDE: path.join(work, "claude"), FAKE_WORK: work };

function command(args, code = 0) {
  const r = spawnSync(bot, args, { env, encoding: "utf8" });
  assert.equal(r.status, code, `${args.join(" ")}: ${r.stderr}`);
  return r;
}

function status(job) {
  return JSON.parse(fs.readFileSync(path.join(state, job, "status.json"), "utf8"));
}

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await sleep(50);
  }
}

function start(job, scenario, options = []) {
  const brief = path.join(work, `${job}.brief`);
  fs.writeFileSync(brief, JSON.stringify(scenario));
  jobs.push(job);
  command(["start", "--dir", work, "--job", job, ...options, brief]);
}

function wait(job, code) {
  return command(["wait", "--timeout", "15", job], code);
}

async function main() {
  // This fake can hold a resumed attempt open, or exit without a result.
  fs.writeFileSync(env.BOT_CLAUDE_CLAUDE, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const brief = fs.readFileSync(0, 'utf8');
const root = process.env.FAKE_WORK;
const resume = args.includes('--resume');
fs.writeFileSync(path.join(root, resume ? 'resume-invocation.json' : 'invocation.json'), JSON.stringify({args, brief, cwd: process.cwd()}));
const emit = ev => process.stdout.write(JSON.stringify(ev) + '\\n');
const result = text => emit({type:'result', subtype:'success', is_error:false, result:text, session_id:'session-original', usage:{input_tokens:7}, total_cost_usd:0.5});
if (resume) {
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(root, 'release'))) return;
    clearInterval(timer);
    const mode = fs.readFileSync(path.join(root, 'release'), 'utf8');
    if (mode === 'done') result('All work and verification completed.');
    process.exit(0);
  }, 50);
} else {
  const scenario = JSON.parse(brief);
  emit({type:'system', subtype:'init', session_id:'session-original'});
  for (const ev of scenario.events || []) emit(ev);
  emit({type:'result', subtype: scenario.subtype || 'success', is_error:!!scenario.error,
    result:scenario.text || 'All checks passed.', session_id:'session-original', usage:{input_tokens:7}, total_cost_usd:0.5});
  process.exit(scenario.exit || 0);
}
`);
  fs.chmodSync(env.BOT_CLAUDE_CLAUDE, 0o700);
  const started = (id, tool) => ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: tool });
  const ended = (id, status = "completed", tool) => ({ type: "system", subtype: "task_notification", task_id: id, status, tool_use_id: tool });
  const tool = (id, name = "Bash") => ({ type: "assistant", message: { content: [
    { type: "tool_use", id, name, input: { command: "sleep 1", run_in_background: true } },
  ] } });
  const launch = (toolId, text) => ({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: toolId, content: text },
  ] } });
  const cases = [
    ["promise", { text: "I'll continue with the remaining tests and report back." }, "incomplete", 5],
    ["pending", { events: [started("bg-1")] }, "incomplete", 5],
    ["completed", { events: [started("bg-1"), ended("bg-1")] }, "succeeded", 0],
    ["failed-task", { events: [started("bg-1"), ended("bg-1", "failed")] }, "succeeded", 0],
    ["stopped-task", { events: [started("bg-1"), ended("bg-1", "stopped")] }, "succeeded", 0],
    ["partial", { events: [started("bg-1"), started("bg-2"), ended("bg-1")] }, "incomplete", 5],
    ["tool-pending", { events: [tool("t-1"), launch("t-1", "Command running in background with ID: bg-1")] }, "incomplete", 5],
    ["tool-complete", { events: [tool("t-1"), launch("t-1", "Command running in background with ID: bg-1"), ended("bg-1")] }, "succeeded", 0],
    ["tool-fast", { events: [tool("t-1"), launch("t-1", "Exit code: 0\nAll checks passed.")] }, "succeeded", 0],
    ["tool-commentary", { events: [
      { type: "assistant", message: { content: [
        { type: "text", text: "I'll run the tests now." },
        { type: "tool_use", id: "t-1", name: "Bash", input: { command: "test" } },
      ] } }, launch("t-1", "Exit code: 0\nAll checks passed."),
    ] }, "succeeded", 0],
    ["agent-fast", { events: [tool("t-1", "Agent"),
      { ...launch("t-1", "agentId: agent-1\nAll checks passed."),
        tool_use_result: { status: "completed", agentId: "agent-1" } },
    ] }, "succeeded", 0],
    ["task-output", { events: [started("bg-1"),
      { type: "assistant", message: { content: [{ type: "tool_use", id: "wait-1", name: "TaskOutput", input: { task_id: "bg-1", block: true } }] } },
      { ...launch("wait-1", "Task completed"), tool_use_result: { retrieval_status: "success", task: { task_id: "bg-1", status: "completed" } } },
    ] }, "succeeded", 0],
    ["task-output-pending", { events: [started("bg-1"),
      { type: "assistant", message: { content: [{ type: "tool_use", id: "wait-1", name: "TaskOutput", input: { task_id: "bg-1", block: true } }] } },
      { ...launch("wait-1", "Task still running"), tool_use_result: { retrieval_status: "timeout", task: { task_id: "bg-1", status: "running" } } },
    ] }, "incomplete", 5],
    ["agent-complete", { events: [tool("t-1", "Agent"), launch("t-1", "agentId: agent-1"), started("agent-1", "t-1"), ended("agent-1")] }, "succeeded", 0],
    ["tool-rejected", { events: [tool("t-1"), { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t-1", is_error: true, content: "denied" }] } }] }, "succeeded", 0],
    ["notification-first", { events: [ended("bg-1"), started("bg-1")] }, "succeeded", 0],
    ["earlier-promise", { events: [
      { type: "assistant", message: { content: [{ type: "text", text: "I'll run the tests now." }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "All work and tests completed." }] } },
    ] }, "succeeded", 0],
    ["final-assistant-promise", { events: [{ type: "assistant", message: { content: [{ type: "text", text: "I'll continue testing." }] } }] }, "incomplete", 5],
    ["recommendation", { text: "Tests passed. You can run bot-claude wait for future jobs." }, "succeeded", 0],
    ["quoted", { text: "> I'll continue later.\n\nAll checks passed.\n```text\nI will run more tests.\n```" }, "succeeded", 0],
    ["failed-precedence", { events: [started("bg-1")], text: "I'll continue.", error: true }, "failed", 1],
    ["exit-precedence", { text: "I'll continue.", exit: 7 }, "failed", 1],
    ["subtype-precedence", { text: "I'll continue.", subtype: "error_max_turns" }, "failed", 1],
  ];
  for (const [job, scenario, terminal, code] of cases) {
    start(job, scenario);
    const r = wait(job, code);
    assert.equal(status(job).state, terminal);
    if (code === 5) assert.match(r.stderr, new RegExp(`resume ${job}.*wait ${job}`));
  }
  for (const text of ["I won't continue.", "If you'd like, I can run more tests.", "If you want, I'll run extra checks.", "Example: `I'll continue.` All checks passed.", "The next maintainer will run tests.", "I will not run anything else.", "I will explain the results below."]) {
    assert.equal(promisesContinuation(text), false, text);
  }
  for (const text of ["I’ll now verify CI.", "Next, I will finish the remaining work.", "We will wait for the job and then report back.", "I'm going to continue testing."]) {
    assert.equal(promisesContinuation(text), true, text);
  }

  const options = ["--model", "sonnet", "--timeout", "1", "--max-turns", "9", "--effort", "low", "--permission-mode", "plan",
    "--add-dir", work, "--append-system-prompt", "Extra rules"];
  start("resume-job", { text: "I'll run the remaining tests." }, options);
  wait("resume-job", 5);
  const dir = path.join(state, "resume-job");
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ ...status("resume-job"), actuals: "recorded", signal: "old-signal" }));
  const original = Object.fromEntries(["brief.md", "job.json", "status.json", "stream.jsonl", "stderr.log", "result.md"]
    .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
  const invoke = JSON.parse(fs.readFileSync(path.join(work, "invocation.json"), "utf8"));
  const prompt = invoke.args[invoke.args.indexOf("--append-system-prompt") + 1];
  for (const phrase of ["noninteractive", "foreground", "blocking bot-devspace wait", "gh run watch", "bot-claude wait", "Never use run_in_background", "Extra rules"]) assert.ok(prompt.includes(phrase), phrase);
  await until(() => {
    try { process.kill(status("resume-job").pid, 0); return false; } catch { return true; }
  });
  // A lock rejects a concurrent preparer without changing any evidence.
  fs.writeFileSync(path.join(dir, "resume.lock"), "held");
  assert.match(command(["resume", "resume-job"], 1).stderr, /resume already in progress/);
  fs.unlinkSync(path.join(dir, "resume.lock"));
  const children = [0, 1].map(() => spawn(bot, ["resume", "resume-job"], { env, stdio: "ignore" }));
  const codes = await Promise.all(children.map((child) => new Promise((resolve) => child.on("exit", resolve))));
  assert.equal(codes.filter((c) => c === 0).length, 1, `concurrent resumes: ${codes}`);
  await until(() => fs.existsSync(path.join(work, "resume-invocation.json")));
  const resumed = JSON.parse(fs.readFileSync(path.join(work, "resume-invocation.json"), "utf8"));
  assert.deepEqual(resumed.args.filter((_, i, a) => a[i - 1] !== "--resume" && a[i] !== "--resume"), invoke.args);
  assert.equal(resumed.args[resumed.args.indexOf("--resume") + 1], "session-original");
  assert.equal(resumed.args[0], "-p");
  assert.equal(resumed.cwd, work);
  assert.match(resumed.brief, /Continue the unfinished task/);
  assert.equal(status("resume-job").attempt, 2);
  for (const field of ["result", "tokens", "cost_usd", "is_error", "incomplete_reasons", "actuals", "signal"]) assert.ok(!(field in status("resume-job")), field);
  assert.ok(!fs.existsSync(path.join(dir, "result.md")));
  for (const [name, text] of Object.entries(original)) assert.equal(fs.readFileSync(path.join(dir, "attempts", "1", name), "utf8"), text, name);
  assert.match(command(["resume", "resume-job"], 2).stderr, /still running/);
  fs.writeFileSync(path.join(work, "release"), "no-result");
  wait("resume-job", 1);
  assert.equal(status("resume-job").state, "failed", "previous result must not make a no-result resume succeed");
  assert.ok(!fs.existsSync(path.join(dir, "result.md")));
  await until(() => {
    try { process.kill(status("resume-job").pid, 0); return false; } catch { return true; }
  });
  fs.rmSync(path.join(work, "release"));
  command(["resume", "resume-job"]);
  fs.writeFileSync(path.join(work, "release"), "done");
  wait("resume-job", 0);
  assert.equal(status("resume-job").attempt, 3);
  assert.equal(status("resume-job").result, "All work and verification completed.");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "attempts", "2", "status.json"), "utf8")).state, "failed");
  assert.match(command(["resume", "resume-job"], 2).stderr, /already succeeded|supervisor is still exiting/);
  assert.match(command(["resume", "nosuchjob"], 2).stderr, /no such job/);
  assert.match(command(["resume", "--model", "sonnet", "promise"], 2).stderr, /unknown option/);
  const missing = status("promise");
  delete missing.session_id;
  fs.writeFileSync(path.join(state, "promise", "status.json"), JSON.stringify(missing));
  assert.match(command(["resume", "promise"], 2).stderr, /no Claude session/);
  console.log("completion and resume regressions passed");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const job of jobs) spawnSync(bot, ["kill", job], { env, stdio: "ignore" });
  fs.rmSync(work, { recursive: true, force: true });
});

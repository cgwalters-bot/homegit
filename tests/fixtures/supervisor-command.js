// Nonexecutable fake poller/Claude CLI, invoked via Node; no external I/O.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const [role, ...args] = process.argv.slice(2);
const dir = process.env.FAKE_SUPERVISOR_DIR;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
const log = path.join(dir, "calls.jsonl");
const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const cmd = role === "poll" ? "poll" : args[0];
const count = previous.filter((c) => c.cmd === cmd).length;
const call = { cmd, args, at: Date.now(), token: process.env.GH_TOKEN };
if (cmd === "start") call.brief = fs.readFileSync(0, "utf8");
fs.appendFileSync(log, `${JSON.stringify(call)}\n`);

function finish(code, out = "", err = "", delay = 0) {
  setTimeout(() => {
    if (cmd === "wait" && !scenario.waits?.[count]?.nonterminal) {
      const state = { 0: "succeeded", 1: "failed", 3: "timeout", 4: "lost", 5: "incomplete" }[code];
      if (state) fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ job: args.at(-1), state }));
    }
    fs.appendFileSync(log, `${JSON.stringify({ cmd: `${cmd}-end`, at: Date.now() })}\n`);
    process.stdout.write(out);
    process.stderr.write(err);
    process.exitCode = code;
  }, delay);
}

if (cmd === "poll") {
  const p = scenario.polls?.[count] || { out: "TIMEOUT: no news in 0 min; run it again\nObserved: nothing\n" };
  finish(p.code || 0, p.out || "", p.err || "", p.delay || 0);
} else if (cmd === "start") {
  const job = args[args.indexOf("--job") + 1];
  if (scenario.startCode && !scenario.startCreates) finish(scenario.startCode, "", "start failed");
  else {
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ job, state: "running" }));
    finish(scenario.startCode || 0, scenario.badId ? "wrong-id\n" : `${job}\n`, "", scenario.startDelay || 0);
  }
} else if (cmd === "status") {
  const file = path.join(dir, "job.json");
  if (scenario.statusCode) finish(scenario.statusCode, "", "status broken");
  else if (fs.existsSync(file)) finish(0, fs.readFileSync(file, "utf8"));
  else finish(2, "", `no such job: ${args.at(-1)}`);
} else if (cmd === "wait") {
  const w = scenario.waits?.[count] || { code: 0 };
  finish(w.code, "completed batch\n", w.code ? "wait failed" : "", w.delay || 0);
} else {
  finish(99, "", `unexpected command ${cmd}`);
}

// Check the escaped sleeper, and safely clean it up even on regression failure.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const [mode, file] = process.argv.slice(2);

function current(identity) {
  try {
    const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] !== "Z" && fields[19] === identity.starttime &&
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === identity.boot_id;
  } catch { return false; }
}

async function main() {
  if (mode === "cleanup" && !fs.existsSync(file)) return;
  const { agent, sleeper } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (mode === "cleanup") {
    if (current(sleeper)) {
      try { process.kill(sleeper.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    return;
  }
  assert.notEqual(sleeper.session, agent.session, "fixture did not escape the session");
  assert.notEqual(sleeper.pgrp, agent.pgrp, "fixture did not escape the group");
  const deadline = Date.now() + 2000;
  while (current(sleeper) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!current(sleeper), "escaped sleeper survived opencode cleanup");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

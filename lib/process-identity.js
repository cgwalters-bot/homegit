"use strict";

const fs = require("node:fs");

// comm may contain spaces and parentheses; fields after its final ')' have
// fixed offsets. Keep starttime as text (it need not fit a JS integer).
function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields.length < 20 || !/^\d+$/.test(fields[19])) return null;
    return { pid, starttime: fields[19], pgrp: Number(fields[2]), session: Number(fields[3]),
      boot_id: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
  } catch {
    return null;
  }
}

function sameIdentity(a, b) {
  return a && b && ["pid", "starttime", "pgrp", "session", "boot_id"].every((k) => a[k] === b[k]);
}

// Signal the original group first, then find token-bearing descendants even
// if they double-forked or changed session/group. Recheck identity after
// reading environ so a recycled PID cannot authorize an individual signal.
function signalJob(identity, tokenVar, token, signal) {
  if (identity && identity.pid === identity.pgrp && identity.pid === identity.session &&
      sameIdentity(identity, processIdentity(identity.pid))) {
    try { process.kill(-identity.pgrp, signal); } catch { /* Already gone. */ }
  }
  if (!token) return;
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const member = processIdentity(Number(entry));
      if (!member) continue;
      try {
        const env = fs.readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
        if (env.includes(`${tokenVar}=${token}`) && sameIdentity(member, processIdentity(member.pid))) {
          process.kill(member.pid, signal);
        }
      } catch { /* A descendant may exit during the scan. */ }
    }
  } catch { /* /proc unavailable: do not signal unverified PIDs. */ }
}

module.exports = { processIdentity, sameIdentity, signalJob };

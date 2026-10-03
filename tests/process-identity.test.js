"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { processIdentity, signalJob } = require("../lib/process-identity");

function stat({ starttime = "123", pgrp = 42, session = 42 } = {}) {
  const fields = Array(20).fill("0");
  fields[0] = "S";
  fields[2] = String(pgrp);
  fields[3] = String(session);
  fields[19] = starttime;
  return `42 (odd ) ( worker) ${fields.join(" ")}\n`;
}

test("token scan rejects stale identities and unrelated processes", (t) => {
  const original = fs.readFileSync;
  let scenario, reads;
  const signals = [];
  t.mock.method(fs, "readdirSync", () => ["self", "42"]);
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === "/proc/42/stat") {
      reads++;
      if (reads > 1 && scenario.gone) throw new Error("exited");
      return stat(reads > 1 ? scenario.changed : {});
    }
    if (file === "/proc/42/environ") return `OTHER=1\0JOB=${scenario.token}\0`;
    if (file === "/proc/sys/kernel/random/boot_id") return reads > 1 && scenario.boot ? "new-boot" : "boot";
    return original(file, ...args);
  });
  t.mock.method(process, "kill", (pid, signal) => signals.push([pid, signal]));
  for (scenario of [
    { token: "secret", expected: [[42, "SIGKILL"]] },
    { token: "secret-suffix", expected: [] },
    { token: "wrong", expected: [] },
    { token: "secret", changed: { starttime: "124" }, expected: [] },
    { token: "secret", changed: { pgrp: 43 }, expected: [] },
    { token: "secret", changed: { session: 43 }, expected: [] },
    { token: "secret", boot: true, expected: [] },
    { token: "secret", gone: true, expected: [] },
  ]) {
    reads = 0;
    signals.length = 0;
    signalJob(null, "JOB", "secret", "SIGKILL");
    assert.deepEqual(signals, scenario.expected, JSON.stringify(scenario));
  }
});

test("group signaling requires the recorded leader identity", (t) => {
  t.mock.method(fs, "readFileSync", (file) => file.endsWith("/stat") ? stat() : "boot");
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => signals.push([pid, signal]));
  const identity = processIdentity(42);
  assert.equal(identity.starttime, "123", "comm parentheses corrupted stat parsing");
  for (const key of ["pid", "starttime", "pgrp", "session", "boot_id"]) {
    signalJob({ ...identity, [key]: "stale" }, "JOB", "", "SIGTERM");
  }
  assert.deepEqual(signals, []);
  signalJob(identity, "JOB", "", "SIGTERM");
  assert.deepEqual(signals, [[-42, "SIGTERM"]]);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cgroupOf, ensureToolbox, scopeName, within } = require("../lib/toolbox");

// Scratch must be under HOME, never in the checkout or /tmp.
const WORK = fs.mkdtempSync(path.join(os.homedir(), "toolbox-cgroup-test-"));
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));
const UNIT = "/user.slice/user-1000.slice/user@1000.service/app.slice/bot-supervisor.service";
const SCOPE = `/user.slice/user-1000.slice/user@1000.service/app.slice/${scopeName("box")}`;
const SELF = 100;
const CONMON = 200;
// A fake podman and systemd-run: STATE.json holds whether the container
// runs; 'start' sets it, with conmon in STATE.startCgroup.
const FAKE = path.join(WORK, "fake.js");
fs.writeFileSync(FAKE, `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [dir, role, ...args] = process.argv.slice(2);
const file = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(file, "utf8"));
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify([role, ...args]) + "\\n");
if (role === "systemd-run") {
  if (state.race) fs.writeFileSync(file, JSON.stringify({ ...state, running: true }));
  if (state.scopeFails) { process.stderr.write("Unit already exists\\n"); process.exit(1); }
  const i = args.indexOf("--");
  require("node:child_process").execFileSync(args[i + 1], args.slice(i + 2), { stdio: "inherit" });
} else if (args[0] === "container") {
  if (state.missing) { process.stderr.write("no such container\\n"); process.exit(125); }
  process.stdout.write(state.running ? "true ${CONMON}\\n" : "false 0\\n");
} else if (args[0] === "start" && state.startCgroup) {
  state.running = true;
  fs.writeFileSync(path.join(dir, "proc", "${CONMON}", "cgroup"), "0::" + state.startCgroup + "\\n");
  fs.writeFileSync(file, JSON.stringify(state));
}
`);
let number = 0;

function setup(state, conmonCgroup) {
  const dir = path.join(WORK, String(number++));
  for (const pid of [SELF, CONMON]) fs.mkdirSync(path.join(dir, "proc", String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, "proc", String(SELF), "cgroup"), `0::${UNIT}\n`);
  if (conmonCgroup) fs.writeFileSync(path.join(dir, "proc", String(CONMON), "cgroup"), `0::${conmonCgroup}\n`);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const opts = { podman: [process.execPath, FAKE, dir, "podman"], systemdRun: [process.execPath, FAKE, dir, "systemd-run"],
    proc: path.join(dir, "proc"), self: SELF };
  const calls = () => fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { opts, calls };
}

test("within compares whole path components", () => {
  assert.ok(within("/a/b", "/a/b"));
  assert.ok(within("/a/b/c", "/a/b"));
  assert.ok(!within("/a/bc", "/a/b"));
  assert.ok(!within("/a", "/a/b"));
});

test("cgroupOf reads the cgroup v2 line only", () => {
  const { opts } = setup({});
  assert.equal(cgroupOf(SELF, opts.proc), UNIT);
  fs.writeFileSync(path.join(opts.proc, String(SELF), "cgroup"), "1:name=systemd:/x\n");
  assert.equal(cgroupOf(SELF, opts.proc), null);
  assert.equal(cgroupOf(999, opts.proc), null);
});

for (const [name, state, conmon, error, started] of [
  ["a stopped container starts in its own scope", { startCgroup: SCOPE }, null, null, true],
  ["a container started by a login session is left alone", { running: true }, "/user.slice/user-1000.slice/session-2.scope", null, false],
  ["a container in the unit's own cgroup is refused", { running: true }, UNIT, /is in this process's cgroup .*bot-supervisor\.service.*podman stop box/, false],
  ["a container in a child of the unit's cgroup is refused", { running: true }, `${UNIT}/sub`, /is in this process's cgroup/, false],
  ["a start that leaves conmon in the unit is refused", { startCgroup: UNIT }, null, /is in this process's cgroup/, true],
  ["a missing container is an error", { missing: true }, null, /no toolbox container box: no such container/, false],
  ["a failed start is an error", { scopeFails: true }, null, /cannot start toolbox container box in bot-toolbox-box\.scope: Unit already exists/, true],
]) test(name, () => {
  const c = setup(state, conmon);
  if (error) assert.throws(() => ensureToolbox("box", c.opts), error);
  else ensureToolbox("box", c.opts);
  const run = c.calls().find((x) => x[0] === "systemd-run");
  assert.equal(Boolean(run), started);
  if (run) assert.deepEqual(run.slice(1, 6), ["--user", "--scope", "--quiet", "--collect", "--unit=bot-toolbox-box.scope"]);
  if (run) assert.deepEqual(run.slice(-2), ["start", "box"]);
});

test("a racing start by the other unit is accepted once the container runs", () => {
  // The other unit holds the scope name, and its start lands meanwhile.
  const c = setup({ scopeFails: true, race: true }, SCOPE);
  ensureToolbox("box", c.opts);
  assert.ok(c.calls().some((x) => x[0] === "systemd-run"));
});

test("an invalid container name is refused before podman runs", () => {
  assert.throws(() => ensureToolbox("../x", {}), /invalid toolbox container name/);
});

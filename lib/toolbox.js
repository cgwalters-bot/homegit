// Run from a systemd unit (INVOCATION_ID is set), 'podman start' leaves
// the container's conmon in the caller's cgroup rather than in a scope
// of its own, and a conmon that is told to stop passes the signal on to
// the container. Started by 'toolbox run' from bot-supervisor.service
// or bot-sweep.service (KillMode=control-group), stopping that unit
// kills the container, and the coordinator session and every job in it.
// So bot-supervisor and bot-sweep start it here first, in a transient
// scope of its own, which is then where conmon stays, and refuse to go
// on while its conmon is still in their cgroup (it was started by an
// earlier copy of the unit, say).
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

// podman's container name syntax; it is also valid in a unit name.
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function scopeName(box) {
  return `bot-toolbox-${box}.scope`;
}

// cgroupOf(PID, PROC): the cgroup v2 path of a process, or null if it
// can't be read or there is none (cgroup v1).
function cgroupOf(pid, proc = "/proc") {
  let text;
  try {
    text = fs.readFileSync(`${proc}/${pid}/cgroup`, "utf8");
  } catch {
    return null;
  }
  return /^0::(\/\S*)$/m.exec(text)?.[1] ?? null;
}

// within(CGROUP, ANCESTOR): whether CGROUP is ANCESTOR or below it.
function within(cgroup, ancestor) {
  return cgroup === ancestor || cgroup.startsWith(`${ancestor}/`);
}

function inspect(box, podman) {
  const r = spawnSync(podman[0], [...podman.slice(1), "container", "inspect", "--format",
    "{{.State.Running}} {{.State.ConmonPid}}", box], { encoding: "utf8" });
  if (r.error) throw new Error(`cannot run ${podman[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`no toolbox container ${box}: ${r.stderr.trim()}`);
  const [running, conmon] = r.stdout.trim().split(/\s+/);
  return { running: running === "true", conmon: Number(conmon) };
}

// ensureToolbox(BOX, OPTS): starts the container BOX in its own scope
// unless it runs, then checks that its conmon is outside this process's
// cgroup. Throws an error saying what to do otherwise. OPTS (for tests):
// podman and systemdRun argv prefixes, proc root, self pid.
function ensureToolbox(box, opts = {}) {
  const { podman = ["podman"], systemdRun = ["systemd-run"], proc = "/proc", self = process.pid } = opts;
  if (!NAME_RE.test(box)) throw new Error(`invalid toolbox container name: ${box}`);
  let state = inspect(box, podman);
  if (!state.running) {
    // A concurrent start by the other unit fails here on the existing
    // scope name; the inspect after it decides.
    const r = spawnSync(systemdRun[0], [...systemdRun.slice(1), "--user", "--scope", "--quiet", "--collect",
      `--unit=${scopeName(box)}`, "--", ...podman, "start", box], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    if (r.error) throw new Error(`cannot run ${systemdRun[0]}: ${r.error.message}`);
    state = inspect(box, podman);
    if (!state.running) throw new Error(`cannot start toolbox container ${box} in ${scopeName(box)}: ${(r.stderr || "").trim()}`);
  }
  const mine = cgroupOf(self, proc);
  const theirs = cgroupOf(state.conmon, proc);
  // The root cgroup (no systemd) or an unreadable one: nothing to own.
  if (!mine || mine === "/" || !theirs || !within(theirs, mine)) return;
  throw new Error(`toolbox container ${box} (conmon ${state.conmon}) is in this process's cgroup ${theirs}, ` +
    "so stopping this unit would kill it and every session and job in it. Stop the container from outside it " +
    `when nothing runs there ('podman stop ${box}'), and start this unit again: it starts the container in ${scopeName(box)}.`);
}

module.exports = { cgroupOf, ensureToolbox, scopeName, within };

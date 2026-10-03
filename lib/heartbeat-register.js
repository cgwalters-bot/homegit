// Append a claimed item to the last local heartbeat input. Publishing owns
// persistence; never reconstruct input from the public (agent_ids-free) JSON.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeItem } = require("./capacity.js");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const LOCK_WAIT_SECONDS = 10;

function stateDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "bot-heartbeat");
}

function register(item, name, { heartbeat = path.join(__dirname, "..", "bin", "bot-heartbeat"), lockWaitSeconds = LOCK_WAIT_SECONDS } = {}) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    // Kernel-managed flock releases even on a crash. Keep the lock file:
    // unlinking it could let a waiter and a new caller lock different inodes.
    execFileSync("flock", ["--exclusive", "--timeout", String(lockWaitSeconds), "--conflict-exit-code", "75",
      path.join(stateDir(), "registration.lock"), process.execPath, __filename, "--locked", name, heartbeat],
    { input: JSON.stringify(item), encoding: "utf8", stdio: ["pipe", "ignore", "inherit"] });
    return true;
  } catch (e) {
    const why = e.status === 75 ? `timed out waiting ${lockWaitSeconds}s for the heartbeat registration lock` : e.message;
    process.stderr.write(`warning: heartbeat registration for ${item.id} failed: ${why}; publish the workers with bot-heartbeat publish\n`);
    return false;
  }
}

function registerLocked(item, name, heartbeat) {
  const file = path.join(stateDir(), "last-publish.json");
  const last = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObject(last) || !isObject(last.input) || !isObject(last.published) || !(last.session === null || typeof last.session === "string")) {
    throw new Error(`${file} is malformed; publish a heartbeat first`);
  }
  const { validate } = require("../bin/bot-heartbeat");
  const now = Date.now();
  validate(last.input, now);
  const url = item.content && item.content.url;
  if (!normalizeItem(url)) throw new Error(`${item.id} has no issue or PR URL`);
  const input = structuredClone(last.input);
  if (!input.workers.some((w) => normalizeItem(w.item_url) === normalizeItem(url))) {
    input.workers.push({ name, item_url: url, started_at: new Date(now).toISOString(), status: "starting" });
  }
  // As with heartbeat refresh, move a sleeping coordinator's wake time
  // with updated_at, keeping its interval and session intact.
  const delta = now - Date.parse(last.input.updated_at || last.published.updated_at);
  input.updated_at = new Date(now).toISOString();
  if (input.coordinator.next_wake_at) {
    input.coordinator.next_wake_at = new Date(Date.parse(input.coordinator.next_wake_at) + delta).toISOString();
  }
  validate(input, now);
  const env = { ...process.env };
  if (last.session === null) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = last.session;
  // Preserve the saved owner's refresh eligibility, including a null
  // session. Do not silently transfer ownership to the invoking session.
  execFileSync(heartbeat, ["publish", "--require-saved-state"], { input: JSON.stringify(input), encoding: "utf8", env, stdio: ["pipe", "ignore", "inherit"] });
}

module.exports = { register };

if (require.main === module) {
  try {
    if (process.argv[2] === "--locked") {
      registerLocked(JSON.parse(fs.readFileSync(0, "utf8")), process.argv[3], process.argv[4]);
      process.exit(0);
    }
    const [board, id, name, heartbeat] = process.argv.slice(2);
    const items = JSON.parse(execFileSync(board, ["list", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`${id} is not on the board`);
    register(item, name, { heartbeat });
  } catch (e) {
    process.stderr.write(`warning: heartbeat registration failed: ${e.message}\n`);
    process.exitCode = 1;
  }
}

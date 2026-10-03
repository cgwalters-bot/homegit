// Add or remove workers in the last local heartbeat input. Publishing owns
// persistence; never reconstruct input from the public (agent_ids-free) JSON.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeItem } = require("./capacity.js");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const LOCK_WAIT_SECONDS = 60;
const ITEM_QUERY = `query($id: ID!) { node(id: $id) { ... on ProjectV2Item {
  id content { ... on Issue { url } ... on PullRequest { url } } } } }`;

function stateDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "bot-heartbeat");
}

const DEFAULT_HEARTBEAT = path.join(__dirname, "..", "bin", "bot-heartbeat");

// Run the locked mode (--locked to add a worker, --unlock to drop one) of
// this file under the registration flock, with INPUT on stdin. True on
// success; otherwise warns about WHAT and returns false.
function underLock(mode, name, heartbeat, lockWaitSeconds, input, what) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    // Kernel-managed flock releases even on a crash. Keep the lock file:
    // unlinking it could let a waiter and a new caller lock different inodes.
    execFileSync("flock", ["--exclusive", "--timeout", String(lockWaitSeconds), "--conflict-exit-code", "75",
      path.join(stateDir(), "registration.lock"), process.execPath, __filename, mode, name, heartbeat],
    { input, encoding: "utf8", stdio: ["pipe", "ignore", "inherit"] });
    return true;
  } catch (e) {
    const why = e.status === 75 ? `timed out waiting ${lockWaitSeconds}s for the heartbeat registration lock` : e.message;
    process.stderr.write(`warning: ${what} failed: ${why}; publish the workers with bot-heartbeat publish\n`);
    return false;
  }
}

// METADATA is the optional public worker fields (location, engine, model,
// last_activity_at) that bot-heartbeat validates.
function register(item, name, { heartbeat = DEFAULT_HEARTBEAT, lockWaitSeconds = LOCK_WAIT_SECONDS, ...metadata } = {}) {
  return underLock("--locked", name, heartbeat, lockWaitSeconds, JSON.stringify({ item, metadata }), `heartbeat registration for ${item.id}`);
}

// Drop the worker NAME from the last local heartbeat input, as a worker
// that ended must (a missing one is fine). Same rules as register.
function deregister(name, { heartbeat = DEFAULT_HEARTBEAT, lockWaitSeconds = LOCK_WAIT_SECONDS } = {}) {
  return underLock("--unlock", name, heartbeat, lockWaitSeconds, "", `heartbeat deregistration of ${name}`);
}

// The last publication's saved state, checked.
function loadLast() {
  const file = path.join(stateDir(), "last-publish.json");
  const last = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObject(last) || !isObject(last.input) || !isObject(last.published) || !(last.session === null || typeof last.session === "string")) {
    throw new Error(`${file} is malformed; publish a heartbeat first`);
  }
  return last;
}

// Publish INPUT (derived from LAST) as the saved owner: a sleeping
// coordinator's wake time moves with updated_at, its interval and session
// stay, and a null session is not silently replaced by the invoker's.
function republishLast(last, input, now, heartbeat) {
  const delta = now - Date.parse(last.input.updated_at || last.published.updated_at);
  input.updated_at = new Date(now).toISOString();
  if (input.coordinator.next_wake_at) {
    input.coordinator.next_wake_at = new Date(Date.parse(input.coordinator.next_wake_at) + delta).toISOString();
  }
  const { validate } = require("../bin/bot-heartbeat");
  validate(input, now);
  const env = { ...process.env };
  if (last.session === null) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = last.session;
  // The helper already holds registration.lock across reading and saving.
  // This internal flag prevents the publisher from acquiring it recursively.
  execFileSync(heartbeat, ["publish", "--locked-state", "--require-saved-state"], { input: JSON.stringify(input), encoding: "utf8", env, stdio: ["pipe", "ignore", "inherit"] });
}

function unregisterLocked(name, heartbeat) {
  let last;
  try {
    last = loadLast();
  } catch (e) {
    // Nothing was ever published, so there is nothing to drop.
    if (e.code === "ENOENT") return;
    throw e;
  }
  const { validate, now: heartbeatNow } = require("../bin/bot-heartbeat");
  const now = heartbeatNow();
  validate(last.input, now);
  if (!last.input.workers.some((w) => w.name === name)) return;
  const input = structuredClone(last.input);
  input.workers = input.workers.filter((w) => w.name !== name);
  republishLast(last, input, now, heartbeat);
}

function registerLocked(item, name, heartbeat, metadata) {
  const last = loadLast();
  const { validate, now: heartbeatNow } = require("../bin/bot-heartbeat");
  const now = heartbeatNow();
  validate(last.input, now);
  const url = item.content && item.content.url;
  if (!normalizeItem(url)) throw new Error(`${item.id} has no issue or PR URL`);
  const input = structuredClone(last.input);
  const key = normalizeItem(url);
  // The worker name identifies an execution, not its item. A retry of
  // that execution preserves its activity and private metadata; a new
  // execution replaces stale identities and starts with fresh metadata.
  if (input.workers.some((w) => w.name === name && normalizeItem(w.item_url) === key)) return;
  input.workers = input.workers.filter((w) => normalizeItem(w.item_url) !== key);
  input.workers.push({ ...metadata, name, item_url: url, started_at: new Date(now).toISOString(), status: "starting" });
  republishLast(last, input, now, heartbeat);
}

module.exports = { register, deregister };

if (require.main === module) {
  try {
    if (process.argv[2] === "--locked") {
      const { item, metadata } = JSON.parse(fs.readFileSync(0, "utf8"));
      registerLocked(item, process.argv[3], process.argv[4], metadata);
      process.exit(0);
    }
    if (process.argv[2] === "--unlock") {
      unregisterLocked(process.argv[3], process.argv[4]);
      process.exit(0);
    }
    // Keep the board argument for existing callers; a known item needs only
    // one node lookup, rather than a listing of the whole board.
    const [_board, id, name, heartbeat, metadata = "{}"] = process.argv.slice(2);
    if (typeof id !== "string" || !/^PVTI_[A-Za-z0-9_-]+$/.test(id)) throw new Error("expected a board item id (PVTI_...)");
    const item = JSON.parse(execFileSync("gh", ["api", "graphql", "-f", `query=${ITEM_QUERY}`, "-f", `id=${id}`, "--jq", ".data.node"], { encoding: "utf8" }));
    if (!isObject(item) || item.id !== id) throw new Error(`${id} was not returned by the board item lookup`);
    if (!isObject(item.content) || typeof item.content.url !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/[1-9][0-9]*$/.test(item.content.url)) {
      throw new Error(`${id} has no issue or PR URL`);
    }
    if (!register(item, name, { ...JSON.parse(metadata), heartbeat })) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`warning: heartbeat registration failed: ${e.message}\n`);
    process.exitCode = 1;
  }
}

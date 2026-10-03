#!/usr/bin/env node
// Manage isolated worktrees for concurrent bot workers. This uses Git's
// worktree bookkeeping rather than copying clones, and deliberately accepts
// only one safe path component as a worker name.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CACHE_DIR = "bot-work";
const DESTINATION_FILE = ".destination.json";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage: bot-work worktree add REPO_DIR NAME [--base REF] [--dir DIR]\n       bot-work worktree rm NAME [--force] [--dir DIR]\n\nCreate worktrees under \${XDG_CACHE_HOME:-~/.cache}/bot-work/NAME/REPO on\nbranch bot/NAME, or register a custom --dir destination there. Removing a\nname refuses tracked or untracked changes unless --force is given; --dir\nlimits removal to that registered destination.\n`);
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.error) fail(`running git failed: ${result.error.message}`);
  return result;
}

function gitOutput(args, description) {
  const result = git(args);
  if (result.status !== 0) fail(`${description}: ${result.stderr.trim() || "git failed"}`);
  return result.stdout.trim();
}

function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || path.join(process.env.HOME || os.homedir(), ".cache");
  // Git records worktrees by real path, so resolve symlinks above the cache
  // directory (a symlinked ~/.cache or /home); the directory itself is still
  // required to be a real one.
  let resolved = path.resolve(base);
  try {
    resolved = fs.realpathSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return path.join(resolved, CACHE_DIR);
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function safeName(name) {
  if (!NAME_RE.test(name) || name === "." || name === "..") {
    fail(`invalid worktree name '${name}' (use letters, digits, '.', '_' or '-', beginning with a letter or digit)`);
  }
}

function ensureDirectory(directory, description) {
  const stat = lstatOrNull(directory);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${description} is not a regular directory: ${directory}`);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function ensureSafeParent(root, name) {
  ensureDirectory(root, "worktree cache directory");
  const worker = path.join(root, name);
  const stat = lstatOrNull(worker);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`worktree directory is not a regular directory: ${worker}`);
  } else {
    fs.mkdirSync(worker, { mode: 0o700 });
  }
  return worker;
}

function add(repoDir, name, base, destination) {
  safeName(name);
  const supplied = path.resolve(repoDir);
  let suppliedStat;
  try {
    suppliedStat = fs.lstatSync(supplied);
  } catch {
    fail(`repository directory does not exist: ${repoDir}`);
  }
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()) fail(`repository directory is not a regular directory: ${repoDir}`);

  const repo = gitOutput(["-C", supplied, "rev-parse", "--show-toplevel"], `not a Git repository: ${repoDir}`);
  const repoName = path.basename(repo);
  if (repoName === "." || repoName === ".." || !repoName) fail(`cannot derive a safe repository name from ${repo}`);
  const commit = gitOutput(["-C", repo, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], `invalid base ref '${base}'`);

  const branch = `bot/${name}`;
  const refCheck = git(["check-ref-format", "--branch", branch]);
  if (refCheck.status !== 0) fail(`worktree name '${name}' does not make a valid branch name: ${branch}`);
  const worker = ensureSafeParent(cacheRoot(), name);
  const entry = path.join(worker, repoName);
  if (lstatOrNull(entry)) fail(`worktree already exists or target is unsafe: ${entry}`);
  let target = entry;
  if (destination) {
    const absolute = path.resolve(destination);
    ensureDirectory(path.dirname(absolute), "worktree destination parent");
    target = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    if (target === entry) destination = undefined;
    else if (target === cacheRoot() || target.startsWith(`${cacheRoot()}${path.sep}`)) {
      fail("custom worktree destination must be outside the worktree cache");
    }
    if (lstatOrNull(target)) fail(`worktree already exists or target is unsafe: ${target}`);
  }
  const existing = git(["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.status === 0) fail(`branch already exists: ${branch}`);
  if (existing.status !== 1) fail(`checking branch ${branch} failed`);

  if (destination) fs.mkdirSync(entry, { mode: 0o700 });
  const result = git(["-C", repo, "worktree", "add", "-b", branch, target, commit], { stdio: "inherit" });
  if (result.status !== 0) {
    if (destination) fs.rmdirSync(entry);
    process.exit(result.status || 1);
  }
  if (destination) {
    const commonDir = assertOwnedWorktree(target, name);
    try {
      fs.writeFileSync(path.join(entry, DESTINATION_FILE), JSON.stringify({ path: target, common_dir: commonDir }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      const cleanup = git(["-C", repo, "worktree", "remove", "--force", target]);
      if (cleanup.status === 0 && fs.readdirSync(entry).length === 0) fs.rmdirSync(entry);
      fail(`registering destination ${target} failed: ${error.message}${cleanup.status === 0 ? "" : "; removing the worktree also failed"}`);
    }
  }
  process.stdout.write(`${target}\n`);
}

function ownedWorktrees(worker) {
  const stat = lstatOrNull(worker);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`worktree directory is not a regular directory: ${worker}`);
  return fs.readdirSync(worker, { withFileTypes: true }).map((entry) => {
    const directory = path.join(worker, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`refusing unsafe worktree entry: ${directory}`);
    // Worktree files are never manager metadata. Git ownership is checked
    // before removal; a tracked or untracked .destination.json is ordinary
    // content when this entry has its own Git directory pointer.
    if (lstatOrNull(path.join(directory, ".git"))) return { worktree: directory };
    const record = path.join(directory, DESTINATION_FILE);
    const recordStat = lstatOrNull(record);
    if (!recordStat) return { worktree: directory };
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || fs.readdirSync(directory).length !== 1) {
      fail(`refusing unsafe destination registration: ${directory}`);
    }
    let registration;
    try {
      registration = JSON.parse(fs.readFileSync(record, "utf8"));
    } catch {
      fail(`invalid destination registration: ${record}`);
    }
    if (!registration || typeof registration.path !== "string" || !path.isAbsolute(registration.path)
        || typeof registration.common_dir !== "string" || !path.isAbsolute(registration.common_dir)) {
      fail(`invalid destination registration: ${record}`);
    }
    const targetStat = lstatOrNull(registration.path);
    // Deleted by hand: nothing left to inspect, only the registration and
    // Git's record of the worktree to clean up (remove() prunes it).
    if (!targetStat) return { worktree: registration.path, commonDir: registration.common_dir, registrationDir: directory, missing: true };
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      fail(`registered destination is not a regular directory: ${registration.path}`);
    }
    return { worktree: registration.path, commonDir: registration.common_dir, registrationDir: directory };
  });
}

function assertOwnedWorktree(worktree, name) {
  const commonDir = gitOutput(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], `cannot locate Git directory for ${worktree}`);
  const registered = gitOutput(["--git-dir", commonDir, "worktree", "list", "--porcelain", "-z"], `cannot list worktrees for ${worktree}`)
    .split("\0")
    .includes(`worktree ${worktree}`);
  if (!registered) fail(`refusing unregistered worktree entry: ${worktree}`);
  const branch = gitOutput(["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"], `worktree is detached or has no branch: ${worktree}`);
  if (branch !== `bot/${name}`) fail(`refusing worktree on branch '${branch}', not bot/${name}: ${worktree}`);
  return commonDir;
}

function remove(name, force, destination) {
  safeName(name);
  const root = cacheRoot();
  const rootStat = lstatOrNull(root);
  if (!rootStat) {
    if (destination) fail(`destination is not registered to ${name}: ${destination}`);
    return;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`worktree cache directory is not a regular directory: ${root}`);
  const worker = path.join(root, name);
  let worktrees = ownedWorktrees(worker);
  if (destination) {
    let target;
    try {
      target = fs.realpathSync(destination);
    } catch (error) {
      fail(`cannot locate destination ${destination}: ${error.message}`);
    }
    worktrees = worktrees.filter(({ worktree }) => worktree === target);
    if (worktrees.length !== 1) fail(`destination is not registered to ${name}: ${target}`);
  }
  const worktreeDirs = [];
  const gone = worktrees.filter((entry) => entry.missing);
  worktrees = worktrees.filter((entry) => !entry.missing);
  for (const entry of worktrees) {
    const { worktree } = entry;
    const commonDir = assertOwnedWorktree(worktree, name);
    if (entry.commonDir && entry.commonDir !== commonDir) fail(`registered destination belongs to another repository: ${worktree}`);
    const status = gitOutput(["-C", worktree, "status", "--porcelain", "--untracked-files=all"], `cannot inspect worktree ${worktree}`);
    if (status && !force) fail(`worktree has tracked or untracked changes: ${worktree} (rerun with --force to remove it)`);
    worktreeDirs.push([worktree, commonDir, entry.registrationDir]);
  }
  for (const [worktree, commonDir, registrationDir] of worktreeDirs) {
    const args = ["--git-dir", commonDir, "worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktree);
    const result = git(args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
    if (registrationDir) {
      fs.unlinkSync(path.join(registrationDir, DESTINATION_FILE));
      fs.rmdirSync(registrationDir);
    }
  }
  for (const { commonDir, registrationDir } of gone) {
    fs.unlinkSync(path.join(registrationDir, DESTINATION_FILE));
    fs.rmdirSync(registrationDir);
    worktreeDirs.push([null, commonDir]);
  }
  for (const commonDir of new Set(worktreeDirs.map(([, commonDir]) => commonDir))) {
    const result = git(["--git-dir", commonDir, "worktree", "prune"], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  if (lstatOrNull(worker) && fs.readdirSync(worker).length === 0) fs.rmdirSync(worker);
}

const args = process.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  usage();
} else if (args[0] === "add") {
  if (args.length < 3) { usage(); process.exit(1); }
  let base = "HEAD", destination;
  const seen = new Set();
  for (let i = 3; i < args.length; i += 2) {
    if (!["--base", "--dir"].includes(args[i]) || !args[i + 1] || seen.has(args[i])) {
      usage(); process.exit(1);
    }
    seen.add(args[i]);
    if (args[i] === "--base") base = args[i + 1];
    else destination = args[i + 1];
  }
  add(args[1], args[2], base, destination);
} else if (args[0] === "rm") {
  if (args.length < 2) { usage(); process.exit(1); }
  let force = false, destination;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--force" && !force) force = true;
    else if (args[i] === "--dir" && !destination && args[i + 1]) destination = args[++i];
    else { usage(); process.exit(1); }
  }
  remove(args[1], force, destination);
} else {
  usage();
  process.exit(1);
}

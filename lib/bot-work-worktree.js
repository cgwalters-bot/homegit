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

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage: bot-work worktree add REPO_DIR NAME [--base REF]\n       bot-work worktree rm NAME [--force]\n\nCreate worktrees under \${XDG_CACHE_HOME:-~/.cache}/bot-work/NAME/REPO on\nbranch bot/NAME. Removing a name refuses tracked or untracked changes unless\n--force is given.\n`);
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

function add(repoDir, name, base) {
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
  const target = path.join(worker, repoName);
  if (lstatOrNull(target)) fail(`worktree already exists or target is unsafe: ${target}`);
  const existing = git(["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.status === 0) fail(`branch already exists: ${branch}`);
  if (existing.status !== 1) fail(`checking branch ${branch} failed`);

  const result = git(["-C", repo, "worktree", "add", "-b", branch, target, commit], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
  process.stdout.write(`${target}\n`);
}

function ownedWorktrees(worker) {
  const stat = lstatOrNull(worker);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`worktree directory is not a regular directory: ${worker}`);
  return fs.readdirSync(worker, { withFileTypes: true }).map((entry) => {
    const worktree = path.join(worker, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`refusing unsafe worktree entry: ${worktree}`);
    return worktree;
  });
}

function assertOwnedWorktree(worktree, name) {
  const commonDir = gitOutput(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], `cannot locate Git directory for ${worktree}`);
  const registered = gitOutput(["--git-dir", commonDir, "worktree", "list", "--porcelain"], `cannot list worktrees for ${worktree}`)
    .split("\n\n")
    .some((entry) => entry.startsWith(`worktree ${worktree}\n`) || entry === `worktree ${worktree}`);
  if (!registered) fail(`refusing unregistered worktree entry: ${worktree}`);
  const branch = gitOutput(["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"], `worktree is detached or has no branch: ${worktree}`);
  if (branch !== `bot/${name}`) fail(`refusing worktree on branch '${branch}', not bot/${name}: ${worktree}`);
  return commonDir;
}

function remove(name, force) {
  safeName(name);
  const root = cacheRoot();
  const rootStat = lstatOrNull(root);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`worktree cache directory is not a regular directory: ${root}`);
  const worker = path.join(root, name);
  const worktrees = ownedWorktrees(worker);
  const worktreeDirs = [];
  for (const worktree of worktrees) {
    const status = gitOutput(["-C", worktree, "status", "--porcelain", "--untracked-files=all"], `cannot inspect worktree ${worktree}`);
    if (status && !force) fail(`worktree has tracked or untracked changes: ${worktree} (rerun with --force to remove it)`);
    worktreeDirs.push([worktree, assertOwnedWorktree(worktree, name)]);
  }
  for (const [worktree, commonDir] of worktreeDirs) {
    const args = ["--git-dir", commonDir, "worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktree);
    const result = git(args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
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
  if (args.length !== 3 && !(args.length === 5 && args[3] === "--base")) {
    usage();
    process.exit(1);
  }
  add(args[1], args[2], args[3] === "--base" ? args[4] : "HEAD");
} else if (args[0] === "rm") {
  if (args.length !== 2 && !(args.length === 3 && args[2] === "--force")) {
    usage();
    process.exit(1);
  }
  remove(args[1], args[2] === "--force");
} else {
  usage();
  process.exit(1);
}

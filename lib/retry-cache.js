// The attempts a sweep made that it shouldn't repeat every time: a head
// that 'bot-pr signoff' or 'bot-pr promote' refused, say. Each costs a
// clone, and its cause (a stale policy record, a conflict) is rarely
// fixed within minutes, so the sweeps repeat its result instead of
// retrying until the head moves or the attempt is RETRY_HOURS old. Used
// by bot-signoff-due and bot-promote-due. Node's standard library only.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RETRY_HOURS = 6;
const HOUR_MS = 3600 * 1000;

// cacheFile(tool): the attempts file of tool, under the XDG cache dir.
const cacheFile = (tool) =>
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), tool, "attempts.json");

// load(file, warn): the attempts, {"URL@HEAD": {..., at}}; none if the
// file is missing, or unreadable (with a warning).
function load(file, warn) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") warn(`ignoring ${file}: ${e.message}`);
    return {};
  }
}

// save(file, attempts): replaces the file with attempts, which should
// hold only the keys still due, so that a head that moved is forgotten.
function save(file, attempts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(attempts)}\n`);
  fs.renameSync(tmp, file);
}

// fresh(attempt): whether an attempt is recent enough to repeat its
// result rather than retry.
const fresh = (attempt) => Boolean(attempt) && Date.now() - Date.parse(attempt.at) < RETRY_HOURS * HOUR_MS;

module.exports = { RETRY_HOURS, cacheFile, load, save, fresh };

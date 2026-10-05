// Preload only in bot-actuals: run the real cost tool over local fixtures,
// and log board calls without needing executable fixture files.
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const execFileSync = cp.execFileSync;

cp.execFileSync = (cmd, args, opts) => {
  if (cmd === process.env.BOT_ACTUALS_COST) {
    fs.appendFileSync(process.env.FAKE_ACTUALS_LOG, `${JSON.stringify(["cost", ...args])}\n`);
    return execFileSync(process.execPath, [cmd, ...args, "--projects", path.join(__dirname, "projects", "proj")], opts);
  }
  if (cmd === process.env.BOT_ACTUALS_BOARD) {
    fs.appendFileSync(process.env.FAKE_ACTUALS_LOG, `${JSON.stringify(["board", ...args])}\n`);
    if (args[0] === "list") return fs.readFileSync(process.env.FAKE_ACTUALS_BOARD, "utf8");
    if (args[0] === "field-ensure" || args[0] === "set") return "";
  }
  throw new Error(`unexpected dependency call: ${cmd} ${args.join(" ")}`);
};

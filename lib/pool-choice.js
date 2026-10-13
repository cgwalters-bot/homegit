// Which inference pool an agentic-job dispatch asks for (bot-runs dispatch
// --pool): the pool furthest under its pace, from the same readings
// bin/bot-capacity paces, and whether the caller's dispatch.yml takes a
// `pool` input at all. Node's standard library only.
//   pool-choice.js choose     prints {pool, line} (pool null: none to ask for)
//   pool-choice.js declares   reads a dispatch.yml on stdin; exit 0 if it
//                             declares the pool input, 1 if not
"use strict";

const path = require("node:path");

const POOLS = ["claude", "openai"];
const INPUT = "pool";
// Exit status of a failure, apart from declares' 1 for "no".
const EX_ERROR = 3;

// declaresPool(yaml): whether the workflow's on.workflow_dispatch.inputs has
// a `pool` key. The inputs of a dispatch.yml are plain block mappings, so
// this follows indentation rather than parsing YAML.
function declaresPool(yaml) {
  const lines = String(yaml).split("\n").map((l) => l.replace(/\s+#.*$/, "").trimEnd()).filter((l) => l.trim() && !l.trim().startsWith("#"));
  const indent = (l) => l.length - l.trimStart().length;
  const key = (l) => /^\s*["']?([^:"']+)["']?\s*:/.exec(l)?.[1];
  let i = lines.findIndex((l) => key(l) === "workflow_dispatch");
  if (i < 0) return false;
  const dispatchIndent = indent(lines[i]);
  let inputsIndent = null, childIndent = null;
  for (i += 1; i < lines.length && indent(lines[i]) > dispatchIndent; i++) {
    const at = indent(lines[i]);
    if (inputsIndent === null) {
      if (key(lines[i]) === "inputs") inputsIndent = at;
      continue;
    }
    if (at <= inputsIndent) { inputsIndent = null; continue; }
    childIndent ??= at;
    if (at === childIndent && key(lines[i]) === INPUT) return true;
  }
  return false;
}

// choosePool(paces): {pool, line} for the pools' paces (bot-capacity's
// pools, by name; null without a reading). The pool with the largest margin
// (what the pace allows now minus what is used) wins, one that holds new
// work only when none is free, and one with no reading never over one that
// has. pool is null when neither has a reading.
function choosePool(paces) {
  const read = POOLS.filter((n) => paces[n]);
  if (!read.length) return { pool: null, line: "no reading of either pool" };
  const margin = (n) => paces[n].allowed_percent - paces[n].used_percent;
  const best = read.reduce((a, b) => (Boolean(paces[b].hold) !== Boolean(paces[a].hold) ? (paces[b].hold ? a : b) : margin(b) > margin(a) ? b : a));
  const detail = (n) => (paces[n] ? `${n} ${Math.round(paces[n].used_percent)}% used of ${Math.round(paces[n].allowed_percent)}% allowed${paces[n].hold ? " (held)" : ""}` : `${n} no reading`);
  const other = POOLS.find((n) => n !== best);
  let why = "furthest under its pace";
  if (!paces[other]) why = `no reading of ${other}`;
  else if (paces[best].hold) why = "both over pace, least over";
  else if (paces[other].hold) why = `${other} is over its pace`;
  return { pool: best, line: `${best}: ${why} (${POOLS.map(detail).join(", ")})` };
}

async function readPaces() {
  const capacity = require(path.join(__dirname, "..", "bin", "bot-capacity"));
  const pools = require(path.join(__dirname, "pools.js"));
  const config = require(path.join(__dirname, "operator.js")).loadOrExit("bot-runs");
  const now = process.env.BOT_CAPACITY_NOW ? Date.parse(process.env.BOT_CAPACITY_NOW) : Date.now();
  const readings = { claude: capacity.claudeReading(), openai: await capacity.openaiReading() };
  return Object.fromEntries(POOLS.map((n) => [n, pools.poolPace(readings[n], config.pacing.pools[n], now)]));
}

async function main(argv) {
  if (argv[0] === "declares") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return declaresPool(Buffer.concat(chunks).toString("utf8")) ? 0 : 1;
  }
  if (argv[0] === "choose") {
    process.stdout.write(`${JSON.stringify(choosePool(await readPaces()))}\n`);
    return 0;
  }
  process.stderr.write("usage: pool-choice.js choose | declares\n");
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stderr.write(`pool-choice: error: ${e.stack || e.message}\n`);
    process.exit(EX_ERROR);
  });
} else module.exports = { POOLS, declaresPool, choosePool };

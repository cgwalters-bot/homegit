// Conservative board retention: archive project items, never their issues.
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);
const DAY_MS = 86400000;
// How long a Done item stays on the board after its issue or PR closed.
const DEFAULT_DAYS = 3;
// Lookups at once: one after another, a few hundred Done items outlast
// the sweep's timeout for this step.
const LOOKUPS = 8;
// Archived per run, each a mutation of a second or two: a backlog takes
// several runs rather than one that is killed halfway.
const MAX_ARCHIVES = 100;
// gh's error for an issue or PR that is gone (deleted, or transferred
// out of reach): that item stays, and the others are still decided.
const GONE_RE = /HTTP (404|410)/;

function parseArgs(argv) {
  const opts = { days: DEFAULT_DAYS, dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i] === "--apply") opts.dryRun = false;
    else if (argv[i] === "--days") {
      const value = argv[++i];
      if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(Number(value))) {
        throw new Error("--days requires a nonnegative integer");
      }
      opts.days = Number(value);
    } else throw new Error(`unknown archive-done argument: ${argv[i]}`);
  }
  return opts;
}

function eligible(content, children, cutoff) {
  const closed = Date.parse(content.closed_at);
  const epic = /^epic(?:\b|:)/i.test(content.title || "") ||
    (content.labels || []).some((l) => /^epic$/i.test(typeof l === "string" ? l : l.name)) ||
    /^epic$/i.test(content.type?.name || "");
  return content.state === "closed" && Number.isFinite(closed) && closed < cutoff && !epic &&
    Array.isArray(children) && children.every((c) => c.state === "closed");
}

// pool(items, fn): fn of each item, LOOKUPS at once; the results in order.
async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(LOOKUPS, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function archiveDone(board, project, opts, run, now = Date.now()) {
  const items = JSON.parse(await run(board, ["--refresh", "--project", project, "list", "--status", "Done", "--json"]));
  if (!Array.isArray(items)) throw new Error("invalid board listing");
  const done = items.filter((item) => item.status === "Done" && /^PVTI_\S+$/.test(item.id)).sort((a, b) => a.id.localeCompare(b.id));
  // Observe every candidate before writing: a failed child lookup must not
  // turn an incomplete observation into permission to archive.
  const verdicts = await pool(done, async (item) => {
    const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)$/.exec(item.content?.url || "");
    if (!match || !["Issue", "PullRequest"].includes(item.content.type)) return false;
    const endpoint = `repos/${match[1]}/${match[2] === "pull" ? "pulls" : "issues"}/${match[3]}`;
    let content;
    try {
      content = JSON.parse(await run("gh", ["api", endpoint]));
    } catch (e) {
      if (!GONE_RE.test(`${e.stderr || ""}${e.message}`)) throw e;
      process.stderr.write(`archive-done: warning: ${item.content.url} is gone; leaving ${item.id} on the board\n`);
      return false;
    }
    if (!eligible(content, [], now - opts.days * DAY_MS)) return false;
    const children = match[2] === "pull" ? [] : JSON.parse(await run("gh", ["api", "--paginate", "--slurp", `${endpoint}/sub_issues?per_page=100`]));
    if (!Array.isArray(children) || children.some((page) => !Array.isArray(page))) throw new Error(`invalid sub-issues for ${item.id}`);
    return eligible(content, children.flat(), now - opts.days * DAY_MS);
  });
  const candidates = done.filter((_, i) => verdicts[i]);
  let archived = 0;
  for (const item of opts.dryRun ? candidates : candidates.slice(0, MAX_ARCHIVES)) {
    if (!opts.dryRun) {
      await run(board, ["--project", project, "archive", item.id]);
      archived++;
    }
    process.stdout.write(`${opts.dryRun ? "would archive" : "archived"} ${item.id}\n`);
  }
  process.stdout.write(`Archive Done: ${archived} archived, ${candidates.length} eligible${opts.dryRun ? " (dry-run)" : ""}\n`);
  return { archived, eligible: candidates.length, dry_run: opts.dryRun };
}

// run(cmd, argv): cmd's stdout; its stderr goes with a failure's message.
const run = async (cmd, argv) => (await execFileP(cmd, argv, { maxBuffer: 256 << 20 })).stdout;

if (require.main === module) {
  const [board, project, ...args] = process.argv.slice(2);
  Promise.resolve().then(() => archiveDone(board, project, parseArgs(args), run)).catch((e) => {
    process.stderr.write(`archive-done: ${(e.stderr || "").trim() || e.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_DAYS, MAX_ARCHIVES, parseArgs, eligible, archiveDone };

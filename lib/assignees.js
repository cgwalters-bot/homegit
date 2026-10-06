// Whose turn an issue or PR is, kept in GitHub's assignee field: assigned
// to the operator, it waits on them; assigned to the bot, it is the bot's
// turn (an agent or run is, or should be, on it); unassigned, nobody's
// (backlog, parked or done). 'bot-board assign', 'handback' and
// 'assign-migrate' run this; see the workstream skill's "Whose turn".
//
// Only the bot's own scope carries assignees: the forge org's
// repositories, the bot's and the tracker. An upstream issue or PR is
// never assigned (that would notify its maintainers and needs triage
// rights the bot mostly lacks): its turn lives on the tracker issue
// whose board item has it in its Branch. So "open items assigned to the
// operator" is one search query over that scope.
"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);
const WHO = ["operator", "bot", "none"];
// The search API returns at most this many per page; one page per run
// is plenty for the asks, and closed items left assigned drain over a
// few sweeps.
const PER_PAGE = 100;
const URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)\/?(?:#.*)?$/;
const REF_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

class Usage extends Error {}

// parseRef(TEXT): {owner, repo, number, url} of an issue or PR URL or
// OWNER/REPO#N (whose url is the issue form: GitHub redirects a PR's).
function parseRef(text) {
  let m = URL_RE.exec(text || "");
  if (m) return { owner: m[1], repo: m[2], number: Number(m[4]), url: `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` };
  m = REF_RE.exec(text || "");
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` };
  throw new Usage(`expected an issue or PR URL or OWNER/REPO#N, got '${text}'`);
}

// key(URL): the same for an issue's and a PR's URL of one number.
const key = (url) => url.toLowerCase().replace(/\/(issues|pull)\//, "/").replace(/\/$/, "");

// inScope(REF, CFG): whether the bot assigns on REF's repository itself.
function inScope(ref, cfg) {
  const owner = ref.owner.toLowerCase();
  return owner === cfg.forgeOrg.toLowerCase() || owner === cfg.bot.toLowerCase() ||
    `${ref.owner}/${ref.repo}`.toLowerCase() === cfg.tracker.toLowerCase();
}

// scopeQuery(CFG): the search qualifiers for that scope.
function scopeQuery(cfg) {
  const q = [`org:${cfg.forgeOrg}`, `user:${cfg.bot}`];
  const trackerOwner = cfg.tracker.split("/")[0].toLowerCase();
  if (![cfg.forgeOrg, cfg.bot].some((o) => o.toLowerCase() === trackerOwner)) q.push(`repo:${cfg.tracker}`);
  return q.join(" ");
}

// turnChange(ASSIGNEES, WHO, CFG): the logins to add and remove so that
// the turn is WHO's; anyone else assigned stays.
function turnChange(assignees, who, cfg) {
  if (!WHO.includes(who)) throw new Usage(`expected operator, bot or none, got '${who}'`);
  const has = (login) => assignees.some((a) => a.toLowerCase() === login.toLowerCase());
  const want = who === "operator" ? cfg.operator : who === "bot" ? cfg.bot : null;
  const add = want && !has(want) ? [want] : [];
  const remove = [cfg.operator, cfg.bot].filter((l) => l !== want && has(l));
  return { add, remove };
}

// handBackEvent(ITEM, CFG): the first thing the operator did on an item
// assigned to them since it was: {kind, url, at}, or null. ITEM is
// {assignedAt, comments, reviews}, as GitHub's REST API gives them; a
// tracker issue's include those of the PRs in its Branch. Only the
// operator's count: never the bot's own comments, nor anyone else's.
// A comment on a question is its answer; a review that approves is an
// approval.
function handBackEvent(item, cfg) {
  const since = Date.parse(item.assignedAt);
  const mine = (u) => (u?.login || "").toLowerCase() === cfg.operator.toLowerCase();
  const events = [
    ...(item.comments || []).filter((c) => mine(c.user)).map((c) => ({ kind: "commented", url: c.html_url, at: c.created_at })),
    ...(item.reviews || []).filter((r) => mine(r.user) && r.state !== "PENDING" && r.submitted_at)
      .map((r) => ({ kind: r.state === "APPROVED" ? "approved" : "reviewed", url: r.html_url, at: r.submitted_at })),
  ].filter((e) => Date.parse(e.at) > since);
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events[0] || null;
}

// lastAssigned(EVENTS, LOGIN): when LOGIN was last assigned, from an
// issue's events, or null.
function lastAssigned(events, login) {
  const at = events.filter((e) => e.event === "assigned" && (e.assignee?.login || "").toLowerCase() === login.toLowerCase())
    .map((e) => e.created_at).sort();
  return at.at(-1) || null;
}

// The GitHub side, through RUN(cmd, argv) -> stdout.
class Forge {
  constructor(cfg, run, board) {
    this.cfg = cfg;
    this.run = run;
    this.board = board;
    this.items = null;
  }

  async gh(args) {
    const out = await this.run("gh", ["api", ...args]);
    return out.trim() ? JSON.parse(out) : null;
  }

  async pages(endpoint) {
    const sep = endpoint.includes("?") ? "&" : "?";
    return (await this.gh(["--paginate", "--slurp", `${endpoint}${sep}per_page=${PER_PAGE}`])).flat();
  }

  async search(q) {
    const r = await this.gh(["-X", "GET", "search/issues", "-f", `q=${q} ${scopeQuery(this.cfg)}`, "-f", `per_page=${PER_PAGE}`, "-f", "sort=updated"]);
    return r.items.map((i) => ({ url: i.html_url, pr: Boolean(i.pull_request), assignees: i.assignees.map((a) => a.login) }));
  }

  // The board's items, for the Branch of tracker issues.
  async boardItems() {
    if (!this.items) this.items = JSON.parse(await this.run(this.board, ["list", "--json"]));
    return this.items;
  }

  // trackerIssues(URL): the open-or-not tracker issues whose board item
  // has URL in its Branch.
  async trackerIssues(url) {
    const k = key(url);
    const prefix = `https://github.com/${this.cfg.tracker}/issues/`.toLowerCase();
    return (await this.boardItems())
      .filter((i) => (i.content?.url || "").toLowerCase().startsWith(prefix) &&
        String(i.branch || "").split(/\s+/).some((b) => b && key(b) === k))
      .map((i) => i.content.url);
  }

  // branchPrs(URL): the PRs in the Branch of URL's board item.
  async branchPrs(url) {
    const item = (await this.boardItems()).find((i) => i.content?.url && key(i.content.url) === key(url));
    return String(item?.branch || "").split(/\s+/).filter((b) => /\/pull\/\d+$/.test(b));
  }

  // acted(REF, PR): what the operator did on REF (a PR if PR) since they
  // were last assigned it (handBackEvent), null for nothing, undefined
  // when its events don't say since when. A tracker issue's includes
  // what they did on the PRs in its Branch.
  async acted(ref, pr) {
    const cfg = this.cfg;
    const assignedAt = lastAssigned(await this.pages(`repos/${ref.owner}/${ref.repo}/issues/${ref.number}/events`), cfg.operator);
    if (!assignedAt) return undefined;
    const sources = [{ ref, pr }];
    if (`${ref.owner}/${ref.repo}`.toLowerCase() === cfg.tracker.toLowerCase()) {
      for (const url of await this.branchPrs(ref.url)) sources.push({ ref: parseRef(url), pr: true });
    }
    const item = { assignedAt, comments: [], reviews: [] };
    for (const s of sources) {
      const a = `repos/${s.ref.owner}/${s.ref.repo}`;
      item.comments.push(...await this.pages(`${a}/issues/${s.ref.number}/comments?since=${encodeURIComponent(assignedAt)}`));
      if (s.pr) item.reviews.push(...await this.pages(`${a}/pulls/${s.ref.number}/reviews`));
    }
    return handBackEvent(item, cfg);
  }

  // setTurn(REF, WHO, APPLY): makes REF WHO's turn; returns what changed
  // (or would), as {add, remove}. Asking the operator again on an item
  // still assigned to them that they acted on since assigns them anew
  // (renewed): the hand-back counts from the assignment, and would
  // otherwise take the new ask for answered.
  async setTurn(ref, who, apply) {
    // Whatever led here, nothing upstream is ever assigned.
    if (!inScope(ref, this.cfg)) throw new Error(`${ref.url} is not in ${this.cfg.forgeOrg}, ${this.cfg.bot}'s repositories or ${this.cfg.tracker}: the bot assigns nobody there`);
    const api = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const issue = await this.gh([api]);
    const change = turnChange(issue.assignees.map((a) => a.login), who, this.cfg);
    const again = who === "operator" && !change.add.length && Boolean(await this.acted(ref, Boolean(issue.pull_request)));
    if (again) Object.assign(change, { add: [this.cfg.operator], renewed: true });
    if (!apply) return change;
    if (again) await this.gh(["-X", "DELETE", `${api}/assignees`, "-f", `assignees[]=${this.cfg.operator}`]);
    if (change.add.length) {
      const after = await this.gh(["-X", "POST", `${api}/assignees`, ...change.add.flatMap((l) => ["-f", `assignees[]=${l}`])]);
      const got = after.assignees.map((a) => a.login.toLowerCase());
      const missing = change.add.filter((l) => !got.includes(l.toLowerCase()));
      if (missing.length) throw new Error(`GitHub did not assign ${missing.join(", ")} on ${ref.url} (not assignable in ${ref.owner}/${ref.repo}?)`);
    }
    if (change.remove.length) await this.gh(["-X", "DELETE", `${api}/assignees`, ...change.remove.flatMap((l) => ["-f", `assignees[]=${l}`])]);
    return change;
  }

  // targets(TEXT): where TEXT's turn lives: itself in the bot's scope,
  // else the tracker issues that have it in their Branch.
  async targets(text) {
    const ref = parseRef(text);
    if (inScope(ref, this.cfg)) return [ref];
    const issues = await this.trackerIssues(ref.url);
    if (!issues.length) {
      throw new Error(`${ref.url} is upstream, where the bot assigns nobody, and no ${this.cfg.tracker} issue on the board has it in its Branch: ` +
        "open one ('bot-board issue') and put the PR in its Branch, then assign that");
    }
    return issues.map(parseRef);
  }
}

const firstLine = (e) => ((e.stderr || "").trim() || e.message).split("\n")[0];

function describe(change) {
  return [...change.add.map((l) => `+${l}${change.renewed ? " (asked again)" : ""}`), ...change.remove.map((l) => `-${l}`)].join(" ") || "unchanged";
}

async function assign(forge, text, who, out) {
  turnChange([], who, forge.cfg);
  for (const ref of await forge.targets(text)) {
    const change = await forge.setTurn(ref, who, true);
    const via = key(ref.url) === key(parseRef(text).url) ? "" : ` (for ${parseRef(text).url})`;
    out(`${ref.url}: ${who}${via}: ${describe(change)}`);
  }
}

// handBack(FORGE, APPLY, OUT): hands every open item assigned to the
// operator that they acted on since back to the bot, and unassigns
// closed items. Returns the counts. An item that fails is reported and
// the rest still done; it then throws, naming how many did.
async function handBack(forge, apply, out) {
  const cfg = forge.cfg;
  const does = (what) => (apply ? what : `would be ${what}`);
  let handed = 0;
  let cleared = 0;
  let failed = 0;
  const each = async (items, fn) => {
    for (const it of items) {
      try {
        await fn(it, parseRef(it.url));
      } catch (e) {
        failed++;
        out(`warning: ${it.url}: ${firstLine(e)}`);
      }
    }
  };
  await each(await forge.search(`is:open assignee:${cfg.operator}`), async (it, ref) => {
    const ev = await forge.acted(ref, it.pr);
    if (ev === undefined) out(`warning: ${it.url} is assigned to ${cfg.operator}, but its events don't say since when; skipped`);
    if (!ev) return;
    await forge.setTurn(ref, "bot", apply);
    handed++;
    out(`Handed back: ${it.url} (${cfg.operator} ${ev.kind} ${ev.url}) ${does(`assigned to ${cfg.bot}`)}`);
  });
  for (const login of [cfg.operator, cfg.bot]) {
    await each(await forge.search(`is:closed assignee:${login}`), async (it, ref) => {
      await forge.setTurn(ref, "none", apply);
      cleared++;
      out(`Closed: ${it.url} ${does("unassigned")}`);
    });
  }
  out(`Hand-back: ${handed} handed back, ${cleared} closed unassigned${apply ? "" : " (dry-run)"}`);
  if (failed) throw new Error(`${failed} item(s) failed (see the warnings)`);
  return { handed, cleared };
}

// migrate(FORGE, ASKS, APPLY, OUT): the one-shot move to assignees: the
// live asks become the operator's turn, and every other item in scope
// assigned to the operator or the bot becomes nobody's.
async function migrate(forge, asks, apply, out) {
  const cfg = forge.cfg;
  const verb = apply ? "" : "would ";
  const keep = new Set();
  for (const ask of asks) {
    for (const ref of await forge.targets(ask)) {
      keep.add(key(ref.url));
      out(`Ask: ${ref.url} ${verb}assign ${cfg.operator}: ${describe(await forge.setTurn(ref, "operator", apply))}`);
    }
  }
  const seen = new Set();
  for (const q of [`assignee:${cfg.operator}`, `assignee:${cfg.bot}`]) {
    for (const it of await forge.search(`is:open ${q}`)) {
      const k = key(it.url);
      if (keep.has(k) || seen.has(k)) continue;
      seen.add(k);
      out(`Other: ${it.url} ${verb}unassign: ${describe(await forge.setTurn(parseRef(it.url), "none", apply))}`);
    }
  }
  out(`Migration: ${keep.size} asks, ${seen.size} others unassigned${apply ? "" : " (dry-run)"}`);
}

function config(op) {
  return { operator: op.operator.login, bot: op.bot.login, forgeOrg: op.forge_org, tracker: op.tracker_repo };
}

// readAsks(TEXT): the URLs or OWNER/REPO#N in TEXT, one per line or
// separated by spaces; '#' starts a comment.
function readAsks(text) {
  return text.split("\n").map((l) => l.replace(/(^|\s)#(?!\d).*$/, "")).join(" ").split(/\s+/).filter(Boolean);
}

const run = async (cmd, argv) => (await execFileP(cmd, argv, { maxBuffer: 256 << 20 })).stdout;

async function main(argv) {
  const [board, command, ...args] = argv;
  const op = require(path.join(__dirname, "operator.js")).loadOrExit("bot-board");
  const forge = new Forge(config(op), run, board);
  const out = (line) => process.stdout.write(`${line}\n`);
  const flag = (f) => {
    const i = args.indexOf(f);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  if (command === "assign") {
    if (args.length !== 2) throw new Usage("usage: bot-board assign ITEM operator|bot|none");
    return assign(forge, args[0], args[1], out);
  }
  const apply = flag("--apply");
  flag("--dry-run");
  if (command === "handback") {
    if (args.length) throw new Usage(`unexpected argument for handback: ${args[0]}`);
    return handBack(forge, apply, out);
  }
  if (command === "assign-migrate") {
    if (args.length !== 1) throw new Usage("usage: bot-board assign-migrate [--apply] FILE|-");
    const text = require("node:fs").readFileSync(args[0] === "-" ? 0 : args[0], "utf8");
    return migrate(forge, readAsks(text), apply, out);
  }
  throw new Usage(`unknown command '${command}'`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${(e.stderr || "").trim() || e.message}\n`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  });
}

module.exports = { WHO, Forge, parseRef, inScope, scopeQuery, turnChange, handBackEvent, lastAssigned, assign, handBack, migrate, readAsks };

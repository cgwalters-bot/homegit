// Deterministic Workstream observations and status updates. Invoked by
// bot-board after project resolution, under its per-project flock.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const HOUR_MS = 3600000;
const THROTTLE_MS = 4 * HOUR_MS;
const STATUS = { "on-track": "ON_TRACK", "at-risk": "AT_RISK", "off-track": "OFF_TRACK" };
const MARKER_RE = /<!-- bot-board-status-v1: ([A-Za-z0-9+/=]+) -->/;
const ITEMS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id updatedAt
      content {
        ... on Issue { title url body state updatedAt closedAt labels(first: 100) { nodes { name } } comments(last: 1) { nodes { body updatedAt } } }
        ... on PullRequest { title url body state updatedAt closedAt mergedAt comments(last: 1) { nodes { body updatedAt } } }
        ... on DraftIssue { title body updatedAt }
      }
      fieldValues(first: 100) { pageInfo { hasNextPage } nodes {
        ... on ProjectV2ItemFieldTextValue { text updatedAt field { ... on ProjectV2Field { name } } }
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
      } }
    }
  } } }
}`;
const UPDATES_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 { statusUpdates(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id body createdAt status project { url } }
  } } }
}`;
const MUTATION = `mutation($project: ID!, $body: String!, $status: ProjectV2StatusUpdateStatus!) {
  createProjectV2StatusUpdate(input: {projectId: $project, body: $body, status: $status}) {
    statusUpdate { id body createdAt creator { login } project { url } }
  }
}`;

function time(value) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function parseArgs(argv) {
  const opts = { auto: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") opts.auto = true;
    else if (["--status", "--since", "--body"].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${a} requires an argument`);
      opts[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument for status-update: ${a}`);
  }
  validateOptions(opts);
  return opts;
}

function validateOptions(opts) {
  if (opts.status && !Object.hasOwn(STATUS, opts.status)) throw new Error("--status must be on-track, at-risk or off-track");
  if (opts.since && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(opts.since) || !Number.isFinite(Date.parse(opts.since)))) {
    throw new Error("--since requires an ISO timestamp with timezone");
  }
  if (opts.auto && (opts.status || opts.since || opts.body)) throw new Error("--auto cannot be combined with --status, --since or --body");
}

function preflight(opts, staleHours) {
  validateOptions(opts);
  if (!Number.isFinite(staleHours) || staleHours <= 0) throw new Error("BOT_BOARD_STATUS_P0_HOURS must be a positive number");
  if (!opts.body) return null;
  let custom;
  try {
    custom = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(opts.body));
  } catch (e) {
    throw new Error(`cannot read --body ${opts.body} as UTF-8: ${e.message}`);
  }
  if (!custom.trim()) throw new Error("--body file is empty");
  if (custom.length >= 65536) throw new Error("status update exceeds GitHub's 65536-character body limit (including recovery marker)");
  return custom;
}

function normalize(node) {
  if (node.fieldValues.pageInfo?.hasNextPage) throw new Error(`too many field values on ${node.id}; refusing an incomplete observation`);
  const fields = Object.fromEntries(node.fieldValues.nodes.filter((f) => f.field)
    .map((f) => [f.field.name.toLowerCase(), f.text ?? f.name]));
  const newsUpdatedAt = node.fieldValues.nodes.find((f) => f.field?.name.toLowerCase() === "news")?.updatedAt;
  const c = node.content || {};
  return { id: node.id, title: c.title || node.id, url: c.url || "", updatedAt: node.updatedAt,
    contentUpdatedAt: c.updatedAt, body: c.body || "", comments: c.comments?.nodes || [],
    closedAt: c.closedAt, mergedAt: c.mergedAt, state: c.state, newsUpdatedAt,
    blocks: c.labels?.nodes.some((l) => ["question", "review", "chore"].includes(l.name))
      ? /^Blocks: (\S+)/.exec(c.body || "")?.[1] || "" : "",
    askClass: c.labels?.nodes.some((l) => l.name === "question") ? "decision" :
      c.labels?.nodes.some((l) => l.name === "review") ? "review" :
        c.labels?.nodes.some((l) => l.name === "chore") ? "action" : "decision / action",
    ...Object.fromEntries(["status", "priority", "why", "news", "branch", "gist", "lead", "run"]
      .map((key) => [key, fields[key] || ""])) };
}

function compare(a, b) {
  for (const key of ["priority", "title", "url", "id"]) {
    const x = a[key] || (key === "priority" ? "P9" : "");
    const y = b[key] || (key === "priority" ? "P9" : "");
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Item text is untrusted and lands in a public update: keep it on one line,
// stop `@user` from pinging (zero-width space, as bot-feedback does), turn
// `<` into an entity so no HTML renders, and defuse a leading block marker.
function clean(text) {
  return String(text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b")
    .replace(/</g, "&lt;")
    .replace(/[\\`*_[\]!~|]/g, "\\$&")
    .trim()
    .replace(/^(#|>|[-*+](?=\s)|\d+(?=[.)]\s))/, "\\$1");
}

function newsText(news) {
  return clean(news).replace(/^\d{4}-\d{2}-\d{2}: /, "");
}

function finished(item) {
  return item.status === "Done" || ["CLOSED", "MERGED"].includes(item.state);
}

function material(items, workers, status) {
  return { status, items: [...items].sort(compare).map((i) => Object.fromEntries(
    ["id", "title", "url", "status", "priority", "why", "branch", "gist", "lead", "run", "state", "askClass"]
      .map((key) => [key, i[key] || ""]).concat([["news", newsText(i.news)], ["movement", movement(i)]]))),
  workers: [...workers].map(({ name, item_url, item_id, status: state }) => ({ name, item_url, item_id, status: state }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en")) };
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function movement(item) {
  // Execution IDs, tokens and timestamp-only updates are bookkeeping.
  return digest(Object.fromEntries(["title", "body", "state", "status", "priority", "lead", "branch", "why", "gist"]
    .map((key) => [key, item[key] || ""]).concat([
      ["news", newsText(item.news)], ["comments", (item.comments || []).map((c) => c.body || "")],
    ])));
}

function observe(items, previous = [], now) {
  const old = new Map(previous.map((i) => [i.id, i]));
  return [...items].sort(compare).map((i) => {
    const fingerprint = movement(i);
    const before = old.get(i.id);
    // On first sight only, timestamps are the available evidence. Once
    // observed, generic updatedAt cannot override the material baseline.
    const evidence = Math.min(now, Math.max(time(i.updatedAt), time(i.contentUpdatedAt),
      time(i.closedAt), time(i.mergedAt), ...(i.comments || []).map((c) => time(c.updatedAt))));
    const movedAt = before?.fingerprint === fingerprint ? before.movedAt : before ? now : evidence;
    return { id: i.id, fingerprint, movedAt };
  });
}

function scopedWorkers(items, workers) {
  return workers.flatMap((w) => {
    // Only exact associations: never infer membership from a repository or
    // a worker name. The current public heartbeat schema uses item_url;
    // explicit IDs / Run / branch links also support board observations.
    const matches = items.filter((i) => (i.url && i.url === w.item_url) ||
      (w.item_id && i.id === w.item_id) || (w.item_url && [i.run, i.branch]
        .some((links) => String(links || "").split(/\s+/).includes(w.item_url))));
    if (!matches.length || matches.some(finished)) return [];
    return matches.map((i) => ({ name: w.name, item_url: i.url, item_id: i.id, status: w.status }));
  });
}

function generate(items, { now, since, previous = [], observations = [], workers = [], staleHours = 24, status, explicitSince = false } = {}) {
  const old = new Map(previous.map((i) => [i.id, i]));
  const sorted = [...items].sort(compare);
  const observed = observe(items, observations, now);
  const movementTimes = new Map(observed.map((i) => [i.id, i.movedAt]));
  const stale = sorted.filter((i) => i.priority === "P0" && !finished(i) &&
    now - movementTimes.get(i.id) >= staleHours * HOUR_MS);
  workers = scopedWorkers(items, workers);
  const derived = status || (stale.length ? "at-risk" : "on-track");
  const changed = [];
  const progress = [];
  const waiting = [];
  const orderedWorkers = material([], workers, derived).workers;
  const blockedParents = new Set(sorted.filter((i) => !finished(i) && i.status === "Needs human" && i.blocks)
    .map((i) => i.blocks));
  const link = (i) => i.url ? `[${clean(i.title)}](${i.url})` : clean(i.title);
  for (const i of sorted) {
    const before = old.get(i.id);
    const events = [];
    if (time(i.mergedAt) > since) events.push("merged");
    else if (time(i.closedAt) > since) events.push("closed");
    else if (i.status === "Done" && before && before.status !== "Done" &&
      (!explicitSince || time(i.updatedAt) > since)) events.push("closed / completed");
    if (i.status === "In Review" && before?.status === "Draft" &&
      (!explicitSince || time(i.updatedAt) > since)) events.push("promoted upstream");
    const dated = /^\d{4}-\d{2}-\d{2}: /.test(i.news || "");
    // News dates have day precision. With a snapshot compare the text;
    // without one retain same-day news, rather than silently losing it.
    const newsSince = i.newsUpdatedAt ? time(i.newsUpdatedAt) > since :
      (dated ? time(i.news.slice(0, 10) + "T00:00:00Z") + 24 * HOUR_MS > since : time(i.updatedAt) > since);
    if (i.news && (before && !explicitSince ? newsText(i.news) !== newsText(before.news) : newsSince)) {
      events.push(newsText(i.news));
    }
    if (events.length) changed.push(`- ${link(i)}: ${events.map(clean).join("; ")}`);
    if (finished(i)) continue;
    if (i.status === "In Progress") {
      const agents = orderedWorkers.filter((w) => w.item_id === i.id).map((w) => `${clean(w.name)} (${clean(w.status)})`);
      const agent = agents.length ? agents.join(", ") : clean(i.lead);
      progress.push(`- ${link(i)}${agent ? ` — agent ${agent}` : ""}${i.run ? ` (${clean(i.run)})` : ""}`);
    }
    if (i.status === "In Review") progress.push(`- ${link(i)} — awaiting upstream review${i.branch ? ` (${clean(i.branch)})` : ""}`);
    if (["Draft", "Needs human"].includes(i.status) &&
      !(i.status === "Needs human" && (blockedParents.has(i.id) || blockedParents.has(i.url)))) {
      waiting.push(`- ${link(i)} — ${i.status === "Draft" ? "review" : i.askClass || "decision / action"}: ${clean(i.why) || "see item"}${i.branch || i.gist ? ` (${clean([i.branch, i.gist].filter(Boolean).join(" "))})` : ""}`);
    }
  }
  for (const w of orderedWorkers) {
    if (!items.some((i) => i.id === w.item_id && i.status === "In Progress")) {
      progress.push(`- Agent ${clean(w.name)}: ${clean(w.status)} (${clean(w.item_url)})`);
    }
  }
  const section = (title, lines) => `## ${title}\n${lines.length ? lines.join("\n") : "- None."}`;
  const body = [section("Changed", changed), section("In progress", progress),
    section("Waiting on the operator", waiting)].join("\n\n") +
    (stale.length ? `\n\nAt risk: stale unfinished P0 (${staleHours}h): ${stale.map(link).join(", ")}.` : "");
  return { body, status: derived,
    digest: digest({ ...material(items, workers, derived), stale: stale.map((i) => i.id) }), observations: observed };
}

function gh(query, variables) {
  let out;
  try {
    out = execFileSync("gh", ["api", "graphql", "--input", "-"], {
      input: JSON.stringify({ query, variables }), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const message = String(e.stderr || e.message).trim();
    const error = new Error(`status-update: GitHub request failed: ${message}`);
    if (/rate limit/i.test(message)) error.code = 75;
    throw error;
  }
  const json = JSON.parse(out);
  if (json.errors?.length) {
    const error = new Error(`status-update: ${json.errors.map((e) => e.message).join("; ")}`);
    if (/rate limit/i.test(error.message)) error.code = 75;
    throw error;
  }
  if (!json.data) throw new Error("status-update: GitHub returned no data");
  return json.data;
}

function pages(request, query, id, field) {
  const nodes = [];
  let after = null;
  const seen = new Set();
  do {
    const connection = request(query, { id, after }).node?.[field];
    if (!connection || !Array.isArray(connection.nodes)) throw new Error(`cannot read project ${field}`);
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after || seen.has(after)) throw new Error(`invalid ${field} pagination cursor`);
    seen.add(after);
  } while (true);
  return nodes;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

function writeSnapshot(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function recover(update) {
  // A custom body can itself be a copied report with an older marker.
  const match = [...(update?.body || "").matchAll(new RegExp(MARKER_RE.source, "g"))].at(-1);
  if (!match) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (typeof value.digest !== "string" || !Array.isArray(value.items)) return null;
    return { ...value, postedAt: update.createdAt, url: update.project?.url || update.url, id: update.id };
  } catch {
    return null;
  }
}

function publish({ id, stateFile, opts, now = Date.now(), staleHours = 24, workers = [], request = gh }) {
  const custom = preflight(opts, staleHours);
  const updates = pages(request, UPDATES_QUERY, id, "statusUpdates")
    .sort((a, b) => time(b.createdAt) - time(a.createdAt));
  const latest = updates[0];
  const local = readJSON(stateFile);
  // The API is authoritative: a crash after posting but before saving must
  // not publish the same update again. Don't manufacture a baseline from
  // observations taken after that post.
  const remote = updates.map(recover).find(Boolean);
  const baseline = local && time(local.postedAt) >= time(remote?.postedAt) ? local : remote;
  // A successful local post may not be visible in the project listing yet.
  const lastTime = Math.max(time(latest?.createdAt), time(local?.postedAt));
  const items = pages(request, ITEMS_QUERY, id, "items").map(normalize);
  const observationFile = `${stateFile}.observations.json`;
  const history = readJSON(observationFile);
  const observations = observe(items, history && history.observedAt >= time(baseline?.postedAt)
    ? history.items : baseline?.observations, now);
  writeSnapshot(observationFile, { observedAt: now, items: observations });
  if (opts.auto && lastTime && now - lastTime < THROTTLE_MS) return { skipped: "four-hour throttle" };
  const generated = generate(items, { now, since: opts.since ? time(opts.since) : lastTime || now - 24 * HOUR_MS,
    previous: baseline?.items, observations, workers, staleHours, status: opts.status, explicitSince: Boolean(opts.since) });
  if (opts.auto && baseline?.digest === generated.digest) return { skipped: "no material change" };
  // Only these fields are needed to identify transitions and changed News.
  // Keep recovery metadata small enough for large boards and custom bodies.
  const snapshot = { digest: generated.digest, observations, items: [...items].sort(compare)
    .map(({ id: itemId, status, news }) => ({ id: itemId, status, news })) };
  const marker = `<!-- bot-board-status-v1: ${Buffer.from(JSON.stringify(snapshot)).toString("base64")} -->`;
  const body = `${custom ?? generated.body}\n\n${marker}`;
  if (body.length > 65536) throw new Error("status update exceeds GitHub's 65536-character body limit");
  const update = request(MUTATION, { project: id, body, status: STATUS[generated.status] }).createProjectV2StatusUpdate?.statusUpdate;
  const url = update?.project?.url;
  if (!url || !update.id || !time(update.createdAt)) throw new Error("status-update mutation returned no project URL, id or timestamp; baseline not saved");
  try {
    writeSnapshot(stateFile, { ...snapshot, postedAt: update.createdAt, url, id: update.id });
  } catch (e) {
    throw new Error(`posted ${url}, but saving the snapshot failed: ${e.message}; recover from project updates on the next run`);
  }
  return { url };
}

function main(argv) {
  const staleHours = Number(process.env.BOT_BOARD_STATUS_P0_HOURS || 24);
  // The shell runs this local-only path before resolving the project or
  // creating its lock. Revalidate on publish in case the file changed.
  if (argv[0] === "--validate") {
    preflight(parseArgs(argv.slice(1)), staleHours);
    return;
  }
  const [id, stateFile, ...args] = argv;
  const opts = parseArgs(args);
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const heartbeat = readJSON(path.join(stateHome, "bot-heartbeat", "last-publish.json"));
  const workers = (heartbeat?.published?.workers || []).filter((w) =>
    Date.now() - time(w.last_activity_at || w.started_at) < 6 * HOUR_MS);
  const result = publish({ id, stateFile, opts, workers, staleHours });
  process.stdout.write(result.url ? `${result.url}\n` : `status-update: skipped (${result.skipped})\n`);
}

module.exports = { clean, parseArgs, normalize, generate, observe, scopedWorkers, publish, recover, ITEMS_QUERY, UPDATES_QUERY, MUTATION, STATUS };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = typeof e.code === "number" ? e.code : 1;
  }
}

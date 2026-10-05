// bot-runs watch orchestration. GitHub reads use the existing gh API transport;
// telemetry is a sanitized read-only endpoint or a local JSON observations array.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const health = require("./run-health.js");
const heartbeat = require("./heartbeat-register.js");

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

// The board list outgrew Node's 1 MB default (ENOBUFS).
const BOARD_MAX_BUFFER = 256 << 20;

function gh(args) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30e3 });
}

function api(endpoint) {
  return JSON.parse(gh([endpoint]));
}

function owned(item, repo) {
  return item.status === "In Progress" && item.workflow !== "manual" &&
    (!item.lead || item.lead === "coordinator") &&
    new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/[0-9]+/?$`, "i").test(item.run || "");
}

function runId(item) {
  return Number(item.run.replace(/\/$/, "").split("/").pop());
}

function uniqueOwner(board, item) {
  const canonical = (run) => typeof run === "string" ? run.replace(/\/$/, "").toLowerCase() : "";
  return board.filter((i) => canonical(i.run) === canonical(item.run)).length === 1;
}

function cancelReason(entry) {
  return `Run watch ${entry.result.health}: ${entry.result.reasons.join("; ")}; ${entry.url}`.slice(0, 300);
}

function recoveryAllowed(board, item, run, repo, attempt) {
  const fresh = board.find((i) => i.id === item.id);
  return Boolean(fresh && owned(fresh, repo) && fresh.run === item.run && uniqueOwner(board, fresh) &&
    run.id === runId(fresh) && run.attempt === attempt && run.status === "completed" && run.conclusion === "cancelled");
}

// Injectable transport/state IO supports full cancellation/recovery tests offline.
async function watch(opts, io = {}) {
  const get = io.api || api;
  const boardRead = io.board || (() => JSON.parse(execFileSync(opts.boardCommand, ["--refresh", "list", "--json"], { encoding: "utf8", maxBuffer: BOARD_MAX_BUFFER })));
  const board = opts.board || boardRead();
  if (!Array.isArray(board)) throw new Error("board must be a bot-board list --json array");
  const initialState = opts.state || { version: 1, runs: {} };
  const state = opts.dryRun ? structuredClone(initialState) : initialState;
  if (state.version !== 1 || !state.runs || typeof state.runs !== "object" || Array.isArray(state.runs)) throw new Error("unusable run watch state");
  const persist = () => { if (!opts.dryRun) (io.save || (() => save(opts.stateFile, state)))(); };
  const applying = opts.apply && !opts.dryRun;
  const liveApply = applying && !opts.runsFile && !opts.offline;
  const publishHealth = liveApply && !opts.observationsFile;
  const warn = io.warn || ((s) => process.stderr.write(`${s}\n`));
  const heartbeatOptions = opts.heartbeatCommand ? { heartbeat: opts.heartbeatCommand } : {};
  let failed = false;
  const cleanupAttempts = new Set();
  const cleanup = async (entry, actions = []) => {
    if (!liveApply || entry.heartbeat_cleaned) return;
    const k = `${entry.result.repo}/${entry.result.run_id}/${entry.result.attempt}`;
    if (cleanupAttempts.has(k)) return;
    cleanupAttempts.add(k);
    let cleaned = false;
    try { cleaned = await (io.deregister || heartbeat.deregister)(`run-${entry.result.run_id}`, heartbeatOptions); } catch { /* retry from durable confirmation */ }
    entry.heartbeat_cleaned = Boolean(cleaned);
    persist();
    actions.push({ type: "heartbeat-cleanup", status: cleaned ? "applied" : "failed" });
    if (!cleaned) {
      failed = true;
      warn(`warning: run watch heartbeat cleanup for run-${entry.result.run_id} failed; a later live apply retries`);
    }
  };
  // A failed cleanup remains retryable even if watch or reconcile cleared Run.
  // Recheck the attempt: a newer rerun must retain its run-ID-named worker.
  if (liveApply) for (const [k, entry] of Object.entries(state.runs)) {
    if (!entry.cancel_confirmed || entry.heartbeat_cleaned) continue;
    if (entry.result?.repo?.toLowerCase() !== opts.repo.toLowerCase()) continue;
    try {
      const run = { ...get(`repos/${opts.repo}/actions/runs/${entry.result.run_id}`), repo: opts.repo };
      if (health.key(run) === k && run.status === "completed" && run.conclusion === "cancelled") await cleanup(entry);
    } catch {
      failed = true;
      warn(`warning: run watch could not revalidate pending heartbeat cleanup for ${entry.item}`);
    }
  }
  const candidates = board.filter((item) => owned(item, opts.repo));
  const resetSuspicion = (item) => {
    // Unknown metadata breaks continuity without losing cancellation intent.
    for (const entry of Object.values(state.runs)) {
      if (entry.item !== item.id || entry.url !== item.run) continue;
      Object.assign(entry, { health: "unknown", since: null, ready: false });
      Object.assign(entry.result, { health: "unknown", reasons: ["run metadata unavailable"],
        observed_at: null, last_activity_at: null, tokens: null,
        line: `${item.title || item.id}: run metadata unavailable` });
    }
  };
  let runs = opts.runs;
  if (!runs) {
    runs = [];
    try {
      if (candidates.length) for (let page = 1; ; page++) {
        const response = get(`repos/${opts.repo}/actions/workflows/${opts.workflow}/runs?status=in_progress&per_page=100&page=${page}`);
        runs.push(...response.workflow_runs);
        if (response.workflow_runs.length < 100) break;
      }
    } catch {
      for (const item of candidates) resetSuspicion(item);
      persist();
      throw new Error("run workflow metadata unavailable; suspicion reset");
    }
  }
  const observations = async () => {
    try {
      const data = io.observations ? await io.observations() : opts.observationsFile ? readJSON(opts.observationsFile) :
        opts.readURL ? await (async () => {
          const url = new URL(opts.readURL);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid read URL");
          const response = await fetch(url, { signal: AbortSignal.timeout(10e3), redirect: "error" });
          if (!response.ok) throw new Error("telemetry unavailable");
          return response.json();
        })() : [];
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  };
  const findObservation = (data, run) => {
    const matches = data.filter((o) => o && typeof o.repo === "string" && o.repo.toLowerCase() === run.repo.toLowerCase() && o.run_id === run.id && o.attempt === run.run_attempt);
    return matches.length === 1 ? matches[0] : null;
  };
  const collected = await observations();
  const results = [];
  for (const item of candidates) {
    // A pending cancellation is polled even after it leaves the active listing.
    let run = runs.find((r) => r.id === runId(item));
    const pending = Object.values(state.runs).some((e) => e.item === item.id && e.url === item.run && e.cancel_requested);
    if (!run && !pending) continue;
    const actions = [];
    try {
      run = run || get(`repos/${opts.repo}/actions/runs/${runId(item)}`);
      if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("unusable run identity");
      run = { ...run, repo: opts.repo };
      const k = health.key(run), previous = state.runs[k];
      if (run.status === "in_progress" && !run.jobs) {
        const jobs = get(`repos/${opts.repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
        // Fail closed rather than guess when a jobs listing is truncated.
        run.jobs = jobs.total_count > jobs.jobs.length ? [] : jobs.jobs;
      }
      const result = health.evaluate(run, findObservation(collected, run), item, opts.now, opts);
      if (!uniqueOwner(board, item)) {
        result.health = "unknown";
        result.reasons = ["run has multiple board owners"];
      }
      result.item = item.id;
      result.run = item.run;
      result.actions = actions;
      result.line = `${item.title || item.id}: run ${run.id}/${run.run_attempt} ${result.health}: ${result.reasons.join("; ")}`;
      results.push(result);
      let suspect = health.suspicion(result, previous, opts.now, opts.graceMs);
      const entry = { ...previous, ...suspect, item: item.id, url: item.run, result };
      state.runs[k] = entry;
      persist();
      if (!applying) {
        if (suspect.ready && !entry.cancel_requested) actions.push({ type: "cancel", status: "would-apply" });
        continue;
      }
      let freshRun, freshItem;
      if (run.status === "in_progress" && (publishHealth || (suspect.ready && !entry.cancel_requested))) {
        const freshBoard = boardRead();
        freshItem = freshBoard.find((i) => i.id === item.id);
        freshRun = { ...get(`repos/${opts.repo}/actions/runs/${run.id}`), repo: opts.repo };
        if (!freshItem || !owned(freshItem, opts.repo) || freshItem.run !== item.run ||
            !uniqueOwner(freshBoard, item) || health.key(freshRun) !== k) {
          actions.push({ type: "revalidation", status: "refused" });
          continue;
        }
        run = freshRun;
        if (freshRun.status === "in_progress") {
          const jobs = get(`repos/${opts.repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
          freshRun.jobs = jobs.total_count > jobs.jobs.length ? [] : jobs.jobs;
        }
        const evaluatedAt = io.now ? io.now() : opts.now;
        const freshResult = health.evaluate(freshRun, findObservation(await observations(), freshRun), freshItem, evaluatedAt, opts);
        suspect = health.suspicion(freshResult, entry, evaluatedAt, opts.graceMs);
        // Keep the returned result, state and heartbeat on the same evidence,
        // including recovery or unknown evidence found during revalidation.
        Object.assign(result, freshResult, { item: item.id, run: item.run, actions,
          line: `${item.title || item.id}: run ${run.id}/${run.run_attempt} ${freshResult.health}: ${freshResult.reasons.join("; ")}` });
        Object.assign(entry, suspect, { result });
        persist();
        if (freshRun.status === "in_progress" && publishHealth && !entry.board_applied) {
          let published = false;
          try {
            published = await (io.updateRun || heartbeat.updateRun)(freshItem, result,
              { ...heartbeatOptions, evaluatedAt: new Date(evaluatedAt).toISOString() });
          } catch { /* publication must not suppress run safety actions */ }
          if (!published) {
            actions.push({ type: "heartbeat", status: "failed" });
            warn(`warning: run watch heartbeat publication for ${item.id} failed`);
          }
        }
      }
      if (suspect.ready && !entry.cancel_requested && freshRun?.status === "in_progress") {
        entry.why = cancelReason(entry);
        // Durable at-most-once intent before POST: an ambiguous transport error
        // must not cause another cancellation on the next sweep.
        entry.cancel_requested = true;
        persist();
        (io.cancel || ((r) => gh(["-X", "POST", `repos/${r.repo}/actions/runs/${r.id}/cancel`])))(freshRun);
        actions.push({ type: "cancel", status: "requested" });
        run = { ...get(`repos/${opts.repo}/actions/runs/${run.id}`), repo: opts.repo };
      }
      if (entry.cancel_requested && !entry.board_applied && run.status === "completed" && run.conclusion === "cancelled" && health.key(run) === k) {
        entry.cancel_confirmed = true;
        persist();
        await cleanup(entry, actions);
        const freshBoard = boardRead();
        const freshItem = freshBoard.find((i) => i.id === item.id);
        if (!freshItem || !owned(freshItem, opts.repo) || freshItem.run !== item.run || !uniqueOwner(freshBoard, item)) {
          actions.push({ type: "board", status: "ownership-changed" });
          continue;
        }
        (io.set || ((id, args) => execFileSync(opts.boardCommand, ["set", id, ...args], { stdio: ["ignore", "pipe", "pipe"] })))(item.id,
          ["--status", "Todo", "--why", entry.why, "--field", "Run", "", "--news", `Run watch cancelled ${item.run}`]);
        actions.push({ type: "board", status: "applied" });
        entry.board_applied = true;
        persist();
      }
    } catch {
      failed = true;
      resetSuspicion(item);
      persist();
      actions.push({ type: "watch", status: "failed" });
      if (!results.some((r) => r.item === item.id)) results.push({ item: item.id, run: item.run, health: "unknown", reasons: ["run metadata unavailable"], actions, line: `${item.id}: run metadata unavailable` });
      // Transport errors may contain unsanitized data; never echo them.
      warn(`run watch: ${item.id} failed; retry on a later sweep`);
    }
  }
  for (const result of results) {
    if (result.actions.length) result.line += ` (${result.actions.map((a) => `${a.type}: ${a.status}`).join(", ")})`;
  }
  return { results, state, failed };
}

function reason(state, repo, id, attempt, item) {
  const entry = state.runs?.[health.key({ repo, id, run_attempt: attempt })];
  return entry?.item === item && entry.cancel_requested && entry.why ? entry.why : "";
}

async function main(argv) {
  // bin/bot-runs holds the same kernel lock and uses this private entrypoint.
  // Direct Node CLI callers also lock before reading any suspicion state.
  const locked = argv[0] === "--locked-watch";
  if (locked) argv = argv.slice(1);
  if (argv[0] === "reason") {
    try { process.stdout.write(reason(readJSON(argv[1]), argv[2], Number(argv[3]), Number(argv[4]), argv[5])); } catch { /* absent state has no watch reason */ }
    return;
  }
  if (argv[0] === "recovery-check") {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    process.exitCode = recoveryAllowed(input.board, input.item, input.run, argv[1], Number(argv[2])) ? 0 : 1;
    return;
  }
  const opts = { repo: process.env.BOT_RUNS_REPO, workflow: process.env.BOT_RUNS_WORKFLOW || "agent.yml",
    stateFile: process.env.BOT_RUNS_WATCH_STATE || path.join(process.env.XDG_STATE_HOME || path.join(require("node:os").homedir(), ".local", "state"), "bot-runs", "watch.json"), boardCommand: process.env.BOT_RUNS_BOT_BOARD,
    readURL: process.env.BOT_RUNS_WATCH_URL, observationsFile: process.env.BOT_RUNS_WATCH_OBSERVATIONS,
    heartbeatCommand: process.env.BOT_RUNS_HEARTBEAT,
    executionStep: process.env.BOT_RUNS_EXECUTION_STEP || "Run agent", now: Date.now() };
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") json = true;
    else {
      const field = { "--board-file": "boardFile", "--runs-file": "runsFile", "--observations-file": "observationsFile", "--read-url": "readURL", "--state-file": "stateFile", "--now": "now", "--stall-minutes": "stallMs", "--grace-minutes": "graceMs", "--execution-step": "executionStep" }[arg];
      if (!field || argv[i + 1] === undefined) throw new Error(`unknown or missing watch argument: ${arg}`);
      const value = argv[++i];
      opts[field] = field === "now" ? Date.parse(value) : field.endsWith("Ms") ? Number(value) * 60e3 : value;
      if (field === "now") opts.fixedNow = true;
      if ((field === "now" || field.endsWith("Ms")) && (!Number.isFinite(opts[field]) || opts[field] < 0)) throw new Error(`invalid ${arg}`);
    }
  }
  if (!locked) {
    fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true });
    const child = spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75",
      `${opts.stateFile}.lock`, process.execPath, __filename, "--locked-watch", ...argv], { stdio: "inherit" });
    if (child.error || child.signal) throw new Error("could not run the locked watch CLI");
    if (child.status === 75) process.stderr.write(`run watch: another bot-runs watch holds ${opts.stateFile}.lock\n`);
    process.exitCode = child.status;
    return;
  }
  if (opts.boardFile) opts.board = readJSON(opts.boardFile);
  if (opts.runsFile) {
    opts.runs = readJSON(opts.runsFile);
    if (!Array.isArray(opts.runs)) throw new Error("--runs-file must be an array");
    if (opts.apply && !opts.dryRun) throw new Error("offline run fixtures require report or --dry-run");
  }
  opts.state = fs.existsSync(opts.stateFile) ? readJSON(opts.stateFile) : undefined;
  const outcome = await watch(opts, { now: () => opts.fixedNow ? opts.now : Date.now() });
  process.stdout.write(json ? `${JSON.stringify(outcome.results)}\n` : outcome.results.map((r) => r.line).join("\n") + "\n");
  if (outcome.failed) process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`run watch: ${e.message}\n`); process.exitCode = 1; });

module.exports = { watch, owned, reason, recoveryAllowed, main };

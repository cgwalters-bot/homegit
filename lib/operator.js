// The operator config: who runs this bot harness (the human operator and
// the bot account) and where its work lives (forge org, tracker, board,
// devspace repository). The one loader for the Node tools; the Rust one
// (crates/bot-poll/src/operator.rs) and the shell helper (bin/operator.sh,
// through bin/bot-operator) must agree with it, which
// tests/fixtures/operator/ checks for both. Node's standard library only.
//
// The file is JSON, at $BOT_OPERATOR_CONFIG, or else
// ${XDG_CONFIG_HOME:-~/.config}/bot-harness/operator.json. Every key is
// optional: a missing file, or a missing key, means today's values
// (cgwalters's harness), and several keys default to values derived from
// others, so that an operator usually sets only operator.*, bot.login and
// forge_org. See docs/bootstrap.md.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENV_PATH = "BOT_OPERATOR_CONFIG";
const CONFIG_DIR = "bot-harness";
const CONFIG_FILE = "operator.json";

// The base values the derived ones build on.
const BASE = {
  operator: { login: "cgwalters", name: "Colin Walters", email: "walters@verbum.org" },
  bot: { login: "cgwalters-bot" },
  forge_org: "cgwalters-forge",
  devspace: { repo: "bootc-dev/cgwalters-devspace-sandbox" },
};
// The Workstream board of the default config, and the milestone boards
// of its epics (by bot-board --project name), which another board starts
// without. (The ids of its state items are in bot-board; another
// board's are board.state_items.)
const DEFAULT_BOARD = { owner_type: "orgs", owner: "cgwalters-forge", number: 1 };
const DEFAULT_EPICS = { "composefs-stable": "users/cgwalters-bot/2" };
// The default tracker's pinned "Bot heartbeat" issue (see bot-heartbeat).
const DEFAULT_TRACKER = "cgwalters-forge/tracker";
const DEFAULT_HEARTBEAT_ISSUE = 176;
// The marker that sets the bot's git email apart from the operator's.
const BOT_EMAIL_TAG = "llm";

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
// A name starts and ends with a non-space.
const NAME_RE = /^(?=\S)[^\x00-\x1f\x7f<>\u2028\u2029]{1,100}(?<=\S)$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#@!&*+,;=%-]{1,500}$/;
const HOST_PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const STATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const STATE_ITEM_RE = /^PVTI_[A-Za-z0-9_-]{1,100}$/;
const STATE_DRAFT_RE = /^DI_[A-Za-z0-9_-]{1,100}$/;
const BOARD_PATH_RE = /^(?:users|orgs)\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[1-9][0-9]{0,5}$/;
const OWNER_TYPES = ["orgs", "users"];
const MAX_NUMBER = 1e9;
// bot-board's --project name of the Workstream board, which epics can't take.
const WORKSTREAM = "workstream";

// The keys a config file may have, and each one's check; a nested
// object's keys are checked the same way.
const SCHEMA = {
  operator: { login: LOGIN_RE, name: NAME_RE, email: EMAIL_RE },
  bot: { login: LOGIN_RE, git_name: NAME_RE, git_email: EMAIL_RE, issue_repo: REPO_RE, homegit_repo: REPO_RE },
  forge_org: LOGIN_RE,
  tracker_repo: REPO_RE,
  heartbeat_issue: "number",
  board: { owner_type: OWNER_TYPES, owner: LOGIN_RE, number: "number", state_items: "state_items", epics: "epics" },
  generated_by_url: URL_RE,
  devspace: { repo: REPO_RE, host_prefix: HOST_PREFIX_RE },
};

class OperatorConfigError extends Error {}

function configPath(env = process.env) {
  if (env[ENV_PATH]) return { path: env[ENV_PATH], explicit: true };
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return { path: path.join(base, CONFIG_DIR, CONFIG_FILE), explicit: false };
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkStateItems(v, where) {
  if (!isObject(v)) throw new OperatorConfigError(`${where} must be an object of NAME: {item, draft}`);
  for (const [name, ids] of Object.entries(v)) {
    if (!STATE_NAME_RE.test(name)) throw new OperatorConfigError(`${where}: invalid state item name '${name}'`);
    if (!isObject(ids) || Object.keys(ids).sort().join() !== "draft,item" ||
        !STATE_ITEM_RE.test(ids.item) || !STATE_DRAFT_RE.test(ids.draft)) {
      throw new OperatorConfigError(`${where}.${name} must be {"item": "PVTI_...", "draft": "DI_..."}`);
    }
  }
}

function checkEpics(v, where) {
  if (!isObject(v)) throw new OperatorConfigError(`${where} must be an object of NAME: "users|orgs/OWNER/NUMBER"`);
  for (const [name, board] of Object.entries(v)) {
    if (!STATE_NAME_RE.test(name) || name === WORKSTREAM) throw new OperatorConfigError(`${where}: invalid board name '${name}'`);
    if (typeof board !== "string" || !BOARD_PATH_RE.test(board)) throw new OperatorConfigError(`${where}.${name} must be "users/OWNER/NUMBER" or "orgs/OWNER/NUMBER", not ${JSON.stringify(board)}`);
  }
}

function checkValue(check, v, where) {
  if (check === "number") {
    if (!Number.isInteger(v) || v < 1 || v > MAX_NUMBER) throw new OperatorConfigError(`${where} must be a positive integer, not ${JSON.stringify(v)}`);
  } else if (check === "state_items") {
    checkStateItems(v, where);
  } else if (check === "epics") {
    checkEpics(v, where);
  } else if (Array.isArray(check)) {
    if (!check.includes(v)) throw new OperatorConfigError(`${where} must be one of ${check.join(", ")}, not ${JSON.stringify(v)}`);
  } else if (typeof v !== "string" || !check.test(v)) {
    throw new OperatorConfigError(`${where} is invalid: ${JSON.stringify(v)}`);
  }
}

// validate(CONFIG): throws on unknown keys (a typo would otherwise
// silently fall back to cgwalters's values) and on invalid values.
function validate(config, schema = SCHEMA, prefix = "") {
  if (!isObject(config)) throw new OperatorConfigError(`${prefix || "the config"} must be a JSON object`);
  for (const [k, v] of Object.entries(config)) {
    const where = prefix + k;
    if (!Object.hasOwn(schema, k)) throw new OperatorConfigError(`unknown key '${where}'; valid: ${Object.keys(schema).map((s) => prefix + s).join(", ")}`);
    if (isObject(schema[k]) && !(schema[k] instanceof RegExp)) validate(v, schema[k], `${where}.`);
    else checkValue(schema[k], v, where);
  }
}

// botEmail(EMAIL): the operator's email with a +llm tag, which is what
// marks the bot's commits (see bin/bot-git).
function botEmail(email) {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, at)}+${BOT_EMAIL_TAG}${email.slice(at)}`;
}

// resolve(CONFIG): the full config, with the defaults filled in.
function resolve(config) {
  validate(config);
  const c = (k) => config[k] || {};
  const operator = { ...BASE.operator, ...c("operator") };
  const botLogin = c("bot").login || BASE.bot.login;
  const bot = {
    login: botLogin,
    git_name: operator.name,
    git_email: botEmail(operator.email),
    issue_repo: `${botLogin}/${botLogin}`,
    homegit_repo: `${botLogin}/homegit`,
    ...c("bot"),
  };
  const forgeOrg = config.forge_org || BASE.forge_org;
  const board = {
    owner_type: DEFAULT_BOARD.owner_type,
    owner: forgeOrg,
    number: DEFAULT_BOARD.number,
    ...c("board"),
  };
  const isDefault = ["owner_type", "owner", "number"].every((k) => board[k] === DEFAULT_BOARD[k]);
  board.state_items = { ...c("board").state_items };
  if (!Object.hasOwn(board, "epics")) board.epics = isDefault ? DEFAULT_EPICS : {};
  const trackerRepo = config.tracker_repo || `${forgeOrg}/tracker`;
  const devspaceRepo = c("devspace").repo || BASE.devspace.repo;
  const devspace = {
    repo: devspaceRepo,
    // cgwalters-devspace-sandbox names its runners cgwalters-devspace-NAME.
    host_prefix: `${devspaceRepo.split("/")[1].replace(/-sandbox$/, "")}-`.toLowerCase(),
    ...c("devspace"),
  };
  checkValue(HOST_PREFIX_RE, devspace.host_prefix, "devspace.host_prefix (derived from devspace.repo; set it)");
  // The trust split: the bot must never pass for the operator.
  if (operator.login.toLowerCase() === bot.login.toLowerCase()) throw new OperatorConfigError("bot.login must differ from operator.login");
  if (operator.email.toLowerCase() === bot.git_email.toLowerCase()) throw new OperatorConfigError("bot.git_email must differ from operator.email");
  return deepFreeze({
    operator,
    bot,
    forge_org: forgeOrg,
    tracker_repo: trackerRepo,
    // null: there is none yet (bot-heartbeat says to set it).
    heartbeat_issue: config.heartbeat_issue || (trackerRepo === DEFAULT_TRACKER ? DEFAULT_HEARTBEAT_ISSUE : null),
    board,
    generated_by_url: config.generated_by_url || `https://github.com/${operator.login}/#llms`,
    devspace,
  });
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (isObject(v)) deepFreeze(v);
  return Object.freeze(o);
}

// load({env}): the operator config of this environment. A missing file
// is the defaults, unless $BOT_OPERATOR_CONFIG names it.
function load({ env = process.env } = {}) {
  const { path: file, explicit } = configPath(env);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" && !explicit) return resolve({});
    throw new OperatorConfigError(`cannot read the operator config ${file}: ${e.message}`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new OperatorConfigError(`the operator config ${file} is not valid JSON: ${e.message}`);
  }
  try {
    return resolve(config);
  } catch (e) {
    if (e instanceof OperatorConfigError) e.message = `${file}: ${e.message}`;
    throw e;
  }
}

// possessive(LOGIN): "cgwalters'" or "jmarrero's", for messages.
function possessive(login) {
  return login.endsWith("s") ? `${login}'` : `${login}'s`;
}

// loadOrExit(PROG): load(), or exit 1 with the error, for the tools'
// startup.
function loadOrExit(prog, opts) {
  try {
    return load(opts);
  } catch (e) {
    if (!(e instanceof OperatorConfigError)) throw e;
    process.stderr.write(`${prog}: error: ${e.message}\n`);
    process.exit(1);
  }
}

// boardUrl(CONFIG) and boardPath(CONFIG): the Workstream board's web URL
// and its KIND/OWNER/NUMBER (as bot-board --project takes it).
function boardPath(config) {
  return `${config.board.owner_type}/${config.board.owner}/${config.board.number}`;
}

function boardUrl(config) {
  return `https://github.com/${config.board.owner_type}/${config.board.owner}/projects/${config.board.number}`;
}

module.exports = { load, loadOrExit, resolve, configPath, boardPath, boardUrl, possessive, OperatorConfigError, ENV_PATH };

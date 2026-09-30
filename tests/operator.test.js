// Offline tests of lib/operator.js and bin/bot-operator. The cases in
// fixtures/operator/cases.json are shared with the Rust loader
// (crates/bot-poll/src/operator.rs). Run with tests/operator.sh,
// or node --test tests/operator.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const operator = require(path.join(__dirname, "..", "lib", "operator.js"));
const TOOL = path.join(__dirname, "..", "bin", "bot-operator");
const CASES = require(path.join(__dirname, "fixtures", "operator", "cases.json"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "operator-test-"));
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const write = (name, config) => {
  const file = path.join(WORK, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  return file;
};

test("the shared cases", () => {
  for (const c of CASES) {
    if (c.expect) assert.deepEqual(JSON.parse(JSON.stringify(operator.resolve(c.config))), c.expect, c.name);
    else assert.throws(() => operator.resolve(c.config), operator.OperatorConfigError, c.name);
  }
});

test("the defaults are today's harness", () => {
  const c = operator.resolve({});
  assert.equal(c.operator.login, "cgwalters");
  assert.equal(c.bot.git_email, "walters+llm@verbum.org");
  assert.equal(operator.boardUrl(c), "https://github.com/orgs/cgwalters-forge/projects/1");
  assert.equal(operator.boardPath(c), "orgs/cgwalters-forge/1");
  assert.throws(() => { c.operator.login = "x"; }, TypeError, "frozen");
});

test("where the config is read from", () => {
  const cases = [
    [{ HOME: "/h" }, "/h/.config/bot-harness/operator.json", false],
    [{ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "/x/bot-harness/operator.json", false],
    [{ HOME: "/h", XDG_CONFIG_HOME: "" }, "/h/.config/bot-harness/operator.json", false],
    [{ HOME: "/h", BOT_OPERATOR_CONFIG: "/c.json" }, "/c.json", true],
  ];
  for (const [env, file, explicit] of cases) assert.deepEqual(operator.configPath(env), { path: file, explicit }, JSON.stringify(env));
});

test("load", () => {
  const home = path.join(WORK, "home");
  assert.equal(operator.load({ env: { HOME: home } }).operator.login, "cgwalters", "no file: the defaults");
  write("home/.config/bot-harness/operator.json", { operator: { login: "jmarrero" } });
  assert.equal(operator.load({ env: { HOME: home } }).operator.login, "jmarrero");
  const cases = [
    [path.join(WORK, "missing.json"), /cannot read the operator config/],
    [write("bad.json", "{"), /is not valid JSON/],
    [write("typo.json", { bot: { logn: "x" } }), /typo\.json: unknown key 'bot\.logn'; valid: bot\.login,/],
    [write("invalid.json", { board: { number: -1 } }), /board\.number must be a positive integer/],
  ];
  for (const [file, re] of cases) {
    assert.throws(() => operator.load({ env: { HOME: home, BOT_OPERATOR_CONFIG: file } }), re, file);
  }
});

test("possessive", () => {
  assert.equal(operator.possessive("cgwalters"), "cgwalters'");
  assert.equal(operator.possessive("jmarrero"), "jmarrero's");
});

test("bot-operator", () => {
  const env = { ...process.env, BOT_OPERATOR_CONFIG: write("cli.json", { operator: { login: "jmarrero" }, forge_org: "jf" }) };
  const run = (...args) => execFileSync(TOOL, args, { env, encoding: "utf8" });
  assert.equal(run("get", "operator.login"), "jmarrero\n");
  assert.equal(run("get", "board.epics"), "{}\n");
  assert.equal(run("path"), `${env.BOT_OPERATOR_CONFIG}\n`);
  assert.equal(JSON.parse(run()).tracker_repo, "jf/tracker");
  assert.match(run("--shell"), /^OP_TRACKER_REPO='jf\/tracker'$/m);
  assert.throws(() => run("get", "operator.nope"), (e) => e.status === 2 && /no key 'operator\.nope'/.test(e.stderr));
  assert.throws(() => run("frob"), (e) => e.status === 2);
});

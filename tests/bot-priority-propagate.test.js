// Offline tests of bin/bot-priority-propagate against the fake gh of
// bot-priority-health's tests (REST fixtures) and a fake bot-board that
// logs its writes. Run with tests/bot-priority-propagate.sh, or
// node --test tests/bot-priority-propagate.test.js.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-priority-propagate");
const FAKE_GH = path.join(__dirname, "fixtures", "bot-priority-health", "fake-gh");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bot-priority-propagate-test-"));
const REST = path.join(WORK, "rest");
const LOG = path.join(WORK, "bot-board.log");
const FAKE_BOT_BOARD = path.join(WORK, "bot-board");
const ENV = {
  ...process.env, XDG_CACHE_HOME: path.join(WORK, "cache"), FAKE_GH_DIR: REST, BOT_PRIORITY_HEALTH_GH: FAKE_GH,
  BOT_PRIORITY_PROPAGATE_BOT_BOARD: FAKE_BOT_BOARD, FAKE_BOT_BOARD_LOG: LOG,
};
const GH = "https://github.com";
const REPO = "example/r";
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// The fake bot-board: logs its arguments; 'add' prints a new item id.
fs.writeFileSync(FAKE_BOT_BOARD, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.FAKE_BOT_BOARD_LOG, args.join(" ") + "\\n");
if (args[0] === "add") process.stdout.write("PVTI_new_" + args[args.length - 1].split("/").pop() + "\\n");
`, { mode: 0o755 });

const put = (p, data) => {
  fs.mkdirSync(path.dirname(path.join(REST, p)), { recursive: true });
  fs.writeFileSync(path.join(REST, `${p}.json`), JSON.stringify(data));
};
const issueUrl = (n) => `${GH}/${REPO}/issues/${n}`;
const prUrl = (n) => `${GH}/${REPO}/pull/${n}`;
// item(n, fields): a board item for issue n (type "PullRequest" for PR n).
const item = (n, { type = "Issue", ...f } = {}) => ({
  id: `PVTI_${type[0]}${n}`, title: `item ${n}`, content: { type, url: type === "Issue" ? issueUrl(n) : prUrl(n) }, ...f,
});
// api(n, state): what GitHub says about issue or PR n.
const api = (n, state = "open") => put(`repos/${REPO}/issues/${n}`, { number: n, state });
const subs = (n, children) => put(`repos/${REPO}/issues/${n}/sub_issues`,
  children.map(([c, state = "open"]) => ({ number: c, state, html_url: issueUrl(c) })));

function exec(setup, board, ...args) {
  fs.rmSync(REST, { recursive: true, force: true });
  fs.rmSync(path.join(WORK, "cache"), { recursive: true, force: true });
  fs.rmSync(LOG, { force: true });
  setup();
  const file = path.join(WORK, "board.json");
  fs.writeFileSync(file, JSON.stringify(board));
  const r = spawnSync(TOOL, ["--board-file", file, "--json", ...args], { env: ENV, encoding: "utf8" });
  const calls = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null, calls };
}

test("a lower or unset Branch child is raised; a higher one is untouched", () => {
  const r = exec(() => {
    [2, 3, 4].forEach((n) => api(n));
  }, [
    item(1, { priority: "P0", branch: `${issueUrl(2)} ${issueUrl(3)} ${issueUrl(4)}` }),
    item(2, { priority: "P2" }), item(3, { priority: "P0" }), item(4, {}),
  ], "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.map((c) => [c.action, c.url, c.from, c.to, c.result]), [
    ["raised", issueUrl(2), "P2", "P0", "applied"],
    ["raised", issueUrl(4), null, "P0", "applied"],
  ]);
  assert.deepEqual(r.calls, ["set PVTI_I2 --priority P0", "set PVTI_I4 --priority P0"]);
  assert.match(r.out[0].line, /^raised .*issues\/2 P2 -> P0 \(under .*issues\/1\)$/);
});

test("P1 children of a P0 parent become P0, never lower; P1 parents come second", () => {
  const r = exec(() => {
    [2, 4, 5].forEach((n) => api(n));
  }, [
    item(1, { priority: "P0", branch: issueUrl(2) }), item(2, { priority: "P1" }),
    item(3, { priority: "P1", branch: `${issueUrl(4)} ${issueUrl(5)}` }), item(4, { priority: "P2" }), item(5, { priority: "P0" }),
  ], "--apply");
  assert.deepEqual(r.out.map((c) => [c.url, c.from, c.to]), [
    [issueUrl(2), "P1", "P0"], [issueUrl(4), "P2", "P1"],
  ]);
});

test("a child in Branch is raised and the parent's Theme copied when it has none", () => {
  const r = exec(() => {
    api(7);
    api(8);
  }, [
    item(1, { priority: "P0", theme: "devspace", branch: `${prUrl(7)} ${GH}/${REPO}/compare/x...y ${prUrl(8)}` }),
    item(7, { type: "PullRequest", priority: "P1", status: "Draft" }),
    item(8, { type: "PullRequest", priority: "P2", theme: "harness" }),
  ], "--apply");
  assert.deepEqual(r.calls, ["set PVTI_P7 --priority P0 --field Theme devspace", "set PVTI_P8 --priority P0"]);
});

test("a sub-issue already on the board keeps its priority, even P2 under a P0 parent", () => {
  const r = exec(() => {
    subs(1, [[2], [3], [4]]);
    [2, 3, 4].forEach((n) => api(n));
  }, [
    item(1, { priority: "P0" }), item(2, { priority: "P2" }), item(3, { priority: "P1" }), item(4, {}),
  ], "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, []);
  assert.deepEqual(r.calls, []);
});

test("a sub-issue that is also in Branch is raised as a Branch child", () => {
  const r = exec(() => {
    subs(1, [[2]]);
    api(2);
  }, [item(1, { priority: "P0", branch: issueUrl(2) }), item(2, { priority: "P2" })], "--apply");
  assert.deepEqual(r.out.map((c) => [c.action, c.url, c.from, c.to]), [["raised", issueUrl(2), "P2", "P0"]]);
});

test("a child missing from the board is added with the parent's Theme", () => {
  const r = exec(() => {
    subs(1, [[2]]);
    api(2);
    api(9);
  }, [item(1, { priority: "P0", theme: "devspace", branch: prUrl(9) })], "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.map((c) => [c.action, c.url, c.to, c.theme]), [
    ["added", prUrl(9), "P0", "devspace"], ["added", issueUrl(2), "P0", "devspace"],
  ]);
  assert.deepEqual(r.calls, [
    `add --priority P0 ${prUrl(9)}`, "set PVTI_new_9 --field Theme devspace",
    `add --priority P0 ${issueUrl(2)}`, "set PVTI_new_2 --field Theme devspace",
  ]);
});

test("Done on the board, and closed or merged on GitHub, are skipped", () => {
  const r = exec(() => {
    subs(1, [[2], [3, "closed"]]);
    api(2);
    api(6, "closed");
    api(7);
  }, [
    item(1, { priority: "P0", branch: `${prUrl(6)} ${prUrl(7)} ${prUrl(5)}` }),
    item(2, { priority: "P2", status: "Done" }), item(3, { priority: "P2" }),
    item(7, { type: "PullRequest", priority: "P2", status: "Done" }),
  ], "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, []);
  assert.deepEqual(r.calls, []);
});

test("a Done parent propagates nothing; --dry-run and the default change nothing", () => {
  for (const args of [["--dry-run"], []]) {
    const r = exec(() => {
      api(2);
      api(4);
    }, [
      item(1, { priority: "P0", status: "Done", branch: issueUrl(2) }), item(2, { priority: "P2" }),
      item(3, { priority: "P0", branch: issueUrl(4) }), item(4, { priority: "P2" }),
    ], ...args);
    assert.deepEqual(r.out.map((c) => [c.url, c.result]), [[issueUrl(4), "planned"]]);
    assert.deepEqual(r.calls, []);
  }
});

test("a raised child's own Branch children follow, and a second run finds nothing", () => {
  const board = [item(1, { priority: "P0", branch: issueUrl(2) }), item(2, { priority: "P2", branch: issueUrl(3) }), item(3, {})];
  const setup = () => {
    api(2);
    api(3);
  };
  const r = exec(setup, board, "--apply");
  assert.deepEqual(r.out.map((c) => [c.url, c.to]), [[issueUrl(2), "P0"], [issueUrl(3), "P0"]]);
  const again = exec(setup, board.map((i) => ({ ...i, priority: "P0" })), "--apply");
  assert.deepEqual(again.out, []);
});

test("a failing bot-board is reported, and the others go on", () => {
  fs.writeFileSync(FAKE_BOT_BOARD, fs.readFileSync(FAKE_BOT_BOARD, "utf8").replace(
    'if (args[0] === "add")', 'if (args[1] === "PVTI_I2") { process.stderr.write("boom\\n"); process.exit(1); }\nif (args[0] === "add")'));
  const r = exec(() => {
    api(2);
    api(3);
  }, [item(1, { priority: "P0", branch: `${issueUrl(2)} ${issueUrl(3)}` }), item(2, { priority: "P2" }), item(3, { priority: "P2" })], "--apply");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boom/);
});

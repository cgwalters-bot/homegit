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

test("a child missing from the board is added with the parent's Theme, unless it is a Branch PR", () => {
  const r = exec(() => {
    subs(1, [[2]]);
    api(2);
    api(9);
  }, [item(1, { priority: "P0", theme: "devspace", branch: `${prUrl(8)} ${issueUrl(9)}` })], "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.map((c) => [c.action, c.url, c.to, c.theme]), [
    ["added", issueUrl(9), "P0", "devspace"], ["added", issueUrl(2), "P0", "devspace"],
  ]);
  assert.deepEqual(r.calls, [
    `add --priority P0 ${issueUrl(9)}`, "set PVTI_new_9 --field Theme devspace",
    `add --priority P0 ${issueUrl(2)}`, "set PVTI_new_2 --field Theme devspace",
  ]);
});

// A P0 parent's Branch holds PR 7 (or issue 7); the case adds item 7 to the
// board as it says, and the expected change (or none).
for (const [name, child, expected] of [
  ["a Branch PR not on the board is not added (the parent records it)", null, []],
  ["a Branch PR on the board as itself is raised", item(7, { type: "PullRequest", priority: "P2", status: "Draft" }), [["raised", prUrl(7)]]],
  ["a Branch PR twin with only a Priority is raised, not duplicated", item(7, { type: "PullRequest", priority: "P1" }), [["raised", prUrl(7)]]],
]) {
  test(name, () => {
    const r = exec(() => api(7), [item(1, { priority: "P0", branch: prUrl(7) }), ...(child ? [child] : [])], "--apply");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.map((c) => [c.action, c.url]), expected);
    assert.ok(!r.calls.some((c) => c.startsWith("add ")), r.calls.join("\n"));
  });
}

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

// --dedupe: each case is a board (item 1 an open tracker parent whose
// Branch records PR 7 unless the case says otherwise) and the expected
// [action, url, fields] lines; it reads nothing from GitHub.
const parent = (f = {}) => item(1, { status: "In Progress", priority: "P0", branch: prUrl(7), ...f });
const pr7 = (f = {}) => item(7, { type: "PullRequest", ...f });
for (const [name, board, expected] of [
  ["a twin with only a Priority is archived", [parent(), pr7({ priority: "P0" })], [["archived", prUrl(7), []]]],
  ["a twin with Org and Theme too is archived", [parent(), pr7({ priority: "P1", org: "bootc-dev", theme: "x", labels: [] })],
    [["archived", prUrl(7), []]]],
  ["a PR item with its own Status is kept", [parent(), pr7({ priority: "P0", status: "Draft" })], [["kept", prUrl(7), ["status"]]]],
  ["a PR item with a Why or Lead is kept", [parent(), pr7({ why: "w", lead: "wfc", news: "" })], [["kept", prUrl(7), ["lead", "why"]]]],
  ["a PR in only a Done item's Branch is no twin", [parent({ status: "Done" }), pr7({ priority: "P0" })], []],
  ["a Done PR item is left alone", [parent(), pr7({ status: "Done" })], []],
  ["a PR item in no Branch is no twin", [parent({ branch: "" }), pr7({ priority: "P0" })], []],
  ["an issue item in a Branch is no twin", [parent({ branch: issueUrl(7) }), item(7, { priority: "P0" })], []],
  ["an item's own URL in its Branch is no twin", [pr7({ priority: "P0", branch: prUrl(7) })], []],
]) {
  test(`--dedupe: ${name}`, () => {
    const r = exec(() => {}, board, "--dedupe", "--apply");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.map((t) => [t.action, t.url, t.fields]), expected);
    const archived = r.out.filter((t) => t.action === "archived");
    assert.deepEqual(r.calls, archived.map((t) => `archive ${t.id}`));
    for (const t of archived) assert.equal(t.line, `archived ${t.url} (in Branch of ${issueUrl(1)})`);
  });
}

test("--dedupe plans only by default and with --dry-run, and lists kept twins", () => {
  for (const args of [["--dry-run"], []]) {
    const r = exec(() => {}, [parent({ branch: `${prUrl(7)} ${prUrl(8)}` }), pr7({ priority: "P0" }),
      item(8, { type: "PullRequest", status: "Draft", why: "w" })], "--dedupe", ...args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.map((t) => [t.action, t.result]), [["archived", "planned"], ["kept", "planned"]]);
    assert.equal(r.out[1].line, `kept ${prUrl(8)}: has status, why (in Branch of ${issueUrl(1)})`);
    assert.deepEqual(r.calls, []);
  }
});

test("--dedupe reports a failed archive and goes on", () => {
  const saved = fs.readFileSync(FAKE_BOT_BOARD, "utf8");
  fs.writeFileSync(FAKE_BOT_BOARD, saved.replace(
    'if (args[0] === "add")', 'if (args[1] === "PVTI_P7") { process.stderr.write("boom\\n"); process.exit(1); }\nif (args[0] === "add")'));
  try {
    const r = exec(() => {}, [parent({ branch: `${prUrl(7)} ${prUrl(8)}` }), pr7({ priority: "P0" }),
      item(8, { type: "PullRequest", priority: "P0" })], "--dedupe", "--apply");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /boom/);
    assert.deepEqual(r.calls, ["archive PVTI_P7", "archive PVTI_P8"]);
  } finally {
    fs.writeFileSync(FAKE_BOT_BOARD, saved);
  }
});

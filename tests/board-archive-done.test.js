"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fixtures = require("./fixtures/bot-board/archive-done.json");
const { DEFAULT_DAYS: DAYS, MAX_ARCHIVES, eligible, parseArgs, archiveDone } = require("../lib/board-archive-done.js");
const NOW = Date.parse("2026-02-01T00:00:00Z");

for (const fixture of fixtures) {
  test(fixture.name, () => {
    assert.equal(eligible(fixture, fixture.children || [], NOW - DAYS * 86400000), fixture.expected);
  });
}

test("retention options are read-only by default and reject invalid ages", () => {
  assert.deepEqual(parseArgs([]), { days: 3, dryRun: true });
  assert.deepEqual(parseArgs(["--days", "30", "--apply"]), { days: 30, dryRun: false });
  for (const value of ["-1", "1.5", "no", "9007199254740992"]) assert.throws(() => parseArgs(["--days", value]));
  assert.throws(() => parseArgs(["--days"]));
});

test("fixture observations archive only eligible Done items in deterministic order", async () => {
  const items = fixtures.map((f, i) => ({ id: `PVTI_${String(i).padStart(2, "0")}`, status: "Done",
    content: { type: i === 1 ? "PullRequest" : "Issue", url: `https://github.com/example/repo/${i === 1 ? "pull" : "issues"}/${i + 1}` } }));
  items.push({ id: "PVTI_open", status: "In Progress" }, { id: "PVTI_draft", status: "Done", content: { type: "DraftIssue" } });
  for (const dryRun of [true, false]) {
    const archived = [];
    const run = (cmd, args) => {
      if (cmd === "board" && args.includes("list")) return JSON.stringify([...items].reverse());
      if (cmd === "board") {
        assert.equal(args[2], "archive");
        archived.push(args[3]);
        return "";
      }
      assert.equal(cmd, "gh");
      const endpoint = args.at(-1);
      const index = Number(/\/(\d+)(?:\/sub_issues.*)?$/.exec(endpoint)[1]) - 1;
      return JSON.stringify(endpoint.includes("sub_issues") ? [[], fixtures[index].children || []] : fixtures[index]);
    };
    const result = await archiveDone("board", "workstream", { days: DAYS, dryRun }, run, NOW);
    assert.deepEqual(archived, dryRun ? [] : ["PVTI_00", "PVTI_01", "PVTI_11"]);
    assert.deepEqual(result, { archived: dryRun ? 0 : 3, eligible: 3, dry_run: dryRun });
  }
});

test("a backlog is archived a limited number per run", async () => {
  const n = MAX_ARCHIVES + 5;
  const items = Array.from({ length: n }, (_, i) => ({ id: `PVTI_${String(i).padStart(4, "0")}`, status: "Done",
    content: { type: "PullRequest", url: `https://github.com/example/repo/pull/${i + 1}` } }));
  const archived = [];
  const run = (cmd, args) => {
    if (cmd === "board" && args.includes("list")) return JSON.stringify(items);
    if (cmd === "board") return archived.push(args[3]);
    return JSON.stringify(fixtures[1]);
  };
  assert.deepEqual(await archiveDone("board", "workstream", { days: DAYS, dryRun: false }, run, NOW), { archived: MAX_ARCHIVES, eligible: n, dry_run: false });
  assert.deepEqual(archived, items.slice(0, MAX_ARCHIVES).map((i) => i.id));
});

test("an item whose issue is gone stays, and the others are still archived", async () => {
  const item = (n) => ({ id: `PVTI_${n}`, status: "Done", content: { type: "PullRequest", url: `https://github.com/example/repo/pull/${n}` } });
  const archived = [];
  const run = (cmd, args) => {
    if (cmd === "board" && args.includes("list")) return JSON.stringify([item(1), item(2)]);
    if (cmd === "board") return archived.push(args[3]);
    if (args.at(-1).endsWith("/1")) throw Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)\n" });
    return JSON.stringify(fixtures[1]);
  };
  assert.deepEqual(await archiveDone("board", "workstream", { days: DAYS, dryRun: false }, run, NOW), { archived: 1, eligible: 1, dry_run: false });
  assert.deepEqual(archived, ["PVTI_2"]);
});

test("failed sub-issue observations prevent all mutations", async () => {
  const item = (n) => ({ id: `PVTI_${n}`, status: "Done", content: { type: "Issue", url: `https://github.com/example/repo/issues/${n}` } });
  let mutations = 0;
  const run = (cmd, args) => {
    if (cmd === "board" && args.includes("list")) return JSON.stringify([item(1), item(2)]);
    if (cmd === "board") { mutations++; return ""; }
    if (args.at(-1).includes("/2/sub_issues")) throw new Error("lookup failed");
    return JSON.stringify(args.at(-1).includes("sub_issues") ? [[]] : fixtures[0]);
  };
  await assert.rejects(archiveDone("board", "workstream", { days: DAYS, dryRun: false }, run, NOW), /lookup failed/);
  assert.equal(mutations, 0);
});

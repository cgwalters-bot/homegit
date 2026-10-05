"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { addOption, parseArgs, FIELD, ITEMS, UPDATE, SET, CLEAR } = require("../lib/board-option-add.js");

// Fake GraphQL server: paginated reads, regenerated ids, and values cleared
// or reassigned as a side effect of replacing the option list.
function server(mode = "clear") {
  let options = [
    { id: "old-a", name: "other", color: "GRAY", description: "Fallback" },
    { id: "old-b", name: "coreos", color: "BLUE", description: "Core OS" },
  ];
  const values = new Map([["item-a", "other"], ["item-b", "coreos"], ["item-c", null]]);
  const calls = [];
  const gql = (query, vars) => {
    calls.push({ query, vars });
    if (query === FIELD) return { node: { fields: {
      nodes: [{ id: "field", name: "Org", options }], pageInfo: { hasNextPage: false },
    } } };
    if (query === ITEMS) {
      const start = vars.after ? Number(vars.after) : 0;
      return { node: { items: {
        nodes: [...values].slice(start, start + 2).map(([id, name]) => ({ id, value: name === null ? null : { name } })),
        pageInfo: { hasNextPage: start === 0, endCursor: "2" },
      } } };
    }
    const input = vars.input;
    if (query === UPDATE) {
      assert.deepEqual(input.singleSelectOptions.slice(0, 2), options.map(({ name, color, description }) => ({ name, color, description })));
      options = input.singleSelectOptions.map((o, i) => ({ ...o, id: `new-${i}` }));
      if (mode !== "keep") for (const id of values.keys()) values.set(id, mode === "change" ? "cgwalters" : null);
    } else if (query === SET) {
      assert.match(input.value.singleSelectOptionId, /^new-/);
      if (mode !== "ignore") values.set(input.itemId, options.find((o) => o.id === input.value.singleSelectOptionId).name);
    } else if (query === CLEAR) values.set(input.itemId, null);
    else throw new Error("unexpected GraphQL query");
    return {};
  };
  return { gql, calls, values };
}

for (const mode of ["clear", "change", "keep"]) {
  test(`preserve names when update ${mode}s values and regenerates ids`, () => {
    const fake = server(mode);
    let saved;
    addOption("project", parseArgs(["Org", "cgwalters", "--color", "GREEN"]), fake.gql,
      (data) => { saved = data; return "snapshot"; }, () => {});
    assert.deepEqual([...fake.values], [["item-a", "other"], ["item-b", "coreos"], ["item-c", null]]);
    assert.deepEqual(saved.items, [...fake.values]);
    assert.equal(fake.calls.filter((c) => c.query === SET).length, mode === "keep" ? 0 : 2);
    assert.equal(fake.calls.filter((c) => c.query === CLEAR).length, mode === "change" ? 1 : 0);
  });
}

test("verification fails loudly if restoration is silently ignored", () => {
  const fake = server("ignore");
  assert.throws(() => addOption("project", parseArgs(["Org", "cgwalters"]), fake.gql, () => "snapshot", () => {}),
    /restoration failed:.*item-a.*recover using snapshot/);
  assert.equal(fake.calls.filter((c) => c.query === SET).length, 2);
});

test("dry-run snapshots every page but performs no mutations or disk writes", () => {
  const fake = server();
  const output = [];
  addOption("project", parseArgs(["Org", "cgwalters", "--dry-run"]), fake.gql,
    () => assert.fail("snapshot on dry-run"), (line) => output.push(line));
  assert.ok(fake.calls.every((c) => c.query === FIELD || c.query === ITEMS));
  assert.match(output.join("\n"), /3 item values/);
  assert.match(output.join("\n"), /Fallback/);
});

test("existing option is an idempotent no-op", () => {
  const fake = server();
  addOption("project", parseArgs(["Org", "other"]), fake.gql, () => assert.fail(), () => {});
  assert.equal(fake.calls.length, 1);
});

test("invalid arguments and non-select fields fail before any update", () => {
  for (const args of [["Org"], ["Org", "new", "--color"], ["Org", "new", "--color", "BAD"], ["", "new"]]) {
    assert.throws(() => parseArgs(args));
  }
  const fake = server();
  assert.throws(() => addOption("project", parseArgs(["Text", "new"]), fake.gql), /single-select/);
  assert.equal(fake.calls.length, 1);
});

test("a failed recovery snapshot prevents destructive mutation", () => {
  const fake = server();
  assert.throws(() => addOption("project", parseArgs(["Org", "new"]), fake.gql,
    () => { throw new Error("disk full"); }, () => {}), /disk full/);
  assert.ok(fake.calls.every((c) => c.query === FIELD || c.query === ITEMS));
});

test("CLI sends GraphQL variables through fake gh and invalidates cached ids", () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), "board-option-test-"));
  try {
    const script = path.join(dir, "fake.js");
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      const file = process.env.FAKE_STORE;
      const state = JSON.parse(fs.readFileSync(file));
      if (process.argv[2] === 'project') { console.log('project'); process.exit(0); }
      const {query, variables: v} = JSON.parse(fs.readFileSync(0, 'utf8'));
      let data = {};
      if (query.includes('fields(first:')) data = {node: {fields: {nodes: [state.field], pageInfo: {hasNextPage: false}}}};
      else if (query.includes('items(first:')) data = {node: {items: {nodes: [{id: 'item', value: state.value ? {name: state.value} : null}], pageInfo: {hasNextPage: false}}}};
      else if (query.includes('updateProjectV2Field(input:')) {
        state.field.options = v.input.singleSelectOptions.map((o, i) => ({...o, id: 'new-' + i}));
        state.value = null;
      } else if (query.includes('updateProjectV2ItemFieldValue(input:')) {
        state.value = state.field.options.find(o => o.id === v.input.value.singleSelectOptionId).name;
      } else throw Error('unexpected query');
      fs.writeFileSync(file, JSON.stringify(state));
      console.log(JSON.stringify({data}));
    `);
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    const store = path.join(dir, "store.json");
    fs.writeFileSync(store, JSON.stringify({ field: { id: "field", name: "Org", options: [
      { id: "old", name: "other", color: "GRAY", description: "fallback" },
    ] }, value: "other" }));
    const cache = path.join(dir, "cache/bot-board/orgs/example/1");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "fields.json"), "stale");
    fs.writeFileSync(path.join(cache, "items.json"), "stale");
    const result = spawnSync("bash", [path.resolve(__dirname, "../bin/bot-board"), "--project", "orgs/example/1", "option-add", "Org", "cgwalters"], {
      encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir,
        XDG_CACHE_HOME: path.join(dir, "cache"), XDG_STATE_HOME: path.join(dir, "state"), FAKE_STORE: store },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified all 1 original item values/);
    assert.equal(JSON.parse(fs.readFileSync(store)).value, "other");
    assert.equal(fs.existsSync(path.join(cache, "fields.json")), false);
    assert.equal(fs.existsSync(path.join(cache, "items.json")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

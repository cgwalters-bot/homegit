// Adding a select option replaces the option list. Preserve values by name,
// not id, and keep a durable recovery snapshot before the destructive call.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"];
const FIELD = `query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 { fields(first: 100, after: $after) {
    nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField {
      id name options { id name color description } } }
    pageInfo { hasNextPage endCursor }
  } } }
}`;
const ITEMS = `query($id: ID!, $field: String!, $after: String) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
    nodes { id value: fieldValueByName(name: $field) {
      ... on ProjectV2ItemFieldSingleSelectValue { name } } }
    pageInfo { hasNextPage endCursor }
  } } }
}`;
const UPDATE = `mutation($input: UpdateProjectV2FieldInput!) {
  updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
}`;
const SET = `mutation($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;
const CLEAR = `mutation($input: ClearProjectV2ItemFieldValueInput!) {
  clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;

function graphql(query, variables) {
  const result = JSON.parse(execFileSync("gh", ["api", "graphql", "--input", "-"], {
    input: JSON.stringify({ query, variables }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }));
  if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
  if (!result.data) throw new Error("GraphQL returned no data");
  return result.data;
}

function parseArgs(args) {
  const opts = { color: "GRAY", dryRun: false, names: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") opts.dryRun = true;
    else if (args[i] === "--color") opts.color = args[++i];
    else if (args[i].startsWith("--color=")) opts.color = args[i].slice(8);
    else if (args[i].startsWith("-")) throw new Error(`unknown option: ${args[i]}`);
    else opts.names.push(args[i]);
  }
  if (opts.names.length !== 2 || opts.names.some((n) => !n.trim())) {
    throw new Error("usage: bot-board option-add FIELD NAME [--color C] [--dry-run]");
  }
  if (!COLORS.includes(opts.color)) throw new Error(`invalid color; choose ${COLORS.join(", ")}`);
  return opts;
}

function pages(gql, query, variables, key) {
  const nodes = [];
  let after = null;
  do {
    const page = gql(query, { ...variables, after }).node?.[key];
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo) throw new Error(`incomplete ${key} response`);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) throw new Error(`invalid ${key} cursor`);
    after = page.pageInfo.endCursor;
  } while (true);
  return nodes;
}

function addOption(project, opts, gql = graphql, snapshot = saveSnapshot, log = console.log) {
  const [fieldName, name] = opts.names;
  const readField = () => {
    const matches = pages(gql, FIELD, { id: project }, "fields").filter((f) => f.name === fieldName);
    if (matches.length !== 1 || !Array.isArray(matches[0].options)) throw new Error(`'${fieldName}' is not a unique single-select field`);
    const field = matches[0];
    if (new Set(field.options.map((o) => o.name)).size !== field.options.length) throw new Error("duplicate option names; cannot restore safely");
    return field;
  };
  const field = readField();
  if (field.options.some((o) => o.name === name)) { log(`'${name}' already exists in '${fieldName}'; no change`); return; }
  const readItems = () => new Map(pages(gql, ITEMS, { id: project, field: fieldName }, "items")
    .map((item) => [item.id, item.value?.name ?? null]));
  const before = readItems();
  for (const value of before.values()) {
    if (value !== null && !field.options.some((o) => o.name === value)) throw new Error(`unknown current option '${value}'`);
  }
  const options = field.options.map(({ name, color, description }) => ({ name, color, description }));
  options.push({ name, color: opts.color, description: "" });
  log(`Append '${name}' (${opts.color}) to '${fieldName}'; preserve ${field.options.length} options in order and ${before.size} item values (including unset). Restore changed values by name and verify.`);
  if (opts.dryRun) { log(JSON.stringify(options, null, 2)); return; }
  const recovery = snapshot({ project, field, items: [...before], options });
  log(`Recovery snapshot: ${recovery}`);
  try {
    gql(UPDATE, { input: { fieldId: field.id, singleSelectOptions: options } });
    const updated = readField();
    const current = readItems();
    const failures = [];
    for (const [itemId, value] of before) {
      if (!current.has(itemId)) { failures.push(`${itemId}: missing from board`); continue; }
      if (current.get(itemId) === value) continue;
      const input = { projectId: project, fieldId: updated.id, itemId };
      try {
        if (value === null) gql(CLEAR, { input });
        else {
          const option = updated.options.find((o) => o.name === value);
          if (!option) throw new Error(`option '${value}' disappeared`);
          gql(SET, { input: { ...input, value: { singleSelectOptionId: option.id } } });
        }
      } catch (e) { failures.push(`${itemId}: ${e.message}`); }
    }
    const verified = readItems();
    for (const [id, value] of before) {
      if (!verified.has(id) || verified.get(id) !== value) failures.push(`${id}: expected ${JSON.stringify(value)}, got ${JSON.stringify(verified.get(id))}`);
    }
    if (failures.length) throw new Error(`restoration failed: ${failures.join("; ")}`);
    if (JSON.stringify(updated.options.map(({ name, color, description }) => ({ name, color, description }))) !== JSON.stringify(options)) {
      throw new Error("option metadata/order did not match requested list");
    }
    log(`Added '${name}'; verified all ${before.size} original item values.`);
  } catch (e) { throw new Error(`${e.message}; field may have changed; recover using ${recovery}`); }
}

function saveSnapshot(data) {
  const root = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "bot-board");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "option-add-"));
  const file = path.join(dir, "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
}

if (require.main === module) {
  try { addOption(process.argv[2], parseArgs(process.argv.slice(3))); }
  catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}

module.exports = { addOption, parseArgs, FIELD, ITEMS, UPDATE, SET, CLEAR };

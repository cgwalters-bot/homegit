// The main rulesets require only ci.yml's required-checks job, so it must
// need every other job there (one left out could fail without blocking a
// merge) and run always() (a skipped required check counts as passing).
// Run with tests/ci-gate.sh, or node --test tests/ci-gate.test.js.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const CI = path.join(__dirname, "..", ".github", "workflows", "ci.yml");
const GATE = "required-checks";

// jobs(text): each job of the workflow TEXT as {id: [its lines]}, from
// the keys indented by two spaces under the top-level jobs:.
function jobs(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, `no jobs: in ${CI}`);
  const out = {};
  let cur = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) out[(cur = m[1])] = [];
    else if (cur) out[cur].push(line);
  }
  return out;
}

const all = jobs(fs.readFileSync(CI, "utf8"));
const gate = all[GATE];

test(`${GATE} exists and runs always()`, () => {
  assert.ok(gate, `${CI} has no ${GATE} job`);
  assert.ok(
    gate.some((l) => /^ {4}if: (\$\{\{\s*)?always\(\)(\s*\}\})?\s*$/.test(l)),
    `${GATE} must have 'if: always()'`,
  );
});

test(`${GATE} needs every other job`, () => {
  const needs = gate.map((l) => /^ {4}needs: \[(.*)\]\s*$/.exec(l)).find(Boolean);
  assert.ok(needs, `${GATE} must have a one-line 'needs: [...]'`);
  const got = needs[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  const want = Object.keys(all).filter((j) => j !== GATE).sort();
  assert.ok(want.length > 0, `no jobs besides ${GATE} in ${CI}`);
  assert.deepEqual(got, want);
});

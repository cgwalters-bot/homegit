// Offline tests of bin/bot-tmt-number against a fake gh serving a
// synthetic repository and its PRs (tests/fixtures/bot-tmt-number/fake-gh)
// and a fake bot-board keeping the reservations in a file. Run with
// tests/bot-tmt-number.sh, or node --test tests/bot-tmt-number.test.js.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FIXTURES = path.join(__dirname, "fixtures", "bot-tmt-number");
const TOOL = path.join(__dirname, "..", "bin", "bot-tmt-number");
const REPO = "acme/bootc";
const FORK = "cgwalters-forge/bootc";
const NOW = "2026-09-26T12:00:00.000Z";
const tmt = require(TOOL);

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const header = (n) => `# number: ${n}\n# tmt:\n#   summary: a test\n\nuse tap.nu\n`;
// addPatch(TEXT): a patch adding every line of TEXT.
const addPatch = (text) => `@@ -0,0 +1 @@\n${text.trimEnd().split("\n").map((l) => `+${l}`).join("\n")}`;

// The default synthetic world: main takes 1-3 and 7 (an fmf name only),
// an upstream PR adds 8, a forge PR adds 9 in an fmf, and a PR adding a
// non-tmt file or removing a test takes nothing.
function defaultWorld() {
  return {
    main: {
      "tests/booted/test-a.nu": header(1),
      "tests/booted/test-b.sh": header(2),
      "tests/install/x/test-c.sh": header(3),
      "tests/test-07-handwritten.fmf": "summary: x\n",
      "tests/booted/README.md": "# number: 99\n",
      "plans/integration.fmf": "/plan-01-a:\n  x\n/plan-02-b:\n",
    },
    prs: {
      [REPO]: [
        { number: 10, sha: "a1", branch: "feature", owner: "someone",
          files: [{ filename: "tmt/tests/booted/test-new.nu", status: "added", patch: addPatch(header(8)) }] },
        { number: 11, sha: "b1", branch: "misc", owner: "someone",
          files: [
            { filename: "src/lib.rs", status: "modified", patch: "@@ -1 +1 @@\n+# number: 40" },
            { filename: "tmt/tests/booted/test-gone.nu", status: "removed", patch: "@@ -1 +0,0 @@\n-# number: 41" },
            { filename: "tmt/tests/booted/test-renum.nu", status: "modified", patch: "@@ -1 +1 @@\n-# number: 42\n+# number: 5" },
          ] },
      ],
      [FORK]: [
        { number: 3, sha: "c1", branch: "bot/thing", owner: "cgwalters-forge",
          files: [{ filename: "tmt/tests/tests.fmf", status: "modified", patch: "@@ -1 +1,2 @@\n /test-01-a:\n+/test-09-thing:" }] },
      ],
    },
    closed: {},
  };
}

class World {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-tmt-number-test-"));
    for (const d of ["gh", "board", "cache"]) fs.mkdirSync(path.join(this.dir, d));
    this.env = {
      ...process.env,
      BOT_TMT_NUMBER_GH: path.join(FIXTURES, "fake-gh"),
      BOT_TMT_NUMBER_BOT_BOARD: path.join(FIXTURES, "fake-bot-board"),
      BOT_TMT_NUMBER_NOW: NOW,
      XDG_CACHE_HOME: path.join(this.dir, "cache"),
      FAKE_GH_DIR: path.join(this.dir, "gh"),
      FAKE_BOARD_DIR: path.join(this.dir, "board"),
    };
    this.set(defaultWorld());
  }

  // set(SPEC): serve SPEC; every answer's ETag is a hash of its body.
  set(spec) {
    const routes = {};
    const serve = (endpoint, body) => (routes[endpoint] = { etag: `W/"${sha(JSON.stringify(body))}"`, body });
    const blob = (content) => {
      const s = sha(content);
      serve(`repos/${REPO}/git/blobs/${s}`, { sha: s, encoding: "base64", content: Buffer.from(content).toString("base64") });
      return s;
    };
    const tree = Object.entries(spec.main).map(([p, c]) => ({ path: p, type: "blob", size: c.length, sha: blob(c) }));
    tree.push({ path: "tests/booted", type: "tree", sha: "d0" });
    serve(`repos/${REPO}/git/trees/HEAD:tmt?recursive=1`, { sha: "t0", tree, truncated: false });
    for (const [repo, prs] of Object.entries(spec.prs)) {
      const list = prs.map((p) => ({
        number: p.number, html_url: `https://github.com/${repo}/pull/${p.number}`,
        head: { sha: p.sha, ref: p.branch, repo: { owner: { login: p.owner } } },
      }));
      for (let page = 1; page === 1 || (page - 1) * 100 < list.length; page++) {
        serve(`repos/${repo}/pulls?state=open&per_page=100&page=${page}`, list.slice((page - 1) * 100, page * 100));
      }
      for (const p of prs) {
        const files = p.files.map((f) => ({ ...f, sha: f.content ? blob(f.content) : sha(f.filename) }));
        serve(`repos/${repo}/pulls/${p.number}/files?per_page=100&page=1`, files);
      }
    }
    for (const repo of [REPO, FORK]) {
      for (const owner of ["cgwalters-forge", "cgwalters-bot"]) {
        for (const branch of ["bot/a", "bot/b", "bot/c", "bot/d", "bot/e", "bot/thing"]) {
          const q = new URLSearchParams({ state: "closed", head: `${owner}:${branch}` });
          serve(`repos/${repo}/pulls?${q}`, (spec.closed[`${repo} ${owner}:${branch}`] || []));
        }
      }
    }
    fs.writeFileSync(path.join(this.dir, "gh", "routes.json"), JSON.stringify(routes));
  }

  run(...args) {
    fs.rmSync(path.join(this.dir, "gh", "calls"), { force: true });
    const r = spawnSync(TOOL, [...args, REPO], { env: this.env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  ok(...args) {
    const r = this.run(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r;
  }

  calls() {
    const f = path.join(this.dir, "gh", "calls");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : [];
  }

  get state() {
    const f = path.join(this.dir, "board", "state.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  }

  set state(value) {
    fs.writeFileSync(path.join(this.dir, "board", "state.json"), JSON.stringify(value));
  }

  race(states) {
    fs.writeFileSync(path.join(this.dir, "board", "race.json"), JSON.stringify(states));
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function withWorld(fn) {
  return () => {
    const w = new World();
    try {
      fn(w);
    } finally {
      w.cleanup();
    }
  };
}

const entry = (branch, reservedAt = NOW) => ({ branch, host: "h", reserved_at: reservedAt });

test("headers, fmf names and file names are parsed like xtask does", () => {
  const cases = [
    [header(12), false, [12]],
    ["  # number:  7 \n", false, [7]],
    ["# number: x\n", false, []],
    [`${"\n".repeat(60)}# number: 3\n`, false, []],
    ["/plan-01-a:\n  - /tmt/tests/tests/test-22-b\n/test-03-c:\n", true, [1, 22, 3]],
    ["/plan-01-a:\n", false, []],
    ["summary: 000-test-selinux\n", true, []],
  ];
  for (const [text, fmf, want] of cases) assert.deepEqual([...tmt.numbersInText(text, fmf)], want, JSON.stringify(text));
  const names = [["tmt/tests/test-32-x.fmf", [32]], ["booted/test-44-shadow.nu", [44]], ["readonly/011-test-x.nu", []]];
  for (const [name, want] of names) assert.deepEqual(tmt.numbersInName(name), want, name);
  const patches = [
    ["@@\n-# number: 4\n+# number: 6\n # number: 5", "tmt/tests/booted/t.nu", [6]],
    ["@@\n+/plan-12-x:\n-/plan-11-x:\n+++ b/x", "tmt/plans/integration.fmf", [12]],
    ["@@\n+/plan-12-x:", "tmt/tests/booted/t.nu", []],
  ];
  for (const [patch, file, want] of patches) assert.deepEqual([...tmt.numbersInPatch(patch, file)], want, patch);
});

test("gh -i output is split into status, headers and body", () => {
  const r = tmt.splitResponse('HTTP/2.0 200 OK\r\nEtag: W/"x"\r\nLink: <a>\r\n\r\n{"a":1}\n\n');
  assert.deepEqual([r.status, r.headers.etag, JSON.parse(r.body)], [200, 'W/"x"', { a: 1 }]);
  assert.equal(tmt.splitResponse("HTTP/2.0 304 Not Modified\r\n\r\n").status, 304);
});

test("the next number is one past everything taken", withWorld((w) => {
  assert.equal(w.ok().stdout, "10\n");
  const v = w.ok("-v").stderr;
  assert.match(v, /default branch: highest 7 \(tmt\/tests\/test-07-handwritten\.fmf\)/);
  assert.match(v, /open PR https:\/\/github.com\/acme\/bootc\/pull\/11: 5\n/);
  assert.match(v, /open PR https:\/\/github.com\/cgwalters-forge\/bootc\/pull\/3: 9\n/);
  w.state = { [REPO]: { 12: entry("bot/a") }, "other/repo": { 30: entry("bot/z") } };
  assert.equal(w.ok().stdout, "13\n");
}));

test("an empty world starts at 1", withWorld((w) => {
  w.set({ main: {}, prs: { [REPO]: [], [FORK]: [] }, closed: {} });
  assert.equal(w.ok().stdout, "1\n");
}));

test("reads are conditional and PRs are rescanned only when their head moves", withWorld((w) => {
  w.ok();
  const first = w.calls();
  assert.ok(first.includes(`repos/${REPO}/pulls/10/files?per_page=100&page=1`));
  assert.ok(!first.some((c) => c.endsWith("(conditional)")));
  w.ok();
  const second = w.calls();
  assert.ok(second.every((c) => c.endsWith("(conditional)")), second.join("\n"));
  assert.ok(!second.some((c) => c.includes("/files") || c.includes("/blobs/")), second.join("\n"));
  const world = defaultWorld();
  world.prs[REPO][0].sha = "a2";
  world.prs[REPO][0].files[0].patch = addPatch(header(20));
  w.set(world);
  assert.equal(w.ok().stdout, "21\n");
  assert.deepEqual(w.calls().filter((c) => c.includes("/files")), [`repos/${REPO}/pulls/10/files?per_page=100&page=1 (conditional)`]);
}));

test("PRs on a second page and files without a patch count", withWorld((w) => {
  const world = defaultWorld();
  for (let i = 0; i < 100; i++) world.prs[REPO].push({ number: 100 + i, sha: `s${i}`, branch: `b${i}`, owner: "x", files: [] });
  world.prs[REPO].push({ number: 300, sha: "big", branch: "big", owner: "x",
    files: [{ filename: "tmt/tests/booted/test-big.nu", status: "added", content: header(33) }] });
  w.set(world);
  assert.equal(w.ok().stdout, "34\n");
  assert.ok(w.calls().includes(`repos/${REPO}/pulls?state=open&per_page=100&page=2`));
}));

test("a failed read fails without a number", withWorld((w) => {
  const world = defaultWorld();
  world.prs[REPO][0].number = 404; // Its files route is then missing.
  w.set(world);
  fs.writeFileSync(path.join(w.dir, "gh", "routes.json"), JSON.stringify(
    Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(w.dir, "gh", "routes.json"), "utf8")))
      .filter(([k]) => !k.includes("/pulls/404/")))));
  const r = w.run();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /GET repos\/acme\/bootc\/pulls\/404\/files.*HTTP 404/);
}));

test("reserve records the number, once per branch", withWorld((w) => {
  assert.equal(w.ok("--reserve", "bot/a").stdout, "10\n");
  assert.equal(w.ok("--reserve", "bot/b").stdout, "11\n");
  assert.equal(w.ok("--reserve", "bot/a").stdout, "10\n");
  assert.deepEqual(Object.entries(w.state[REPO]).map(([n, e]) => [n, e.branch, e.reserved_at]),
    [["10", "bot/a", NOW], ["11", "bot/b", NOW]]);
  assert.equal(w.ok().stdout, "12\n");
  const list = spawnSync(TOOL, ["--list"], { env: w.env, encoding: "utf8" }).stdout;
  assert.match(list, /^\| number \| repo \| branch \| host \| reserved at \|\n\|---/);
  assert.match(list, new RegExp(`\\| 11 \\| ${REPO} \\| bot/b \\| .+ \\| ${NOW} \\|`));
}));

test("reserve retries when another machine reserved meanwhile", withWorld((w) => {
  w.race([{ [REPO]: { 10: entry("bot/other") } }]);
  const r = w.ok("--reserve", "bot/a");
  assert.equal(r.stdout, "11\n");
  assert.match(r.stderr, /another machine changed the reservations meanwhile; retrying/);
  assert.deepEqual(Object.keys(w.state[REPO]), ["10", "11"]);
}));

test("release drops a branch's reservation", withWorld((w) => {
  w.state = { [REPO]: { 10: entry("bot/a"), 11: entry("bot/b") } };
  assert.equal(w.ok("--release", "bot/a").stdout, "released 10 (bot/a)\n");
  assert.deepEqual(Object.keys(w.state[REPO]), ["11"]);
  const r = w.run("--release", "bot/a");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bot\/a holds no reservation/);
}));

test("gc releases what main, PRs or age settled, and keeps the rest", withWorld((w) => {
  const old = "2026-09-01T00:00:00.000Z";
  const world = defaultWorld();
  world.closed[`${FORK} cgwalters-forge:bot/c`] = [{ html_url: "https://x/pull/1", closed_at: "2026-09-26T13:00:00Z" }];
  world.closed[`${REPO} cgwalters-forge:bot/d`] = [{ html_url: "https://x/pull/2", closed_at: "2026-09-20T00:00:00Z" }];
  w.set(world);
  w.state = { [REPO]: {
    3: entry("bot/a"), // on main
    9: entry("bot/thing"), // in its open forge PR
    20: entry("bot/c"), // its PR closed after the reservation
    21: entry("bot/d"), // an older PR of a reused branch name
    22: entry("bot/e", old), // stale
    23: entry("bot/b"), // fresh, no PR yet
  } };
  const out = w.ok("--gc").stdout;
  assert.match(out, /^released 3 \(bot\/a\): on the default branch \(tmt\/tests\/install\/x\/test-c\.sh\)$/m);
  assert.match(out, /^released 9 \(bot\/thing\): in its open PR https:\/\/github.com\/cgwalters-forge\/bootc\/pull\/3$/m);
  assert.match(out, /^released 20 \(bot\/c\): its PR https:\/\/x\/pull\/1 is closed$/m);
  assert.match(out, /^released 22 \(bot\/e\): no PR after 14 days$/m);
  assert.deepEqual(Object.keys(w.state[REPO]), ["21", "23"]);
}));

test("usage errors", withWorld((w) => {
  const cases = [["--reserve"], ["--reserve", "--gc"], ["--gc", "--list"], ["--bogus"], ["a/b", "c/d"], ["notarepo"]];
  for (const args of cases) assert.equal(spawnSync(TOOL, args, { env: w.env }).status, 2, args.join(" "));
}));

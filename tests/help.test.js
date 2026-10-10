// Run with node --test tests/help.test.js. Requires Linux unshare, mount,
// and chroot (unprivileged user namespaces); no credentials or network.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..");
const FORBIDDEN_COMMANDS = ["gh", "git", "curl", "wget", "ssh", "scp", "nc", "podman"];
// Legacy positional-only helpers, not the bot CLIs. Keep exceptions explicit:
// a new executable must support --help rather than silently escaping coverage.
const NO_HELP_TOOLS = [
  "git-hubclone", "git-mprlog", "git-multigrep", "git-outgoing", "git-pr",
  "git-un-diff-whitespace",
  "git-xsel", "makesudoinstall", "rpmbuild-cwd", "ssh-unknown",
];
const tools = fs.readdirSync(path.join(REPO, "bin")).filter((name) =>
  fs.statSync(path.join(REPO, "bin", name)).mode & 0o111).sort();

test("help exceptions still name executable tools without documented --help", () => {
  for (const name of NO_HELP_TOOLS) {
    assert.ok(tools.includes(name), `stale no-help exception: ${name}`);
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, "bin", name), "utf8"), /--help/,
      `${name} now documents --help; remove its exception`);
  }
});

test("a new executable without --help fails with its name", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "homegit-help-fixture-"));
  try {
    fs.mkdirSync(path.join(repo, "bin"));
    fs.mkdirSync(path.join(repo, "tests"));
    const filename = path.join(repo, "tests", "help.test.js");
    fs.copyFileSync(__filename, filename);
    fs.writeFileSync(path.join(repo, "bin", "missing-help-fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=missing-help-fixture", filename],
      { encoding: "utf8", timeout: 15000, env });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `the missing-help fixture should fail: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /missing-help-fixture must document and implement --help/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

for (const name of tools.filter((tool) => !NO_HELP_TOOLS.includes(tool))) {
  test(`${name} --help is offline and side-effect free`, () => {
    assert.match(fs.readFileSync(path.join(REPO, "bin", name), "utf8"), /--help/,
      `${name} must document and implement --help`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homegit-help-"));
    try {
      for (const dir of ["home", "tmp", "stubs"]) fs.mkdirSync(path.join(root, dir));
      // Only interpreters and read-only text/path utilities are available.
      for (const cmd of ["node", "python", "python3", "bash", "sh", "basename", "dirname", "realpath", "cat", "readlink", "sed"]) {
        fs.symlinkSync(cmd === "node" ? process.execPath : `/usr/bin/${cmd}`, path.join(root, "stubs", cmd));
      }
      for (const cmd of FORBIDDEN_COMMANDS) {
        fs.writeFileSync(path.join(root, "stubs", cmd),
          `#!/bin/sh\necho "forbidden command: ${cmd}" >&2\necho '${cmd}' >> /tmp/forbidden\nexit 99\n`, { mode: 0o755 });
      }
      const result = spawnSync("/usr/bin/unshare", [
        "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--kill-child",
        process.execPath, path.join(__dirname, "help-sandbox.js"), root, REPO, name, ...FORBIDDEN_COMMANDS,
      ], { encoding: "utf8", timeout: 15000, env: { PATH: "/usr/bin:/bin" } });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${name} --help failed: ${result.stderr}`);
      assert.match(result.stdout, /^Usage:/mi, `${name} must print Usage on stdout`);
      assert.ok(!fs.existsSync(path.join(root, "tmp", "forbidden")), `${name} invoked a forbidden command`);
      assert.deepEqual(fs.readdirSync(path.join(root, "home")), [], `${name} wrote to HOME`);
      assert.deepEqual(fs.readdirSync(path.join(root, "tmp")), [], `${name} wrote to TMPDIR`);
    } finally {
      // Mounts belonged to the child namespace and are gone before cleanup.
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

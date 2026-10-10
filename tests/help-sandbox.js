// Internal launcher for help.test.js. Linux user/mount/network namespaces
// keep the checkout and host runtime read-only; only the temporary root is writable.
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [root, repo, tool, ...forbiddenCommands] = process.argv.slice(2);

function bind(source, target) {
  const dest = path.join(root, target);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("/usr/bin/mount", ["--bind", source, dest]);
  execFileSync("/usr/bin/mount", ["-o", "remount,bind,ro", dest]);
}

for (const dir of ["usr", "lib", "lib64", "bin"]) {
  if (fs.existsSync(`/${dir}`)) bind(`/${dir}`, dir);
}
// setup-node can install the interpreter outside the system runtime directories.
if (!process.execPath.startsWith("/usr/") && !process.execPath.startsWith("/bin/")) {
  bind(path.dirname(process.execPath), path.dirname(process.execPath));
}
bind(repo, "repo");
// PATH wrappers should also catch tools invoked by absolute path (or after
// resetting PATH). Overlay the common system locations in this namespace only.
for (const cmd of forbiddenCommands) {
  for (const dir of ["usr/bin", "usr/local/bin", "bin"]) {
    const dest = path.join(root, dir, cmd);
    if (fs.existsSync(dest)) execFileSync("/usr/bin/mount", ["--bind", path.join(root, "stubs", cmd), dest]);
  }
}
// /dev/null is the only writable host object, not a persistent file.
fs.mkdirSync(path.join(root, "dev"));
fs.writeFileSync(path.join(root, "dev/null"), "");
execFileSync("/usr/bin/mount", ["--bind", "/dev/null", path.join(root, "dev/null")]);
const result = spawnSync("/usr/sbin/chroot", [root, `/repo/bin/${tool}`, "--help"], {
  cwd: root,
  env: { HOME: "/home", PATH: "/stubs", TMPDIR: "/tmp", LC_ALL: "C" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

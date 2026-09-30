// Offline tests of how long a devspace has left (bin/bot-devspace-time),
// through 'bot-devspace remaining' and the warning and --min-left refusal
// of 'bot-devspace ssh'. A fake ssh plays the devspaces: asked for
// DEVSPACE_STARTED/DEVSPACE_DEADLINE it prints $FAKE/HOST.env (and fails
// like an unreachable host without one), and it records any other command
// it runs. Run with tests/bot-devspace-time.sh.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const BIN = path.join(__dirname, "..", "bin");
const time = require(path.join(BIN, "bot-devspace-time"));

// Every fake devspace's duration started then.
const STARTED = "2026-09-30T18:37:35Z";
const at = (minutes) => new Date(Date.parse(STARTED) + minutes * 60_000).toISOString().replace(/\.000Z$/, "Z");
const epoch = (iso) => String(Date.parse(iso) / 1000);
// What a devspace of that many minutes prints for the probe.
const envOf = (minutes) => `${epoch(STARTED)} ${epoch(at(minutes))}\n`;

const FAKE_SSH = `#!/bin/sh
host=
while test $# -gt 0; do
    case "$1" in
        -F|-o) shift 2 ;;
        *) host=$1; shift; break ;;
    esac
done
case "$*" in
    *DEVSPACE_DEADLINE*)
        echo "$host" >>"$FAKE/probes"
        test -e "$FAKE/$host.env" || { echo "ssh: connect to host $host port 22: No route to host" >&2; exit 255; }
        cat "$FAKE/$host.env" ;;
    *) echo "$host $*" >>"$FAKE/ran" ;;
esac
`;

test("parseTimes reads the probe's STARTED DEADLINE line", () => {
  const cases = [
    [envOf(120), { started_at: STARTED, deadline: at(120) }],
    [` ${epoch(at(60))}\n`, { started_at: null, deadline: at(60) }],
    [" \n", { started_at: null, deadline: null }],
  ];
  for (const [out, want] of cases) assert.deepEqual(time.parseTimes(out), want, JSON.stringify(out));
  for (const bad of ["soon later\n", "1 2 3\n", "-5 10\n"]) assert.throws(() => time.parseTimes(bad), /unexpected/, bad);
});

test("withMinutesLeft rounds down and stops at 0", () => {
  const info = { deadline: at(120) };
  const cases = [
    [at(0), 120],
    [at(30.5), 89],
    [at(119.9), 0],
    [at(500), 0],
  ];
  for (const [now, want] of cases) assert.equal(time.withMinutesLeft(info, Date.parse(now)).minutes_left, want, now);
  assert.equal(time.withMinutesLeft({ deadline: null }, Date.parse(at(0))).minutes_left, null);
});

const workDirs = [];
test.after(() => workDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// A state root with devspaces NAME -> what its SSH sessions set (minutes
// of duration, "" for nothing, null for unreachable), with the ssh_config
// 'bot-devspace start' writes, and a bin dir with the fake ssh.
function setup(devspaces) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bot-devspace-time-"));
  workDirs.push(work);
  const root = path.join(work, "state", "bot-devspace");
  const fake = path.join(work, "fake");
  fs.mkdirSync(fake, { recursive: true });
  for (const [name, minutes] of Object.entries(devspaces)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run_id"), "4242\n");
    fs.writeFileSync(path.join(dir, "ssh_config"), `Host devspace-${name}\n    HostName cgwalters-devspace-4242\n`);
    if (minutes != null) fs.writeFileSync(path.join(fake, `devspace-${name}.env`), minutes === "" ? " \n" : envOf(minutes));
  }
  const bin = path.join(work, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  // bot-devspace checks gh is installed; these commands never call it.
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho unexpected gh call >&2\nexit 1\n", { mode: 0o755 });
  return { work, root, fake };
}

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);

function devspace(ctx, args, now) {
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(ctx.work, "state"),
    PATH: `${path.join(ctx.work, "bin")}:${process.env.PATH}`,
    BOT_DEVSPACE_NOW: now,
    FAKE: ctx.fake,
  };
  const r = spawnSync(path.join(BIN, "bot-devspace"), args, { env, encoding: "utf8" });
  const ranFile = path.join(ctx.fake, "ran");
  const ran = fs.existsSync(ranFile);
  fs.rmSync(ranFile, { force: true });
  return { ...r, ran };
}

test("remaining --json NAME, from the devspace's environment", () => {
  const ctx = setup({ long: 120, short: 30, old: "" });
  const cases = [
    // [name, want minutes_left, deadline, started_at]
    ["long", 90, at(120), STARTED],
    ["short", 0, at(30), STARTED],
    ["old", null, null, null],
  ];
  for (const [name, left, deadline, started] of cases) {
    const r = devspace(ctx, ["remaining", "--json", name], at(30));
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { name, started_at: started, deadline, minutes_left: left }, name);
  }
});

test("remaining without NAME describes every devspace, and lists the others when one is unreachable", () => {
  const ctx = setup({ long: 120, gone: null, old: "", short: 30 });
  const r = devspace(ctx, ["remaining"], at(30));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^gone: unknown \(cannot reach the devspace over SSH: ssh: connect to host devspace-gone port 22: No route to host\)$/);
  assert.deepEqual(lines.slice(1), [
    `long: 90 min left, until ${at(120)} (started ${STARTED})`,
    "old: unknown (the devspace doesn't set DEVSPACE_DEADLINE; its workflow predates it)",
    `short: deadline passed at ${at(30)} (started ${STARTED}); the devspace is gone or about to be`,
  ]);
  const all = JSON.parse(devspace(ctx, ["remaining", "--json"], at(30)).stdout);
  assert.deepEqual(all.map((i) => i.name), ["gone", "long", "old", "short"]);
});

test("remaining fails clearly for an unknown devspace or a bad name", () => {
  const ctx = setup({});
  for (const [name, want] of [["nope", /no devspace named 'nope'/], ["../x", /invalid devspace name/]]) {
    const r = devspace(ctx, ["remaining", name], at(0));
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, want, name);
  }
});

test("ssh warns under 20 minutes left and --min-left refuses", () => {
  const ctx = setup({ d: 120 });
  const cases = [
    // [minutes since start, extra args, want ssh to run, stderr pattern (null: empty)]
    [30, [], true, null],
    [100, [], true, null],
    [101, ["--min-left", "20"], false, /refusing to start: devspace 'd' has 19 min left .* --min-left asks for 20/],
    [102, [], true, /warning: devspace 'd' has 18 min left \(deadline 2026-09-30T20:37:35Z\)/],
    [60, ["--min-left", "60"], true, null],
    [60, ["--min-left", "61"], false, /refusing to start.* 60 min left/],
    [60, ["--min-left=61"], false, /refusing to start/],
    [130, [], true, /has 0 min left/],
    [30, ["--min-left", "x"], false, /--min-left takes a number/],
  ];
  for (const [minutes, extra, ran, stderr] of cases) {
    const r = devspace(ctx, ["ssh", ...extra, "d", "true"], at(minutes));
    const label = `${minutes} min, ${extra.join(" ")}`;
    assert.equal(r.ran, ran, `${label}: ${r.stderr}`);
    assert.equal(r.status === 0, ran, label);
    if (stderr) assert.match(r.stderr, stderr, label);
    else assert.equal(r.stderr, "", label);
  }
});

test("ssh reads the times once, then from the cache", () => {
  const ctx = setup({ d: 120, old: "" });
  for (const name of ["d", "d", "old", "old"]) devspace(ctx, ["ssh", name, "true"], at(0));
  assert.deepEqual(readLines(path.join(ctx.fake, "probes")), ["devspace-d", "devspace-old"]);
});

test("ssh runs with a note when the time left can't be told", () => {
  const ctx = setup({ gone: null, old: "" });
  const cases = [
    ["gone", [], /note: cannot tell how long devspace 'gone' has left: cannot reach/],
    ["gone", ["--min-left", "10"], /note: cannot tell how long devspace 'gone' has left/],
    ["old", [], null],
    ["old", ["--min-left", "10"], /note: devspace 'old' doesn't set DEVSPACE_DEADLINE/],
  ];
  for (const [name, extra, stderr] of cases) {
    const r = devspace(ctx, ["ssh", ...extra, name, "true"], at(0));
    const label = `${name} ${extra.join(" ")}`;
    assert.ok(r.ran, `${label}: ${r.stderr}`);
    if (stderr) assert.match(r.stderr, stderr, label);
    else assert.equal(r.stderr, "", label);
  }
});

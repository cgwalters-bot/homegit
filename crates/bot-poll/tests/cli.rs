//! bot-poll itself, over fake tools that print the fixture outputs of
//! tests/fixtures: "base", then "news", which adds an approval, a P0
//! health line, a sign-off, an answer and item news.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_bot-poll");
/// The fake tools, with the step whose fixture output each prints.
const FAKES: [(&str, &str); 5] = [
    ("bot-notify", "notify"),
    ("bot-pr", "inbox"),
    ("bot-watch", "watch"),
    ("bot-tmt-number", "tmt-gc"),
    ("git", "git"),
];
const BASE_KINDS: &str = "health-P0, review, approval, forge-review, rebase, health";
const NEWS_KINDS: &str = "health-P0, approval, signoff, notify, forge-review, news";
const ALL_KINDS: &str =
    "health-P0, review, approval, signoff, notify, forge-review, rebase, health, news";

struct World {
    dir: tempfile::TempDir,
}

struct Run {
    status: i32,
    stdout: String,
    stderr: String,
    /// The fake tools' calls, "NAME ARGS...".
    calls: Vec<String>,
}

fn fixtures(set: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(set)
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("homegit/bin");
        fs::create_dir_all(&bin).unwrap();
        for (name, step) in FAKES {
            let script = format!(
                "#!/bin/sh\necho \"{name} $*\" >>\"$FAKE_LOG\"\n\
                 test ! -e \"$FAKE_FIXTURES/{step}.txt\" || cat \"$FAKE_FIXTURES/{step}.txt\"\n\
                 test ! -e \"$FAKE_FIXTURES/{step}.status\" || exit \"$(cat \"$FAKE_FIXTURES/{step}.status\")\"\n"
            );
            let path = bin.join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
        }
        World { dir }
    }

    fn state(&self) -> PathBuf {
        self.dir.path().join("state")
    }

    fn run(&self, fixtures: &Path, args: &[&str]) -> Run {
        let log = self.dir.path().join("calls");
        let _ = fs::remove_file(&log);
        let bin = self.dir.path().join("homegit/bin");
        let out = Command::new(BIN)
            .arg("--state-dir")
            .arg(self.state())
            .args(args)
            .env("BOT_POLL_BIN_DIR", &bin)
            .env("BOT_POLL_GIT", bin.join("git"))
            .env("FAKE_LOG", &log)
            .env("FAKE_FIXTURES", fixtures)
            .output()
            .unwrap();
        Run {
            status: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8(out.stdout).unwrap(),
            stderr: String::from_utf8(out.stderr).unwrap(),
            calls: fs::read_to_string(&log)
                .map(|t| t.lines().map(str::to_string).collect())
                .unwrap_or_default(),
        }
    }
}

/// Asserts a NEWS line with these kinds, returning its run directory.
fn assert_news(r: &Run, kinds: &str) -> PathBuf {
    assert_eq!(r.status, 0, "{}", r.stderr);
    let rest = r
        .stdout
        .strip_prefix(&format!("NEWS ({kinds}) at "))
        .unwrap_or_else(|| panic!("not NEWS ({kinds}): {}", r.stdout));
    let (hhmm, glob) = rest.trim_end().split_once(": ").unwrap();
    assert!(
        hhmm.len() == 4 && hhmm.bytes().all(|b| b.is_ascii_digit()),
        "{hhmm}"
    );
    PathBuf::from(glob.strip_suffix("/*.txt").unwrap())
}

fn assert_no_news(r: &Run) {
    assert_eq!(r.status, 0, "{}", r.stderr);
    assert!(r.stdout.starts_with("No news at "), "{}", r.stdout);
}

#[test]
fn reports_once_and_keeps_the_seen_sets_across_runs() {
    let w = World::new();
    // The first sweep: all of base is new. Every step runs, in order.
    let r = w.run(&fixtures("base"), &["--once"]);
    let run = assert_news(&r, BASE_KINDS);
    let repo = w.dir.path().join("homegit");
    assert_eq!(
        r.calls,
        [
            format!("git -C {} pull -q --ff-only", repo.display()),
            "bot-notify ".to_string(),
            "bot-pr inbox --dry-run".to_string(),
            "bot-watch --apply".to_string(),
            "bot-tmt-number --gc".to_string(),
        ]
    );
    assert_eq!(
        fs::read_to_string(run.join("watch.txt")).unwrap(),
        fs::read_to_string(fixtures("base").join("watch.txt")).unwrap()
    );

    // The same again, in a new process: the sets come from the state dir.
    assert_no_news(&w.run(&fixtures("base"), &["--once"]));
    assert_news(&w.run(&fixtures("news"), &["--once"]), NEWS_KINDS);

    let r = w.run(&fixtures("news"), &["--summary"]);
    assert_eq!(r.status, 0, "{}", r.stderr);
    assert!(r.calls.is_empty(), "--summary runs nothing");
    for want in [
        "\nPriority health (P0) (health-P0):\n  P0 ci-failing https://github.com/bootc-dev/bootc/pull/2437 781bbcac8255: required-checks",
        "\nApproved fork PRs (promote) (approval):\n  install/config: Skip config fragments that vanish while loading [APPROVED]\n    https://github.com/cgwalters-forge/bootc/pull/24\n",
        "\nSign-offs (signoff):\n  Signed off: https://github.com/bootc-dev/bootc/pull/2516 (5e20ab31c0d2)\n",
        "  answer from @cgwalters: bootc#2499 (.vmlinuz.hmac): sign off again [thread 25909312948]\n    https://github.com/cgwalters-forge/tracker/issues/151#issuecomment-1\n",
        "\nItem news (news):\n  UKI Addons Support: bootc-dev/bootc#2448 review COMMENTED by @Johan-Liebert1: fixed\n    https://github.com/bootc-dev/bootc/pull/2448#pullrequestreview-5362732351\n",
    ] {
        assert!(
            r.stdout.contains(want),
            "--summary lacks {want:?}:\n{}",
            r.stdout
        );
    }
    assert!(
        !r.stdout.contains("renovate") && !r.stdout.contains("pull/2500"),
        "{}",
        r.stdout
    );

    // bot-watch rate limited: no news, and nothing forgotten, so the next
    // whole sweep has none either.
    let broken = w.dir.path().join("broken");
    fs::create_dir(&broken).unwrap();
    for s in ["notify", "inbox"] {
        fs::copy(
            fixtures("base").join(format!("{s}.txt")),
            broken.join(format!("{s}.txt")),
        )
        .unwrap();
    }
    fs::write(
        broken.join("watch.txt"),
        "error: GitHub is rate limiting the bot\n",
    )
    .unwrap();
    fs::write(broken.join("watch.status"), "75").unwrap();
    let r = w.run(&broken, &["--once"]);
    assert_no_news(&r);
    assert!(r.stderr.contains("watch exited 75"), "{}", r.stderr);
    assert_no_news(&w.run(&fixtures("news"), &["--once"]));

    // --dry-run runs nothing and changes no state.
    let before = fs::read_to_string(w.state().join("state.json")).unwrap();
    let r = w.run(&fixtures("news"), &["--dry-run"]);
    assert_eq!(r.status, 0, "{}", r.stderr);
    assert!(r.calls.is_empty());
    assert!(
        r.stdout.starts_with("A sweep runs:\n  ")
            && r.stdout.contains("/git -C ")
            && r.stdout.contains("/bot-watch --apply\n"),
        "{}",
        r.stdout
    );
    assert!(r.stdout.ends_with("has no news.\n"), "{}", r.stdout);
    assert_eq!(
        fs::read_to_string(w.state().join("state.json")).unwrap(),
        before
    );
}

#[test]
fn a_restart_reports_what_the_last_sweep_found_once() {
    let w = World::new();
    assert_news(&w.run(&fixtures("base"), &["--once"]), BASE_KINDS);
    // A sweep that finished its steps but was killed before checking them.
    let id = (chrono::Utc::now() + chrono::Duration::minutes(1))
        .format("%Y%m%d-%H%M%S-%3f")
        .to_string();
    let run = w.state().join("runs").join(&id);
    fs::create_dir(&run).unwrap();
    for s in ["notify", "inbox", "watch"] {
        fs::copy(
            fixtures("news").join(format!("{s}.txt")),
            run.join(format!("{s}.txt")),
        )
        .unwrap();
    }
    fs::write(
        run.join("status.json"),
        r#"{"git":0,"notify":0,"inbox":0,"watch":1}"#,
    )
    .unwrap();
    // Reported at once, without sweeping or waiting the interval.
    let r = w.run(&fixtures("news"), &["--interval", "3600"]);
    assert_eq!(assert_news(&r, NEWS_KINDS), run);
    assert!(r.calls.is_empty(), "{:?}", r.calls);
    // And not again.
    assert_no_news(&w.run(&fixtures("news"), &["--once"]));
}

#[test]
fn loops_until_the_max_duration() {
    let w = World::new();
    assert_news(&w.run(&fixtures("news"), &["--once"]), ALL_KINDS);
    let r = w.run(
        &fixtures("news"),
        &["--no-wait", "--interval", "1", "--max-duration", "2"],
    );
    assert_eq!(r.status, 0, "{}", r.stderr);
    assert!(
        r.stdout.starts_with("No news in 2s (last sweep: ") && r.stdout.ends_with("/*.txt)\n"),
        "{}",
        r.stdout
    );
    assert!(
        r.calls.iter().any(|c| c == "bot-watch --apply"),
        "{:?}",
        r.calls
    );
}

#[test]
fn a_restart_keeps_the_sweep_schedule() {
    let w = World::new();
    assert_news(&w.run(&fixtures("news"), &["--once"]), ALL_KINDS);
    // Just swept: the next sweep is an interval away.
    let r = w.run(
        &fixtures("news"),
        &["--interval", "60", "--max-duration", "1"],
    );
    assert_eq!(r.status, 0, "{}", r.stderr);
    assert!(r.calls.is_empty(), "{:?}", r.calls);
    // The newest sweep an hour ago: the next one is overdue.
    let runs = w.state().join("runs");
    let id = fs::read_dir(&runs)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name();
    let id = id.to_str().unwrap();
    let old = (chrono::Utc::now() - chrono::Duration::hours(1))
        .format("%Y%m%d-%H%M%S-%3f")
        .to_string();
    fs::rename(runs.join(id), runs.join(&old)).unwrap();
    let state = fs::read_to_string(w.state().join("state.json")).unwrap();
    fs::write(w.state().join("state.json"), state.replace(id, &old)).unwrap();
    let r = w.run(
        &fixtures("news"),
        &["--interval", "60", "--max-duration", "1"],
    );
    assert_eq!(r.status, 0, "{}", r.stderr);
    assert!(
        r.calls.iter().any(|c| c == "bot-watch --apply"),
        "{:?}",
        r.calls
    );
}

#[test]
fn one_poll_per_state_dir() {
    let w = World::new();
    fs::create_dir_all(w.state()).unwrap();
    let lock = fs::File::create(w.state().join("lock")).unwrap();
    lock.lock().unwrap();
    let r = w.run(&fixtures("news"), &["--once"]);
    assert_eq!(r.status, 1);
    assert!(
        r.stderr.contains("another bot-poll is polling with"),
        "{}",
        r.stderr
    );
    assert!(r.calls.is_empty());
    lock.unlock().unwrap();
    assert_eq!(w.run(&fixtures("news"), &["--once"]).status, 0);
}

#[test]
fn usage_errors() {
    let w = World::new();
    for args in [
        &["--interval", "soon"][..],
        &["--bogus"],
        &["--summary", "--dry-run"],
    ] {
        assert_eq!(w.run(&fixtures("news"), args).status, 2, "{args:?}");
    }
    assert!(
        w.run(&fixtures("news"), &["--help"])
            .stdout
            .contains("NEWS (KIND, ...) at HHMM: RUN/*.txt")
    );
}

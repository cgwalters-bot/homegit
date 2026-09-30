//! bot-poll itself, over fake tools that print the fixture outputs of
//! tests/fixtures: "base", then "news", which adds an approval, a P0
//! health line, a sign-off, an answer and item news. A fake gh answers
//! its requests from files each test writes (see [`World::gh`]).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_bot-poll");
/// The fake tools, with the step whose fixture output each prints.
const FAKES: [(&str, &str); 6] = [
    ("bot-notify", "notify"),
    ("bot-signoff-due", "signoff"),
    ("bot-pr", "inbox"),
    ("bot-watch", "watch"),
    ("bot-tmt-number", "tmt-gc"),
    ("git", "git"),
];
const BASE_KINDS: &str = "health-P0, review, approval, forge-review, rebase, health";
const NEWS_KINDS: &str = "health-P0, approval, signoff, notify, forge-review, news";
const ALL_KINDS: &str =
    "health-P0, review, approval, signoff, notify, forge-review, rebase, health, news";

// The requests of a hot set's rebuild and of a hot cycle, for the default
// operator config.
const FORGE_SEARCH: &str =
    "search/issues?q=is:pr+is:open+author:cgwalters-bot+org:cgwalters-forge&per_page=100&page=1";
const UPSTREAM_SEARCH: &str =
    "search/issues?q=is:pr+is:open+author:cgwalters-bot+-org:cgwalters-forge&per_page=100&page=1";
const ASKS: &str =
    "repos/cgwalters-forge/tracker/issues?assignee=cgwalters&state=open&per_page=100&page=1";
const NOTIFICATIONS: &str = "notifications?per_page=50";
const NOTIFICATIONS_LM: &str = "Wed, 30 Sep 2026 12:00:00 GMT";
const EVENTS: &str = "users/cgwalters/events?per_page=100";
const EMPTY_SEARCH: &str = r#"{"total_count":0,"items":[]}"#;

/// The fake gh: `gh api -i PATH [-H HEADER]...` answers from
/// $FAKE_GH/KEY.json, KEY being PATH without its since= parameter and
/// with every other character than a letter or digit made '_'. The Nth
/// request of a PATH answers from KEY.N.json instead, if there is one.
/// With a KEY.etag, a header naming it (If-None-Match or
/// If-Modified-Since) gets a 304; otherwise the response sends it as its
/// ETag and Last-Modified. A KEY.http is a whole error response. No file,
/// a 404. Like gh, it exits 1 on anything but a 200 (a 304 too), saying
/// so on stderr. Each request is logged as "PATH [HEADER] STATUS".
const FAKE_GH: &str = r#"#!/bin/sh
path=$3; shift 3; cond=
while [ $# -ge 2 ]; do cond=$2; shift 2; done
f=$FAKE_GH/$(printf %s "$path" | sed 's/since=[^&]*&\{0,1\}//' | tr -c 'A-Za-z0-9' _)
n=$(( $(cat "$f.n" 2>/dev/null || echo 0) + 1 )); echo $n >"$f.n"
test ! -e "$f.$n.json" || f=$f.$n
v=$(cat "$f.etag" 2>/dev/null)
if test -e "$f.http"; then echo "$path http" >>"$FAKE_GH_LOG"; cat "$f.http"; echo "gh: HTTP error" >&2; exit 1
elif test ! -e "$f.json"; then st=404
elif test -n "$v" && { test "$cond" = "If-None-Match: $v" || test "$cond" = "If-Modified-Since: $v"; }; then st=304
else st=200; fi
echo "$path${cond:+ [$cond]} $st" >>"$FAKE_GH_LOG"
case $st in
404) printf 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1;;
304) printf 'HTTP/2.0 304 Not Modified\r\n\r\n'; echo "gh: HTTP 304" >&2; exit 1;;
*) printf 'HTTP/2.0 200 OK\r\n'; test -z "$v" || printf 'Etag: %s\r\nLast-Modified: %s\r\n' "$v" "$v"
   printf '\r\n'; cat "$f.json";;
esac
"#;

struct World {
    dir: tempfile::TempDir,
}

struct Run {
    status: i32,
    stdout: String,
    stderr: String,
    /// The fake tools' calls, "NAME ARGS...".
    calls: Vec<String>,
    /// The fake gh's requests, "PATH [HEADER] STATUS".
    gh: Vec<String>,
}

fn lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .map(|t| t.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn executable(path: &Path, script: &str) {
    fs::write(path, script).unwrap();
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
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
            executable(&bin.join(name), &script);
        }
        executable(&dir.path().join("gh"), FAKE_GH);
        fs::create_dir(dir.path().join("gh-fixtures")).unwrap();
        let w = World { dir };
        // An empty hot set, with nothing new.
        for (path, body) in [
            (FORGE_SEARCH, EMPTY_SEARCH),
            (UPSTREAM_SEARCH, EMPTY_SEARCH),
            (ASKS, "[]"),
        ] {
            w.gh(path, body, None);
        }
        w.gh(NOTIFICATIONS, "[]", Some(NOTIFICATIONS_LM));
        w.gh(EVENTS, "[]", Some("\"e1\""));
        w
    }

    /// Answers GET PATH with BODY, and a 304 to a request naming ETAG.
    fn gh(&self, path: &str, body: &str, etag: Option<&str>) {
        self.gh_nth(path, None, body, etag);
    }

    /// The same for the Nth request of PATH (counted from now) only.
    fn gh_nth(&self, path: &str, n: Option<u32>, body: &str, etag: Option<&str>) {
        let path = match path.split_once("since=") {
            Some((a, b)) => format!("{a}{}", b.split_once('&').map_or("", |(_, r)| r)),
            None => path.to_string(),
        };
        let key: String = path
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let dir = self.dir.path().join("gh-fixtures");
        let base = match n {
            Some(n) => {
                let _ = fs::remove_file(dir.join(format!("{key}.n")));
                format!("{key}.{n}")
            }
            None => key,
        };
        let _ = fs::remove_file(dir.join(format!("{base}.http")));
        fs::write(dir.join(format!("{base}.json")), body).unwrap();
        let etag_file = dir.join(format!("{base}.etag"));
        match etag {
            Some(e) => fs::write(etag_file, e).unwrap(),
            None => {
                let _ = fs::remove_file(etag_file);
            }
        }
    }

    /// Answers GET PATH with the whole error response RAW.
    fn gh_error(&self, path: &str, raw: &str) {
        self.gh(path, "", None);
        let key: String = path
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        fs::write(
            self.dir
                .path()
                .join("gh-fixtures")
                .join(format!("{key}.http")),
            raw,
        )
        .unwrap();
    }

    fn status(&self) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(self.state().join("status.json")).unwrap())
            .unwrap()
    }

    fn state(&self) -> PathBuf {
        self.dir.path().join("state")
    }

    fn run(&self, fixtures: &Path, args: &[&str]) -> Run {
        let log = self.dir.path().join("calls");
        let gh_log = self.dir.path().join("gh-calls");
        let _ = fs::remove_file(&log);
        let _ = fs::remove_file(&gh_log);
        let bin = self.dir.path().join("homegit/bin");
        let out = Command::new(BIN)
            .arg("--state-dir")
            .arg(self.state())
            .args(args)
            .env("BOT_POLL_BIN_DIR", &bin)
            .env("BOT_POLL_GIT", bin.join("git"))
            .env("FAKE_LOG", &log)
            .env("FAKE_FIXTURES", fixtures)
            .env("BOT_POLL_GH", self.dir.path().join("gh"))
            .env("FAKE_GH", self.dir.path().join("gh-fixtures"))
            .env("FAKE_GH_LOG", &gh_log)
            // The default operator config, whatever this machine's.
            .env("XDG_CONFIG_HOME", self.dir.path())
            .env_remove("BOT_OPERATOR_CONFIG")
            .output()
            .unwrap();
        Run {
            status: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8(out.stdout).unwrap(),
            stderr: String::from_utf8(out.stderr).unwrap(),
            calls: lines(&log),
            gh: lines(&gh_log),
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

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

/// A hot set of a fork PR, an upstream PR and an ask.
fn hot_world() -> World {
    let w = World::new();
    let pr = |url: &str, title: &str| {
        format!(
            r#"{{"total_count":1,"items":[{{"html_url":"{url}","title":"{title}","pull_request":{{}},
                 "body":"Fixes it.\n\n<!-- bot-meta -->\nItem: x\n<!-- /bot-meta -->"}}]}}"#
        )
    };
    w.gh(
        FORGE_SEARCH,
        &pr(
            "https://github.com/cgwalters-forge/bootc/pull/30",
            "Fix foo",
        ),
        None,
    );
    w.gh(
        UPSTREAM_SEARCH,
        &pr("https://github.com/bootc-dev/bootc/pull/2516", "Seal it"),
        None,
    );
    w.gh(
        ASKS,
        r#"[{"html_url":"https://github.com/cgwalters-forge/tracker/issues/151","title":"Which way?","labels":[{"name":"question"}]},
            {"html_url":"https://github.com/cgwalters-forge/tracker/issues/152","title":"An epic","labels":[{"name":"P1"}]}]"#,
        None,
    );
    w
}

fn rfc3339(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// The operator's events: a review of OWNER/REPO/pulls/N.
fn review_event(pr: &str) -> String {
    let (repo, n) = pr.split_once("/pulls/").unwrap();
    format!(
        r#"[{{"id":"2","type":"PullRequestReviewEvent","actor":{{"login":"cgwalters"}},"repo":{{"name":"{repo}"}},
             "created_at":"{}","payload":{{"action":"created","review":{{"id":1}},
             "pull_request":{{"url":"https://api.github.com/repos/{pr}","number":{n}}}}}}}]"#,
        rfc3339(chrono::Utc::now())
    )
}

/// He approves OWNER/REPO/pulls/N at HEAD, in review ID with an inline
/// comment (discussion_rID+1), after the cursor; the PR's head is HEAD.
fn approve(w: &World, pr: &str, id: u32) {
    approve_at(w, pr, id, chrono::Utc::now() + chrono::Duration::hours(1));
}

/// The same, at a given time.
fn approve_at(w: &World, pr: &str, id: u32, at: chrono::DateTime<chrono::Utc>) {
    let (repo, n) = pr.split_once("/pulls/").unwrap();
    let at = rfc3339(at);
    w.gh(
        &format!("repos/{pr}/comments?since=X&per_page=100&page=1"),
        &format!(
            r#"[{{"id":{c},"user":{{"login":"cgwalters"}},"html_url":"https://github.com/{repo}/pull/{n}#discussion_r{c}",
                 "created_at":"{at}","body":"nit","pull_request_review_id":{id}}}]"#,
            c = id + 1
        ),
        Some("\"rc1\""),
    );
    w.gh(
        &format!("repos/{pr}/reviews?per_page=100&page=1"),
        &format!(
            r#"[{{"id":{id},"user":{{"login":"cgwalters"}},"state":"APPROVED","commit_id":"{HEAD}",
                 "html_url":"https://github.com/{repo}/pull/{n}#pullrequestreview-{id}","submitted_at":"{at}","body":"Ship it"}}]"#
        ),
        None,
    );
    w.gh(
        &format!("repos/{repo}/issues/{n}/comments?since=X&per_page=100&page=1"),
        "[]",
        Some("\"c1\""),
    );
    w.gh(
        &format!("repos/{pr}"),
        &format!(r#"{{"head":{{"sha":"{HEAD}"}}}}"#),
        None,
    );
}

fn assert_no_hot_news(r: &Run, requests: u32, not_modified: u32) {
    assert_eq!(r.status, 0, "{}", r.stderr);
    let tail = format!("(hot cycle: {requests} requests, {not_modified} not modified)\n");
    assert!(
        r.stdout.starts_with("No news at ") && r.stdout.ends_with(&tail),
        "{}{:?}\n{}",
        r.stdout,
        r.gh,
        r.stderr
    );
}

/// A sweep, which builds the hot set, then a hot cycle, which reads the
/// feeds' first pages.
fn swept(w: &World) {
    let r = w.run(&fixtures("base"), &["--once"]);
    assert_news(&r, BASE_KINDS);
    assert_eq!(r.gh.len(), 3, "{:?}", r.gh);
    assert_eq!(
        w.status()["hot"],
        serde_json::json!({"ask": 1, "forge": 1, "recent": 0, "upstream": 1})
    );
    assert_no_hot_news(&w.run(&fixtures("base"), &["--hot-once"]), 2, 0);
}

#[test]
fn a_hot_cycle_wakes_once_on_a_new_approval() {
    let w = hot_world();
    swept(&w);
    // Nothing changed: two 304s, no news.
    let r = w.run(&fixtures("base"), &["--hot-once"]);
    assert_no_hot_news(&r, 2, 2);
    assert_eq!(
        r.gh,
        [
            format!("{NOTIFICATIONS} [If-Modified-Since: {NOTIFICATIONS_LM}] 304"),
            format!("{EVENTS} [If-None-Match: \"e1\"] 304"),
        ]
    );
    assert!(r.calls.is_empty(), "{:?}", r.calls);
    let status = w.status();
    assert_eq!(status["last_cycle"]["requests"], 2, "{status:#}");
    assert_eq!(
        status["last_hour"],
        serde_json::json!({"hot_cycles": 2, "rebuilds": 1, "requests": 7, "not_modified": 2})
    );

    // He approves the fork PR's head.
    w.gh(
        EVENTS,
        &review_event("cgwalters-forge/bootc/pulls/30"),
        Some("\"e2\""),
    );
    approve(&w, "cgwalters-forge/bootc/pulls/30", 900);
    let r = w.run(&fixtures("base"), &["--hot-once"]);
    let run = assert_news(&r, "approval");
    assert!(
        run.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("hot-"),
        "{}",
        run.display()
    );
    assert!(r.calls.is_empty(), "{:?}", r.calls);
    let r = w.run(&fixtures("base"), &["--summary"]);
    for want in [
        "\nApproved fork PRs (promote) (approval):\n  cgwalters-forge/bootc#30  Fix foo: review APPROVED at 0123456789ab (the head): Ship it\n    https://github.com/cgwalters-forge/bootc/pull/30#pullrequestreview-900\n",
        " since the last wake (",
        "Hot set: 3 items (1 ask, 1 forge, 0 recent, 1 upstream), 1 polled directly.\n",
    ] {
        assert!(
            r.stdout.contains(want),
            "--summary lacks {want:?}:\n{}",
            r.stdout
        );
    }

    // A restart: he was active on the fork PR, so its reviews are read on
    // every cycle, but the approval is no news again.
    let r = w.run(&fixtures("base"), &["--hot-once"]);
    assert_no_hot_news(&r, 5, 4);
    assert!(
        r.gh.contains(
            &"repos/cgwalters-forge/bootc/pulls/30/reviews?per_page=100&page=1 200".to_string()
        ),
        "{:?}",
        r.gh
    );
    // Nor is it when a sweep lists it.
    let approved = w.dir.path().join("approved");
    fs::create_dir(&approved).unwrap();
    for s in ["notify", "watch"] {
        fs::copy(
            fixtures("base").join(format!("{s}.txt")),
            approved.join(format!("{s}.txt")),
        )
        .unwrap();
    }
    // With its inline comment, which the inbox lists apart.
    fs::write(
        approved.join("inbox.txt"),
        "https://github.com/cgwalters-forge/bootc/pull/30  [APPROVED]  Fix foo\n  \
         2026-09-30T14:20:59Z review APPROVED: https://github.com/cgwalters-forge/bootc/pull/30#pullrequestreview-900\n    > Ship it\n  \
         2026-09-30T14:20:59Z review comment on src/x.rs: https://github.com/cgwalters-forge/bootc/pull/30#discussion_r901\n    > nit\n  \
         -> approved by https://github.com/cgwalters-forge/bootc/pull/30#pullrequestreview-900: bot-pr promote https://github.com/cgwalters-forge/bootc/pull/30\n",
    )
    .unwrap();
    assert_no_news(&w.run(&approved, &["--once"]));
}

#[test]
fn a_promote_comment_wakes_once() {
    let w = hot_world();
    swept(&w);
    w.gh(
        EVENTS,
        &review_event("cgwalters-forge/bootc/pulls/30"),
        Some("\"e2\""),
    );
    let at = rfc3339(chrono::Utc::now() + chrono::Duration::hours(1));
    w.gh(
        "repos/cgwalters-forge/bootc/pulls/30/reviews?per_page=100&page=1",
        "[]",
        None,
    );
    w.gh(
        "repos/cgwalters-forge/bootc/pulls/30/comments?since=X&per_page=100&page=1",
        "[]",
        None,
    );
    w.gh(
        "repos/cgwalters-forge/bootc/issues/30/comments?since=X&per_page=100&page=1",
        &format!(
            r#"[{{"id":55,"user":{{"login":"cgwalters"}},"html_url":"https://github.com/cgwalters-forge/bootc/pull/30#issuecomment-55",
                 "created_at":"{at}","body":"Thanks!\n/promote"}}]"#
        ),
        None,
    );
    assert_news(&w.run(&fixtures("base"), &["--hot-once"]), "approval");
    // The sweep's inbox names the same comment as the approval.
    let fx = w.dir.path().join("promoted");
    fs::create_dir(&fx).unwrap();
    for s in ["notify", "watch"] {
        fs::copy(
            fixtures("base").join(format!("{s}.txt")),
            fx.join(format!("{s}.txt")),
        )
        .unwrap();
    }
    fs::write(
        fx.join("inbox.txt"),
        "https://github.com/cgwalters-forge/bootc/pull/30  [APPROVED]  Fix foo\n  \
         2026-09-30T14:20:59Z comment: https://github.com/cgwalters-forge/bootc/pull/30#issuecomment-55\n    > Thanks! /promote\n  \
         -> approved by https://github.com/cgwalters-forge/bootc/pull/30#issuecomment-55: bot-pr promote https://github.com/cgwalters-forge/bootc/pull/30\n",
    )
    .unwrap();
    assert_no_news(&w.run(&fx, &["--once"]));
}

#[test]
fn what_a_sweep_saw_before_the_cursor_is_not_hot_news() {
    let w = hot_world();
    swept(&w);
    // His approval from before the last sweep started: the sweep's.
    w.gh(
        EVENTS,
        &review_event("cgwalters-forge/bootc/pulls/30"),
        Some("\"e2\""),
    );
    approve_at(
        &w,
        "cgwalters-forge/bootc/pulls/30",
        900,
        chrono::Utc::now() - chrono::Duration::hours(1),
    );
    let r = w.run(&fixtures("base"), &["--hot-once"]);
    assert_no_hot_news(&r, 5, 1);
}

#[test]
fn a_rate_limit_pauses_the_hot_cycles() {
    let w = hot_world();
    swept(&w);
    w.gh_error(
        NOTIFICATIONS,
        &format!(
            "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: {}\r\n\r\n{{\"message\":\"API rate limit exceeded\"}}",
            (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp()
        ),
    );
    let r = w.run(&fixtures("base"), &["--hot-once"]);
    assert_no_hot_news(&r, 1, 0);
    assert!(r.stderr.contains("rate limiting"), "{}", r.stderr);
    // Nothing is requested until the reset.
    let r = w.run(&fixtures("base"), &["--hot-once"]);
    assert_no_hot_news(&r, 0, 0);
    assert!(r.gh.is_empty(), "{:?}", r.gh);
}

#[test]
fn a_new_approval_wakes_within_one_hot_cycle() {
    let w = hot_world();
    swept(&w);
    // The loop's first hot cycle finds nothing new, its second (a second
    // later) his approval; the sweep isn't due for an hour.
    w.gh_nth(
        EVENTS,
        Some(2),
        &review_event("cgwalters-forge/bootc/pulls/30"),
        Some("\"e2\""),
    );
    approve(&w, "cgwalters-forge/bootc/pulls/30", 900);
    let start = std::time::Instant::now();
    let r = w.run(
        &fixtures("base"),
        &[
            "--interval",
            "3600",
            "--hot-interval",
            "1",
            "--max-duration",
            "60",
        ],
    );
    assert_news(&r, "approval");
    assert!(start.elapsed().as_secs() < 30, "{:?}", start.elapsed());
    assert!(r.calls.is_empty(), "no sweep: {:?}", r.calls);
    let events: Vec<&String> = r.gh.iter().filter(|l| l.starts_with(EVENTS)).collect();
    assert_eq!(events.len(), 2, "{:?}", r.gh);
    assert!(
        events[0].ends_with(" 304") && events[1].ends_with(" 200"),
        "{events:?}"
    );
}

#[test]
fn an_upstream_approval_runs_bot_signoff_due() {
    let w = hot_world();
    swept(&w);
    w.gh(
        EVENTS,
        &review_event("bootc-dev/bootc/pulls/2516"),
        Some("\"e2\""),
    );
    approve(&w, "bootc-dev/bootc/pulls/2516", 901);
    let fx = w.dir.path().join("signoff");
    fs::create_dir(&fx).unwrap();
    fs::write(
        fx.join("signoff.txt"),
        "Signed off: https://github.com/bootc-dev/bootc/pull/2516 (5e20ab31c0d2)\n",
    )
    .unwrap();
    let r = w.run(&fx, &["--hot-once"]);
    let run = assert_news(&r, "review, signoff");
    assert_eq!(r.calls, ["bot-signoff-due --apply"]);
    assert!(run.join("signoff.txt").exists());
    // The sweep's bot-watch lists the same sign-off: no news again.
    let r = w.run(&fixtures("news"), &["--once"]);
    assert_news(&r, "health-P0, approval, notify, forge-review, news");
}

#[test]
fn a_notification_that_asks_runs_bot_notify() {
    let w = hot_world();
    let thread = |at: &str| {
        format!(
            r#"[{{"reason":"mention","updated_at":"{at}","subject":{{"title":"Which way?","url":"https://api.github.com/repos/cgwalters-forge/tracker/issues/151"}},"repository":{{"full_name":"cgwalters-forge/tracker"}}}}]"#
        )
    };
    w.gh(
        NOTIFICATIONS,
        &thread("2026-09-30T10:00:00Z"),
        Some(NOTIFICATIONS_LM),
    );
    swept(&w);
    w.gh(
        NOTIFICATIONS,
        &thread("2026-09-30T11:00:00Z"),
        Some("Wed, 30 Sep 2026 13:00:00 GMT"),
    );
    w.gh(
        "repos/cgwalters-forge/tracker/issues/151/comments?since=X&per_page=100&page=1",
        "[]",
        None,
    );
    let r = w.run(&fixtures("news"), &["--hot-once"]);
    let run = assert_news(&r, "notify");
    assert_eq!(r.calls, ["bot-notify "]);
    assert!(run.join("notify.txt").exists());
    assert!(
        r.gh.iter()
            .any(|l| l.starts_with("repos/cgwalters-forge/tracker/issues/151/comments")),
        "the ask is polled: {:?}",
        r.gh
    );
    // Unchanged since: no bot-notify, no news.
    let r = w.run(&fixtures("news"), &["--hot-once"]);
    assert_no_hot_news(&r, 2, 2);
    assert!(r.calls.is_empty(), "{:?}", r.calls);
}

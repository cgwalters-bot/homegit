//! bot-poll: the coordinator's news-gated poll. It sweeps with
//! bot-notify, `bot-pr inbox` and bot-watch every few minutes, polls the
//! hot set cheaply in between, and exits, waking the coordinator, only
//! when something new turns up.

mod gh;
mod poller;

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, anyhow, bail};
use bot_poll::hot::CycleStat;
use bot_poll::{
    KindNews, LastNews, Output, STATE_VERSION, Source, State, evaluate, news_line, operator,
    render_status, render_summary, status,
};
use chrono::{Local, Utc};
use clap::Parser;
use poller::Poller;

const DEFAULT_INTERVAL: u64 = 900;
const DEFAULT_HOT_INTERVAL: u64 = 90;
const DEFAULT_MAX_DURATION: u64 = 12 * 3600;
/// A step that runs longer than this is killed, so that one hung call
/// can't stall the poll.
const STEP_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const STEP_POLL: Duration = Duration::from_millis(100);
const RUNS_KEEP: Duration = Duration::from_secs(3 * 24 * 3600);
/// Run directories are named by their UTC start, which sorts.
const RUN_ID_FORMAT: &str = "%Y%m%d-%H%M%S-%3f";
/// The tool whose location on PATH says where the others (and the
/// homegit checkout) are.
const LOCATOR: &str = "bot-watch";
/// The prefix of a hot cycle's run directory, which isn't a sweep's.
const HOT_RUN_PREFIX: &str = "hot-";

/// One sweep, in order: output (stdout and stderr) to NAME.txt in the
/// run's directory. None as the tool is git.
const STEPS: [(&str, Option<&str>, &[&str]); 5] = [
    ("git", None, &["pull", "-q", "--ff-only"]),
    ("notify", Some("bot-notify"), &[]),
    ("inbox", Some("bot-pr"), &["inbox", "--dry-run"]),
    ("watch", Some("bot-watch"), &["--apply"]),
    ("tmt-gc", Some("bot-tmt-number"), &["--gc"]),
];

#[derive(Parser)]
#[command(
    about = "The coordinator's news-gated poll of bot-notify, bot-pr inbox and bot-watch",
    long_about = LONG_ABOUT
)]
struct Cli {
    /// Seconds between sweeps.
    #[arg(long, default_value_t = DEFAULT_INTERVAL)]
    interval: u64,
    /// Seconds between hot cycles (0: none).
    #[arg(long, default_value_t = DEFAULT_HOT_INTERVAL)]
    hot_interval: u64,
    /// Seconds after which to give up without news.
    #[arg(long, default_value_t = DEFAULT_MAX_DURATION)]
    max_duration: u64,
    /// Sweep at once, not after an interval.
    #[arg(long)]
    no_wait: bool,
    /// Sweep once, at once, print the news or "No news", and exit.
    #[arg(long)]
    once: bool,
    /// Run one hot cycle, at once, print the news or "No news", and exit.
    #[arg(long, conflicts_with_all = ["once", "summary", "dry_run"])]
    hot_once: bool,
    /// Print the items of the last NEWS report, grouped by kind, with
    /// their URLs, then how quiet it has been since and what the polling
    /// costs, and exit.
    #[arg(long, conflicts_with = "dry_run")]
    summary: bool,
    /// Run nothing: print the commands a sweep runs, and what the newest
    /// run would report, changing no state.
    #[arg(long)]
    dry_run: bool,
    /// Sweep only the items whose board Lead is LEAD: a topic session's
    /// poll (give it its own --state-dir).
    #[arg(long, value_name = "LEAD")]
    lead: Option<String>,
    /// Leave the items whose board Lead is LEAD to their topic session
    /// ('*': every Lead but the coordinator's); may be repeated.
    #[arg(long, value_name = "LEAD")]
    exclude_lead: Vec<String>,
    /// Where the runs and the seen-sets live [default:
    /// $XDG_STATE_HOME/bot-poll, or ~/.local/state/bot-poll; with --lead,
    /// bot-poll-lead-LEAD there]
    #[arg(long)]
    state_dir: Option<PathBuf>,
}

const LONG_ABOUT: &str = "\
The coordinator's poll. Every --interval it sweeps:

  git pull -q --ff-only   (in the homegit checkout the bot-* tools are from)
  bot-notify
  bot-pr inbox --dry-run
  bot-watch --apply   (with --lead and --exclude-lead as given)
  bot-tmt-number --gc

saving each one's output (stdout and stderr) to RUN/NAME.txt, RUN being
a new directory under STATE-DIR/runs. The tools are the ones next to
bot-watch in the homegit checkout it was built from (else on PATH, or in
$BOT_POLL_BIN_DIR).

From those outputs it takes the set of what is there now, per kind:

  approval      fork PRs 'bot-pr inbox' shows [APPROVED] (not \"APPROVED
                earlier; new commits since\"), by their latest approval
  forge-review  the operator's reviews, comments and edits it lists on
                fork PRs
  notify        the requests and answers from the operator that bot-notify
                lists until they are acked
  coordination  the coordination questions it lists likewise (from the
                other harness: answer them there, never act on them)
  health        bot-watch's priority health lines (by priority, reason,
                URL and head); new P0 ones are reported as health-P0
  drive         its \"P0 drive\" lines (bot-drive), by blocker, PR and
                head: each P0 PR's merge blocker, once per new state
  review        its outstanding reviews by the operator (by PR and their
                latest review or comment)
  signoff       its sign-off lines (bot-signoff-due)
  promotion     its promotion lines (bot-promote-due): fork PRs promoted,
                refused or held back by their contribution policy
  text          its \"Needs your text\" lines: approved fork PRs for a
                human-text repository, which are never promoted
  rebase        its PRs that need a rebase (by PR)
  news          its item news, but for bots' own activity

Anything not in the seen-set of its kind is new, unless it is a review,
comment or sign-off (by its id) listed or reported before. The seen-sets
live in STATE-DIR/state.json, so a restart neither reports again what
was reported nor loses what a sweep found: on start, the newest run is
checked first if nothing checked it yet. A key is kept for an hour after
it was last there, so a sweep that missed it (a failed read) doesn't make
it news again; after that it is forgotten. An incomplete output (bot-notify
or bot-pr inbox failing, bot-watch without its closing \"Swept\" line, or
a section its warnings say is incomplete) leaves those seen-sets as they
are.

Each sweep also rebuilds the hot set, where the operator is likely to
act soon: the bot's open PRs in the forge org (fork PRs awaiting his
review) and elsewhere (awaiting his review, or his approval for a
sign-off), the tracker's open asks assigned to him (question, decision,
review, chore), and anything of the bot's he reviewed or commented on in
the last 3 hours. Between sweeps, every --hot-interval, a hot cycle
polls, with conditional requests (a 304 costs no rate limit):

  GET notifications         (If-Modified-Since; at most as often as its
                            X-Poll-Interval says)
  GET users/OPERATOR/events (If-None-Match; likewise)

and then, for each hot item a changed notification thread or one of his
events points at, and each he was active on in the last 3 hours (at most
10), its reviews and comments (If-None-Match). His reviews and comments
since the sweep before the last are new events, by their ids: an
approval of a fork PR's head (or /promote) is an approval, other
activity there forge-review; on a tracker issue notify; on another PR
review (an approval of an upstream PR's head also runs
bot-signoff-due --apply, whose results are signoff), else news. A
thread updated for a mention, review request or assignment runs
bot-notify, whose output counts as a sweep's. What a hot cycle reports,
a sweep doesn't report again, and the other way round. Its files are in
a RUN named hot-*.

On the first new item it prints

  NEWS (KIND, ...) at HHMM: RUN/*.txt

and exits 0; --summary then lists the new items, and how quiet it has
been since and what its own requests cost (STATE-DIR/status.json holds
the same). Otherwise it goes on, until --max-duration is up, when it
prints \"No news ...\" and exits 0. Its first sweep is due an interval after the newest one
started (at once, with --no-wait or --once), so a restart keeps the
schedule. Only one poll runs per STATE-DIR at a time.";

fn state_dir(cli: &Cli) -> Result<PathBuf> {
    if let Some(d) = &cli.state_dir {
        return Ok(d.clone());
    }
    let base = match std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(
            std::env::var_os("HOME").context("neither XDG_STATE_HOME nor HOME is set")?,
        )
        .join(".local/state"),
    };
    // A topic's poll keeps its own seen-sets, apart from the coordinator's.
    Ok(match &cli.lead {
        Some(lead) => base.join(format!("bot-poll-lead-{}", lead.replace('/', "_"))),
        None => base.join("bot-poll"),
    })
}

/// The directory of the bot-* tools: $BOT_POLL_BIN_DIR, else bin/ of the
/// homegit checkout this was built from ('make install-crates' builds it
/// there), else where bot-watch on PATH really lives (install-bin.sh
/// links it from a checkout's bin/).
fn tools_dir() -> Result<PathBuf> {
    if let Some(d) = std::env::var_os("BOT_POLL_BIN_DIR") {
        return Ok(PathBuf::from(d));
    }
    let built = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin");
    if built.join(LOCATOR).is_file() {
        return fs::canonicalize(&built).with_context(|| format!("resolving {}", built.display()));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let found = std::env::split_paths(&path)
        .map(|d| d.join(LOCATOR))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            anyhow!(
                "no {LOCATOR} in {} (the checkout this was built from) nor on PATH; set BOT_POLL_BIN_DIR to homegit's bin/",
                built.display()
            )
        })?;
    let real =
        fs::canonicalize(&found).with_context(|| format!("resolving {}", found.display()))?;
    Ok(real.parent().expect("a file has a parent").to_path_buf())
}

struct Sweeper {
    /// Extra arguments of bot-watch: the --lead and --exclude-lead
    /// filters, which say whose items this poll's sweeps are about.
    watch_args: Vec<String>,
    tools: PathBuf,
    /// The homegit checkout, which the tools are in.
    repo: PathBuf,
    git: PathBuf,
}

impl Sweeper {
    fn new(cli: &Cli) -> Result<Self> {
        let tools = tools_dir()?;
        let repo = tools
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| tools.clone());
        let git =
            std::env::var_os("BOT_POLL_GIT").map_or_else(|| PathBuf::from("git"), PathBuf::from);
        let watch_args = cli
            .lead
            .iter()
            .flat_map(|l| ["--lead", l.as_str()])
            .chain(cli.exclude_lead.iter().flat_map(|l| ["--exclude-lead", l]))
            .map(str::to_string)
            .collect();
        Ok(Sweeper {
            watch_args,
            tools,
            repo,
            git,
        })
    }

    fn command(&self, tool: Option<&str>, args: &[&str]) -> (PathBuf, Vec<String>) {
        let extra = if tool == Some(LOCATOR) {
            self.watch_args.as_slice()
        } else {
            &[]
        };
        let args = args
            .iter()
            .map(|a| a.to_string())
            .chain(extra.iter().cloned());
        match tool {
            Some(t) => (self.tools.join(t), args.collect()),
            None => (
                self.git.clone(),
                ["-C".to_string(), self.repo.display().to_string()]
                    .into_iter()
                    .chain(args)
                    .collect(),
            ),
        }
    }

    /// Runs the steps into run directory `run`, recording each finished
    /// step's exit status (null: killed, or it didn't start) in
    /// status.json as it goes.
    fn sweep(&self, run: &Path) -> Result<()> {
        fs::create_dir_all(run).with_context(|| format!("creating {}", run.display()))?;
        let mut status: BTreeMap<&str, Option<i32>> = BTreeMap::new();
        for (name, tool, args) in STEPS {
            let out_path = run.join(format!("{name}.txt"));
            let code = self.step(&out_path, tool, args)?;
            if code != Some(0) {
                let how = code.map_or("was killed, or failed to start".to_string(), |c| {
                    format!("exited {c}")
                });
                eprintln!(
                    "bot-poll: warning: {name} {how}; see {}",
                    out_path.display()
                );
            }
            status.insert(name, code);
            write_atomic(&run.join("status.json"), &serde_json::to_string(&status)?)?;
        }
        Ok(())
    }

    fn step(&self, out_path: &Path, tool: Option<&str>, args: &[&str]) -> Result<Option<i32>> {
        let (cmd, args) = self.command(tool, args);
        run_captured(out_path, None, &cmd, &args, STEP_TIMEOUT)
    }
}

/// Runs CMD with ARGS, its stdout to OUT_PATH and its stderr there too
/// or to ERR_PATH, killing it after TIMEOUT: its exit status (None:
/// killed, or it didn't start).
fn run_captured(
    out_path: &Path,
    err_path: Option<&Path>,
    cmd: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<Option<i32>> {
    let mut out =
        File::create(out_path).with_context(|| format!("creating {}", out_path.display()))?;
    let err = match err_path {
        Some(p) => File::create(p).with_context(|| format!("creating {}", p.display()))?,
        None => out.try_clone()?,
    };
    let child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(err)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            writeln!(out, "bot-poll: cannot run {}: {e}", cmd.display())?;
            return Ok(None);
        }
    };
    let start = Instant::now();
    loop {
        if let Some(st) = child.try_wait()? {
            return Ok(st.code());
        }
        if start.elapsed() > timeout {
            // Killing an exited child fails harmlessly.
            let _ = child.kill();
            child.wait()?;
            writeln!(
                out,
                "bot-poll: killed {} after {}s",
                cmd.display(),
                timeout.as_secs()
            )?;
            return Ok(None);
        }
        sleep(STEP_POLL);
    }
}

/// The gh CLI: $BOT_POLL_GH, else gh on PATH.
fn gh_path() -> PathBuf {
    std::env::var_os("BOT_POLL_GH").map_or_else(|| PathBuf::from("gh"), PathBuf::from)
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))
}

struct Store {
    dir: PathBuf,
}

impl Store {
    fn runs(&self) -> PathBuf {
        self.dir.join("runs")
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    fn load(&self) -> Result<State> {
        let path = self.state_path();
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(State::default()),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        let state: State = serde_json::from_str(&text).with_context(|| {
            format!(
                "{} is not bot-poll's state; fix or remove it to start over",
                path.display()
            )
        })?;
        if state.version != STATE_VERSION {
            bail!(
                "{} has version {}, not {STATE_VERSION}; remove it to start over",
                path.display(),
                state.version
            );
        }
        Ok(state)
    }

    /// Saves the state, and the status that goes with it.
    fn save(&self, state: &State) -> Result<()> {
        write_atomic(
            &self.state_path(),
            &format!("{}\n", serde_json::to_string(state)?),
        )?;
        write_atomic(
            &self.dir.join("status.json"),
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&status(state, now_ms()))?
            ),
        )
    }

    /// The newest run's id.
    fn latest_run(&self) -> Option<String> {
        let entries = fs::read_dir(self.runs()).ok()?;
        entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| chrono::NaiveDateTime::parse_from_str(n, RUN_ID_FORMAT).is_ok())
            .max()
    }

    /// The outputs of a run's steps that finished.
    fn read_run(&self, id: &str) -> BTreeMap<Source, Output> {
        let run = self.runs().join(id);
        let status: BTreeMap<String, Option<i32>> = fs::read_to_string(run.join("status.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Source::ALL
            .into_iter()
            .filter_map(|s| {
                let code = *status.get(s.name())?;
                let text = fs::read_to_string(run.join(format!("{}.txt", s.name()))).ok()?;
                Some((s, Output { text, status: code }))
            })
            .collect()
    }

    fn prune_runs(&self) {
        let Ok(entries) = fs::read_dir(self.runs()) else {
            return;
        };
        let now = SystemTime::now();
        for e in entries.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|t| now.duration_since(t).unwrap_or_default() > RUNS_KEEP);
            if old && let Err(err) = fs::remove_dir_all(e.path()) {
                eprintln!(
                    "bot-poll: warning: pruning {} failed: {err}",
                    e.path().display()
                );
            }
        }
    }

    /// How long until the next sweep is due: an interval after the newest
    /// one started, so that restarting (after each NEWS) doesn't put the
    /// sweeps off.
    fn until_next_sweep(&self, interval: Duration) -> Duration {
        let Some(started) = self.latest_run().and_then(|id| {
            chrono::NaiveDateTime::parse_from_str(&id, RUN_ID_FORMAT)
                .ok()
                .map(|t| t.and_utc())
        }) else {
            return interval;
        };
        let since = (Utc::now() - started).to_std().unwrap_or_default();
        interval.saturating_sub(since)
    }

    fn run_glob(&self, id: &str) -> String {
        format!("{}/*.txt", self.runs().join(id).display())
    }

    /// Checks run `id` for news, updating state; the NEWS line, if any.
    fn check(&self, state: &mut State, id: &str) -> Option<String> {
        let (news, seen, reported) =
            evaluate(&self.read_run(id), &state.seen, &state.reported, now_ms());
        state.seen = seen;
        state.reported = reported;
        state.evaluated = Some(id.to_string());
        self.record_news(state, news, id)
    }

    /// Records the news of run `id` as the last reported; its NEWS line.
    fn record_news(&self, state: &mut State, news: Vec<KindNews>, id: &str) -> Option<String> {
        if news.is_empty() {
            return None;
        }
        let now = Utc::now();
        let hhmm = now.with_timezone(&Local).format("%H%M").to_string();
        let line = news_line(&news, &hhmm, &self.runs().join(id).display().to_string());
        state.last_news = Some(LastNews {
            at: now.to_rfc3339(),
            run: id.to_string(),
            line: line.clone(),
            items: news,
        });
        Some(line)
    }

    /// Takes the poll's lock, held until the process exits (the kernel
    /// drops it then, however it ends).
    fn lock(&self) -> Result<File> {
        let path = self.dir.join("lock");
        let file = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        match file.try_lock() {
            Ok(()) => Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                bail!("another bot-poll is polling with {}", self.dir.display())
            }
            Err(std::fs::TryLockError::Error(e)) => {
                Err(e).with_context(|| format!("locking {}", path.display()))
            }
        }
    }
}

/// A full sweep: its run id, and its NEWS line if any. Rebuilds the hot
/// set after it.
fn full_sweep(
    store: &Store,
    sweeper: &Sweeper,
    poller: &Poller,
    state: &mut State,
) -> Result<(String, Option<String>)> {
    store.prune_runs();
    state.hot.start_sweep(now_ms());
    let id = Utc::now().format(RUN_ID_FORMAT).to_string();
    sweeper.sweep(&store.runs().join(&id))?;
    let line = store.check(state, &id);
    poller.rebuild(state, now_ms());
    Ok((id, line))
}

/// A hot cycle: its NEWS line if any, and its requests.
fn hot_cycle(
    store: &Store,
    poller: &Poller,
    state: &mut State,
) -> Result<(Option<String>, CycleStat)> {
    let now = Utc::now();
    let id = format!("{HOT_RUN_PREFIX}{}", now.format(RUN_ID_FORMAT));
    // On a copy: a cycle that fails midway leaves the state as it was, so
    // that what it found is found again.
    let mut next = state.clone();
    let cycle = poller.cycle(&mut next, &store.runs().join(&id), now.timestamp_millis())?;
    *state = next;
    Ok((store.record_news(state, cycle.news, &id), cycle.stat))
}

fn run(cli: Cli) -> Result<()> {
    let store = Store {
        dir: state_dir(&cli)?,
    };
    if store.dir.starts_with(std::env::temp_dir()) {
        // Often a tmpfs: a reboot would lose what was reported.
        eprintln!(
            "bot-poll: warning: the state dir {} is under {}, which may not survive a reboot",
            store.dir.display(),
            std::env::temp_dir().display()
        );
    }
    let cfg = operator::load()?;
    if cli.summary {
        let state = store.load()?;
        print!(
            "{}\n{}",
            render_summary(state.last_news.as_ref(), &cfg.operator),
            render_status(&status(&state, now_ms()))
        );
        return Ok(());
    }
    let sweeper = Sweeper::new(&cli)?;
    let poller = Poller {
        cfg: &cfg,
        gh: gh_path(),
        sweeper: &sweeper,
        dir: &store.dir,
    };
    if cli.dry_run {
        println!("A sweep runs:");
        for (_, tool, args) in STEPS {
            let (cmd, args) = sweeper.command(tool, args);
            println!(
                "  {}",
                [cmd.display().to_string()]
                    .into_iter()
                    .chain(args)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
        let mut state = store.load()?;
        println!(
            "Every {}s in between, a hot cycle polls the notifications, {}'s events and \
             the hot items they flag, and up to {} he was active on (hot set: {} items).",
            cli.hot_interval,
            cfg.operator.login,
            bot_poll::hot::MAX_DIRECT,
            state.hot.items.len()
        );
        let Some(id) = store.latest_run() else {
            println!("No run yet.");
            return Ok(());
        };
        match store.check(&mut state, &id) {
            Some(_) => print!(
                "The newest run would report:\n{}",
                render_summary(state.last_news.as_ref(), &cfg.operator)
            ),
            None => println!("The newest run, {id}, has no news."),
        }
        return Ok(());
    }

    fs::create_dir_all(store.runs())
        .with_context(|| format!("creating {}", store.runs().display()))?;
    let _lock = store.lock()?;
    let start = Instant::now();
    let max = Duration::from_secs(cli.max_duration);
    let interval = Duration::from_secs(cli.interval);
    let mut state = store.load()?;
    // Printed before it's saved: a crash in between reports it again
    // rather than never.
    let report = |state: &State, line: &str| -> Result<()> {
        println!("{line}");
        store.save(state)
    };

    // What a sweep found before a restart, if nothing checked it since.
    if let Some(id) = store
        .latest_run()
        .filter(|id| state.evaluated.as_ref() != Some(id))
    {
        if let Some(line) = store.check(&mut state, &id) {
            return report(&state, &line);
        }
        store.save(&state)?;
    }
    let hhmm = || Local::now().format("%H%M");
    if cli.hot_once {
        let (line, stat) = hot_cycle(&store, &poller, &mut state)?;
        if let Some(line) = line {
            return report(&state, &line);
        }
        store.save(&state)?;
        println!(
            "No news at {} (hot cycle: {} requests, {} not modified)",
            hhmm(),
            stat.requests,
            stat.not_modified
        );
        return Ok(());
    }
    if cli.once {
        let (id, line) = full_sweep(&store, &sweeper, &poller, &mut state)?;
        if let Some(line) = line {
            return report(&state, &line);
        }
        store.save(&state)?;
        println!("No news at {}: {}", hhmm(), store.run_glob(&id));
        return Ok(());
    }

    let hot_every = (cli.hot_interval > 0).then(|| Duration::from_secs(cli.hot_interval));
    let mut next_sweep = if cli.no_wait {
        start
    } else {
        start + store.until_next_sweep(interval)
    };
    // A hot cycle at once, unless a sweep is due.
    let mut next_hot = start;
    let end = start + max;
    loop {
        let now = Instant::now();
        if now >= end {
            break;
        }
        if now >= next_sweep {
            let (_, line) = full_sweep(&store, &sweeper, &poller, &mut state)?;
            if let Some(line) = line {
                return report(&state, &line);
            }
            store.save(&state)?;
            next_sweep = now + interval;
            next_hot = Instant::now() + hot_every.unwrap_or_default();
        } else if let Some(every) = hot_every
            && now >= next_hot
        {
            match hot_cycle(&store, &poller, &mut state) {
                Ok((Some(line), _)) => return report(&state, &line),
                Ok((None, _)) => store.save(&state)?,
                Err(e) => eprintln!("bot-poll: warning: the hot cycle failed: {e:#}"),
            }
            next_hot = now + every;
        }
        let wake = match hot_every {
            Some(_) => next_sweep.min(next_hot),
            None => next_sweep,
        }
        .min(end);
        sleep(wake.saturating_duration_since(Instant::now()));
    }
    let last = state
        .evaluated
        .as_ref()
        .map(|id| format!(" (last sweep: {})", store.run_glob(id)))
        .unwrap_or_default();
    println!("No news in {}s{last}", cli.max_duration);
    Ok(())
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bot-poll: {e:#}");
            ExitCode::FAILURE
        }
    }
}

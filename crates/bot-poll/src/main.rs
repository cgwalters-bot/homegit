//! bot-poll: the coordinator's news-gated poll. It sweeps with
//! bot-notify, `bot-pr inbox` and bot-watch every few minutes, and exits,
//! waking the coordinator, only when something new turns up.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, anyhow, bail};
use bot_poll::{
    LastNews, Output, STATE_VERSION, Source, State, evaluate, news_line, render_summary,
};
use chrono::{Local, Utc};
use clap::Parser;

const DEFAULT_INTERVAL: u64 = 900;
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
    /// Seconds after which to give up without news.
    #[arg(long, default_value_t = DEFAULT_MAX_DURATION)]
    max_duration: u64,
    /// Sweep at once, not after an interval.
    #[arg(long)]
    no_wait: bool,
    /// Sweep once, at once, print the news or "No news", and exit.
    #[arg(long)]
    once: bool,
    /// Print the items of the last NEWS report, grouped by kind, with
    /// their URLs, and exit.
    #[arg(long, conflicts_with = "dry_run")]
    summary: bool,
    /// Run nothing: print the commands a sweep runs, and what the newest
    /// run would report, changing no state.
    #[arg(long)]
    dry_run: bool,
    /// Where the runs and the seen-sets live [default:
    /// $XDG_STATE_HOME/bot-poll, or ~/.local/state/bot-poll]
    #[arg(long)]
    state_dir: Option<PathBuf>,
}

const LONG_ABOUT: &str = "\
The coordinator's poll. Every --interval it sweeps:

  git pull -q --ff-only   (in the homegit checkout the bot-* tools are from)
  bot-notify
  bot-pr inbox --dry-run
  bot-watch --apply
  bot-tmt-number --gc

saving each one's output (stdout and stderr) to RUN/NAME.txt, RUN being
a new directory under STATE-DIR/runs. The tools are the ones next to
bot-watch in the homegit checkout it was built from (else on PATH, or in
$BOT_POLL_BIN_DIR).

From those outputs it takes the set of what is there now, per kind:

  approval      fork PRs 'bot-pr inbox' shows [APPROVED] (not \"APPROVED
                earlier; new commits since\"), by his latest approval
  forge-review  cgwalters' reviews, comments and edits it lists on fork PRs
  notify        the requests and answers from cgwalters that bot-notify
                lists until they are acked
  health        bot-watch's priority health lines (by priority, reason,
                URL and head); new P0 ones are reported as health-P0
  review        its outstanding reviews by cgwalters (by PR and his
                latest review or comment)
  signoff       its sign-off lines (bot-signoff-due)
  rebase        its PRs that need a rebase (by PR)
  news          its item news, but for bots' own activity

Anything not in the seen-set of its kind is new. The seen-sets live in
STATE-DIR/state.json, so a restart neither reports again what was
reported nor loses what a sweep found: on start, the newest run is
checked first if nothing checked it yet. A key is kept for an hour after
it was last there, so a sweep that missed it (a failed read) doesn't make
it news again; after that it is forgotten. An incomplete output (bot-notify
or bot-pr inbox failing, bot-watch without its closing \"Swept\" line, or
a section its warnings say is incomplete) leaves those seen-sets as they
are.

On the first new item it prints

  NEWS (KIND, ...) at HHMM: RUN/*.txt

and exits 0; --summary then lists the new items. Otherwise it sweeps
again, until --max-duration is up, when it prints \"No news ...\" and
exits 0. It waits one interval before the first sweep, unless --no-wait
or --once. Only one poll runs per STATE-DIR at a time.";

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
    Ok(base.join("bot-poll"))
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
    tools: PathBuf,
    /// The homegit checkout, which the tools are in.
    repo: PathBuf,
    git: PathBuf,
}

impl Sweeper {
    fn new() -> Result<Self> {
        let tools = tools_dir()?;
        let repo = tools
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| tools.clone());
        let git =
            std::env::var_os("BOT_POLL_GIT").map_or_else(|| PathBuf::from("git"), PathBuf::from);
        Ok(Sweeper { tools, repo, git })
    }

    fn command(&self, tool: Option<&str>, args: &[&str]) -> (PathBuf, Vec<String>) {
        let args = args.iter().map(|a| a.to_string());
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
        let mut out =
            File::create(out_path).with_context(|| format!("creating {}", out_path.display()))?;
        let (cmd, args) = self.command(tool, args);
        let child = Command::new(&cmd)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out.try_clone()?)
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
            if start.elapsed() > STEP_TIMEOUT {
                // Killing an exited child fails harmlessly.
                let _ = child.kill();
                child.wait()?;
                writeln!(
                    out,
                    "bot-poll: killed {} after {}s",
                    cmd.display(),
                    STEP_TIMEOUT.as_secs()
                )?;
                return Ok(None);
            }
            sleep(STEP_POLL);
        }
    }
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

    fn save(&self, state: &State) -> Result<()> {
        write_atomic(
            &self.state_path(),
            &format!("{}\n", serde_json::to_string(state)?),
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

    fn run_glob(&self, id: &str) -> String {
        format!("{}/*.txt", self.runs().join(id).display())
    }

    /// Checks run `id` for news, updating state; the NEWS line, if any.
    fn check(&self, state: &mut State, id: &str) -> Option<String> {
        let now = Utc::now();
        let (news, seen) = evaluate(&self.read_run(id), &state.seen, now.timestamp_millis());
        state.seen = seen;
        state.evaluated = Some(id.to_string());
        if news.is_empty() {
            return None;
        }
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

fn run(cli: Cli) -> Result<()> {
    let store = Store {
        dir: state_dir(&cli)?,
    };
    if cli.summary {
        print!("{}", render_summary(store.load()?.last_news.as_ref()));
        return Ok(());
    }
    let sweeper = Sweeper::new()?;
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
        let Some(id) = store.latest_run() else {
            println!("No run yet.");
            return Ok(());
        };
        let mut state = store.load()?;
        match store.check(&mut state, &id) {
            Some(_) => print!(
                "The newest run would report:\n{}",
                render_summary(state.last_news.as_ref())
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
    if !cli.no_wait && !cli.once {
        sleep(interval.min(max));
    }
    loop {
        if !cli.once && start.elapsed() >= max {
            break;
        }
        store.prune_runs();
        let id = Utc::now().format(RUN_ID_FORMAT).to_string();
        sweeper.sweep(&store.runs().join(&id))?;
        if let Some(line) = store.check(&mut state, &id) {
            return report(&state, &line);
        }
        store.save(&state)?;
        if cli.once {
            println!(
                "No news at {}: {}",
                Local::now().format("%H%M"),
                store.run_glob(&id)
            );
            return Ok(());
        }
        if start.elapsed() + interval >= max {
            break;
        }
        sleep(interval);
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

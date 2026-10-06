//! `bot-sched`: the scheduler's command line. See --help.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};

use bot_sched::action::emit;
use bot_sched::forge::{Forge, Recorded, Recorder, Rest};
use bot_sched::model::{BoardRef, SNAPSHOT_SCHEMA, Snapshot};
use bot_sched::observe::observe;
use bot_sched::parity::{Parity, parity};
use bot_sched::{operator, report, rules};

/// The scheduler: observes the forge as a typed snapshot, reconciles it
/// with pure rules, and emits the writes they ask for as gh-aw safe
/// outputs. It never writes to the forge itself.
#[derive(Parser)]
#[command(name = "bot-sched", version)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Args)]
struct Source {
    /// Answer from this recording instead of asking GitHub (see
    /// 'observe --record'); no token is needed.
    #[arg(long, value_name = "FILE")]
    recorded: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Read the board into a snapshot and print it as JSON.
    Observe {
        #[command(flatten)]
        source: Source,
        /// Also keep GitHub's answers in FILE, for --recorded.
        #[arg(long, value_name = "FILE", conflicts_with = "recorded")]
        record: Option<PathBuf>,
    },
    /// Print the actions that would bring the board to where it should be.
    Reconcile {
        #[command(flatten)]
        source: Source,
        /// Reconcile this snapshot ('observe' output) instead of observing.
        #[arg(long, value_name = "FILE", conflicts_with = "recorded")]
        snapshot: Option<PathBuf>,
        /// Run only this rule; may be repeated. All of them by default.
        #[arg(long, value_name = "NAME")]
        rule: Vec<String>,
        /// Print the actions as JSON.
        #[arg(long)]
        json: bool,
        /// Write the actions' writes to FILE as gh-aw's agent_output.json.
        #[arg(long, value_name = "FILE")]
        emit: Option<PathBuf>,
    },
    /// Check that bot-reconcile's rules of the same names list the same
    /// actions on the same board; exits 1 unless they do.
    Parity {
        #[command(flatten)]
        source: Source,
        /// Where the files bot-reconcile is given are written.
        #[arg(long, value_name = "DIR")]
        dir: PathBuf,
        /// The directory of bot-reconcile.
        #[arg(long, value_name = "DIR", default_value = "bin")]
        bin_dir: PathBuf,
    },
    /// The controller's pass with nothing applied, as a Markdown report:
    /// 'bot-sweep --read-only', 'bot-reconcile' on that sweep, and this
    /// tool's own observe, reconcile and emit. Written to DIR/report.md
    /// and appended to $GITHUB_STEP_SUMMARY, if set. Exits 0 once the
    /// report is written, whatever the steps found.
    Report {
        #[command(flatten)]
        source: Source,
        /// Where the report, the sweep's run, the snapshot and
        /// agent_output.json go.
        #[arg(long, value_name = "DIR")]
        dir: PathBuf,
        /// The directory of bot-sweep and bot-reconcile.
        #[arg(long, value_name = "DIR", default_value = "bin")]
        bin_dir: PathBuf,
    },
}

fn forge(source: &Source) -> Result<Box<dyn Forge>> {
    Ok(match &source.recorded {
        Some(file) => Box::new(Recorded::load(file)?),
        None => Box::new(Rest::from_env()?),
    })
}

fn board() -> Result<BoardRef> {
    let board = operator::load()?.board;
    Ok(BoardRef {
        owner_type: board.owner_type,
        owner: board.owner,
        number: board.number,
    })
}

fn read_snapshot(file: &Path) -> Result<Snapshot> {
    let text = std::fs::read_to_string(file)
        .with_context(|| format!("cannot read the snapshot {}", file.display()))?;
    let snapshot: Snapshot = serde_json::from_str(&text)
        .with_context(|| format!("{} is not a snapshot", file.display()))?;
    anyhow::ensure!(
        snapshot.schema == SNAPSHOT_SCHEMA,
        "{} is a snapshot of schema '{}', not {SNAPSHOT_SCHEMA}",
        file.display(),
        snapshot.schema
    );
    Ok(snapshot)
}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn warn(problems: &[String]) {
    for problem in problems {
        eprintln!("bot-sched: warning: not read: {problem}");
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Cmd::Observe { source, record } => {
            let forge = forge(&source)?;
            let recorder = Recorder::new(forge.as_ref());
            let observed = observe(&recorder, &board()?)?;
            if let Some(file) = record {
                recorder.save(&file)?;
            }
            warn(&observed.problems);
            print_json(&observed.snapshot)
        }
        Cmd::Reconcile {
            source,
            snapshot,
            rule,
            json,
            emit: emit_to,
        } => {
            let snapshot = match snapshot {
                Some(file) => read_snapshot(&file)?,
                None => {
                    let observed = observe(forge(&source)?.as_ref(), &board()?)?;
                    warn(&observed.problems);
                    observed.snapshot
                }
            };
            let actions = rules::reconcile(&snapshot, &rule)?;
            if let Some(file) = emit_to {
                let emitted = emit(&actions, &snapshot.board);
                let text = serde_json::to_string_pretty(&emitted.output)?;
                std::fs::write(&file, text + "\n")
                    .with_context(|| format!("cannot write {}", file.display()))?;
                for (key, why) in &emitted.unsupported {
                    eprintln!("bot-sched: not emitted: {key}: {why}");
                }
            }
            if json {
                return print_json(&serde_json::json!({ "actions": actions }));
            }
            if actions.is_empty() {
                println!("Actions: none");
            }
            for action in &actions {
                println!("{}", action.line());
            }
            Ok(())
        }
        Cmd::Parity {
            source,
            dir,
            bin_dir,
        } => {
            let observed = observe(forge(&source)?.as_ref(), &board()?)?;
            warn(&observed.problems);
            let actions = rules::reconcile(&observed.snapshot, &[])?;
            let parity = parity(&dir, &bin_dir, &observed.snapshot, &actions);
            println!("Against bot-reconcile on the same board: {parity}");
            anyhow::ensure!(matches!(parity, Parity::Same(_)), "the rules do not agree");
            Ok(())
        }
        Cmd::Report {
            source,
            dir,
            bin_dir,
        } => {
            let opts = report::Options { dir, bin_dir };
            let source = forge(&source).and_then(|forge| Ok((forge, board()?)));
            let file = report::report(&opts, source)?;
            println!("bot-sched: wrote {}", file.display());
            Ok(())
        }
    }
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bot-sched: error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

//! bot-meta: edit the bot-meta section of the bot's fork PR bodies, for
//! bot-pr. It reads a section on stdin and prints the result on stdout.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the run footers in the bot-meta section on stdin,
    /// blank-separated.
    Footers {
        /// Fold them in the collapsed block, as the section and the
        /// upstream PR carry them (nothing if there are none).
        #[arg(long)]
        fold: bool,
    },
    /// Print the run footer in FILE, failing unless it is one as
    /// bot-footer prints it: a summary line, then a marker line.
    CheckFooter { file: PathBuf },
    /// Print the bot-meta section on stdin with the run FOOTER added
    /// after its other footers, all folded in the block at its end.
    AddFooter { footer: String },
}

fn stdin() -> Result<String> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .context("reading stdin")?;
    Ok(text)
}

fn run(cli: Cli) -> Result<String> {
    Ok(match cli.command {
        Command::Footers { fold } => {
            let meta = stdin()?;
            let footers = bot_meta::footers(&meta);
            if fold {
                bot_meta::fold(footers)
            } else {
                bot_meta::join_footers(footers)
            }
        }
        Command::CheckFooter { file } => {
            let text = std::fs::read_to_string(&file)
                .with_context(|| format!("reading the footer '{}'", file.display()))?;
            bot_meta::parse_footer(&text)
                .with_context(|| format!("the footer '{}'", file.display()))?
        }
        Command::AddFooter { footer } => bot_meta::add_footer(&stdin()?, &footer)?,
    })
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(out) => {
            let mut stdout = std::io::stdout().lock();
            if out.is_empty() {
                return ExitCode::SUCCESS;
            }
            let end = if out.ends_with('\n') { "" } else { "\n" };
            match write!(stdout, "{out}{end}") {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("bot-meta: error: writing stdout: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(e) => {
            eprintln!("bot-meta: error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

//! The controller's pass with nothing applied, as one Markdown report:
//! `bot-sweep --read-only` and `bot-reconcile` on that sweep, as before,
//! and the scheduler's own pass (observe, reconcile, emit) next to them.
//! The controller-report workflow runs it with the job's read-only
//! token, to compare with the local sweep before any write moves.

use std::fmt::{self, Write as _};
use std::fs;
use std::marker::PhantomData;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Number;

use crate::action::Action;
use crate::forge::Forge;
use crate::forge::github::emit;
use crate::model::Snapshot;
use crate::observe::observe;
use crate::parity::{Parity, parity};
use crate::rules::{RULES, reconcile};
use crate::tool::{self, Ran, exit_text};

pub const REPORT_FILE: &str = "report.md";
pub const SNAPSHOT_FILE: &str = "snapshot.json";
/// The scheduler's safe outputs, as gh-aw's handlers read them.
pub const AGENT_OUTPUT_FILE: &str = "agent_output.json";
const RECONCILE: &str = "reconcile";
const SWEEP_TOOL: &str = "bot-sweep";
const RECONCILE_TOOL: &str = "bot-reconcile";
const STATUS_FILE: &str = "status.json";
const SUMMARY_ENV: &str = "GITHUB_STEP_SUMMARY";
/// bot-sweep stops its own steps by 22 minutes.
const SWEEP_TIMEOUT: Duration = Duration::from_secs(25 * 60);
const RECONCILE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A job summary holds 1MiB: each output is cut to this many characters
/// there; the steps' are whole in the sweep's run directory.
const OUTPUT_MAX: usize = 60 * 1000;

pub struct Options {
    /// Where the report and what it is made from are written.
    pub dir: PathBuf,
    /// The directory of bot-sweep and bot-reconcile.
    pub bin_dir: PathBuf,
}

/// How a step of the sweep ended, in its status.json: `exit` is null for
/// one that was killed.
#[derive(Debug, Deserialize)]
struct Step {
    exit: Option<i64>,
    duration_s: Number,
}

/// bot-sweep's `status.json`.
#[derive(Debug, Deserialize)]
struct SweepStatus {
    run: String,
    dir: PathBuf,
    started_at: String,
    duration_s: Number,
    complete: bool,
    #[serde(default)]
    problems: Vec<String>,
    /// In the order the sweep ran them.
    #[serde(default, deserialize_with = "ordered")]
    steps: Vec<(String, Step)>,
}

/// A JSON object's entries in the order they were written, which
/// serde_json's own map does not keep.
fn ordered<'de, D, T>(deserializer: D) -> Result<Vec<(String, T)>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Entries<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> Visitor<'de> for Entries<T> {
        type Value = Vec<(String, T)>;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an object")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut entries = Vec::new();
            while let Some(entry) = map.next_entry()? {
                entries.push(entry);
            }
            Ok(entries)
        }
    }

    deserializer.deserialize_map(Entries(PhantomData))
}

/// Seconds to a tenth, as status.json has them.
fn tenths(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 10.0).round() / 10.0
}

/// A fenced block that TEXT cannot close early.
fn fenced(text: &str) -> String {
    let total = text.chars().count();
    let cut = if total > OUTPUT_MAX {
        let kept: String = text.chars().take(OUTPUT_MAX).collect();
        format!("{kept}\n[... {} more characters cut]\n", total - OUTPUT_MAX)
    } else {
        text.to_owned()
    };
    let longest = cut
        .split(|c: char| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0)
        .max(2);
    let fence = "`".repeat(longest + 1);
    let newline = if cut.is_empty() || cut.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    format!("{fence}text\n{cut}{newline}{fence}")
}

fn section(name: &str, exit: Option<i64>, seconds: &dyn fmt::Display, output: &str) -> String {
    format!(
        "<details><summary><code>{name}</code>: {}, {seconds}s, {} characters</summary>\n\n{}\n\n</details>\n",
        exit_text(exit),
        output.chars().count(),
        fenced(output)
    )
}

fn tool_section(name: &str, ran: &Ran) -> String {
    section(name, ran.exit, &tenths(ran.duration), &ran.output)
}

/// The scheduler's own pass: what it observed, the actions of its rules,
/// what of them it can emit, and whether bot-reconcile agrees.
struct Pass {
    snapshot: Snapshot,
    problems: Vec<String>,
    actions: Vec<Action>,
    unsupported: Vec<(String, String)>,
    emitted: usize,
    parity: Parity,
}

fn rule_names() -> String {
    RULES.iter().map(|r| r.name).collect::<Vec<_>>().join(", ")
}

fn pass_section(pass: &Result<Pass>) -> String {
    let mut out = String::from("## Scheduler (bot-sched)\n\n");
    let pass = match pass {
        Ok(pass) => pass,
        Err(e) => {
            let _ = writeln!(out, "Its pass failed:\n\n{}\n", fenced(&format!("{e:#}\n")));
            return out;
        }
    };
    let items = &pass.snapshot.items;
    let _ = writeln!(
        out,
        "Observed {} board items ({} of an issue or PR, their state from the board's own listing) and {} linked PRs.\n",
        items.len(),
        items.iter().filter(|it| it.content.is_some()).count(),
        pass.snapshot.linked.len()
    );
    if !pass.problems.is_empty() {
        let _ = writeln!(
            out,
            "Not read:\n\n{}\n",
            fenced(&(pass.problems.join("\n") + "\n"))
        );
    }
    let lines: Vec<String> = pass.actions.iter().map(Action::line).collect();
    let _ = writeln!(out, "Actions of {}: {}\n", rule_names(), lines.len());
    if !lines.is_empty() {
        let _ = writeln!(out, "{}\n", fenced(&(lines.join("\n") + "\n")));
    }
    let _ = writeln!(
        out,
        "Safe outputs: {} in `{AGENT_OUTPUT_FILE}` (nothing applies them yet).\n",
        pass.emitted
    );
    if !pass.unsupported.is_empty() {
        let none: Vec<String> = pass
            .unsupported
            .iter()
            .map(|(key, why)| format!("{key}: {why}"))
            .collect();
        let _ = writeln!(
            out,
            "No safe-output type:\n\n{}\n",
            fenced(&(none.join("\n") + "\n"))
        );
    }
    let _ = writeln!(
        out,
        "Against bot-reconcile on the same board: {}\n",
        pass.parity
    );
    out
}

fn pass(opts: &Options, forge: &dyn Forge) -> Result<Pass> {
    let observed = observe(forge)?;
    let snapshot = observed.snapshot;
    let write = |name: &str, text: String| {
        let file = opts.dir.join(name);
        fs::write(&file, text + "\n").with_context(|| format!("cannot write {}", file.display()))
    };
    write(SNAPSHOT_FILE, serde_json::to_string_pretty(&snapshot)?)?;
    let actions = reconcile(&snapshot, &[])?;
    let emitted = emit(&actions, &snapshot.board);
    write(
        AGENT_OUTPUT_FILE,
        serde_json::to_string_pretty(&emitted.output)?,
    )?;
    let parity = parity(&opts.dir, &opts.bin_dir, &snapshot, &actions);
    Ok(Pass {
        snapshot,
        problems: observed.problems,
        actions,
        unsupported: emitted.unsupported,
        emitted: emitted.output.items.len(),
        parity,
    })
}

/// The sweep's status, or why there is none to report.
fn read_status(file: &std::path::Path) -> Result<SweepStatus, String> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("bot-sweep published no status".to_owned());
        }
        Err(e) => return Err(format!("bot-sweep's {STATUS_FILE} cannot be read: {e}")),
    };
    serde_json::from_str(&text)
        .map_err(|e| format!("bot-sweep's {STATUS_FILE} is not what this reads: {e}"))
}

fn render(
    status: &Result<SweepStatus, String>,
    sweep: &Ran,
    reconcile: &Ran,
    pass: &Result<Pass>,
) -> String {
    let mut out = String::new();
    match status {
        Ok(st) => {
            let _ = writeln!(out, "# Controller report (read-only): sweep {}\n", st.run);
            let complete = if st.complete {
                "complete"
            } else {
                "not complete"
            };
            let _ = writeln!(
                out,
                "Started {}, took {}s; {complete}.\n",
                st.started_at, st.duration_s
            );
            if st.problems.is_empty() {
                out.push_str("No problems.\n\n");
            } else {
                // Fenced: a problem ends with a tool's last line, which is not Markdown.
                let _ = writeln!(
                    out,
                    "Problems:\n\n{}\n",
                    fenced(&(st.problems.join("\n") + "\n"))
                );
            }
        }
        Err(why) => {
            let _ = writeln!(
                out,
                "# Controller report (read-only): sweep not published\n"
            );
            let _ = writeln!(out, "{why} ({}).\n", sweep.exit_text());
        }
    }
    out.push_str(&pass_section(pass));
    for (st, (name, step)) in status
        .iter()
        .flat_map(|st| st.steps.iter().map(move |s| (st, s)))
    {
        let output = fs::read(st.dir.join(format!("{name}.txt"))).map_or_else(
            |e| format!("cannot read the output of {name}: {e}\n"),
            |b| String::from_utf8_lossy(&b).into_owned(),
        );
        out.push_str(&section(name, step.exit, &step.duration_s, &output));
        out.push('\n');
    }
    out.push_str(&tool_section(RECONCILE, reconcile));
    out.push('\n');
    out.push_str(&tool_section(SWEEP_TOOL, sweep));
    out
}

/// Writes the report into `opts.dir` (and appends it to the job summary,
/// if there is one), and returns its path. Whatever the steps found is in
/// the report, a SOURCE that could not be had included; only failing to
/// write the report is an error.
pub fn report(opts: &Options, source: Result<Box<dyn Forge>>) -> Result<PathBuf> {
    let sweep_dir = opts.dir.join("sweep");
    fs::create_dir_all(&sweep_dir)
        .with_context(|| format!("cannot create {}", sweep_dir.display()))?;
    let status_file = sweep_dir.join(STATUS_FILE);
    // In a directory used before: a sweep that publishes nothing must not
    // be reported with the last one's status.
    match fs::remove_file(&status_file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(e).with_context(|| format!("cannot remove {}", status_file.display()));
        }
        _ => {}
    }
    let sweep_arg = sweep_dir.to_string_lossy();
    let sweep = tool::run(
        &opts.bin_dir.join(SWEEP_TOOL),
        &["--read-only", "--state-dir", &sweep_arg],
        SWEEP_TIMEOUT,
        &opts.dir.join("sweep.txt"),
        true,
    );
    let status = read_status(&status_file);
    let reconcile = tool::run(
        &opts.bin_dir.join(RECONCILE_TOOL),
        &["--sweep-dir", &sweep_arg],
        RECONCILE_TIMEOUT,
        &opts.dir.join(format!("{RECONCILE}.txt")),
        true,
    );
    let pass = source.and_then(|forge| pass(opts, forge.as_ref()));
    let text = render(&status, &sweep, &reconcile, &pass);
    let file = opts.dir.join(REPORT_FILE);
    fs::write(&file, &text).with_context(|| format!("cannot write {}", file.display()))?;
    if let Some(summary) = std::env::var_os(SUMMARY_ENV).filter(|s| !s.is_empty()) {
        use std::io::Write as _;
        fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&summary)
            .and_then(|mut f| f.write_all(text.as_bytes()))
            .with_context(|| format!("cannot append to ${SUMMARY_ENV}"))?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_outlast_the_text() {
        // (text, the fence, the block's last line before the fence)
        let cases = [
            ("plain\n", "```", "plain"),
            ("no newline", "```", "no newline"),
            ("a ```` fence\n", "`````", "a ```` fence"),
            ("", "```", "```text"),
        ];
        for (text, fence, last) in cases {
            let block = fenced(text);
            let lines: Vec<&str> = block.lines().collect();
            assert_eq!(lines[0], format!("{fence}text"), "{text:?}");
            assert_eq!(lines[lines.len() - 1], fence, "{text:?}");
            assert_eq!(lines[lines.len() - 2], last, "{text:?}");
        }
        let long = "x".repeat(OUTPUT_MAX + 7);
        assert!(fenced(&long).ends_with("\n[... 7 more characters cut]\n```"));
    }

    #[test]
    fn steps_keep_the_sweeps_order() {
        let status: SweepStatus = serde_json::from_str(
            r#"{"run": "r", "dir": "/d", "started_at": "t", "duration_s": 1, "complete": true,
                "steps": {"watch": {"exit": 0, "duration_s": 0.5}, "inbox": {"exit": null, "duration_s": 2}, "handback": {"exit": 1, "duration_s": 0}}}"#,
        )
        .unwrap();
        let names: Vec<_> = status
            .steps
            .iter()
            .map(|(name, step)| (name.as_str(), step.exit))
            .collect();
        assert_eq!(
            names,
            [("watch", Some(0)), ("inbox", None), ("handback", Some(1))]
        );
    }
}

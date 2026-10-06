//! Running the tools that are not ported yet, bounded in time.

use std::fs::{self, File};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

const POLL: Duration = Duration::from_millis(100);

/// How a tool's run ended.
#[derive(Debug)]
pub struct Ran {
    /// None for one that was killed, or could not start.
    pub exit: Option<i64>,
    pub duration: Duration,
    /// Its stdout, and whatever kept it from running.
    pub output: String,
}

impl Ran {
    /// "exit 1", or "killed".
    pub fn exit_text(&self) -> String {
        exit_text(self.exit)
    }
}

/// "exit 1", or "killed" for None.
pub fn exit_text(exit: Option<i64>) -> String {
    exit.map_or("killed".to_owned(), |code| format!("exit {code}"))
}

/// Runs TOOL to its end or TIMEOUT, with its stdout kept in CAPTURE, and
/// its stderr too if MERGE (a report shows both; a parser wants one).
pub fn run(tool: &Path, args: &[&str], timeout: Duration, capture: &Path, merge: bool) -> Ran {
    let start = Instant::now();
    let wait = || -> Result<Option<i64>> {
        let out =
            File::create(capture).with_context(|| format!("cannot write {}", capture.display()))?;
        let err = if merge {
            Stdio::from(out.try_clone()?)
        } else {
            Stdio::inherit()
        };
        let mut child = Command::new(tool)
            .args(args)
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .with_context(|| format!("cannot run {}", tool.display()))?;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status.code().map(i64::from));
            }
            if start.elapsed() > timeout {
                child.kill()?;
                child.wait()?;
                return Ok(None);
            }
            std::thread::sleep(POLL);
        }
    };
    let (exit, error) = match wait() {
        Ok(exit) => (exit, String::new()),
        Err(e) => (None, format!("{e:#}\n")),
    };
    let output = fs::read(capture).map(|b| String::from_utf8_lossy(&b).into_owned());
    Ran {
        exit,
        duration: start.elapsed(),
        output: output.unwrap_or_default() + &error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_are_bounded_and_say_how_they_ended() {
        let dir = tempfile::tempdir().unwrap();
        let capture = dir.path().join("out");
        let sh = Path::new("/bin/sh");
        let long = Duration::from_secs(30);
        // (script, timeout, merge, the exit, the output)
        let cases = [
            (
                "echo out; echo err >&2; exit 3",
                long,
                true,
                Some(3),
                "out\nerr\n",
            ),
            ("echo out; echo err >&2", long, false, Some(0), "out\n"),
            (
                "echo early; sleep 30",
                Duration::from_secs(2),
                true,
                None,
                "early\n",
            ),
        ];
        for (script, timeout, merge, exit, output) in cases {
            let ran = run(sh, &["-c", script], timeout, &capture, merge);
            assert_eq!((ran.exit, ran.output.as_str()), (exit, output), "{script}");
            assert!(ran.duration < long, "{script}");
        }
        let missing = run(&dir.path().join("nope"), &[], long, &capture, true);
        assert_eq!(missing.exit_text(), "killed");
        assert!(
            missing.output.starts_with("cannot run "),
            "{}",
            missing.output
        );
    }
}

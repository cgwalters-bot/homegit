//! The run footers in the bot-meta section that bot-pr appends to fork PR
//! bodies. A footer is what bot-footer prints (or an agent.yml run's
//! summary): one human summary line, then a marker line carrying the same
//! data as JSON in an HTML comment. Footers accumulate at the end of the
//! section, folded in one collapsed `<details>` block (the cost needn't
//! show by default), where bot-runs and later sweeps read them back; the
//! upstream PR gets the same block after its body.

use anyhow::{Context, Result, bail};

/// The lines that open and close the bot-meta section.
pub const META_START: &str = "<!-- bot-meta -->";
pub const META_END: &str = "<!-- /bot-meta -->";

/// The schemas of the markers that end a run footer: bot-footer's, and an
/// agent.yml run's.
const MARKER_SCHEMAS: &[&str] = &["bot-run/v1", "agent-run-summary/v1"];
const MARKER_OPEN: &str = "<!-- ";
const MARKER_CLOSE: &str = " -->";
/// The starts of a footer's summary line, the line before its marker:
/// bot-footer's, and an agent.yml run's.
const SUMMARY_PREFIXES: &[&str] = &["<sub>Bot run: ", "Agent run ["];
/// The lines of the block the footers are folded in.
pub const DETAILS_OPEN: &str = "<details><summary>Run details</summary>";
pub const DETAILS_CLOSE: &str = "</details>";

/// Whether `line` is a run footer's marker: `<!-- SCHEMA {...} -->`, with
/// SCHEMA one of [`MARKER_SCHEMAS`].
pub fn is_marker(line: &str) -> bool {
    let Some(rest) = line.strip_prefix(MARKER_OPEN) else {
        return false;
    };
    let Some(json) = MARKER_SCHEMAS
        .iter()
        .find_map(|schema| rest.strip_prefix(schema)?.strip_prefix(' '))
    else {
        return false;
    };
    json.strip_suffix(MARKER_CLOSE)
        .is_some_and(|json| json.len() >= 2 && json.starts_with('{') && json.ends_with('}'))
}

/// Whether `line` is a footer's summary line, when a marker follows it.
/// Only lines that look like one count, so no other line in the section
/// is ever taken along with a footer.
fn is_summary(line: &str) -> bool {
    SUMMARY_PREFIXES.iter().any(|p| line.starts_with(p))
}

/// Whether `line` opens or closes the footers' block, maybe after a hand
/// edit.
fn is_details_line(line: &str) -> bool {
    let line = line.trim();
    line == DETAILS_OPEN || line == DETAILS_CLOSE
}

/// One run footer: its summary line, if it has one, and its marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Footer<'a> {
    pub summary: Option<&'a str>,
    pub marker: &'a str,
}

impl std::fmt::Display for Footer<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(summary) = self.summary {
            writeln!(f, "{summary}")?;
        }
        f.write_str(self.marker)
    }
}

/// The run footers in `meta`, in order.
pub fn footers(meta: &str) -> Vec<Footer<'_>> {
    let mut prev = "";
    let mut found = Vec::new();
    for line in meta.lines() {
        if is_marker(line) {
            found.push(Footer {
                summary: is_summary(prev).then_some(prev),
                marker: line,
            });
        }
        prev = line;
    }
    found
}

/// `footers` as text, blank-separated.
pub fn join_footers<'a>(footers: impl IntoIterator<Item = Footer<'a>>) -> String {
    footers
        .into_iter()
        .map(|f| f.to_string())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `footers` folded in the collapsed block, or nothing if there are none.
/// The blank lines let the markdown inside render.
pub fn fold<'a>(footers: impl IntoIterator<Item = Footer<'a>>) -> String {
    let joined = join_footers(footers);
    if joined.is_empty() {
        return joined;
    }
    format!("{DETAILS_OPEN}\n\n{joined}\n\n{DETAILS_CLOSE}")
}

/// The run footer in `text`, if it is one as bot-footer prints it: a
/// summary line, then a marker. Blank lines and CRs are ignored.
pub fn parse_footer(text: &str) -> Result<String> {
    let text = text.replace('\r', "");
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        bail!("it is empty; did bot-footer fail?");
    }
    match lines[..] {
        [summary, marker]
            if is_summary(summary)
                && !summary.contains("<!--")
                && !summary.contains("bot-meta")
                && !marker.contains("bot-meta")
                && is_marker(marker) =>
        {
            Ok(format!("{summary}\n{marker}"))
        }
        _ => bail!(
            "it doesn't look like bot-footer output: a summary line, then a '<!-- bot-run/v1 {{...}} -->' line"
        ),
    }
}

/// `meta`, a whole bot-meta section, with `footer` added after its other
/// footers, all folded in one block at its end, as bot-pr's meta_section
/// lays them out. Footers found elsewhere in the section (from before
/// they were folded) move into the block too.
pub fn add_footer(meta: &str, footer: &str) -> Result<String> {
    let meta = meta.trim_end();
    if !(meta.starts_with(META_START) && meta.ends_with(META_END)) {
        bail!("not a complete bot-meta section, from {META_START} to {META_END}");
    }
    let footer = parse_footer(footer).context("the footer to add")?;
    let mut all = footers(meta);
    all.extend(footers(&footer));
    let rest = strip_footers(meta);
    let rest = rest
        .strip_suffix(META_END)
        .context("the section's end marker went missing")?
        .trim_end_matches('\n');
    Ok(format!("{rest}\n\n{}\n{META_END}\n", fold(all)))
}

/// `meta` without its run footers and the lines of their block, wherever
/// they are, and without the runs of blank lines that leaves.
fn strip_footers(meta: &str) -> String {
    let lines: Vec<&str> = meta.lines().collect();
    let mut drop = vec![false; lines.len()];
    for (i, line) in lines.iter().enumerate() {
        if is_marker(line) {
            drop[i] = true;
            if i > 0 && is_summary(lines[i - 1]) {
                drop[i - 1] = true;
            }
        } else if is_details_line(line) {
            drop[i] = true;
        }
    }
    let mut out = String::new();
    let mut blank = false;
    for (line, dropped) in lines.iter().zip(drop) {
        if dropped || (line.is_empty() && blank) {
            continue;
        }
        blank = line.is_empty();
        out.push_str(line);
        out.push('\n');
    }
    out.truncate(out.trim_end_matches('\n').len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT: &str = r#"<!-- bot-run/v1 {"task":"x"} -->"#;
    const AGENT: &str = r#"<!-- agent-run-summary/v1 {"run_id":1} -->"#;
    const S1: &str = "<sub>Bot run: session a</sub>";
    const S2: &str = "<sub>Bot run: session b</sub>";
    const SA: &str = "Agent run [1](https://x): claude, 1m, success";
    const HEAD: &str =
        "<!-- bot-meta -->\n---\n\n- Upstream: `a/b`, base `main`\n- Board item: `PVTI_x`";

    fn fp<'a>(summary: Option<&'a str>, marker: &'a str) -> Footer<'a> {
        Footer { summary, marker }
    }

    #[test]
    fn markers() {
        let cases = [
            (BOT, true),
            (AGENT, true),
            (r#"<!-- bot-run/v1 {} -->"#, true),
            (r#"<!-- bot-run/v2 {"task":"x"} -->"#, false),
            (r#"<!-- bot-run/v1 { -->"#, false),
            (r#"<!-- bot-run/v1 {"task":"x"} --> "#, false),
            (r#" <!-- bot-run/v1 {"task":"x"} -->"#, false),
            (r#"<!-- bot-run/v1 "task" -->"#, false),
            (META_START, false),
            ("", false),
        ];
        for (line, want) in cases {
            assert_eq!(is_marker(line), want, "{line:?}");
        }
    }

    #[test]
    fn extracts_footers() {
        // Only a line that looks like a summary goes with its marker: not
        // a list line, nor the section's start.
        let meta = format!(
            "{HEAD}\n{BOT}\n\n{S1}\n{BOT}\n\n{SA}\n{AGENT}\n{META_START}\n{BOT}\n{META_END}"
        );
        let want = [
            fp(None, BOT),
            fp(Some(S1), BOT),
            fp(Some(SA), AGENT),
            fp(None, BOT),
        ];
        assert_eq!(footers(&meta), want);
        assert_eq!(
            join_footers(want),
            format!("{BOT}\n\n{S1}\n{BOT}\n\n{SA}\n{AGENT}\n\n{BOT}")
        );
        assert_eq!(
            fold(want[1..2].iter().copied()),
            format!("{DETAILS_OPEN}\n\n{S1}\n{BOT}\n\n{DETAILS_CLOSE}")
        );
        assert_eq!(fold(footers(HEAD)), "");
    }

    #[test]
    fn parses_footers() {
        let ok = format!("{S1}\n{BOT}");
        let cases: &[(&str, Option<&str>)] = &[
            (&format!("{S1}\n{BOT}\n"), Some(&ok)),
            (&format!("\r\n  \n{S1}\r\n\n{BOT}\r\n"), Some(&ok)),
            (&format!("{SA}\n{AGENT}"), Some(&format!("{SA}\n{AGENT}"))),
            ("", None),
            (&format!("{S1}\n"), None),
            (BOT, None),
            (&format!("a\n{S1}\n{BOT}"), None),
            (&format!("- Board item: x\n{BOT}"), None),
            (&format!("<sub>Bot run: <!-- x --></sub>\n{BOT}"), None),
            (
                &format!("{S1}\n<!-- bot-run/v1 {{\"x\":\"bot-meta\"}} -->"),
                None,
            ),
            (&format!("{S1}\n<!-- bot-run/v2 {{}} -->"), None),
        ];
        for (text, want) in cases {
            assert_eq!(parse_footer(text).ok().as_deref(), *want, "{text:?}");
        }
        assert!(
            parse_footer("")
                .unwrap_err()
                .to_string()
                .contains("did bot-footer fail")
        );
    }

    #[test]
    fn adds_footers_folded() {
        let f1 = format!("{S1}\n{BOT}");
        let f2 = format!("{S2}\n{BOT}");
        let fa = format!("{SA}\n{AGENT}");
        let folded =
            |fs: &[&str]| format!("{DETAILS_OPEN}\n\n{}\n\n{DETAILS_CLOSE}", fs.join("\n\n"));
        // What goes before and after the section's content, and the footers
        // expected in the block, whatever layout it finds.
        let cases: &[(&str, &str, &str, &[&str])] = &[
            ("none", "", "", &[&f2]),
            ("unfolded at the end", "", &format!("\n\n{f1}"), &[&f1, &f2]),
            ("unfolded at the start", &format!("{fa}\n"), "", &[&fa, &f2]),
            (
                "unfolded at both",
                &format!("{fa}\n"),
                &format!("\n\n{f1}"),
                &[&fa, &f1, &f2],
            ),
            (
                "folded",
                "",
                &format!("\n\n{}", folded(&[&f1])),
                &[&f1, &f2],
            ),
            (
                "hand-edited block",
                "",
                &format!("\n\n  {DETAILS_OPEN} \n\n{f1}\n\n{DETAILS_CLOSE}  \n"),
                &[&f1, &f2],
            ),
            (
                "marker without summary",
                "",
                &format!("\n{BOT}"),
                &[BOT, &f2],
            ),
        ];
        let (start, content) = HEAD.split_once('\n').unwrap();
        for (name, before, after, want) in cases {
            let meta = format!("{start}\n{before}{content}{after}\n{META_END}\n");
            let got = add_footer(&meta, &format!("\n{f2}\n")).unwrap();
            assert_eq!(
                got,
                format!("{HEAD}\n\n{}\n{META_END}\n", folded(want)),
                "{name}"
            );
            // Adding to that again only appends.
            let again = add_footer(&got, &f1).unwrap();
            let mut more = want.to_vec();
            more.push(&f1);
            assert_eq!(
                again,
                format!("{HEAD}\n\n{}\n{META_END}\n", folded(&more)),
                "{name}, again"
            );
        }
    }

    #[test]
    fn add_footer_refuses() {
        let f1 = format!("{S1}\n{BOT}");
        let complete = format!("{HEAD}\n{META_END}");
        let cases: &[(&str, &str, &str)] = &[
            ("", &f1, "not a complete bot-meta section"),
            (HEAD, &f1, "not a complete bot-meta section"),
            (META_END, &f1, "not a complete bot-meta section"),
            (&complete, BOT, "doesn't look like bot-footer output"),
        ];
        for (meta, footer, want) in cases {
            let err = format!("{:#}", add_footer(meta, footer).unwrap_err());
            assert!(err.contains(want), "{meta:?}: {err}");
        }
    }
}

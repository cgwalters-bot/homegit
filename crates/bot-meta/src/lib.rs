//! The run footers in the bot-meta section that bot-pr appends to fork PR
//! bodies. A footer is what bot-footer prints (or an agent.yml run's
//! summary): one human summary line, then a marker line carrying the same
//! data as JSON in an HTML comment. Footers accumulate at the end of the
//! section, where bot-runs and later sweeps read them back.

use anyhow::{Context, Result, bail};

/// The lines that open and close the bot-meta section.
pub const META_START: &str = "<!-- bot-meta -->";
pub const META_END: &str = "<!-- /bot-meta -->";

/// The schemas of the markers that end a run footer: bot-footer's, and an
/// agent.yml run's.
const MARKER_SCHEMAS: &[&str] = &["bot-run/v1", "agent-run-summary/v1"];
const MARKER_OPEN: &str = "<!-- ";
const MARKER_CLOSE: &str = " -->";

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

/// Whether `line` may be the summary line of the marker after it.
fn is_summary(line: &str) -> bool {
    !line.is_empty() && !is_marker(line) && line != META_START && line != META_END
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
            if !summary.contains("<!--")
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
/// footers, as bot-pr's meta_section lays them out.
pub fn add_footer(meta: &str, footer: &str) -> Result<String> {
    let body = meta
        .trim_end()
        .strip_prefix(META_START)
        .and_then(|m| m.strip_suffix(META_END))
        .with_context(|| {
            format!("not a complete bot-meta section, from {META_START} to {META_END}")
        })?;
    let body = body.trim_end_matches('\n');
    Ok(format!("{META_START}{body}\n\n{footer}\n{META_END}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT: &str = r#"<!-- bot-run/v1 {"task":"x"} -->"#;
    const AGENT: &str = r#"<!-- agent-run-summary/v1 {"run_id":1} -->"#;

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
        let meta = format!(
            "{META_START}\n---\n- Upstream: x\n\nS1\n{BOT}\n\n{AGENT}\n{META_START}\n{BOT}\n{META_END}"
        );
        let want = [
            Footer {
                summary: Some("S1"),
                marker: BOT,
            },
            Footer {
                summary: None,
                marker: AGENT,
            },
            Footer {
                summary: None,
                marker: BOT,
            },
        ];
        assert_eq!(footers(&meta), want);
        assert_eq!(join_footers(want), format!("S1\n{BOT}\n\n{AGENT}\n\n{BOT}"));
        assert_eq!(join_footers(footers("")), "");
    }

    #[test]
    fn parses_footers() {
        let ok = format!("S1\n{BOT}");
        let cases: &[(&str, Option<&str>)] = &[
            (&format!("S1\n{BOT}\n"), Some(&ok)),
            (&format!("\r\n  \nS1\r\n\n{BOT}\r\n"), Some(&ok)),
            ("", None),
            ("S1\n", None),
            (BOT, None),
            (&format!("a\nb\n{BOT}"), None),
            (&format!("<!-- x -->\n{BOT}"), None),
            (&format!("{META_END}\n{BOT}"), None),
            ("S1\n<!-- bot-run/v2 {} -->", None),
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
    fn adds_footers() {
        let head = format!("{META_START}\n- Upstream: x");
        let footer = format!("S2\n{BOT}");
        let want = format!("{head}\n\n{footer}\n{META_END}\n");
        for meta in [
            format!("{head}\n{META_END}"),
            format!("{head}\n\n\n{META_END}\n"),
        ] {
            assert_eq!(add_footer(&meta, &footer).unwrap(), want, "{meta:?}");
        }
        for meta in ["", "- Upstream: x", META_END, &format!("{head}\n")] {
            assert!(add_footer(meta, &footer).is_err(), "{meta:?}");
        }
    }
}

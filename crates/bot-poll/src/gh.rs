//! bot-poll's own GitHub requests, through `gh api -i`: conditional GETs
//! whose 304s cost no rate limit, counted per cycle.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use bot_poll::hot::{CycleStat, Validator};

use crate::run_captured;

/// One request can't hold up a cycle for longer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
pub const NOT_MODIFIED: u16 = 304;
const OK: u16 = 200;
const FORBIDDEN: u16 = 403;
const TOO_MANY_REQUESTS: u16 = 429;
/// How long to back off when a rate limit names no reset time.
const RATE_LIMIT_BACKOFF_MS: i64 = 60 * 1000;
/// The page size of every listing requested.
pub const PER_PAGE: usize = 100;
/// A listing is read up to this many pages.
pub const MAX_PAGES: usize = 10;

pub struct Response {
    pub status: u16,
    headers: Vec<(String, String)>,
    pub body: String,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// X-Poll-Interval, in ms.
    pub fn poll_interval_ms(&self) -> i64 {
        self.header("x-poll-interval")
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or_default()
            * 1000
    }
}

/// `gh api -i` output: the status line and headers, a blank line, the
/// body.
fn parse_response(raw: &str) -> Result<Response> {
    let raw = raw.replace("\r\n", "\n");
    let (head, body) = raw.split_once("\n\n").unwrap_or((&raw, ""));
    let mut lines = head.lines();
    let status = lines
        .next()
        .filter(|l| l.starts_with("HTTP/"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow!("{}", raw.lines().next().unwrap_or("no output")))?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Ok(Response {
        status,
        headers,
        body: body.to_string(),
    })
}

/// A 429, or a 403 for an exhausted primary or a secondary rate limit.
fn is_rate_limited(r: &Response) -> bool {
    r.status == TOO_MANY_REQUESTS
        || (r.status == FORBIDDEN
            && (r.header("x-ratelimit-remaining") == Some("0")
                || r.header("retry-after").is_some()))
}

/// A conditional read of a listing's pages: the bodies of those that
/// changed, and the validators to keep once they were processed.
#[derive(Default)]
pub struct Fetched {
    bodies: Vec<String>,
    validators: Vec<(String, Validator)>,
}

impl Fetched {
    pub fn texts(&self) -> Vec<&str> {
        self.bodies.iter().map(String::as_str).collect()
    }

    /// Keeps the validators, once the bodies were processed: until then
    /// a crash must leave them to be read again.
    pub fn commit(self, etags: &mut BTreeMap<String, Validator>) {
        etags.extend(self.validators);
    }
}

pub struct Gh {
    bin: PathBuf,
    /// Where each response is captured, and gh's own messages.
    out: PathBuf,
    err: PathBuf,
    pub stat: CycleStat,
    /// GitHub rate limited a request: none is made before this (ms).
    pub limited_until: Option<i64>,
}

impl Gh {
    pub fn new(bin: PathBuf, out: PathBuf, now: i64, sweep: bool) -> Self {
        Gh {
            bin,
            err: out.with_extension("err"),
            out,
            limited_until: None,
            stat: CycleStat {
                at: now,
                sweep,
                ..CycleStat::default()
            },
        }
    }

    /// GET PATH with HEADERS; an error unless it answers 200 or 304. Once
    /// one was rate limited, every request fails at once.
    pub fn get(&mut self, path: &str, headers: &[(&str, &str)]) -> Result<Response> {
        if let Some(until) = self.limited_until {
            bail!(
                "GET {path}: rate limited until {}",
                bot_poll::hot::rfc3339(until)
            );
        }
        let mut args = vec!["api".to_string(), "-i".to_string(), path.to_string()];
        for (k, v) in headers {
            args.push("-H".to_string());
            args.push(format!("{k}: {v}"));
        }
        self.stat.requests += 1;
        // gh exits nonzero on a 304 too: the status line says what happened.
        let code = run_captured(
            &self.out,
            Some(&self.err),
            &self.bin,
            &args,
            REQUEST_TIMEOUT,
        )?;
        let raw = fs::read_to_string(&self.out)
            .with_context(|| format!("reading {}", self.out.display()))?;
        let r = parse_response(&raw).with_context(|| {
            let err = fs::read_to_string(&self.err).unwrap_or_default();
            format!(
                "GET {path}: {} exited {code:?} without a response: {}",
                self.bin.display(),
                err.trim()
            )
        })?;
        match r.status {
            NOT_MODIFIED => {
                self.stat.not_modified += 1;
                Ok(r)
            }
            OK => Ok(r),
            s if is_rate_limited(&r) => {
                let now = chrono::Utc::now().timestamp_millis();
                let until = r
                    .header("retry-after")
                    .and_then(|v| v.trim().parse::<i64>().ok())
                    .map(|secs| now + secs * 1000)
                    .or_else(|| {
                        r.header("x-ratelimit-reset")
                            .and_then(|v| v.trim().parse::<i64>().ok())
                            .map(|epoch| epoch * 1000)
                    })
                    .filter(|&t| t > now)
                    .unwrap_or(now + RATE_LIMIT_BACKOFF_MS);
                self.limited_until = Some(until);
                bail!("GET {path}: HTTP {s}, rate limited")
            }
            s => {
                let msg = serde_json::from_str::<serde_json::Value>(&r.body)
                    .ok()
                    .and_then(|v| v.get("message")?.as_str().map(str::to_string))
                    .unwrap_or_default();
                bail!("GET {path}: HTTP {s} {msg}")
            }
        }
    }

    /// Reads the pages of the listing at PATH that changed
    /// since their validators in ETAGS: a page that answers 304 is left
    /// out, and the next one is read only if it was full.
    pub fn changed_pages(
        &mut self,
        path: &str,
        etags: &mut BTreeMap<String, Validator>,
        now: i64,
    ) -> Result<Fetched> {
        let mut out = Fetched::default();
        let sep = if path.contains('?') { '&' } else { '?' };
        for page in 1..=MAX_PAGES {
            let p = format!("{path}{sep}per_page={PER_PAGE}&page={page}");
            let cached = etags.get(&p).cloned();
            let cond = cached.as_ref().map(|v| ("If-None-Match", v.etag.as_str()));
            let r = self.get(&p, cond.as_slice())?;
            let full = if r.status == NOT_MODIFIED {
                let Some(v) = etags.get_mut(&p) else {
                    bail!("GET {p}: 304 to a request without a validator");
                };
                v.used = now;
                v.full
            } else {
                let n = serde_json::from_str::<Vec<serde_json::Value>>(&r.body)
                    .with_context(|| format!("GET {p}: not a JSON array"))?
                    .len();
                let full = n >= PER_PAGE;
                if let Some(etag) = r.header("etag") {
                    let v = Validator {
                        etag: etag.to_string(),
                        used: now,
                        full,
                    };
                    out.validators.push((p, v));
                }
                out.bodies.push(r.body);
                full
            };
            if !full {
                break;
            }
        }
        Ok(out)
    }

    /// All the items of the search results for QUERY.
    pub fn search(&mut self, query: &str) -> Result<Vec<String>> {
        let mut pages = Vec::new();
        for page in 1..=MAX_PAGES {
            let path = format!(
                "search/issues?q={}&per_page={PER_PAGE}&page={page}",
                encode_query(query)
            );
            let body = self.get(&path, &[])?.body;
            let n = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("items")?.as_array().map(Vec::len))
                .with_context(|| format!("GET {path}: no search results"))?;
            pages.push(body);
            if n < PER_PAGE {
                break;
            }
        }
        Ok(pages)
    }
}

/// A search query as a URL query value.
fn encode_query(q: &str) -> String {
    q.bytes()
        .map(|b| match b {
            b' ' => "+".to_string(),
            b if b.is_ascii_alphanumeric() || b"-_.:/".contains(&b) => (b as char).to_string(),
            b => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses() {
        let r = parse_response(
            "HTTP/2.0 200 OK\r\nEtag: W/\"abc\"\r\nX-Poll-Interval: 60\r\n\r\n[1]\n",
        )
        .unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.header("ETag"), Some("W/\"abc\""));
        assert_eq!(r.poll_interval_ms(), 60_000);
        assert_eq!(r.body, "[1]\n");
        let r = parse_response("HTTP/2.0 304 Not Modified\nEtag: x\n\n").unwrap();
        assert_eq!((r.status, r.body.as_str()), (304, ""));
        assert_eq!(r.poll_interval_ms(), 0);
        assert!(parse_response("gh: not logged in\n").is_err());
        for (raw, limited) in [
            ("HTTP/2.0 429 Too Many Requests\nRetry-After: 30\n\n", true),
            ("HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\n\n", true),
            (
                "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 12\n\n",
                false,
            ),
            ("HTTP/2.0 404 Not Found\n\n", false),
        ] {
            assert_eq!(
                is_rate_limited(&parse_response(raw).unwrap()),
                limited,
                "{raw}"
            );
        }
        assert_eq!(
            encode_query("is:pr author:bot -org:o x&y"),
            "is:pr+author:bot+-org:o+x%26y"
        );
    }
}

//! Reading the forge. [`Forge`] is the one seam between the scheduler
//! and GitHub: [`Rest`] asks the API, [`Recorded`] answers from a file
//! (the tests, and replaying a pass), and [`Recorder`] writes that file
//! from a live pass.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;

const API: &str = "https://api.github.com/";
const USER_AGENT: &str = concat!("bot-sched/", env!("CARGO_PKG_VERSION"));
/// The environment variables a token is taken from, in this order.
const TOKEN_ENV: [&str; 2] = ["GH_TOKEN", "GITHUB_TOKEN"];
const TIMEOUT: Duration = Duration::from_secs(60);
/// A page of board items carries each issue's or PR's whole REST body.
const MAX_BODY: u64 = 64 << 20;
/// A listing longer than this is a bug or a loop.
const MAX_PAGES: usize = 100;
/// The statuses of something that is not there: never was, or deleted.
const ABSENT: [u16; 2] = [404, 410];

/// Read access to the forge's REST API, by path (`repos/O/R/issues/1`).
pub trait Forge {
    /// Every element of a paginated listing.
    fn list(&self, path: &str) -> Result<Vec<Value>>;

    /// One object, or None if the forge has none there (404, 410).
    fn get(&self, path: &str) -> Result<Option<Value>>;
}

/// GitHub's REST API, with a token from the environment.
pub struct Rest {
    agent: ureq::Agent,
    token: String,
}

impl Rest {
    pub fn from_env() -> Result<Self> {
        let token = TOKEN_ENV
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
            .with_context(|| format!("no GitHub token: set {}", TOKEN_ENV.join(" or ")))?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Self { agent, token })
    }

    /// (status, body, the next page's URL).
    fn fetch(&self, url: &str) -> Result<(u16, String, Option<String>)> {
        let mut response = self
            .agent
            .get(url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", USER_AGENT)
            .call()
            .with_context(|| format!("GET {url}"))?;
        let next = response
            .headers()
            .get("link")
            .and_then(|v| v.to_str().ok())
            .and_then(next_link);
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .with_context(|| format!("reading the answer to GET {url}"))?;
        Ok((response.status().as_u16(), body, next))
    }
}

/// The `rel="next"` URL of a Link header. Its URLs may hold commas (a
/// listing's `fields=1,2`), so it is cut at the brackets, not at commas.
fn next_link(header: &str) -> Option<String> {
    header.split('<').skip(1).find_map(|link| {
        let (url, params) = link.split_once('>')?;
        let is_next = |p: &str| p.trim().trim_end_matches(',').trim_end() == "rel=\"next\"";
        params.split(';').any(is_next).then(|| url.to_owned())
    })
}

/// GitHub's own words for a refusal, which name a missing scope or an
/// exhausted quota.
fn refusal(url: &str, status: u16, body: &str) -> anyhow::Error {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_default();
    anyhow!("GET {url}: HTTP {status}: {message}")
}

impl Forge for Rest {
    fn list(&self, path: &str) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut next = Some(format!("{API}{path}"));
        for _ in 0..MAX_PAGES {
            let Some(url) = next else { return Ok(out) };
            let (status, body, link) = self.fetch(&url)?;
            if status != 200 {
                return Err(refusal(&url, status, &body));
            }
            let page: Vec<Value> = serde_json::from_str(&body)
                .with_context(|| format!("GET {url}: the answer is not a JSON list"))?;
            out.extend(page);
            // The token goes with every request: only to the API.
            if let Some(other) = link.as_deref().filter(|u| !u.starts_with(API)) {
                bail!("GET {url}: its next page is {other}, outside {API}");
            }
            next = link;
        }
        bail!("GET {path}: more than {MAX_PAGES} pages")
    }

    fn get(&self, path: &str) -> Result<Option<Value>> {
        let url = format!("{API}{path}");
        let (status, body, _) = self.fetch(&url)?;
        match status {
            200 => serde_json::from_str(&body)
                .map(Some)
                .with_context(|| format!("GET {url}: the answer is not JSON")),
            _ if ABSENT.contains(&status) => Ok(None),
            _ => Err(refusal(&url, status, &body)),
        }
    }
}

/// Answers from a recording: `{PATH: answer}`, a list for [`Forge::list`]
/// and an object, or null for a 404, for [`Forge::get`]. A path that was
/// not recorded is an error, so a test cannot read more than it shows.
#[derive(Debug, Default)]
pub struct Recorded(BTreeMap<String, Value>);

impl Recorded {
    pub fn load(file: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(file)
            .with_context(|| format!("cannot read the recording {}", file.display()))?;
        let map = serde_json::from_str(&text)
            .with_context(|| format!("the recording {} is not a JSON object", file.display()))?;
        Ok(Self(map))
    }

    fn answer(&self, path: &str) -> Result<&Value> {
        self.0
            .get(path)
            .with_context(|| format!("GET {path} is not in the recording"))
    }
}

impl Forge for Recorded {
    fn list(&self, path: &str) -> Result<Vec<Value>> {
        match self.answer(path)? {
            Value::Array(items) => Ok(items.clone()),
            _ => bail!("GET {path} is recorded as something other than a list"),
        }
    }

    fn get(&self, path: &str) -> Result<Option<Value>> {
        Ok(Some(self.answer(path)?.clone()).filter(|v| !v.is_null()))
    }
}

/// Passes requests on and keeps the answers, as [`Recorded`] reads them.
pub struct Recorder<'a> {
    inner: &'a dyn Forge,
    seen: RefCell<BTreeMap<String, Value>>,
}

impl<'a> Recorder<'a> {
    pub fn new(inner: &'a dyn Forge) -> Self {
        Self {
            inner,
            seen: RefCell::default(),
        }
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        let text = serde_json::to_string_pretty(&*self.seen.borrow())?;
        std::fs::write(file, text + "\n")
            .with_context(|| format!("cannot write the recording {}", file.display()))
    }
}

impl Forge for Recorder<'_> {
    fn list(&self, path: &str) -> Result<Vec<Value>> {
        let items = self.inner.list(path)?;
        self.seen
            .borrow_mut()
            .insert(path.to_owned(), Value::Array(items.clone()));
        Ok(items)
    }

    fn get(&self, path: &str) -> Result<Option<Value>> {
        let answer = self.inner.get(path)?;
        self.seen
            .borrow_mut()
            .insert(path.to_owned(), answer.clone().unwrap_or(Value::Null));
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_links() {
        let cases = [
            (
                r#"<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last""#,
                Some("https://api.github.com/x?page=2"),
            ),
            (
                r#"<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?after=Y>; rel="next""#,
                Some("https://api.github.com/x?after=Y"),
            ),
            (r#"<https://api.github.com/x?page=1>; rel="first""#, None),
            (
                r#"<https://api.github.com/p/items?per_page=100&fields=13,34,36&after=Y>; rel="next", <https://api.github.com/p/items?fields=13,34>; rel="last""#,
                Some("https://api.github.com/p/items?per_page=100&fields=13,34,36&after=Y"),
            ),
            (
                r#"<https://api.github.com/x?page=3>; rel="next"; title="more""#,
                Some("https://api.github.com/x?page=3"),
            ),
            ("", None),
        ];
        for (header, want) in cases {
            assert_eq!(next_link(header).as_deref(), want, "{header}");
        }
    }
}

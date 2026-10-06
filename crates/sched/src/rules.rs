//! The reconcile rules: each compares a [`Snapshot`] with the state the
//! board should be in and returns the [`Action`]s that close the gap.
//! Rules are pure functions: no network, no clock, no files. What a rule
//! needs that the snapshot lacks belongs in the observation, not here.
//!
//! These two are ports of `closedNotDone` and `staleLead` in homegit's
//! `lib/reconcile.js`, which still carries them out locally; the
//! controller report compares the two until that copy goes.

use std::collections::BTreeMap;

use anyhow::{Result, bail};

use crate::action::{Action, Kind, Write};
use crate::model::{
    ContentKind, ContentState, FIELD_LEAD, FIELD_NEWS, FIELD_STATUS, Item, Snapshot, Status,
};

/// A worker's claim on an item (`bot-pace assign`), which ends when the
/// item leaves In Progress. Any other Lead is a topic session's.
pub const COORDINATOR_LEAD: &str = "coordinator";

pub struct Rule {
    pub name: &'static str,
    pub run: fn(&Snapshot) -> Vec<Action>,
}

/// Every rule, in the order their actions are listed.
pub const RULES: &[Rule] = &[
    Rule {
        name: Kind::ClosedNotDone.as_str(),
        run: closed_not_done,
    },
    Rule {
        name: Kind::StaleLead.as_str(),
        run: stale_lead,
    },
];

/// Runs the named rules (all of them for none), each rule's actions
/// sorted by key.
pub fn reconcile(snapshot: &Snapshot, names: &[String]) -> Result<Vec<Action>> {
    if let Some(unknown) = names.iter().find(|n| RULES.iter().all(|r| r.name != *n)) {
        let known: Vec<_> = RULES.iter().map(|r| r.name).collect();
        bail!(
            "unknown rule '{unknown}'; the rules are {}",
            known.join(", ")
        );
    }
    let mut out = Vec::new();
    for rule in RULES {
        if names.is_empty() || names.iter().any(|n| n == rule.name) {
            let mut actions = (rule.run)(snapshot);
            actions.sort_by(|a, b| a.key.cmp(&b.key));
            out.extend(actions);
        }
    }
    Ok(out)
}

/// An item whose own issue or PR is closed or merged is Done, whatever
/// its Status says. Not while one of its Branch PRs is open or of unknown
/// state: promoting closes the fork PR an item may be of and puts the
/// upstream PR in Branch. A PR closed without merging needs a human: one
/// whose item is Needs human is already that question and stays; for
/// another the action has no write.
fn closed_not_done(snapshot: &Snapshot) -> Vec<Action> {
    let states = snapshot.states();
    snapshot
        .items
        .iter()
        .filter_map(|item| closed_item(item, &states))
        .collect()
}

fn closed_item(item: &Item, states: &BTreeMap<String, ContentState>) -> Option<Action> {
    let content = item.content.as_ref()?;
    if item.status == Some(Status::Done) || !content.state.ended() {
        return None;
    }
    let own = content.of.key();
    let pending =
        |key: &String| !matches!(states.get(key), Some(s) if s.ended() || *s == ContentState::Gone);
    if item
        .branch
        .iter()
        .map(|u| u.key())
        .any(|k| k != own && pending(&k))
    {
        return None;
    }
    let kind = content.of.kind;
    let unmerged = kind == ContentKind::PullRequest && content.state == ContentState::Closed;
    let what = format!(
        "{} {}",
        kind.noun(),
        if unmerged {
            "closed unmerged"
        } else {
            content.state.as_str()
        }
    );
    let (done, question) = (Status::DONE, Status::NEEDS_HUMAN);
    let status = item.status_name();
    let (todo, write) = if unmerged {
        if item.status == Some(Status::NeedsHuman) {
            return None;
        }
        let todo = format!(
            "its {what}, but it is {status}: ask the operator whether to drop it ({done}) or redo it ({question}), or set it {done} if it is clear"
        );
        (todo, None)
    } else {
        let fields = BTreeMap::from([
            (FIELD_STATUS.to_owned(), done.to_owned()),
            (FIELD_NEWS.to_owned(), format!("{what}; set {done}")),
        ]);
        let write = Write::SetFields { fields };
        (
            format!("its {what}, but it is {status}: set it {done}"),
            Some(write),
        )
    };
    Some(Action {
        key: format!("{}:{}", Kind::ClosedNotDone, content.of),
        kind: Kind::ClosedNotDone,
        item: item.id.clone(),
        content: Some(content.of.clone()),
        todo,
        write,
    })
}

/// The coordinator's Lead on an item that is not In Progress is left
/// over from an edit made elsewhere: clear it.
fn stale_lead(snapshot: &Snapshot) -> Vec<Action> {
    let stale = |it: &&Item| {
        it.lead.as_deref() == Some(COORDINATOR_LEAD) && it.status != Some(Status::InProgress)
    };
    let action = |it: &Item| Action {
        key: format!(
            "{}:{}",
            Kind::StaleLead,
            it.content_ref().map_or(it.id.clone(), ToString::to_string)
        ),
        kind: Kind::StaleLead,
        item: it.id.clone(),
        content: it.content_ref().cloned(),
        todo: format!(
            "Lead {COORDINATOR_LEAD}, but it is {}: clear its Lead",
            it.status_name()
        ),
        write: Some(Write::ClearField {
            field: FIELD_LEAD.to_owned(),
        }),
    };
    snapshot.items.iter().filter(stale).map(action).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Content, ContentRef, SNAPSHOT_SCHEMA};

    /// No forge's: the rules read references, they never parse them.
    const WEB: &str = "https://forge.example/";
    const FORK: &str = "https://forge.example/o/r/pull/100";
    const OTHER: &str = "https://forge.example/o/r/pull/101";

    /// The reference a forge would make of `WEB/OWNER/REPO/KIND/N`.
    fn content_ref(url: &str) -> ContentRef {
        let parts: Vec<&str> = url.strip_prefix(WEB).unwrap().split('/').collect();
        let [owner, repo, kind, number] = parts[..] else {
            panic!("{url}");
        };
        ContentRef {
            url: url.to_owned(),
            repo: format!("{owner}/{repo}"),
            kind: match kind {
                "issues" => ContentKind::Issue,
                _ => ContentKind::PullRequest,
            },
            number: number.parse().unwrap(),
        }
    }

    fn snapshot(items: Vec<Item>, linked: &[(&str, ContentState)]) -> Snapshot {
        Snapshot {
            schema: SNAPSHOT_SCHEMA.to_owned(),
            board: format!("{WEB}o/boards/1"),
            items,
            linked: linked.iter().map(|(u, s)| ((*u).to_owned(), *s)).collect(),
        }
    }

    fn item(n: u64, status: Option<&str>, url: &str, state: ContentState, branch: &str) -> Item {
        Item {
            id: format!("ITEM_{n}"),
            content: Some(Content {
                of: content_ref(url),
                state,
            }),
            status: status.map(|s| Status::from(s.to_owned())),
            priority: None,
            lead: None,
            run: None,
            branch: branch.split_whitespace().map(content_ref).collect(),
        }
    }

    /// (status, URL, its state, Branch, the fork PR's state, what to do or
    /// None, the News it sets or None)
    type Case<'a> = (
        Option<&'a str>,
        String,
        ContentState,
        &'a str,
        Option<ContentState>,
        Option<String>,
        Option<&'a str>,
    );

    /// The cases of lib/reconcile.js's closedNotDone test.
    #[test]
    fn closed_not_done_cases() {
        use ContentState::{Closed, Gone, Merged, Open};
        const ASK: &str = "ask the operator whether to drop it (Done) or redo it (Needs human), or set it Done if it is clear";
        let pr = |n| format!("https://forge.example/o/r/pull/{n}");
        let issue = |n| format!("https://forge.example/o/r/issues/{n}");
        let both = format!("{FORK} {OTHER}");
        #[rustfmt::skip]
        let cases: Vec<Case> = vec![
            (Some("Draft"), pr(1), Merged, "", None, Some("its PR merged, but it is Draft: set it Done".into()), Some("PR merged; set Done")),
            (Some("Needs human"), pr(2), Merged, "", None, Some("its PR merged, but it is Needs human: set it Done".into()), Some("PR merged; set Done")),
            // A PR closed unmerged needs a human: listed, never carried out.
            (Some("In Review"), pr(3), Closed, "", None, Some(format!("its PR closed unmerged, but it is In Review: {ASK}")), None),
            // The "closed without merging" question waits on the operator.
            (Some("Needs human"), pr(4), Closed, "", None, None, None),
            (Some("Needs human"), issue(5), Closed, "", None, Some("its issue closed, but it is Needs human: set it Done".into()), Some("issue closed; set Done")),
            (None, issue(6), Closed, "", None, Some("its issue closed, but it is untriaged: set it Done".into()), Some("issue closed; set Done")),
            (Some("Done"), issue(7), Closed, "", None, None, None),
            (Some("Draft"), issue(8), Open, "", None, None, None),
            (Some("Draft"), issue(9), Gone, "", None, None, None),
            // The fork PR promote closed, its upstream PR in Branch: open, or unknown (a failed read).
            (Some("In Review"), pr(11), Closed, FORK, Some(Open), None, None),
            (Some("In Review"), pr(12), Merged, FORK, Some(Open), None, None),
            (Some("In Review"), pr(13), Merged, FORK, None, None, None),
            (Some("Draft"), issue(14), Closed, &both, Some(Merged), None, None),
            (Some("In Review"), issue(15), Closed, FORK, Some(Merged), Some("its issue closed, but it is In Review: set it Done".into()), Some("issue closed; set Done")),
            (Some("In Review"), issue(16), Closed, "https://forge.example/O/R/pull/100", Some(Closed), Some("its issue closed, but it is In Review: set it Done".into()), Some("issue closed; set Done")),
            (Some("In Review"), issue(17), Closed, FORK, Some(Gone), Some("its issue closed, but it is In Review: set it Done".into()), Some("issue closed; set Done")),
            // Its own URL in Branch is not another PR to wait for.
            (Some("Draft"), pr(18), Merged, "https://forge.example/o/r/pull/18", None, Some("its PR merged, but it is Draft: set it Done".into()), Some("PR merged; set Done")),
        ];
        for (status, url, state, branch, fork, todo, news) in cases {
            let it = item(1, status, &url, state, branch);
            let linked: Vec<_> = fork.iter().map(|s| (FORK, *s)).collect();
            let actions = closed_not_done(&snapshot(vec![it], &linked));
            let got: Vec<_> = actions.iter().map(|a| a.todo.clone()).collect();
            assert_eq!(got, todo.into_iter().collect::<Vec<_>>(), "{url}");
            let Some(action) = actions.first() else {
                continue;
            };
            assert_eq!(action.key, format!("closed-not-done:{url}"));
            assert_eq!(action.item, "ITEM_1");
            let want = news.map(|news| Write::SetFields {
                fields: BTreeMap::from([
                    ("Status".to_owned(), "Done".to_owned()),
                    ("News".to_owned(), news.to_owned()),
                ]),
            });
            assert_eq!(action.write, want, "{url}");
        }
    }

    /// The cases of lib/reconcile.js's staleLead test.
    #[test]
    fn stale_lead_cases() {
        // (status, Lead, what to do or None)
        let cases = [
            (
                Some("Draft"),
                Some("coordinator"),
                Some("Lead coordinator, but it is Draft: clear its Lead"),
            ),
            (
                Some("In Review"),
                Some("coordinator"),
                Some("Lead coordinator, but it is In Review: clear its Lead"),
            ),
            (
                Some("Needs human"),
                Some("coordinator"),
                Some("Lead coordinator, but it is Needs human: clear its Lead"),
            ),
            (
                Some("Todo"),
                Some("coordinator"),
                Some("Lead coordinator, but it is Todo: clear its Lead"),
            ),
            (
                Some("Done"),
                Some("coordinator"),
                Some("Lead coordinator, but it is Done: clear its Lead"),
            ),
            (
                None,
                Some("coordinator"),
                Some("Lead coordinator, but it is untriaged: clear its Lead"),
            ),
            (Some("In Progress"), Some("coordinator"), None),
            // A topic session owns its items in every status.
            (Some("Draft"), Some("wfc"), None),
            (Some("Done"), Some("wfc"), None),
            (Some("Draft"), None, None),
        ];
        for (status, lead, todo) in cases {
            let mut it = item(
                1,
                status,
                "https://forge.example/o/r/issues/1",
                ContentState::Open,
                "",
            );
            it.lead = lead.map(str::to_owned);
            let actions = stale_lead(&snapshot(vec![it], &[]));
            let got: Vec<_> = actions.iter().map(|a| a.todo.as_str()).collect();
            assert_eq!(
                got,
                todo.into_iter().collect::<Vec<_>>(),
                "{status:?} {lead:?}"
            );
            if let Some(action) = actions.first() {
                let clear = Write::ClearField {
                    field: "Lead".to_owned(),
                };
                assert_eq!(action.write, Some(clear));
                assert_eq!(action.key, "stale-lead:https://forge.example/o/r/issues/1");
            }
        }
    }

    #[test]
    fn unknown_rules_are_refused() {
        let err = reconcile(&snapshot(vec![], &[]), &["nope".to_owned()]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "unknown rule 'nope'; the rules are closed-not-done, stale-lead"
        );
    }
}

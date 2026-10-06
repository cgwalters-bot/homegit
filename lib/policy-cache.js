// The body of the one tracker issue that caches the bot's view of each
// upstream repository's contribution policy (bot-promote-due keeps it):
// a table for the operator, and the same as JSON in a hidden marker,
// which is what counts. Each repository's entry says what its record
// says, what 'upstream-policy check' last made of it, and what the record
// said at the bot's last submission there, so that a policy whose sources
// changed since is rechecked rather than trusted. Node's standard library
// only.
"use strict";

const TITLE = "Upstream contribution policies (the bot's view)";
const MARKER = "bot-policy-cache";
const MARKER_RE = new RegExp(`<!-- ${MARKER}\\n([\\s\\S]*?)\\n-->`);
// What 'upstream-policy check' said, as bot-promote-due names it.
const CURRENT = ["ok", "human-text", "refused"];
// GitHub's limit on an issue body, less room for the table's prose.
const BODY_MAX = 65000;

// parse(body): the entries in an issue body, {"OWNER/REPO": entry}; none
// if it has no marker or its JSON is unreadable.
function parse(body) {
  const m = MARKER_RE.exec((body || "").replace(/\r\n/g, "\n"));
  if (!m) return {};
  try {
    const data = JSON.parse(m[1]);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// update(entries, repo, seen): entries with repo's entry updated from
// what a sweep saw: {at, status (what check said: ok, human-text,
// refused, missing, stale, invalid), view (upstream-policy show's, or
// null), submitted (the upstream PR a promotion just opened, or null)}.
// recheck: the record needs a policy check, because check found its
// sources changed upstream (stale) or no valid record.
// changed_since_submission: the record was rechecked against other
// sources than it had at the last submission.
function update(entries, repo, seen) {
  const old = entries[repo] || {};
  const view = seen.view || null;
  const digest = view ? view.digest : null;
  // The same upstream PR, under the same record, is no new submission.
  const same = old.submission && old.submission.url === seen.submitted && old.submission.digest === digest;
  const submission = seen.submitted && !same ? { at: seen.at, url: seen.submitted, digest } : old.submission || null;
  const changed = Boolean(submission && digest && submission.digest !== digest);
  const entry = {
    status: seen.status,
    verdict: view ? view.verdict : null,
    checked: view ? view.checked : null,
    ai_trailer: view ? view.ai_trailer : null,
    digest,
    submission,
    changed_since_submission: changed,
    recheck: !CURRENT.includes(seen.status),
  };
  // at is when the view last changed: a sweep that sees the same leaves
  // the issue be.
  const { at, ...before } = old;
  if (at && JSON.stringify(before) === JSON.stringify(entry)) return entries;
  return { ...entries, [repo]: { at: seen.at, ...entry } };
}

const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");

const code = (s) => `\`${String(s).replace(/`/g, "")}\``;

// render(entries): the issue body.
function render(entries) {
  const repos = Object.keys(entries).sort();
  const rows = repos.map((r) => {
    const e = entries[r];
    // In a code span: the tracker is public, and a bare link would put
    // "mentioned this" on the upstream PR's timeline.
    const sub = e.submission ? `${code(e.submission.url)} (${e.submission.at.slice(0, 10)})${e.changed_since_submission ? ", record changed since" : ""}` : "";
    return `| ${cell(r)} | ${cell(e.verdict)} | ${cell(e.status)} | ${cell(e.checked)} | ${cell(e.ai_trailer)} | ${cell(sub)} | ${e.recheck ? "yes" : ""} |`;
  });
  // Nothing in it may end the comment.
  const json = JSON.stringify(entries, null, 1).replace(/-->/g, "--\\u003e");
  const body = [
    "The bot's view of each upstream repository's contribution policy, as `bot-promote-due` last saw it when an approval was due there: the record's verdict in homegit's `upstream-policy/`, what `upstream-policy check` said of it (stale: its sources changed upstream), and the last upstream PR promoted there. A row marked for recheck needs a policy check before the next promotion. Kept by the bot; edits are overwritten.",
    "",
    "| Repository | Verdict | Check | Record checked | AI trailer | Last submission | Recheck |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `<!-- ${MARKER}`,
    json,
    "-->",
    "",
  ].join("\n");
  if (body.length > BODY_MAX) throw new Error(`the policy cache would be ${body.length} characters, over GitHub's limit`);
  return body;
}

module.exports = { TITLE, MARKER, parse, update, render };

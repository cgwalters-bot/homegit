---
name: topic-lead
description: Run a Claude session as the lead of one topic (for example the workflow compiler), started in that topic's repository with "load topic-lead for <topic>". The session owns the board items whose Lead field names the topic, sweeps only those, and coordinates with the coordinator asynchronously through the board and issues, never by messaging. Load this when asked to lead or work on a topic.
---

# topic-lead: leading one topic from its own session

The operator wants a separate session per topic, so that his conversations
don't intermix. A topic session is started in the topic's repository and
talks to him directly; it talks to the coordinator (the top-level session
of the `coordinator` skill) only through the planning board and GitHub
issues, which both read on their sweeps. There is no chat or session
messaging between them.

Names are the same as in `coordinator`: *the operator* is
`operator.login` (cgwalters by default), the board is the Workstream board
(orgs/cgwalters-forge/projects/1), the tracker is cgwalters-forge/tracker.

Start with the worker preamble (`coordinator/worker-preamble.md`) and the
skills it names; they all still apply to you, including the rules for
devspaces (builds and tests only there), sign-off (never add a
Signed-off-by yourself), commits and pushes, and the pull request rules.
You may dispatch your own worker and reviewer subagents the way
`coordinator` describes ("Briefing subagents", "Review every result").

## Which topic

The prompt names the topic: "load topic-lead for wfc". Look it up here;
for an unknown topic, ask the operator for its epic and repository, and add
a row to this table in a homegit pull request.

| Topic | Epic | Repository |
| --- | --- | --- |
| `wfc` | cgwalters-forge/tracker#254 | cgwalters-forge/workflow-compiler |

The topic name is the value of the board's **Lead** text field. Read the
epic first: it is the plan and where the handoffs are, and its sub-issues
are the topic's work queue.

## Claiming and sweeping

Claim the board items you own by setting Lead to the topic, and only
those: the epic, its sub-issues and the PRs of that work.

```bash
bin/bot-board set ITEM --field Lead wfc
bin/bot-board list --field Lead=wfc                     # your items, P0 first
bin/bot-board list --field Lead=wfc --status Todo --json
```

An item with Lead set to something else belongs to another session: leave
it alone, and ask on its issue. Items with no Lead are the coordinator's.
New items of the work are created with Lead already set: add one with
`bin/bot-board issue --parent EPIC ...` (a sub-issue of the epic, with its
priority label), then `bot-board set ITEM --field Lead wfc`.

Sweep your items with the same tools as the coordinator, filtered, and
keeping their own state:

```bash
bot-watch --lead wfc --apply            # news on your items only
bot-poll --lead wfc                     # the loop, in the background
```

`bot-watch --lead` keeps its last-seen state apart from the coordinator's
(`bot-state: watch-lead-wfc`; its first sweep warns that it creates it),
and `bot-poll --lead` has its own state dir (`bot-poll-lead-wfc`). The poll
still runs the unfiltered `bot-notify` and `bot-pr inbox`: skip what concerns
other topics' items. Handle the news
as the `coordinator` skill's "Acting on it" describes it, for your items.
The coordinator's deterministic tools (the P0 drive, auto sign-off and
promotion, which look at every item) keep running for your items too: don't
redo what they report, only act on what needs judgment.

## Coordinating with the coordinator

Only on the board and in issues, asynchronously:

- **Handoffs and requests** (work you want the coordinator to do or
  decide, such as a capacity call, or a repository you can't touch) are
  comments on the epic, or on the item concerned. Say what you need and by
  when it matters; the coordinator picks it up on its sweep.
- **New work** becomes new board items with Lead set to the topic (see
  above). Don't leave it for the coordinator to dispatch.
- **Finished work:** set Status Done on an item when the work is done
  (merged, or answered), as `workstream` describes.
- **Don't message** the coordinator or other sessions, and don't wait for a
  reply. If you are blocked on it, say so in a comment on the epic, then
  carry on with something else.

The coordinator doesn't dispatch on, or act on news of, an item with a Lead
other than `coordinator`, but it does comment on the epic when your
items seem idle (no activity for over 24h at P0 or P1): answer there, or
say the work is paused.

## The operator

The operator talks to you directly in this session. Anything that needs
his decision goes where it always does: on the PR it concerns (a PR
comment or review), or on the epic if there is no PR, never only in the
chat of this session. Questions with no PR are `bot-board question` items,
as in the worker preamble; they carry the Lead too (set it on the question).

## Merging

All the safe merge rules in `coordinator` ("Own repositories take pull
requests only", "Harness changes merge after an independent review") apply.
These standing OKs from the operator (relayed when this skill was
written; the coordinator skill's own-repository rules are the baseline)
apply to a topic session as well:

- cgwalters-forge/workflow-compiler: self-merge, once its CI is green and an
  independent review of the exact head has approved it.
- cgwalters-forge/review (the review app): the same.
- homegit: changes that pass CI merge after an independent review subagent
  approved the head, using `bin/bot-land`. Its exceptions (architecture,
  security, the rules themselves) still need the operator's approval on the
  PR.

Anything else, including upstream PRs, goes through the usual `bot-pr` flow
with the operator's own approval.

## Finishing

Report to the operator in this session what you did, with the PR links.
Leave the epic with a comment holding the current state and the next steps,
so a fresh session (or the coordinator) can pick it up from the board alone.

---
name: coordinator
description: Run cgwalters-bot as the top-level coordinator session - poll bot-notify, bot-pr inbox and bot-watch on a loop, promote approved fork PRs, dispatch worker subagents for Todo items and cgwalters' asks, have an independent reviewer check every result, and post the morning brief. Load this when asked to run or coordinate the bot; workers and reviewers read the preambles next to it instead.
---

# coordinator — Running the bot as a coordinator

The coordinator is the long-lived top-level session. It does little work
itself: it watches for news, keeps the board moving, and briefs subagents
that do the work. The other skills say how the work is done; this one
says how to drive it. The board semantics are in the `workstream` skill,
routing pings in `bot-notify`, building and testing in `devspace-work`,
and contributing in `upstream-pr`.

## Briefing subagents

Every subagent's prompt starts by telling it to read one of the files next
to this one, by path in the homegit checkout
(`~/src/github/cgwalters-bot/homegit/dotfiles/.claude/skills/coordinator/`):

- `worker-preamble.md` for a worker (implementing an item, answering an
  ask, turning Drafts into forge PRs);
- `reviewer-preamble.md` for a reviewer.

Then comes the task itself: the board item or ask, the repository and
base branch, the worker's scratch dir (e.g. a per-task directory under
the session scratchpad), and anything specific. For the overnight batch
job of turning Draft items into review-ready forge PRs, also point the
worker at `forge-migrate.md` in the same directory and list its batch of
items.

## Polling

At session start, and on every loop iteration, in this order (`$SCRATCH`
being the session's scratch dir):

```bash
bot-notify
bot-pr inbox --dry-run
bot-watch --apply > "$SCRATCH/watch-$(date +%H%M).txt"
```

`bot-notify` routes new pings (see its skill; ack requests once they're on
the board). `bot-pr inbox --dry-run` shows cgwalters' review activity on
fork PRs without consuming it, so the worker who picks up a fork PR still
sees it. `bot-watch --apply` consumes its news (the next sweep won't
report it again), so capture its whole output to a file and read that,
instead of piping it through `tail` and losing lines for good.

## Acting on it

- **Promote** a fork PR when inbox shows `[APPROVED]` (an approving
  review, or a `/promote` line): run the `bot-pr promote` command it
  prints. A go-ahead in other words only gets its `-> hint:` passed on;
  never promote on your own reading.
- **Review feedback** on a fork PR goes to a worker, preferably the one
  that wrote it if it's still around.
- **Dispatch** workers for Todo items (by priority, per `workstream`) and
  for cgwalters' asks from `bot-notify`. Scale the number of concurrent
  workers with the load: more when the queue is deep and items are
  independent, fewer when they share a repository or the GraphQL quota
  is running low.
- **Review every result.** When a worker reports back, start an
  independent reviewer subagent on its branch or gist, and send the
  findings to the same worker (SendMessage, so it keeps its context) to
  fix. Repeat until the reviewer says it can ship before pointing
  cgwalters at it.
- **Reply where cgwalters tagged the bot**, per the rule in `workstream`:
  his own @-mentions only, one concise answer in the same thread, once
  the work behind it is reviewed.

## Loop cadence

Loop with a background sleep as the heartbeat (`sleep 1200` or `sleep 1800`
run in the background, which wakes the session when it exits): 20 minutes while
workers are running or news is coming in, 30 minutes when idle. Worker
completions wake the session too; handle them as they arrive, and poll
again when the sleep ends.

## Morning brief

Each morning, open an issue on
[cgwalters-bot/cgwalters-bot](https://github.com/cgwalters-bot/cgwalters-bot/issues)
that mentions @cgwalters, with:

- **quick wins**: fork PRs that are small and ready, with links;
- **review queue**: everything else Draft, in priority order;
- **decisions**: Needs human items, each with its one question;
- **reading**: analysis gists and notable upstream activity.

Keep it scannable, and end it with
`Generated-by: https://github.com/cgwalters/#llms`.

## Stopping

There is no programmatic readout of the weekly usage left, so don't try
to ration it or guess. Keep looping until cgwalters says to stop.

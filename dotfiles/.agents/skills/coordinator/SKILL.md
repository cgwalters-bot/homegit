---
name: coordinator
description: Run the bot (cgwalters-bot) as the top-level coordinator session - poll bot-notify, bot-pr inbox and bot-watch on a loop, promote approved fork PRs, dispatch worker subagents for Todo items and the operator's asks, have an independent reviewer check every result, and post the morning brief. Load this when asked to run or coordinate the bot; workers and reviewers read the preambles next to it instead.
---

# coordinator — Running the bot as a coordinator

Names: *the operator* is the human who runs this bot (`operator.login` in
the operator config, see `bot-operator` and docs/bootstrap.md; cgwalters by
default). The bot account, forge org, tracker and board below are the default
config's (cgwalters-bot, cgwalters-forge, cgwalters-forge/tracker,
orgs/cgwalters-forge/projects/1); under another operator config, read them as
that config's values (`bot-operator --json`). The goals in the next section
are cgwalters'.

The coordinator is the long-lived top-level session. It does little work
itself: it watches for news, keeps the board moving, and briefs subagents
that do the work. The other skills say how the work is done; this one
says how to drive it. The board semantics are in the `workstream` skill,
routing pings in `bot-notify`, building and testing in `devspace-work`,
and contributing in `upstream-pr`.

## What we're working toward

Priorities, in cgwalters' words: "p0 priority remains composefs
stability overall, other stuff like improving our own infra, burning
down backlog issues is p1". The concrete P0 goal is a branch of
[redhat-cop/rhel-bootc-examples](https://github.com/redhat-cop/rhel-bootc-examples)
that builds on current c10s with bootc from git and yields a viable
containerdisk through image-builder (forge rhel-bootc-examples#4 and
its e2e); the bootc, composefs-rs, image-builder and ostree fixes that
path needs come first. The [Composefs Stable](https://github.com/users/cgwalters-bot/projects/2)
board tracks it.

Within P1 (see "Priority" in the workstream skill, which also counts
backlog burn-down and the operator's direct requests), the main thread is
the bot's own harness, aiming at something like GitHub Agentic
Workflows without its inner sandbox: task definitions compiled to
Actions, digest-pinned task containers, an ACP agent wrapper
(`bot-harness`, proposed in cgwalters-forge/cgwalters-devspace-sandbox#3)
whose transcripts land as
run artifacts, and comments that carry run metadata and cost.
Prompt-injection defense is a top-level concern of that harness: a
multi-model intake review before untrusted text reaches Todo, and
workers writing only through capped, separately applied safe outputs
(cgwalters-forge/tracker#225). Then the
review app (<https://cgwalters-forge.github.io/review/>) growing into
the operator's one inbox, a github.com-like dashboard with the queue, news,
run history and eventually chat; shared GitHub API caching; cheaper
models only where an eval shows they hold up.

The interactive coordinator session is itself temporary. The target is a coordinator launched
from a scheduled workflow, with an interactive ACP session the operator
can drive from the review app (design:
<https://gist.github.com/cgwalters-bot/0a42c8916ac9a82f90e601576fe4c90b>),
and the coordinator moving out of homegit into a repository of its own.
Keep that in mind when changing this skill: put state on the board, in
tracker issues and in git rather than in the session, and keep what the
coordinator needs to know here or in the files next to this one.

## Briefing subagents

Every subagent's prompt starts by telling it to read one of the files next
to this one, by path in the homegit checkout
(`~/src/github/cgwalters-bot/homegit/dotfiles/.agents/skills/coordinator/`):

- `worker-preamble.md` for a worker (implementing an item, answering an
  ask, turning Drafts into forge PRs);
- `reviewer-preamble.md` for a reviewer;
- `policy-check.md` for a policy check (see "Promote" below).

Then comes the task itself: the board item or ask, the repository and
base branch, the worker's scratch dir (e.g. a per-task directory under
the session scratchpad), and anything specific. When the task needs a
devspace, name it after the task and give it 16 cores or fewer (16 is
the default) and the shortest duration that fits; brief 64 cores only
when a 16-core run has proven too slow for this work, and say why.
Naming the board item, scratch dir and devspace in the prompt is also
what lets `bot-cost` attribute the task's cost. For the overnight batch
job of turning Draft items into review-ready forge PRs, also point the
worker at `forge-migrate.md` in the same directory and list its batch of
items.

For purely mechanical work (loop until a branch compiles, clippy/fmt
fix-ups, a named failing test with a local fix, bisecting a build
break, first-pass classification of CI failures), dispatch the
`builder` agent type, or have a worker dispatch it: it is pinned to
Sonnet 5.5 and costs about half as much. It never commits or pushes (a
hook refuses it); it leaves its changes uncommitted and reports the
diff, which the caller reviews and commits through `bin/bot-git`. Don't pass `model`, which
would override the pin. Reviews, design, security and root-causing a
failure it reports as "unexplained" stay on the default model.

## Polling

Poll with `bot-poll`, run in the background, which wakes the session
(by exiting) only when something new turns up:

```bash
bot-poll
```

Every 15 minutes it sweeps the checkout with `git pull --ff-only`, then
runs:

```bash
bot-notify
bot-pr inbox --dry-run
bot-watch --apply
bot-tmt-number --gc
```

saving each one's whole output under `~/.local/state/bot-poll/runs/`,
and compares what they list against what it has already reported:
approvals, the operator's activity on fork PRs, outstanding reviews,
rebase needs, priority health lines (a new P0 one is its own kind),
sign-offs, requests and answers from `bot-notify`, and item news other
than bots'. A review, comment or sign-off is news once, by its id,
whichever report lists it.

Each sweep also rebuilds a *hot set*: the bot's open PRs (fork PRs in
the forge and the rest), the tracker's open asks assigned to the
operator, and anything of the bot's they reviewed or commented on in
the last 3 hours. Between sweeps, every 90 seconds, a hot cycle polls
the notifications and the operator's public events with conditional
requests (a 304 costs no rate limit, and their X-Poll-Interval is
honored), then reads the reviews and comments of the hot items those
point at, and of up to 10 they were active on lately. The operator's
new reviews and comments there wake the session within a cycle: an
approval of a fork PR's head (or `/promote`) as `approval`, other fork
PR activity as `forge-review`, on a tracker issue `notify`, on another
PR `review` (an approval of an upstream PR's head also runs
`bot-signoff-due --apply`, reported as `signoff`), else `news`. A
thread updated for a mention, review request or assignment runs
`bot-notify` at once. A quiet cycle costs two 304s, plus about three
more (also 304s) per item the operator is active on; GitHub rate limits
pause the cycles until their reset. Nothing wakes the session unless
something is new. What the hot cycles can't see (the operator's
activity in private repositories, items the bot doesn't follow) waits
for the next sweep, as before.

On the first new item it exits printing
`NEWS (KINDS) at HHMM: RUN/*.txt` (RUN is `hot-*` for a hot cycle's);
then run `bot-poll --summary` for the new items themselves, grouped,
with their URLs, and read the run's files for the rest. The summary
ends with how long it has been quiet, the hot set's size and the
requests per cycle and per hour (also in
`~/.local/state/bot-poll/status.json`). After 12h without news it exits
too. Handle the news, then start `bot-poll` again: what it reported
stays reported,
and news a sweep found before a restart is reported on the next
start, since it keeps what it has seen in its state dir, and keeps
the sweeps' 15-minute schedule across restarts. `bot-poll
--once` sweeps right away (at session start, say); `--help` has the
rest. It is homegit's Rust crate `crates/bot-poll`: `make
install-crates` in the shared checkout installs it into `~/.cargo/bin`,
and it runs that checkout's `bin/` tools. Its sweeps pull the checkout
but don't rebuild it, so after a pull that changes `crates/bot-poll`,
run `make install-crates` again before restarting it.

`bot-notify` routes new pings (see its skill; ack requests once they're on
the board). `bot-pr inbox --dry-run` shows the operator's review activity on
fork PRs without consuming it, so the worker who picks up a fork PR still
sees it. `bot-watch --apply` consumes its news (the next sweep won't
report it again), which is why `bot-poll` keeps its whole output: read
the file rather than rerunning it. `bot-tmt-number --gc` releases the
bootc tmt test numbers workers reserved once their number is on main
or in their open PR, or their PR closed.

## Acting on it

- **Priority health before anything else.** `bot-watch` starts every
  sweep with a "Priority health" section (from `bot-priority-health`):
  the open PRs of P0 and P1 board items, and of the Composefs Stable
  board, whose CI fails on the current head (naming the failing jobs),
  whose checks have been pending over 4h, that conflict or are behind a
  base that must be up to date, whose DCO check fails, or that have had
  no activity for over 24h (P0) or 72h (P1). One line per problem, P0
  first:

  ```
  Priority health:
    P0 ci-failing https://github.com/bootc-dev/bootc/pull/2516 12fe99311b45: required-checks, test-integration (...)
  ```

  The first four fields (priority, reason, URL, head) identify a
  problem and stay the same until it is fixed or the head moves, so
  `bot-poll` wakes on each new one once. Handle a new
  P0 line first, before other news: find out why (the failing job's
  log, the conflict, who it waits on) and dispatch a worker or fix it,
  or, when it waits on a human (a review, a rerun, a sign-off), make
  sure there is an ask for it (see `workstream`). P1 lines come after
  the outstanding reviews below. A line that stays while someone is
  on it needs nothing more.
- **Sign-offs.** `bot-watch --apply` runs `bot-pr signoff` itself on
  each of the bot's upstream PRs whose DCO check fails although
  the operator approved its current head (`bot-signoff-due`), and lists
  the result under "Sign-offs": `Signed off: URL (NEW-HEAD)`, or why
  `bot-pr signoff` refused. A refusal needs a look (a stale policy
  record, say): once its cause is fixed, run `bot-pr signoff URL` by
  hand, since the sweeps only retry a refused head after 6h. A sign-off
  needs nothing more.
- **Promotions.** Likewise, `bot-watch --apply` runs `bot-pr promote`
  itself (with `--draft` after the operator's `/draft`) on each fork PR
  whose current head they approved, by review or `/promote` line, when
  `upstream-policy check` passes for its upstream (`bot-promote-due`).
  This is level-triggered: an approval `bot-poll` never woke on (its
  seen-set was reset, say) still gets promoted on the next sweep. The
  "Promotions" section lists `Promoted: FORK-PR -> UPSTREAM-PR`, which
  needs nothing more; `Promotion refused: ...` (a conflict, say), which
  needs the same look a refused promote by hand does, then `bot-pr
  promote URL` by hand once fixed, since refused heads are retried only
  after 6h; or `Not promoted: ...` for a missing or stale policy
  record, which needs a policy check (see "Policy gate"). Fork PRs
  approved for a human-text repository are never promoted
  automatically: they are listed under "Needs your text" until the
  operator's text and `/promote --human-text` are in, and then promoted
  by hand.
- **Outstanding reviews first** (after P0 health). The "Outstanding reviews by LOGIN"
  section (LOGIN being the operator's login) `bot-watch` prints on every sweep is P0: dispatch a worker for
  each listed PR, unless a live worker is already on it (check it's
  still running). It stays listed on every sweep until the bot pushes or
  replies, so a listing alone isn't a reason for another worker.
- **Needs rebase.** `bot-watch` also lists, on every sweep, the bot's
  open PRs that need rebasing onto their base: CI failing while the
  base moved on, a base that must be up to date, or conflicts. Each
  tick, run `bot-pr rebase URL` yourself on up to 3 of the
  conflict-free ones, unless the failing checks look caused by the PR
  itself (a lint, build or unit test failure in code it touches: that's
  a fix for a worker, not a rebase), or it has maintainers' approvals
  that a force-push would make stale (ask the operator instead). PRs with
  an outstanding review by the operator aren't listed there: the worker
  answering it rebases on the way. Nor are conflict-free upstream PRs
  in repositories with a merge queue (unless the policy record says
  `rebase: any`) or a policy record saying `rebase: conflicts-only`:
  there a rebase only reruns CI that the maintainers
  must approve again, and `bot-pr rebase` refuses it. It refuses
  anything that isn't a clean, rebase-only change of the bot's own
  commits (and the operator's), keeps the operator's sign-off, and comments one line on an upstream PR. When it
  exits 10 (conflicts), or for the conflicting ones, dispatch a worker
  to resolve the conflicts, retest and push, per `upstream-pr` (on an
  upstream PR the operator's sign-off then stays only on commits whose resolution
  changed nothing beyond context; the others need `bot-pr signoff`). A
  PR the sweep listed for CI isn't listed again once rebased: if CI
  still fails, it's real, and the next "CI failing" news is work for a
  worker.
- **Promote** a fork PR when inbox shows `[APPROVED]` (an approving
  review, or a `/promote` line) and the same sweep's "Promotions" didn't
  already: run the `bot-pr promote` command it prints. A go-ahead in
  other words only gets its `-> hint:` passed on; never promote on your
  own reading. For a DCO repository, promote adds
  the operator's sign-off; if it stops over someone else's commits, ask them, and pass
  `--include-others` only if they say so.
- **Policy gate.** Promote and `bot-pr signoff` first run
  `upstream-policy check OWNER/REPO`, which needs a record of the upstream
  repository's contribution policy in homegit
  (`upstream-policy/OWNER/REPO.md`) whose sources are unchanged upstream
  and whose verdict is bot-ok. Before promoting, run that check yourself;
  if the record is missing or stale, dispatch a separate policy-check
  subagent (brief it with `policy-check.md` and OWNER/REPO; it only reads
  upstream, and lands the record on homegit main with `bot-land`), never
  the worker who wrote the change. Once it's merged (bot-land
  fast-forwards the shared clone; otherwise `git -C
  ~/src/github/cgwalters-bot/homegit pull --ff-only`) so the gate sees
  it, promote. For a human-text verdict, tell the operator the text must be
  theirs: they retitle the fork PR, edit its body (dropping the bot's
  `Generated-by` line), reword the commits and push them themselves, then
  comment a `/promote --human-text` line (or open the upstream PR
  themselves); inbox then shows `[APPROVED, text by LOGIN]` with the operator's login. Promote
  checks GitHub's record of who pushed the approved head, who edited the
  body last and who set the title, so the bot must not push to or edit
  that fork PR after they do. For human-only or no-go,
  set the item Needs human with the record's link. Never edit a record's
  verdict to get past the gate; only the operator loosens one: when they ask
  for that, open the pull request with `bot-land --no-auto`, and enable
  auto-merge (`gh pr merge N --auto --rebase`) only once they approved it,
  since the gate counts their approval of the merged head.
- **Own repositories take pull requests only.** homegit and the bot's
  other own repositories (listed in `worker-preamble.md`) require a pull
  request with a green `ci` check on main, rebase-merged; workers land
  there with `bin/bot-land`, never with a push to main. Commit in a
  worktree of your own (`git worktree add`), not in the shared clone:
  `bot-git` refuses to commit or rebase in
  `~/src/github/cgwalters-bot/homegit` and the clones listed in
  `~/.config/bot-git/shared-clones`. For a rare one-line fix that has to
  be made right there, prefix that one command with
  `BOT_GIT_ALLOW_SHARED_CLONE=1`; bot-land's fast-forward of the shared
  clone needs nothing.
- **Harness changes merge after an independent review, not after
  the operator.** For the bot's own harness (the own repositories above,
  cgwalters-forge/review and cgwalters-forge/tracker), a change may
  auto-merge once a separate reviewer subagent (never the worker that
  wrote it) has approved that exact head and its verdict is posted on
  the pull request. For bootc-dev/cgwalters-devspace-sandbox the same
  review counts as their approval for promote, only if that repository
  doesn't enforce DCO (their sign-off always needs their own approval). They
  asked for this so harness work doesn't queue behind them; they read it
  afterwards in the review app's news pane. Exceptions, which still need
  their approval before merging (open them with `bot-land --no-auto`,
  which puts the pull request on the board, and request their review on
  it: the pull request is their queue entry, never a tracker question or
  `--review` ask):
  - **architecture:** a new component or service, a new trust boundary,
    or a change of direction against a design they wrote or approved;
  - **security:** credentials and tokens, sandboxing and containment,
    workflow `permissions:` and secrets, action or container pinning,
    the review app's auth, CSP and approve guard, egress;
  - **the rules themselves:** `bot-git`'s sign-off handling, the
    upstream-policy gate, `bot-pr promote`/`signoff`, this list, and
    anything else in AGENTS.md or these skills that loosens what the bot
    may do without them.
  When unsure whether a change falls under an exception, treat it as
  one.
- **Housekeeping needs no question.** Clearing local caches, removing
  finished worktrees and scratch clones, stopping idle devspaces and
  similar routine cleanup of the bot's own local state: just do it and
  mention it in passing. The operator doesn't want to be asked about these.
- **Review feedback** on a fork PR goes to a worker, preferably the one
  that wrote it if it's still around.
- **Dispatch** workers for Todo items (by priority, per `workstream`) and
  for the operator's asks from `bot-notify`. Composefs stability comes
  first: fill free worker slots with P0 (composefs-stable) items before
  any P1 own-infra or backlog item, and only then P2. Scale the number of concurrent
  workers with the load: more when the queue is deep and items are
  independent, fewer when they share a repository or the GraphQL quota
  is running low.
- **Forge CI is off.** Forge forks run no workflows, so a worker's
  devspace run is the fork PR's CI: brief workers to put its results in
  the PR description, and don't wait for, or ask about, fork CI. Only a
  change to a CI workflow itself gets that workflow opted in on its fork
  (`bot-pr fork-setup REPO --ci FILE`, or `fork-pr --ci`); once its run
  is linked in the PR, turn it off again with `bot-pr fork-setup REPO
  --no-ci`, since until then it runs for every PR on that fork.
- **Review every result.** When a worker reports back, start an
  independent reviewer subagent on its branch or gist, and send the
  findings to the same worker (resuming it, so it keeps its context) to
  fix. Repeat until the reviewer says it can ship before pointing
  the operator at it. For a forge PR, the reviewer also posts a review
  guide (`bin/bot-review-guide`, see `reviewer-preamble.md`): the
  hotspots to read closely and what to skim, which the review app
  (<https://cgwalters-forge.github.io/review/>) walks and tints in the
  diff. After a fix is pushed, the next review round posts a new guide
  for the new head; the app shows the old one as stale.
- **Questions for the operator are question issues** in
  cgwalters-forge/tracker (`bot-board question`, one per question, the
  recommendation first as A), never a separate list (a claude.ai
  artifact, a local file): their queue is the board's "Needs cgwalters"
  view (Needs human and Draft, by Priority; see "The operator's queue" in
  `workstream`), which GitHub keeps current as they answer, approves,
  promotes and merges. When a worker reports a question, make sure it
  landed as a question issue blocking the right item. They answer with a
  comment on it: `bot-notify` prints an `answer` record, which you act
  on (or dispatch), then close with `bot-board resolve` and ack. When they
  answer one in the session instead, act on it the same way and put
  their answer in the question issue's closing comment.
  A question or decision for the operator belongs on the PR it concerns (a
  PR comment or review reply) when there is one, or else as the tracker
  question above — never only in the coordinator's terminal chat with
  them. Keep chat replies to brief status, pointing at where it was
  posted rather than restating the options.
- **Reply where the operator tagged the bot**, per the rule in `workstream`:
  their own @-mentions only, one concise answer in the same thread, once
  the work behind it is reviewed.

## Loop cadence

`bot-poll` in the background is the loop's heartbeat: it wakes the
session on news, or after 12h. Worker completions wake the session too;
handle them as they arrive, and keep one `bot-poll` running (a second
one refuses to start while the first holds its state dir).

## Heartbeat

The review app's ops view can't see the workers on this machine, so
publish them: on each loop wake (after polling) and whenever a worker
starts or finishes, pipe the current state to `bot-heartbeat publish`:

```bash
jq -n --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
  updated_at: $now,
  coordinator: {session: "SESSION", loop_state: "sleeping", next_wake_at: "2026-09-28T20:30:00Z"},
  workers: [{name: "ops-v2", item_url: "https://github.com/OWNER/REPO/issues/N",
             started_at: "2026-09-28T19:40:00Z", devspace: "ops-v2", status: "testing"}]
}' | bot-heartbeat publish
```

`session` is this session's id, `loop_state` what the loop does next
(`polling`, `working`, `sleeping`, or `stopped` when the operator says to
stop), `next_wake_at` when the running `bot-poll` gives up (its start plus
12h; it wakes the session sooner on news), and each running worker is listed by the name, board item and
devspace in its brief, with the `status` it last reported (`starting`,
`working`, `testing`, `reviewing`, `landing`, `waiting`); a finished one
is left out. The heartbeat is public: names and links only, never task
text. The tool drops workers on private repositories' items, and edits
one pinned comment on cgwalters-forge/tracker#176 in place, which
notifies no one. The view warns when `updated_at` is more than 15
minutes old and `next_wake_at` (if given) has passed by more than a few
minutes, which means the session is gone or stuck.

## Morning brief

Each morning, open an issue on
[cgwalters-bot/cgwalters-bot](https://github.com/cgwalters-bot/cgwalters-bot/issues)
that mentions the operator, with a link to the "Needs cgwalters" view
(<https://github.com/orgs/cgwalters-forge/projects/1/views/2>) and a
summary of it:

- **quick wins**: fork PRs that are small and ready, with links;
- **review queue**: everything else Draft, in priority order;
- **decisions**: open question issues, each with its link;
- **reading**: analysis gists and notable upstream activity;
- **cost**: yesterday's estimate from `bot-cost --since yesterday
  --until today`: the total, compute (core-hours) against inference, and
  the top few tasks, labeled as an estimate at list prices.

Keep it scannable, and end it with
`Generated-by: https://github.com/cgwalters/#llms` (the config's `generated_by_url`).

## Stopping

There is no programmatic readout of the weekly usage left, so don't try
to ration it or guess. Keep looping until the operator says to stop.

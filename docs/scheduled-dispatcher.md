# The dispatcher as a scheduled job

Today the controller loop is deterministic: `node bin/bot-supervisor`
runs `bot-poll-loop --until-actions` and starts a short Sonnet "dispatcher"
(the `dispatcher` skill) only for configured actionable reports. The Opus
coordinator is needed only for what the dispatcher escalates. The goal the operator set
is to move this to a scheduled job that edge-activates on events ("don't
block on me, improve dispatch, bear in mind our goal is to move this to a
scheduled job alongside edge activation on events"), and on 2026-10-06,
after a restart of the supervisor unit killed the toolbox every session
and job ran in: "i want to get towards having the controller (you) just
be a scheduled GHA job or so via the same remote agent running infra
that's the real fix"
([tracker#401](https://github.com/cgwalters-forge/tracker/issues/401)).
Only [the read-only report](#the-read-only-report) is hosted so far; this
note says how today's pieces map onto a GitHub Actions workflow, and
[the plan](#moving-the-controller-to-actions) orders the move. It follows
[tracker#265](https://github.com/cgwalters-forge/tracker/issues/265)
(`agent.yml` and the gh-aw fork that is to replace it) and
[tracker#270](https://github.com/cgwalters-forge/tracker/issues/270)
(workflow-compiler safe outputs); the workflow is to be compiled from a
task definition by the workflow compiler (wfc-owned), not hand-written
here.

## What is already headless

The controller is level-triggered: every run derives what to do from the
board, the issues and PRs and the latest sweep, so a run that was
dropped, repeated or late loses nothing. `bot-reconcile --apply` does the
deterministic part with no model: it sets finished items Done, clears
stale Leads, and dispatches the top Todo issue of each lane that carries
the `dispatch` label as a devspace run (its brief built from the issue's
text, the operator's comments and its acceptance criteria), within the
agent target, the lanes, the pace of the pool of the run's agent (see
`bot-capacity`) and the remote share of the mix (`pacing.opencode_share`,
1 in 4, rounded up so that at least one remote run is allowed while any
agent is; never more than `pacing.opencode_runs` at once). A run is
opencode, on the openai pool (the Codex subscription's, from the praxis
broker's `/usage`), or claude, on the Claude subscription, while the
claude pool is behind its pace and the openai one is held or ahead of its
own; `bot-runs dispatch` gives a claude run a larger default `--budget`,
since its AIC are api-equivalent. Each dispatch also gets its token budget, and a task past it is
a `budget` action.
What it can't decide it reports as an action, which the dispatcher
handles by kind, or escalates.

The board is the operator's primary interface. Periodic summaries are
native project status updates, and chat replies are one line plus the
update URL. Today `bot-sweep` ends with `bot-board status-update --auto`
(two-minute timeout), after watch/notify/inbox and gc/actuals/fill-org;
earlier failures do not gate the posting phase. It posts only after the
four-hour throttle and material-change check pass. An unfinished P0 stale
for at least `BOT_BOARD_STATUS_P0_HOURS` (24 hours by default) derives
`at-risk`; otherwise the status is `on-track`. Explicit `--status`,
`--since` and `--body` posts bypass those auto checks, and cannot be
combined with `--auto`. See [Project status updates](../README.md#project-status-updates)
for the flags, observation baseline and recovery behavior. The current
per-project lock is local: use one publishing machine per project.
The current publisher returns the project URL, not an update-specific
permalink. The status-update schema was checked by introspection; exact
review-app parity remains outstanding.

State lives in three kinds of places. The shared, durable state is
already GitHub's: the board (Status, Lead, Run, Why, News, budgets),
project status updates (including their recovery markers),
issues and their labels (`dispatch`, `escalate`), PRs, and the run
artifacts of `agent.yml` (`summary.json`, `agent-out`). The per-loop state
is local files: `bot-reconcile --state FILE` (which actions fired and
when, the edge-triggering), `bot-poll-loop`'s seen-sets, the sweeps under
`~/.local/state/bot-sweep`, the heartbeat's local input, and the per-project
status-update snapshot under `~/.local/state/bot-board`. Those are
the only state to move: `--state FILE` is already the whole interface for
the actions (read it at the start, write it at the end), so a job can
keep it as a file on a state branch of a repository, or an artifact of
its previous run, and the rest is recomputable from GitHub.

## Local supervisor

The existing poll loop checks notifications about once a minute (respecting
GitHub's X-Poll-Interval), with If-Modified-Since for unchanged polls. It
reads the latest comment's API author, not mentions or quoted text, and
wakes as `news, fast` for the configured operator on open threads authored
by or assigned to the bot, or on its board (including Branch PRs). This
read-only path never marks notifications read; local comment URL/timestamp
seen-sets dedupe repeats and edits. Failed reads retain the polling window.
A fresh state looks back ten minutes. The slower sweep remains the safety
net for missed notifications and comments hidden by a later reply.

Launch from the checkout with an interpreter:

```
node bin/bot-supervisor --dir /path/to/dedicated/dispatcher-worktree
```

The supervisor is a nonexecutable (100644), Node standard-library script;
do not chmod it, install executable aliases, or add skill symlinks. It
invokes the existing poller through Bash and bot-claude through Node.
The canonical dispatcher skill and `supervisor-brief.md` are read directly
from `dotfiles/.agents/skills/dispatcher` and inlined into each job's brief.
The checkout must remain available at runtime.

`--action-kinds CSV` (or `BOT_SUPERVISOR_ACTION_KINDS`) replaces the default
allowlist shown by `--help`; an empty value disables model dispatch. Only
fired `* KIND [URL or board-item ID]: ...` reconcile payload lines and event wake kinds are
selected. The header's `actions:` summary alone cannot start a model.
Defaults exclude completed deterministic work (`closed-not-done`,
`stale-lead`, `midstream-pr`, `dispatch`) and coordinator-only `escalate`.
Quiet/timeouts and ignored wakes loop without model calls. Reports are
passed intact as data, with selected kinds explicitly listed.

Jobs use `--model sonnet --effort low`, a 10-minute timeout and 20-turn
limit (configurable with `--job-timeout-min` and `--max-turns`). The
supervisor starts one job and waits before polling again. A wait timeout
(124) retains the pending ID and waits again. Only wait exit 0 acknowledges
and removes the pending batch. Failed, timed-out, lost, killed or incomplete
jobs retain the entire batch with a failure marker and exit with a recovery
error. Subsequent starts fail closed on that marker, without polling,
waiting again, or launching another model. Exit 1 is confirmed with status
first, since CLI errors also use that code; an unconfirmed failure retains
the pending ID for another status/wait attempt.
The dispatcher dispatches long workers and records
their IDs instead of waiting through them. Poll/start/status errors back
off too (`--retry-delay-ms`, default 30 seconds). Idle reports have a
one-second backoff (`--idle-delay-ms`) to avoid spinning on short windows.

State defaults to `$XDG_STATE_HOME/bot-supervisor` or
`~/.local/state/bot-supervisor` (`--state-dir` overrides). Atomic
`pending.json` records the brief and a preselected unique job ID before
start. After restart, status checks recover a started job and wait on it;
only an explicit "no such job" permits starting that same ID. Malformed
state or ambiguous start/status failures retain the state and fail closed.
An incomplete bot-claude job directory may need manual inspection and
repair. There is no automatic resume or retry of failed model sessions. Use one
supervisor per state directory and publishing host; do not run a manual
instance alongside the service. Poller state remains owned by bot-poll-loop;
a crash between poll completion and saving pending can delay persistent
reconcile actions until resync. Event-only wakes have already been marked
seen and may never be delivered again: recover those manually from the
poller state and referenced sweep/event reports. Saved batches survive
dispatcher failures, but the edge-trigger handoff gap means this is not
reliable batch delivery or exactly-once writes.

### Repairing a blocked batch

Stop the service (or manual supervisor) first; `Restart=always` otherwise
repeats the recovery error. Keep `pending.json` and the failed bot-claude
job's evidence. Inspect `node bin/bot-claude status --json JOB` and
`node bin/bot-claude log JOB`, plus the saved `brief` in pending.json.
Check which writes already happened before repeating anything.

Repair the cause and handle the remaining actions manually, or extract
the saved `brief` into a regular file outside the checkout and explicitly
replay it using `node bin/bot-claude start --dir DISPATCHER_WORKTREE
--model sonnet --timeout 10 --max-turns 20 --effort low BRIEF_FILE`.
Alternatively, `node bin/bot-claude resume JOB` can continue an unsuccessful
job that has a resumable session. Follow the chosen job with
`node bin/bot-claude wait JOB` and verify successful handling of the batch.
The failure marker deliberately blocks automatic recovery even if an
operator later resumes that job successfully.

Only after successful handling, archive pending.json to a unique filename
outside the active state path, preserving the brief, failure marker and
original job ID, then restart the supervisor. Do not merely delete pending
or clear its failure marker to get polling running again; an event-only
action would otherwise be lost. There is no automatic retry/reset command.

The supplied `dotfiles/.config/systemd/user/bot-supervisor.service` uses
`Restart=always`. Before enabling it, create the dedicated dispatcher
worktree named by `--dir` and install the regular unit file into the user
unit directory. Its default checkout paths match bot-sweep's; use a user
drop-in replacing ExecStart for other checkout/worktree or Node paths.
`~/.config/bot-supervisor.env` should set `BOT_SUPERVISOR_TOOLBOX` (the
toolbox holding `gh`, which the host PATH lacks; the supervisor re-executes
itself there, like bot-sweep's `BOT_SWEEP_TOOLBOX`) and
`BOT_SUPERVISOR_GH_TOKEN_FILE` (the bot's existing gh token file, read into
`GH_TOKEN` when that is unset). It may also set the action-kind allowlist and JSON
argv arrays `BOT_SUPERVISOR_POLL_COMMAND` / `BOT_SUPERVISOR_CLAUDE_COMMAND`
for interpreter-based tool overrides (also used by offline tests).
No symlink or executable installation is required. Then reload user units
and enable/start `bot-supervisor.service`; keep `bot-sweep.timer` enabled
to provide observations. Stop kills the unit's cgroup, including jobs it
started; restart recovers their terminal/lost state. Service installation
and live enabling are operator steps, not part of checkout-only changes.

Neither unit may own the toolbox container. A container started from a
systemd unit keeps its conmon in that unit's cgroup, so if `bot-supervisor.service` (or
`bot-sweep.service`) were first to run `toolbox run` after a boot,
stopping it would kill the container, the coordinator's session and
every job in it; that took the coordinator down on 2026-10-06. Both
therefore start a stopped container themselves, with `podman start` in
a transient `bot-toolbox-NAME.scope` (`systemd-run --user --scope`), and
refuse to run, saying so in the journal, while its conmon is in their
own cgroup. Remove any local `KillMode=process` drop-in for
`bot-supervisor.service` once this is installed: it is no longer needed
and leaks the unit's `toolbox run` child on restart. Even so, never
restart or stop these units from inside the toolbox without first
checking with `systemd-cgls --user` that the container's conmon is in
its own scope (or a login session's), not under the unit.

## The workflow

Triggers, one workflow where it can be, because every trigger means the
same thing: "run the controller now". Two limits shape where it lives:
repository events (`issue_comment`, `pull_request_review`, `issues`,
`workflow_run`) fire only in a repository that holds the workflow, and
`workflow_run` only for workflows of that same repository.

- `schedule`, every 10 minutes (the cadence of `bot-sweep.timer`): the
  level trigger. Cron is best effort (runs are delayed or dropped under
  load, and a public repository's schedule is disabled after 60 days
  without activity), so it backs the events up rather than replacing
  them, and a heartbeat check should notice a silent one.
- `issue_comment`, `pull_request_review` and
  `pull_request_review_comment`, in the tracker and the bot's own
  repositories: the operator's messages and approvals there, which must
  act within minutes. The first step checks the actor against
  `operator.login` and stops for anyone else before any model runs;
  their text is data either way. The operator's approvals on upstream
  PRs are in repositories without the workflow, so they stay with the
  cron, or a webhook relay that sends `repository_dispatch`.
- `agent.yml` completing: it lives in the devspace repository, so a
  `workflow_run` trigger there can't start a job here. Its last step
  sends a `repository_dispatch` to the job's repository instead (or the
  cron picks it up).
- `issues` (`labeled`, for `dispatch` and `escalate`) in the tracker, and
  board changes. `projects_v2_item` is a webhook event; as far as we know
  it is not an Actions trigger (to be checked when this is built), so
  board edits reach the job through the cron, or the same relay.

One concurrency group, `bot-dispatcher`, with `cancel-in-progress: false`:
runs queue behind the one in flight, and GitHub keeps only the newest
pending one, which is right for a level-triggered controller, since the
pending run reads the state the dropped ones would have. Never cancel a
run in flight: it may be between a label removal and a dispatch.

The job: check out homegit, run the sweep steps `bot-sweep` does today
(`bot-watch --apply`, `bot-notify`, `bot-pr inbox`), then `bot-reconcile
--apply --state ...`. If actions that need handling remain, start the
dispatcher as a single pass: Sonnet with the `dispatcher` skill, given
the report instead of looping on `bot-poll-loop`, exiting when the report
is handled. Its writes go through capped, separately applied safe outputs
(tracker#270): labels, comments, board fields, draft PRs, merges under
the standing rule, nothing else, so a prompt-injected thread can't widen
what the job does.

## Where the coordinator's escalation lands

An escalation is an issue in the tracker labeled `escalate`, filed by
the dispatcher with a recommendation (see its skill). Today the
`escalate` rule of `bot-reconcile` lists it, so a coordinator session
sees it as an action. In the job it is an edge: `issues: labeled` with
the `escalate` label starts a second workflow, on Opus, whose prompt is
the issue, the coordinator skill and the same safe outputs, in its own
concurrency group so that long judgment never blocks the dispatcher. It
answers on the issue and closes it, which ends the action. Operator
messages the dispatcher can't answer with a pointer take the same path.
Questions only the operator can answer stay `bot-board question`s, in
their queue, not escalations.

## What the job may hold

The operator decided this on tracker#401; it is laid out under
[Credentials](#credentials) in the plan below. The job that reads and
decides, model or not, holds only read access. Every write is a safe
output, applied later in the same workflow run by gh-aw's own handlers
under a GitHub App token minted for that run. That token needs contents
and pull requests on the bot's and the forge org's repositories, issues
and labels on the tracker, write on the org's Projects v2 board, and
`actions: write` on the devspace repository to dispatch `agent.yml`; it
is never given to a run's sandbox. The default `GITHUB_TOKEN` is not
enough: it reaches one repository and no project. Model access is
through the praxis broker's per-run tokens, as `agent.yml` does, never
a raw API key on the runner.

The apply step opens draft fork PRs or homegit PRs and never merges;
merging stays with the review step: homegit and the devspace stack after
an independent review, upstream only on the operator's approval.

## The read-only report

The first piece that runs in Actions is the observing half of the pass,
with nothing applied: the `controller-report` workflow in this repository
(hourly, `workflow_dispatch`, and on pull requests that touch it). It
holds no secret, only the job's own `GITHUB_TOKEN` with `contents: read`,
and runs `bot-sched report` (`crates/sched`), which is `bot-sweep
--read-only` followed by `bot-reconcile` without `--apply` or `--state`.
The report (each step's status and output, the sweep's problems, the
reconcile actions) is the job summary and the `controller-report`
artifact. It exists to be compared with the local sweep under
`~/.local/state/bot-sweep/runs` before anything that writes moves.

The same report carries the first piece of the scheduler's rewrite, as a
pass of its own: `bot-sched` reads the board once into a typed snapshot
(`snapshot.json` in the artifact), runs its rules on it (`closed-not-done`
and `stale-lead` so far, ports of the two in `lib/reconcile.js`), and
writes the changes they ask for as gh-aw safe-output items
(`agent_output.json`), which nothing applies yet. The board's REST
listing carries each item's issue or PR whole, so the snapshot has their
states from that one listing, without `bot-watch`'s request per URL.
The report says whether `bot-reconcile`, given the same board and
states, lists the same actions, saying and doing the same (`bot-sched
parity`, which `tests/bot-sched-parity.sh` also runs on a recorded
board); the copy in `lib/reconcile.js` goes once that has held and the
write moves here. `bot-sched reconcile --recorded FILE` replays a pass
from GitHub's recorded answers (`observe --record FILE`), which is how
its tests run without a network.

It lives here rather than next to `agent.yml` because the tools it runs
are this repository's, so there is no second checkout to keep in step,
and because the devspace repository belongs to bootc-dev, whose runners
and settings are not ours to load with a controller.

`bot-sweep --read-only` sets `BOT_GH_READ_ONLY=1`, under which
`bot-watch` and `bot-pr inbox` skip their check that gh is the bot and
refuse anything but `--dry-run`, starting from an empty state; no other
tool heeds it. What that token reads decides what the report holds (measured
on runs 37488421665 and 37489294615, 2026-10-06):

- It reads everything public over REST: the Workstream board's items
  and fields (an organization project), issues, PRs, reviews, checks,
  search, the `agent.yml` runs and the heartbeat comment. A sweep of 362
  URLs took about 200 seconds, as it does locally.
- Its quota is small: four sweeps within 28 minutes passed and the fifth
  was refused ("API rate limit exceeded for installation"), with the
  ETag caches restored. `rate_limit` answered 5000 of 5000 throughout, so
  it does not show this limit (GitHub documents 1000 requests an hour
  per repository for `GITHUB_TOKEN`). Hence hourly: the local cadence
  of 10 minutes needs a token with a quota of its own.
- It reads no last-seen state. `bot-watch`, `bot-notify` and `bot-pr
  inbox` keep theirs in archived draft items of the board (GraphQL,
  behind the project scope) or in local files. So a read-only run starts
  from none: its level sections are right, and its news is not news.
- It reads no notifications (403), so `bot-notify` is left out and the
  operator-activity section of `bot-watch` fails, which makes that step
  a problem in every report.
- It cannot list the epic board (`users/cgwalters-bot/2`): a user-owned
  project answers 403 to a workflow token even though it is public. The
  priority health and P0 drive sections then cover the Workstream board
  only.
- `bot-reconcile` has no pool readings (they come from the statusline
  and the praxis broker's `/usage`, on the tailnet), so it reports both
  pools as unpaced, and no `operator.json`, so it counts lanes and the
  remote share by the default pacing, not the workstation's.

Against the local sweep of the same ten minutes (20261006-154029-153):
"Needs your text" (11), "Outstanding reviews" (3) and "Devspace runs"
were identical; priority health had 9 of 16 lines, the other 7 being the
epic board's; "Needs rebase" listed one PR more and the inbox 54 lines
for 87, both for want of the state; operator activity had none of 10.

## Moving the controller to Actions

Nothing in this section is built except step 0. The statements about
today were checked on 2026-10-06 against this repository, the units in
`~/.config/systemd/user` on Xenon and `agent.yml` at
`bot/agent-run-praxis`; those about gh-aw against its source at v0.88.2,
which bootc-dev/gh-agentic-workflows pins, and at c6be697, the head of
our fork (v0.90.1 plus four commits). What was read and not run is
marked *not tried*.

### What runs where today

Everything that decides or writes runs on one workstation, Xenon, inside
one interactive toolbox container:

- `bot-sweep.timer` starts `bot-sweep` every 10 minutes. It re-executes
  in the toolbox (`BOT_SWEEP_TOOLBOX`), reads the bot's token from a
  file there, and both observes and applies: `bot-watch --apply`
  rebases, signs off and promotes on the operator's approvals, moves
  finished runs on and sets closed items Done.
- `bot-supervisor.service` loops on `bot-poll-loop --until-actions`,
  which reads the sweeps and runs `bot-reconcile --apply --state`, and
  starts a ten-minute Sonnet dispatcher (`bot-claude`, local) for the
  action kinds it is allowed. The dispatcher starts the local apply and
  review workers, which hold the bot's token.
- The coordinator, an interactive Claude Code session, takes what the
  dispatcher escalates and whatever the operator types.
- The praxis broker is also on Xenon, as podman units of the user
  manager bound to the tailnet interface, outside the toolbox. It holds
  the Claude and Codex subscription logins.

What already runs elsewhere is the sandboxed agent run: `agent.yml` on
CNCF RHEL 10 runners, with no repository secret. It joins the tailnet
with the job's OIDC token and trades the same for a praxis run token.
Its output comes back as an artifact that `bot-runs apply` commits on
Xenon. So the runner half is remote and everything privileged is local,
which is the "half way there" of [agent-runtimes.md](agent-runtimes.md)
(homegit#156).

### The target

One controller workflow in this repository, level-triggered, with the
triggers listed under [The workflow](#the-workflow). Each run has two
jobs. The first does the deterministic pass with no model (sweep,
reconcile, pacing, archive) holding read access only, and writes
nothing: what it would change, it emits as safe-output items. The
second holds a token minted for that run, runs gh-aw's safe-outputs
handlers over those items, and decides nothing. Whatever needs judgment
becomes a sandboxed agent run started by `workflow_dispatch`, with
inference through praxis and no GitHub credential: the dispatcher pass,
triage, review and the work itself. What an agent run produces is
applied the same way, by the same handlers. State is the board, the
issues and PRs, the run list and the run artifacts.

What each local piece becomes:

| Today, on Xenon | In the target |
| --- | --- |
| `bot-sweep.timer` and `bot-sweep` | the controller workflow's schedule and its first steps |
| `bot-poll-loop`, `bot-reconcile --apply --state` | a step of the same job; the action state in a file the job carries over (below) |
| `bot-supervisor.service` | gone: the workflow run is the supervisor, and a failed run is retried by the next trigger |
| the Sonnet dispatcher (`bot-claude`) | an agent run with the `dispatcher` skill, started when actions remain, writing through safe outputs |
| the coordinator session | an agent run on an `escalate` issue (see above); an interactive session is still how the operator talks to it, but nothing waits on one |
| local apply (`bot-runs apply`) and review workers | gh-aw's safe-outputs handlers in a job of the workflow, and review as an agent run |
| `bot-heartbeat` | derived from the run list; nothing to publish |
| the praxis broker | unchanged, and still on a host of the operator's (below) |

This agrees with agent-runtimes.md on every layer: gh-aw as the workflow
layer for agent runs, the controller in homegit, admission by a
deliberate `workflow_dispatch`. The operator's answer here is also its
decision D6, as option A (a `safe_outputs` job with a forge-scoped
GitHub App), extended from agent runs to the controller. It differs in
three places:

- Order. There, moving the controller is step 6, after the gh-aw
  cutover. But the deterministic pass does not depend on the workflow
  layer, and it is the part whose loss cost ten hours, so it moves
  first, on `agent.yml` as it is.
- The pass is not a compiled gh-aw workflow, since those always have an
  agent job. It is a hand-written workflow that runs gh-aw's handlers,
  as gh-aw's own maintenance workflow does (below).
- "Apply in the workflow" (its step 5) no longer waits for the fork to
  reach parity (its step 4): the handlers can apply `agent.yml`'s
  output as it is today.

One correction to that document: bootc-dev/gh-agentic-workflows pins
gh-aw v0.88.2, not v0.90.1.

### Credentials

The operator's decision, on tracker#401: "we should be using the
safe-outputs model - have the GHA run mint a new `GH_TOKEN` for the job
but the agent (CI run) gets readonly except for what happens in
safe-outputs processing which should run as part of that job", and "We
should be able to reuse the GHA safe-outputs code directly".

So no long-lived GitHub token is stored in Actions. Whatever reads and
decides, a model or the deterministic pass, has read access only and
hands back a list of requested writes. A step that runs gh-aw's
handlers, and nothing of ours that decides, applies them in the same
workflow run under a token minted for that run and revoked at its end.
In gh-aw this processing is a separate job of the same run, so the
token is never on the machine that ran the agent; "that job" is read
here as "that run".

#### What is reused from gh-aw

gh-aw's `safe_outputs` job is four steps, none specific to its
compiler: the `github/gh-aw-actions/setup` action, which unpacks gh-aw's
scripts on the runner; a download of the artifact holding
`agent_output.json`; `actions/create-github-app-token`; and an
`actions/github-script` step calling `process_safe_outputs.cjs`. That
script is the handler manager. Its whole interface is the file named by
`GH_AW_AGENT_OUTPUT` (`{"items": [{"type": ...}, ...]}`), the JSON in
`GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG` (which types are enabled, with
their caps, allowed repositories and optionally a token per type) and
the token of the step. gh-aw itself runs it outside a compiled
workflow: the `apply_safe_outputs` job of its maintenance workflow sets
those two variables and calls the same manager
(`apply_safe_outputs_replay.cjs`).

Used as they are, pinned by commit:

- the `setup` action and every handler it ships, for both the pass and
  agent runs;
- `collect_ndjson_output.cjs`, the validator that turns an agent's
  JSONL into `agent_output.json`. `agent.yml`'s `Safe outputs` job runs
  our vendored copy of it today; it takes the same file from the action
  instead, and `vendor/gh-aw/` goes;
- the handlers' staged mode (`staged: true` on a type), which prints
  what would be written and writes nothing. Step 2 of the migration
  uses it.

Ours, and small: the workflow YAML around those steps, the handler
configuration, the checks gh-aw does not make on a patch (listed in
[devspace-agent-runs.md](devspace-agent-runs.md)), and an `--emit` mode
for `bot-reconcile`, `bot-watch` and `bot-board`, next to `--apply`,
that prints each write as an item. Gone: `bot-runs apply` and the local
re-check. The handler configuration is what gh-aw's compiler generates,
not a documented interface, so a pin bump is tested in staged mode
first. Running the manager from a hand-written workflow with an App
token is *not tried*; the replay job does it with `GITHUB_TOKEN`.

When agent runs become compiled gh-aw workflows (agent-runtimes.md,
step 4), their `safe_outputs` job is the stock one and only the
controller's own workflow stays hand-written.

#### How the token is minted

Two tokens can be minted per run without storing one.

The workflow's own `GITHUB_TOKEN` needs no setup and is narrowed by
`permissions:`. It reaches only the repository the workflow is in,
cannot touch a Projects v2 board at all, and is refused after about
1000 requests an hour. It is what the read-only job holds; it can apply
nothing outside homegit.

A GitHub App installation token is what gh-aw's `github-app:` mints,
with `actions/create-github-app-token`: the job presents the App's
private key, held as a secret of an Actions environment, and gets a
token that lasts an hour at most, limited to the repositories and
permissions that step names, with a quota of its own (5000 requests an
hour or more). It reaches what the App is installed on, and a token
belongs to one installation: the tracker and the board (cgwalters-forge)
and homegit (cgwalters-bot) are two installations, so two mint steps,
the second given to its handlers as their per-type token. An App can
write an organization's project (the "Projects" organization
permission) but no user-owned one, so the epic board
(`users/cgwalters-bot/2`) moves to the organization or is left out. It
cannot act where it is not installed, which is every upstream
repository, and it writes as `<app>[bot]`, not as cgwalters-bot.

The private key is the one long-lived secret, and it is the App's, not
the bot's: it can do only what the installations grant. gh-aw can also
take a token minted by a step from the job's OIDC identity (octo-sts),
which stores no key but puts someone else's App and service in the
path; not proposed.

#### What the operator sets up

Creating and installing an App is his; the bot cannot and should not.

1. Create a GitHub App, owned by cgwalters-forge, with no webhook,
   installable on any account (an App limited to its owner cannot be
   installed on cgwalters-bot or bootc-dev). Repository permissions:
   Contents, Pull requests, Issues and Actions read and write, Workflows
   write (GitHub refuses a push touching `.github/workflows` without
   it), Metadata read. Organization permissions: Projects read and
   write. Nothing else.
2. Install it on cgwalters-forge (all repositories: the tracker,
   review, the forks), on the cgwalters-bot account (homegit and the
   bot's own repositories), and on bootc-dev limited to
   cgwalters-devspace-sandbox, which is what dispatching `agent.yml`
   from the controller needs.
3. Put the client id in a variable (`CONTROLLER_APP_CLIENT_ID`) and a
   private key in a secret (`CONTROLLER_APP_PRIVATE_KEY`) of an Actions
   environment `controller`, restricted to the default branch, in
   homegit (the controller) and in the devspace repository (applying
   agent runs). The key never passes through the bot. No required
   reviewer: the pass runs every ten minutes.

Each mint step then asks for less than the App has: the pass's apply
job gets issues and the project, an agent run's gets contents and pull
requests on the one repository it was dispatched for.

#### What the writes become

| The controller's write | Safe-output type | Notes |
| --- | --- | --- |
| board fields (Status, Lead, Run, Why, News, budgets), adding an item | `update_project` | fields by name, on issues, PRs and draft items; needs the project token |
| the periodic status update | `create_project_status_update` | body, status and dates |
| questions, escalations, follow-up issues | `create_issue`, `link_sub_issue`, `set_issue_type` | |
| comments on issues and PRs | `add_comment` | |
| `dispatch`, `escalate` and other labels | `add_labels`, `remove_labels` | |
| whose turn (assignees), review requests | `assign_to_user`, `unassign_from_user`, `add_reviewer` | |
| closing and editing issues | `close_issue`, `update_issue` | |
| a run's patch as a draft PR on a forge fork or in homegit | `create_pull_request` | `target-repo` and `allowed-repos`; who authors the commit is an open point |
| a fix pushed to an open PR | `push_to_pull_request_branch` | appends; cannot rewrite the branch |
| PR body, ready for review, a reviewer's verdict | `update_pull_request`, `mark_pull_request_as_ready_for_review`, `submit_pull_request_review` | |
| dispatching `agent.yml` | `dispatch_workflow` | cross-repository with `target-repo`; Actions write there |

A write that needs the result of another (the `Run` field needs the
run that `dispatch_workflow` started) is left to the next pass, which
reads the run list.

No type today:

- **Clearing a board field and archiving an item.** `update_project`
  sets values only, so `stale-lead` and `archive-done` have no handler.
  It also creates a missing single-select option instead of failing,
  which the emit side must not rely on. These two are a small handler
  to propose upstream, or a custom safe-output job in the meantime.
- **Merging to the default branch.** `merge_pull_request` is
  experimental and always refuses the default branch, so merging the
  bot's own PRs has no handler. GitHub's auto-merge, enabled by a
  custom job, is the likely answer.
- **Rebasing a PR branch**, a force push.
- **Promote.** Opening the upstream PR as cgwalters-bot with the
  operator's `Signed-off-by` on his approval of the exact head: no
  handler rewrites commits or adds a trailer, and no App can act as the
  bot's user upstream. The same holds for a summoned reply upstream.
- **Notifications**, which are a user's: no App reads or marks them.
- Gists, and editing a comment in place (the heartbeat comment, which
  goes away).

Promote, summoned replies, notifications and rebase therefore stay
where the bot's own token is, on Xenon, as a timer that needs no
session and no model (`bot-promote-due`, `bot-notify`, `bot-pr
rebase`). That token is not minted per run, so under this decision it
does not go to Actions. The sign-off never moves under any design:
`bot-pr promote` adds it only on his verified approval of the exact
head.

### Inference and usage readings

Agent runs already reach praxis from a runner: `agent.yml` joins the
tailnet with the job's OIDC identity (an OAuth client id and audience
held as repository variables, no secret). The controller's own steps use no
model. They need only the pools' usage, to pace dispatch, which is two
readings today: OpenAI's from the broker's `/usage`, and Claude's from
the statusline of the local session (`bot-heartbeat statusline`), which
a headless controller does not have. The broker holds the Claude login
as well, so it should report both; that is a change to the broker, and
then `/usage` is the one source. The controller job reads it by joining
the tailnet as `agent.yml` does, which needs the tailnet to trust
homegit's workflow identity too. Without a reading a pool is unpaced
(`bot-reconcile` already says so and holds nothing), so the pass
degrades to the per-run caps rather than stopping.

The broker itself stays on a machine of the operator's, and with it
inference for every run. "Nothing depends on a workstation session"
holds after this plan; "nothing depends on Xenon" does not, until the
broker moves to a host that is meant to be always on. That is a
separate decision and not a blocker here.

### Local state

| State | Where it is | What becomes of it |
| --- | --- | --- |
| `operator.json` | `~/.config/bot-harness`, absent on a runner | the defaults are this deployment's, except the four pacing values Xenon's file overrides (`agents`, `harness_agents`, `opencode_share`, `opencode_runs`), which the report's reconcile therefore lacks; it becomes a repository variable the job writes out, since it holds no secret |
| reconcile's action state (`--state`) | a local file | the one file the job carries over: an artifact of its previous run, restored at the start, which needs no token beyond the job's own |
| last-seen state of `bot-watch`, `bot-notify`, `bot-pr inbox` | archived draft items of the board, mirrored in `~/.local/state` | for `bot-watch` and `bot-pr inbox` it joins reconcile's state in the carried-over file: it is the pass's own memory, and keeping it off the board saves a write and a project read the job's token lacks. `bot-notify` stays local, and its state with it |
| sweep runs | `~/.local/state/bot-sweep` | the run's artifact and summary, as the read-only report does now |
| upstream-policy records | `upstream-policy/` in this repository; which remote branch of it was last accepted, and a merge-queue cache, under `~/.local/state` and `~/.cache` | the records are the job's checkout of `main`; the cache is recomputed |
| `bot-claude` and `bot-opencode` job state | `~/.local/state` | gone with local jobs: a run's state is the Actions run |
| pool readings | `~/.cache/bot-heartbeat`, `~/.local/state/bot-capacity` | the broker's `/usage` |
| the heartbeat and usage comments | tracker#176, and a private repository | derived from the run list; the usage comment is replaced by `/usage` |
| devspace SSH | keys on Xenon | not used by the controller; interactive devspaces stay a local tool |
| the status-update lock | a local lock, one publisher per project | the workflow's concurrency group |

### Runners

The controller is small (a sweep is about four minutes of API calls)
and its apply job holds a credential, so it does not belong on the CNCF
runners, which are for CNCF projects and run the agents. A public
repository's standard hosted runners cost nothing and are where the
read-only report runs; that is enough for both jobs of the pass. Agent runs stay
where they are until the self-hosted runners of tracker#287 exist; the
controller can follow them there, which would also put it on the
tailnet without federation.

### Migration order

Each step leaves a working system, and the local controller keeps
running until the step that retires its part.

0. **The read-only report** (done): the observing half, hourly, no
   credential. It shows what a runner sees and what it cannot.
1. **The App** (the operator): created, installed and its key stored,
   as listed under [Credentials](#what-the-operator-sets-up). Nothing
   changes behavior yet. Meanwhile the tools learn the App's login
   next to the bot's, and the epic board moves to the organization.
2. **Emit and stage.** The tools grow `--emit`, and the report
   workflow gains the apply job with every type `staged`: it mints the
   token, runs gh-aw's handlers and prints what they would write. The
   read job stays on its own `GITHUB_TOKEN`, hourly because of that
   token's quota. The staged output is compared with what the local
   sweep wrote in the same hour; fix what differs. This also settles
   the *not tried* points.
3. **Full cadence and usage readings.** The read job gets a read-only
   token from the App for its quota, then runs every 10 minutes and on
   events. The broker reports both pools, and the tailnet trusts the
   controller job.
4. **Move the writes that cannot race first**: the ones keyed on forge
   state and idempotent, in this order, each for a few days before the
   next: `closed-not-done`, `fill-org` and `handback`, the status
   update, then reconcile and dispatch. Each moves by taking `staged`
   off its type in the same change that turns its step off locally (a
   flag in the sweep's configuration), so that exactly one side owns
   it. `stale-lead` and `archive-done` wait for a handler.
5. **Apply agent runs in their workflow** (step 5 of
   agent-runtimes.md, on `agent.yml` as it is): its `Safe outputs`
   job takes gh-aw's scripts from the action, and an apply job with
   the App token opens the draft PR. `bot-runs apply` and
   `vendor/gh-aw/` go.
6. **The dispatcher as an agent run**, emitting the same types,
   started by the controller when actions remain.
   `bot-supervisor.service` is then stopped for good, which also ends
   tracker#400.
7. **Escalations as agent runs**, as described above. The coordinator
   session becomes optional.
8. **What is left locally** is the timer for what has no type and no
   mintable token: promote, summoned replies, notifications, rebase.

How the two avoid acting twice, until step 6 ends the overlap: no
action is ever enabled on both sides (step 4); the steps that are
moved are idempotent on forge state, so a double run during a mistaken
overlap sets a field to the value it has; dispatch is guarded by the
`dispatch` label, removed before dispatching, and by the per-item
concurrency group of `agent.yml`, so two controllers cannot start two
runs for one item; and a type stays `staged` until its step comes.

## Open points

Where the broker lives once nothing else needs Xenon. Whether
`projects_v2_item` is an Actions trigger, to be checked at step 2 of the
plan. Whether the App's login can stand in for the bot's everywhere the
tools compare logins, to be found by the staged run at step 2.

Who authors a commit that `create_pull_request` makes: by default
gh-aw recreates it through GitHub's API, signed and authored by the
App, while `bot-git check` and promote expect the bot's `+llm`
address. Whether `signed-commits: false` keeps the patch's author is
not tried.

How gh-aw's threat-detection job, which runs a model, gets inference
when praxis is the only holder (also open in agent-runtimes.md). The
hand-written pass has no such job, since no model produced its items.

Trust is of an issue's author, not of whoever edited it last: a dispatched brief is read from the live issue, but an edit by a third party to the operator's issue is not detected. Tighten that if edits by others become common.

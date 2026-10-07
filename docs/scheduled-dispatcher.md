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
and runs `bin/bot-controller-report`, which is `bot-sweep --read-only`
followed by `bot-reconcile` without `--apply` or `--state`. The report
(each step's status and output, the sweep's problems, the reconcile
actions) is the job summary and the `controller-report` artifact. It
exists to be compared with the local sweep under
`~/.local/state/bot-sweep/runs` before anything that writes moves.

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

This order is the protocol's GitHub instance, and its steps are what
any forge's would be: observe with read access (0), a write credential
that only the apply job holds (1), writes emitted and staged before any
is applied (2), the full cadence (3), the writes moved one kind at a
time (4), agent runs applied by the same job (5), judgment as agent
runs (6, 7). What changes per forge is in [The forge](#the-forge): who
mints the token of step 1, what applies in steps 2 and 5, and which
events can wake step 3. On GitHub nothing in the order changes.

How the two avoid acting twice, until step 6 ends the overlap: no
action is ever enabled on both sides (step 4); the steps that are
moved are idempotent on forge state, so a double run during a mistaken
overlap sets a field to the value it has; dispatch is guarded by the
`dispatch` label, removed before dispatching, and by the per-item
concurrency group of `agent.yml`, so two controllers cannot start two
runs for one item; and a type stays `staged` until its step comes.

## The scheduler in Rust

Status: **proposal** for the operator's decision
([tracker#405](https://github.com/cgwalters-forge/tracker/issues/405)),
written 2026-10-06 from the code at ea3f5e5. He asked for it in these
words: "biggest thing is to clean up slop on our harness. We should have
a really nice agent-run style thing. Decoupled from our scheduler which
is a giant organically grown mess. Needs a clean Rust rewrite". Then,
the same day, he said what the rewrite is really about:

> The main thing I'm thinking about for this rewrite is basically again
> around the paper clip comparison like best practices for having a
> coordinator agent interact with a human and delegate work to sub
> agents whether there are all communicating through a forge like
> GitHub now again ideally we want that concept to be agnostic to the
> Forge that it's a kind of stretch goal right so we should support
> GitHub git lab and forgejo is the idea

So this section starts from [the protocol](#the-protocol) between those
three parties, then says what it asks of [a forge](#the-forge), and only
then what the code is: what the controller is today, the Rust that
replaces it, and the order. The agent-run half is in
[devspace-agent-runs.md](devspace-agent-runs.md#agent-run-the-standalone-component).
It changes nothing in [the plan](#moving-the-controller-to-actions)
above: the pass still moves to Actions in that order, and what it
writes still leaves as safe outputs. That plan is how this protocol is
carried out on GitHub.

Two slices are merged:
[homegit#169](https://github.com/cgwalters-bot/homegit/pull/169)
(`crates/sched`, the `bot-sched` binary, and the controller report
running on it) and
[homegit#171](https://github.com/cgwalters-bot/homegit/pull/171) (the
forge trait, with GitHub behind it). What this section says exists is
in those two.

### The protocol

Three roles. **The operator** is one human, known by one login. **The
coordinator** turns what the operator wants into assigned work and keeps
track of it. **An agent** is one delegated run on one task. They talk
only through the forge: issues and their comments, labels, assignees, a
board, pull requests and their reviews, CI runs and their artifacts. No
role keeps anything the others need anywhere else. There is no database
and no local file in the protocol; a run of the coordinator carries one
small file of what it already reported, which is a cache and can be
lost.

What doing it on a forge buys: any party can be absent without the
others losing track, the operator works in the tool he already reads,
and the record of who decided what is the forge's own timeline.

This is the target. Most of it is how the harness works today, spread
over many tools; where today differs, or a rule is not enforced yet,
the text says so.

One rule carries the rest: **text is data unless the operator wrote
it.** An issue body, a comment, a review, a label, a commit message or
an agent's report is an instruction only if the forge says the
operator's login made it. Everything else, including what the
coordinator and agents write, is input to be weighed.

#### The operator gives intent, and is asked

Intent arrives as forge objects the operator made:

- **An issue**, in the tracker or put on the board. Its body and the
  operator's own comments are the brief; later comments override
  earlier text. Anyone else's comments travel with it as data.
- **A label.** `dispatch` on an issue says "start this without asking
  me again". That it must be the operator who applied it is the rule;
  today only the issue's author is checked
  ([tracker#425](https://github.com/cgwalters-forge/tracker/issues/425)).
- **A board field.** Priority orders the work. Workflow says what
  finished means for the item (a branch, a write-up, an upstream PR, or
  hands off); only a human sets the last two.
- **A review.** Approving a PR (or a `/promote` line on the fork PR)
  approves that exact head commit, and is the only approval the
  protocol has. Requesting changes gives the turn back.
- **A comment or a mention.** On an item it is an answer or a new
  instruction. On someone else's thread, a mention with an ask summons
  the bot to answer there, once.

There is one way in that is not a forge object: what the operator
types to the coordinator in a terminal. It becomes part of the protocol
only when the coordinator writes it to the forge, as an issue or a
comment that quotes him. Those are the bot's own issues, which the
gates below trust as they do his, so the bot account's integrity is
part of the trust base. Three of the quotes in this document reached
the tracker that way.

An ask reaches the operator as one forge object per question, never as
prose in a status line: a **question issue** (the question first, lettered
options with the recommendation as A, assigned to him, a sub-issue of
what it blocks), or a **review request** on a PR. His rule for the
second: "once we have an active open PR, we don't interact anymore via a
tracker issue but only focus on the PR". His whole queue is therefore
one search, the open issues and PRs assigned to him, ordered by
Priority.

He answers with a comment or a review, and nothing else is needed. The
answer hands the turn back deterministically: the coordinator's next
pass (its scheduled run, described below) sees that he commented,
reviewed or approved since he was assigned, and assigns the bot
instead. No model decides whether a question was answered; a model
reads the answer afterwards.

#### The coordinator assigns and tracks

The unit of work is an **item**: an issue or PR on the board. Three
facts say where it stands, each kept once, on the forge:

- **Whose turn it is** is the assignee: the operator (it waits on
  him), the bot (a run is on it or should be), or nobody (backlog,
  parked, done).
- **Its state** is the board's Status: Todo, In Progress, Draft, In
  Review, Needs human, Done.
- **What it produced** is linked from it, in board fields: the PRs in
  Branch, a write-up in Gist, the run in Run, one line of result in
  Why.

The transitions, and what makes each. "The pass" is the coordinator's
deterministic run and "a judgment run" its agent run, both under
[What the coordinator is](#what-the-coordinator-is); "the apply job"
is the job that carries out a run's safe outputs.

| From | To | Made by | On |
| --- | --- | --- | --- |
| Todo | In Progress | the pass | the `dispatch` label, a free slot and budget: it claims the item (Lead, a token budget, the bot assigned), removes the label and dispatches one run |
| In Progress | Draft | the apply job | a run handed back a change or a write-up: a draft PR on the fork, or a gist. The operator is assigned |
| In Progress | Needs human | a judgment run | a question only the operator can answer: an ask is opened and he is assigned |
| Draft, Needs human, In Review | In Progress | the pass, then a judgment run | his answer, or changes requested by him or upstream: the pass hands the turn back, and the state follows when the item is picked up again |
| Draft | In Review | the promote step | his approval of the exact head: the PR is opened upstream, with his sign-off where the project needs one |
| any | Done | the pass | the item's own issue or PR closed or merged, and nothing it links is still open |

It relies on three properties. **Done is observed, not claimed**: an
agent saying it finished changes nothing; the issue or PR closing
does. **Every wait has an object**: an item in Needs human or Draft
has an open ask, a PR in the operator's queue, or the write-up its Gist
field links; one with none is a bug to report, not a state (the review
app reports it today, and it becomes a rule of the pass). And **the
pass is level-triggered**: it recomputes every item from the forge each
time, so a pass that was late, repeated or lost changes nothing that
the next one does not put right.

The operator's own vocabulary for this, from a review of another
project's design, is a controller's: "concrete important terms to use
here are "spec" vs "status"". Read that way (my mapping, not his): what
the operator writes is spec (the issue, its labels, Priority, Workflow,
a review), and what the coordinator writes is status (Status, Lead,
Run, Why, News, the assignee it hands back). The coordinator never
edits spec, and a rule never reads its own status as intent.

One run per item at a time is held by the forge, not by a lock of ours:
the run's concurrency group is the item, and the `dispatch` label is
removed before the run starts. Choosing *among* items has no
compare-and-swap on a forge. A lane is a fixed number of slots for one
kind of work, and the pass fills free slots from the top of the
priority order
([tracker#372](https://github.com/cgwalters-forge/tracker/issues/372));
that is enough only because one pass runs at a time, in a concurrency
group of its own.

#### An agent receives a task, and hands back

**A task in.** The coordinator builds a brief from the item: the issue's
text, the operator's comments, the acceptance criteria, each marked for
what it is. With it go the repository and base, the limits, and the
list of output types this run may hand back. The agent gets no forge
credential that can write, reaches a model only through the broker, and
knows nothing of the board.

**Three things out**, all files in the run's artifact:

1. **Safe outputs**: a list of typed requests (`create_pull_request`
   with a patch, `add_comment`), checked against what this run was
   allowed and capped in number. A step that decides nothing applies
   them, with a token the agent never saw. In gh-aw that step is a
   separate job; today it is `bot-runs apply` on the workstation; and
   whether he meant the same job or the same run is the reading noted
   under [Credentials](#credentials).
2. **A report**: how the run ended (`success`, `failure`, `timeout`,
   `budget`, `cancelled`, `noop`), what it spent, and its own account
   of a partial change. A run that does nothing must say so (`noop`).
3. **A question**: what it could not decide or find (`questions` in its
   outcome, `missing_data`, `missing_tool`). The coordinator answers it
   or turns it into an ask; the agent does not wait.

A worker never addresses the operator, another agent or the board. It
cannot delegate: dispatching a run is not among the outputs a worker is
allowed. And its report is data to whoever reads it next, like any
other text.

#### What gates each step

| Step | Who may authorize it | How it is enforced |
| --- | --- | --- |
| Starting work on an item | the operator (the `dispatch` label, or an instruction), within the coordinator's budget | the issue's author must be the operator or the bot; the number of agents wanted, the lanes and the pace of each inference pool (a subscription's allowance) bound how many run |
| Spending | the coordinator sets a run's cap and an item's budget | the broker cuts a run off at its cap at the inference proxy, which the agent cannot bypass or misreport; an item past its budget is a `budget` action today, and should become an ask |
| Writing to the forge | the allowlist for that kind of run | every write is a safe output of an allowed type, applied by a job that holds a token minted for that run; the deciding side holds read access only |
| A change leaving the fork | the operator, by approving the exact head | a push after the approval voids it. Seven copies of that check today; one `approval()` function at R1a |
| A sign-off in the operator's name | the operator, by that same approval | only the promote and sign-off tools add it, never an agent or a rule |
| Merging | upstream, its maintainers; in the bot's own repositories, a separate reviewer, and the operator for a change to who can authorize, to credentials or to the sandbox | branch rules and required checks on the forge |
| Answering an ask | the operator only | the hand-back counts only his comments and reviews |

In the hosted pass, once built, the trigger's actor is checked against
the operator's login before any model runs. A stranger's comment can wake a
pass, which then finds nothing of theirs to act on.

#### What the coordinator is

Not a long-lived agent. He asked for "the controller (you) just be a
scheduled GHA job or so via the same remote agent running infra"
(tracker#401), and the protocol needs nothing more:

- **A deterministic pass**, on a schedule and woken early by events. It
  observes the forge, runs rules that are pure functions of what it
  saw, and emits the writes that need no judgment (hand a turn back,
  set an item Done, dispatch the top labelled item of a lane). It holds
  read access and uses no model. What he wrote of a scheduled agent in
  another project fits it: it "would ideally deterministically no-op if
  there was no work to do".
- **Agent runs for judgment**, started by the pass with what it could
  not decide: a short one on a cheap model that handles the routine
  kinds, and one on the strongest model for what that escalates. Each
  is a sub-agent in this protocol's own sense: a task in, safe outputs
  out. They differ from a worker only in which outputs they are
  allowed (labels, asks, board fields, a dispatch), which is why the
  rules above that say "a worker" do not bind them.

So "the coordinator" is a set of rules and two prompts. An interactive
session is still how the operator talks to it when he wants to, and
nothing waits on one.

#### Against Paperclip

Paperclip was read in its source at
[2ca0d26](https://github.com/paperclipai/paperclip/commit/2ca0d26a99c0d7e8db055b784e50b732c242b8f4)
(2026-10-06), its `docs/` and `doc/` trees included; nothing was run.
[agent-runtimes.md](agent-runtimes.md)
([homegit#156](https://github.com/cgwalters-bot/homegit/pull/156), at
72ff3a9) compares its runtime with ours and the review app's
[command-ui-design.md](https://github.com/cgwalters-forge/review/blob/main/docs/command-ui-design.md)
its interface; this compares the protocol, and corrects the first where
it has moved on.

**Where the parties meet.** Paperclip's is its own PostgreSQL and web
UI, reached by an API. GitHub appears twice: as a connection for
repository tools, git and `gh`, and as a review bot that turns mentions
and PR events into Paperclip tasks. External trackers are on its
roadmap as "on-ramps", with Paperclip staying the control plane.
Ours is the forge and nothing else. This is the difference he asked
for: "something a bit like Paperclip.ing except with an external
project tracking system"
([tracker#305](https://github.com/cgwalters-forge/tracker/issues/305)).

**Intent.** The same objects: issues (it calls them tasks), comments,
goals, assignment. A comment by the human on an agent's open task wakes
the assignee; a mention wakes nobody. *Taken*: a human's comment on the
bot's item is a wake, which is our hand-back. *Different*: a mention is
a summons for us, because our operator works in other people's
repositories where there is no item to comment on.

**Asking the human.** This is where Paperclip is ahead. An agent asks
with a typed interaction (`ask_user_questions`, `request_confirmation`,
`request_item_verdicts`, `suggest_tasks`, among others), parks the task
`in_review`, and is woken with the answer; its skill says prose alone
is not a way to wait. Formal approvals (`hire_agent`,
`budget_override_required`, `request_board_approval`, among others) are
separate records only the human can resolve. *Taken*: an ask is a typed object with options, never a
sentence in a status field, and it names what resumes when it is
answered. Ours is the question issue; the scheduler parses it into a
type (`asks` in the snapshot) instead of each tool matching its text.
*Taken*: its rule that an accepted interaction "never authorizes the
underlying action": answering a question is not an approval of a head.
*Different*: its interactions default to `resolverPolicy: anyone`,
other agents included. Ours are answered by the operator only.

**Assigning and tracking.** Seven statuses to our six, one assignee as
a hard invariant, and checkout as one conditional SQL update: a
conflict is a 409 the agent must not retry. `in_review` needs a real
reviewer path, which the server enforces. *Taken*: one assignee as the
turn, and "every wait has an object" as a rule the pass checks (the
review app reports it today; it becomes a rule in R3). *Different*: a
forge has no conditional update, so there is no checkout. A
level-triggered pass, one run per item by concurrency group, and a
label consumed before dispatch do the same job with weaker primitives;
the cost is that two coordinators at once could pick the same item,
which is why there is one.

**Delegating.** Any Paperclip agent with the permission creates a child
task for another; a run may write only to the task it checked out and
its descendants, and reports upward through a blocker being resolved or
one comment on the parent. *Taken*: a run's writes are scoped to what
it was given (our per-run allowlist of repository, base and types).
*Different*: no org chart and no agent-to-agent delegation. Only the
coordinator dispatches, so there is one place where budget and trust
are checked.

**Handing back.** A heartbeat is one bounded run, given a wake payload
and its task. The agent then calls the API itself, with its own key:
it sets the status, writes documents and attaches work products, and
must leave a comment each run. The adapter's result carries an exit
code, cost and optionally a summary or a typed question, but what the
run did to the task is whatever it wrote through the API. *Taken*: a report every run, and results as
typed links (its work products are our Branch and Run). *Different*,
and the main one: the agent holds a credential and its writes are
authorized call by call. Ours holds none; what it hands back is a file
that another job checks and applies. Its `low_trust_review` preset
moves toward the same boundary: for such an agent the one comment it
may leave on the parent task is switched off, as "a prompt-injection
carrier into higher-trust context".

**Budgets.** Dollars per agent, project or company, summed from the
cost each adapter reports. At the hard limit the server cancels the
scope's running work and pending wakes, pauses it, and opens a
`budget_override_required` approval that the human resolves by raising
the budget or leaving it paused. (agent-runtimes.md left the in-flight
cancel untraced; it is in `budgets.ts` and `heartbeat.ts`.) *To take*:
an overrun as an ask to the human with the work paused. Today it is an
action for the dispatcher. *Different*: where it is measured. Theirs is what the
agent's own process reported; ours is the proxy the tokens pass
through.

**What the coordinator is.** The CEO is an ordinary agent on
heartbeats with an instruction bundle and some authority in code. The
server does the deterministic part: a scheduler tick, a wake queue that
coalesces, reaping of orphaned runs, reconciliation of stranded tasks,
watchdogs, the budget stop. No deterministic code decides *what* to
work on; that is the agents and the human. *Taken*: all of the server's
list, which is our pass (`stale-lead`, `lead-orphan` and `heartbeat`
are the same reaping). *Different*: what is next is decided by rules
(Priority, lanes, the label), and a model is asked only where a rule
cannot say.

**Sandboxing.** Unchanged since agent-runtimes.md: local adapters run
unsandboxed on the host by default and sandboxes are opt-in plugins.

#### Against current practice elsewhere

Three projects the operator has reviewed or contributed to, each read
in its repository on 2026-10-06: gh-aw at 3fd44f8, fullsend at cb9825e,
packit/ai-workflows at 698e58f. His positions are quoted from his own
comments there; the survey that collected them is
[tracker#392](https://github.com/cgwalters-forge/tracker/issues/392).

**gh-aw** is the closest on hand-back and gates, and has no protocol
above them. An agent's output is typed items in `agent_output.json`; a
detection job and scoped write jobs follow; his summary is "the tools
you provide to the agent are read-only, then safe outputs gates
writes." It has no state machine (its docs compose queues from issue
checklists, sub-issues or a project board), no type for asking a human
(a comment, an issue or `missing_data`, the answer arriving as the next
event; that reading is mine), and its orchestrator is another LLM
workflow that calls `dispatch_workflow`. Human approval is an Actions
environment's required reviewers. *Taken*: the schema and the handlers,
as he asked on tracker#401 ("We should be able to reuse the GHA
safe-outputs code directly I think"); `noop` as a required answer; and
his
point that "agent invocations are just action runs and so existing
verbs like `concurrency` which are already well-understood and known
apply." *Different*: we add the states, the turn and the ask on top,
and the orchestrator is rules.

**fullsend** has the same sandbox boundary ("No credentials present
inside") and a deterministic coordinator of a different shape: "there
is no central orchestrator", a shim workflow dispatches agents from
labels and slash commands, and "Labels are the state machine"
(`needs-info`, `ready-to-code`, `ready-for-review`, `ready-for-merge`).
An agent asks by labelling `needs-info` and commenting; the human
replies and reruns triage. Output is validated against a schema on the
host and a post-script writes. It is the only one with a forge
abstraction (`forge.Client`, with GitHub, GitLab and Jira; Forgejo
intended). *Taken*: labels as the state where a forge has no board (see
[the gaps](#the-gaps-and-what-stands-in)), and clearing
`ready-for-merge` when a review starts, which is our exact-head rule by
other means. *Different*: we have a coordinator, because one operator's
work spans many repositories that are not ours to install a workflow
in. On whether every agent must reconcile, he wrote "Do we *really*
need that for all agents? I don't think so."; here only the pass does.
On credentials, of fullsend's central service that hands out tokens
for shared Apps, "I've come to dislike the mint and consider it a
highly privileged security risk", naming as alternatives the stock
Actions bot or to "Create their own bot app owned by their repo/org".
The App of [Credentials](#credentials) above is the second: its token
is issued by GitHub to the job, with no service of ours in between.

**packit/ai-workflows** runs the same loop against Jira and GitLab
dist-git with deterministic Python on cron: Jira labels are the state,
a fetcher swaps a trigger label for an in-progress one, triage can
return a typed `CLARIFICATION_NEEDED` that becomes a comment and a
`ymir_needs_attention` label, and the human answers and adds a retry
label. Its agents write through MCP tools directly, with human review
of the merge request as the check, and its threat model lists an agent
driven to exhaust its build and test quotas as unmitigated. *Taken*: its trigger label counts only if a member of a
trusted group applied it, verified from the issue's changelog. We check
an issue's author and not who applied `dispatch`
([tracker#425](https://github.com/cgwalters-forge/tracker/issues/425)).
His comments there are consistent with the gates above being code:
"constraints like this are better enforced in *code* than in text"
(of a working tree an agent was told not to change), and "prompt
injection is often the primary risk to anything related to LLMs".

Across the four: fullsend and ai-workflows schedule with deterministic
code and ask a model only for content, as this design does, while
gh-aw's orchestrator and Paperclip's CEO are themselves agents. Only
fullsend abstracts the forge, and only Paperclip has an ask as a typed,
assigned object.

#### What is inferred here

The operator has not stated these; they are this design's reading.

- That "spec" and "status" map onto the operator's and the
  coordinator's writes as described.
- That only the operator answers an ask. He has said who is trusted,
  not this in particular.
- That an item over budget should become an ask rather than a
  dispatcher action; taken from Paperclip.
- That who applied a label should be checked. Today's code checks the
  issue's author (`lib/dispatch.js`).
- That an issue the bot wrote from a terminal session is as trusted as
  one he wrote. Today's code treats it so.
- That "GitHub first" is the order. His words name the three forges
  and call it a stretch goal.
- That an agent must not delegate. It is true today because of which
  outputs workers are allowed, and nobody decided it.
- How gh-aw workflows ask a human, which its docs do not name.

### The forge

He called forge-agnosticism "a kind of stretch goal" and named the
forges: "we should support GitHub git lab and forgejo". GitHub is
built first because it is where everything is. He has also said what
he does not want from an abstraction, on fullsend's design: "A problem with any abstraction
layer like that is it drives to the lowest common denominator, and I
don't think we want to force that. People who know they are using a
specific forge should be able to do forge-native things", and "I'm
arguing for supporting both."

So the split is this. The snapshot, the rules and the actions name no
forge: they are the protocol. A forge is a module that implements one
trait and keeps its API, its URLs and its way of carrying out a write
to itself. The core never takes a forge's types. Where the protocol
wants something only one forge has (a project status update, archiving
a board item), it is a write that forge carries out and the others
answer as unsupported, with the reason.

#### The trait

`crates/sched/src/forge.rs` has the reading part the first rules need
(homegit#171). The whole, in the model's types:

```rust
/// Reading one forge, with read access.
pub trait Forge {
    // The board, or what stands in for one.
    fn board_url(&self) -> String;
    fn board_fields(&self) -> Result<Vec<String>>;
    fn board_items(&self, fields: &[&str]) -> Result<Vec<BoardItem>>;

    // Issues and pull requests.
    fn content_ref(&self, text: &str) -> Option<ContentRef>;
    fn content_state(&self, content: &ContentRef) -> Result<ContentState>;
    /// Body, author, labels with who applied each, assignees, comments.
    fn thread(&self, content: &ContentRef) -> Result<Thread>;
    /// Head, base, draft, mergeable, reviews (who, verdict, when, and
    /// on which commit if the forge records one), requested reviewers,
    /// checks.
    fn pull(&self, content: &ContentRef) -> Result<Pull>;
    fn children(&self, content: &ContentRef) -> Result<Vec<ContentRef>>;

    // Agent runs: CI runs of one kind since a time, each with the id
    // its caller gave it.
    fn runs(&self, kind: &RunKind, since: Timestamp) -> Result<Vec<Run>>;
    fn artifact(&self, run: &RunId, name: &str) -> Result<Vec<u8>>;
}

/// What the forge wants one user to look at. Apart from `Forge`: it
/// needs that user's own token, which no job can mint.
pub trait Inbox {
    fn notifications(&self, since: Timestamp) -> Result<Vec<Notification>>;
}

/// How writes leave. A forge has up to two: one that writes a file for
/// a job that holds the token, and one that writes directly, for a tool
/// a person runs with a token of its own.
pub trait Outbox {
    fn send(&self, writes: &[Write]) -> Result<Sent>;
}
```

A `Write` is the protocol's, not a forge's: set or clear a field, add
or remove a label, comment, open an issue under a parent, assign, open
or update a pull request, request a review, archive, post a status
update, dispatch a run with a task. An outbox that cannot carry one out
says so with a reason in what it returns (`Emitted::unsupported` does
this today for clearing a field); nothing is dropped silently.

Three things are deliberately not in the trait. Logins: who the
operator and the bot are is configuration, not something a forge can
say, and a job's token is neither. Tokens: a `Forge` is built with read
access and an `Outbox` with whatever its job was given, so which token
a step holds is the workflow's to say. And a second forge: a snapshot
is of one. A link to an issue or PR on another forge is not a reference
and is dropped, as a URL that is not GitHub's is today; several forges
in one pass is not designed.

How a run gets its caller's id is the forge module's business: on
GitHub it is in the run's name, which the listing returns. An approval
without a commit (GitLab's) is no approval of an exact head, so
`approval()` answers no there and promote stays off; see the gaps.

Each forge's transport stays its own. GitHub's is REST by path with
recordings by path, which is where conditional requests and replaying a
real board belong; another forge would bring its own, and the
forge-neutral fixture is a saved snapshot.

#### What each concept maps to

Checked on 2026-10-06 against GitLab's documentation at master (19.5)
and Forgejo's at v16.0 with the swagger of 16.0.5. "Premium" is
GitLab's paid tier and above. Nothing here was tried against a running
instance.

| Concept | GitHub (built) | GitLab | Forgejo |
| --- | --- | --- | --- |
| Issues, comments | REST issues and comments | Issues and Notes APIs | issues, comments, timeline |
| Closed as done or not planned | `state_reason` | no reason on an issue; work item Status is Premium | none |
| Parent and child issues | sub-issues | child tasks, GraphQL only; issue links over REST (`blocks` is Premium) | none; dependencies (`/dependencies`, `/blocks`) |
| Labels | labels | labels; scoped `key::value` is Premium | labels; exclusive `scope/name` |
| The turn (assignees) | several | one on Free, several on Premium | several |
| Board with typed fields | Projects v2 over REST | boards of label lists over REST; custom fields and status are Premium and GraphQL only, with no date type | projects exist in the UI only: **no API** (a first [pull request](https://codeberg.org/forgejo/forgejo/pulls/14723) is open) |
| Status updates | project status updates | none | none |
| Pull requests | pulls | merge requests | pulls |
| Review on an exact commit | a review has `commit_id` | approving takes a `sha` and fails unless it is the head, but the recorded approval has none; "changes requested" is a reviewer state, not a review; resetting approvals on push is Premium | a review has `commit_id` and `stale` |
| Auto-merge, rebase | yes | `auto_merge`; the merge method is the project's | `merge_when_checks_succeed`, `Do: rebase` |
| CI runs and artifacts | Actions runs, artifacts | pipelines, jobs, job artifacts | Actions runs (v12), artifacts (v16) |
| A run's summary page | job summary | none found | not documented |
| Dispatch a run with inputs | `workflow_dispatch` | create a pipeline with `inputs`, or a trigger token | workflow dispatch with `inputs`, returning the run |
| A reusable unit | `workflow_call` | CI/CD components, `include`, downstream pipelines | `workflow_call` (its `secrets` key is [rejected](https://codeberg.org/forgejo/forgejo/issues/14674)), composite actions |
| Waking on an event | `issue_comment`, `issues`, `pull_request_review`, `schedule` | schedules only; a pipeline has no issue, comment or approval source, so a webhook must call the trigger URL | `issues`, `issue_comment`, `schedule`; no `pull_request_review` ([issue](https://codeberg.org/forgejo/forgejo/issues/14548)) |
| Notifications | notification threads | the To-Do list | notification threads |
| A bot identity | a user, or an App | a service account, or a project or group access token's bot user (paid on GitLab.com) | a user with scoped tokens |
| A write token minted per run | an App installation token | none: `CI_JOB_TOKEN` cannot write issues, notes or merge requests | Authorized Integrations (v16): the API takes a job's own JWT, bound to a repository, workflow, ref and event, with token scopes |
| A job's OIDC identity | `id-token: write` | `id_tokens:` | `enable-openid-connect` (v15) |

#### The gaps, and what stands in

**Projects v2 fields.** The board is the operator's main view, and
neither other forge has it as an API on its free tier. What stands in
is two things every forge has: the single-selects (Status, Priority,
Workflow) as exclusive labels (`status/draft` on Forgejo, `status::draft`
on GitLab Premium, plain labels kept exclusive by the pass on GitLab
Free), and the text and number fields (Lead, Run, Branch, Why, News, the
budgets) as one marked block in a comment the bot keeps on the item.
`board_items` is then a search for labelled issues plus a comment each,
which is a request per item where GitHub needs one for the board; the
operator's queue is a search by assignee and label, which both forges
have. They lose a sortable table and gain label noise. On GitLab
Premium the native custom fields are the better implementation, behind
the same trait. This is a design, not code (decision J; a read-only
Forgejo pass to try it is
[tracker#426](https://github.com/cgwalters-forge/tracker/issues/426)).

**Status updates.** No equivalent. A comment on one pinned issue stands
in, or nothing does.

**Safe-outputs handlers.** gh-aw's handlers are JavaScript that runs in
Actions against GitHub's API. Their input is not: `agent_output.json`
is a plain schema. His position, on fullsend: "Forge agnostic I think
does really want a `generic-safe-outputs` tool that has its own
dedicated backends for gitlab/forgejo/etc", and of gh-aw's code that
"it should be feasible to actually reuse the implementation code (mostly
in Go) and this also means we reuse the *exact same schema*." What
carries over is the schema and the validation. The handlers that write
are the part that cannot: they are scripts run by Actions'
`github-script` against GitHub's API (the Go he mentions is gh-aw's
compiler and CLI). So off GitHub the applier is a direct `Outbox`
behind a small command of ours, which reads the same file and writes
through that forge's API, in a job apart from the one that decided. On
GitHub gh-aw's handlers stay, as he asked on tracker#401. Types only GitHub has (`update_project`,
`create_project_status_update`) are forge-native: the scheduler emits
them there and the stand-in's labels and comment elsewhere. Unsolved:
gh-aw's threat-detection job has no counterpart, and whether its
validator (`collect_ndjson_output.cjs`) runs unchanged outside Actions
is not tried (decision K,
[tracker#427](https://github.com/cgwalters-forge/tracker/issues/427)).

**A token minted per run.** GitHub's App installation token is what
keeps a long-lived write credential out of CI. Forgejo's Authorized
Integrations is close, and stores no key at all: the apply job's own
identity token is the credential, scoped by configuration (read, not
tried). GitLab has
nothing like it: the job token cannot write what the protocol writes,
so the apply job would hold a stored access token of a bot user. That
is weaker than what he decided for GitHub, and is unsolved rather than
accepted.

**Actions OIDC for the broker.** Both forges issue a job identity
token, so the mechanism carries over. The claims do not: the broker
admits a run by GitHub's `job_workflow_ref`, and each forge names the
workflow and ref in claims of its own. The broker's policy needs an
issuer and a claim mapping per forge, which is not written. Joining a
tailnet with such a token off GitHub is unverified.

**Reusable workflows.** `workflow_call` is GitHub's packaging, with a
Forgejo equivalent and a different thing on GitLab. So the portable
unit of agent-run is its binary in a container, and each forge gets a
thin wrapper around it (decision B). This also fits what he has said
about other forges: "I have a somewhat strong opinion that generic
forge support is actually going to best done by encouraging agent
execution inside a Tekton pipeline or so." His stated preference there
goes further than a wrapper per forge's CI: to "target Tekton as a
baseline, which would drop the abstractions". A container is what a
Tekton task runs, so this keeps that open without choosing it; that
reading is mine.

**Events.** GitLab cannot start a pipeline from a comment or an
approval, and Forgejo cannot from a review. The schedule covers both,
since the pass is level-triggered and an event only makes it sooner. On
GitLab a project webhook can call the pipeline trigger URL itself, with
no relay to run.

**An approval of an exact head.** This is the protocol's one approval,
and on GitLab an approval records no commit. Approving with a `sha`
guards the moment of approval, not what is read back later, and
removing approvals on a push is a paid setting. Comparing the approval
time with the last push might do; it is not verified, and this is
where a sign-off comes from. So no promote or sign-off on GitLab until
it is solved.

**Smaller ones.** No sub-issues on Forgejo: an ask names what it
blocks in its body and with a dependency. No close reason outside
GitHub: a label. No job summary: the report is an artifact only.

#### agent-run stays forge-neutral

By construction it should: a task in, safe outputs out, and nothing
about boards or asks. Its interface is agentic-job's
([devspace-agent-runs.md](devspace-agent-runs.md#agent-run-the-standalone-component)
points at its plan), which lists what its binary still knows of GitHub:
the identity-token request for a proxy that wants proof, the clone URL,
and the check that the target is public. What it hands back needs no
change: the types a worker is allowed
(`create_pull_request`, `add_comment`, `noop`, `missing_tool`,
`missing_data`) carry a patch, text and a target, with nothing of
GitHub in them but their names.

On a forge with no gh-aw its output is applied as above: the same
file, that forge's `Outbox`, in a job of its own. agent-run does not
change.

#### The first slice, checked

`crates/sched` as merged in homegit#169 had a `Forge` trait, but it was
GitHub's REST API by path, and GitHub was in the core:

- the snapshot held a Projects v2 reference (`orgs` or `users`, a
  number) and built `api.github.com` paths from it;
- an issue or PR was a `ContentUrl` that parsed only `github.com`
  URLs, and a saved snapshot was read back through that parser;
- `observe` decoded GitHub's JSON (`node_id`, `merged_at`, a
  single-select's `name.raw`);
- `action` held gh-aw's `update_project` next to the rules' own types.

homegit#171 moved all of that behind the trait, as `forge::github`. The
snapshot's schema is v2: the board is a URL and a reference is data
(`ContentRef`) that only a forge makes from text. Which field means
what stays in `observe`. A test runs a pass over an in-memory forge
with a nested group and merge-request URLs, and another fails if the
core's sources name GitHub.

What is still GitHub-shaped, each with an issue:

- **Writes have no seam.** `Outbox` is not built, nor `Inbox`; `emit`
  is a function of the GitHub module that the command line and the
  report call by name ([tracker#423](https://github.com/cgwalters-forge/tracker/issues/423)).
- **The operator config** names a `forge_org` and a board by
  `owner_type`, `owner` and `number`, and has no place to say which
  forge or where it is
  ([tracker#424](https://github.com/cgwalters-forge/tracker/issues/424)).
- **`board_items` must come with each item's state**, which is free on
  GitHub and a request per item elsewhere. It is the right contract for
  a pass that reads once; a forge that pays for it should fail an item
  softly, as linked PRs already do. Part of tracker#408.
- **A reference's key is its lowercased URL**, on the belief that
  every forge ignores case in owner and repository names. That is
  checked for GitHub only.
- `report` and `parity` run GitHub-only tools that are not ported, and
  go with them.

### What is there today

`bin/` has 52 files and about 25,900 lines; `lib/` has 21 and 4,200;
`tests/` has 20,500. Twelve of the 52 are the operator's own git and
rpm helpers from 2010 to 2021, which no harness code calls; they are
left out below and stay as they are. Every other tool was read, with its
callers found by grep, for the table; a `lib/` file not named goes
with the tool that uses it. "Scheduler" means it becomes part
of the Rust below; "agent-run" that it belongs to the other half;
"neither" that it is a tool for a person or an agent at a terminal.

| Tool (lines) | What it is | Verdict |
| --- | --- | --- |
| `bot-reconcile` (547), `lib/reconcile.js` (800) | observes, runs 11 rules, applies 4 of them | scheduler: the model to keep. The rules are already pure functions of an observed state |
| `bot-watch` (1,493 bash) | per-URL change detection over the board, and the runner of seven other steps | scheduler, rewritten as one observation: see below |
| `bot-sweep` (602), `bot-poll-loop` (401 bash), `bot-supervisor` (281) | the timer's pass, the wait for news, the loop that starts a dispatcher | not carried over: the workflow run is all three |
| `bot-board` (2,010 bash), `lib/assignees.js`, `board-status-update.js`, `board-archive-done.js` (860) | the board's fields, tracker issues and asks, and a key-value store in archived draft items | scheduler: the typed model and the `bot board` verbs. The key-value store goes |
| `bot-pr` (3,273 bash), `bot-promote-due` (674), `bot-signoff-due` (244), `dco-detect.sh`, `review-state.sh` | fork PRs, promote, sign-off, rebase, inbox | scheduler, last and reviewed by the operator: it holds the sign-off rules |
| `bot-runs` (1,720 bash), `lib/run-watch.js`, `run-health.js` (402) | dispatch, apply, show, and moving the board when a run ends | split: dispatch, reconcile and watch are scheduler; apply goes (gh-aw's handlers); show, log and diff are agent-run's |
| `bot-capacity` (319), `bot-pace` (158), `lib/pools.js`, `pacing.js`, `capacity.js`, `budget.js` (837) | pool pace and budgets | scheduler: pure math, ported with its tables |
| `bot-priority-health` (521), `bot-drive` (414), `bot-priority-propagate` (368) | P0 and P1 PR health, and next steps | scheduler, as rules over the snapshot |
| `bot-notify` (1,273 bash), `bot-operator-activity` (444) | the bot's notifications, and the operator's events classified by a model | scheduler; stays on the workstation with the bot's token (step 8 of the plan). The model call leaves the pass |
| `bot-heartbeat` (1,075), `lib/heartbeat-register.js` (186) | the liveness comment the review app reads | not carried over: derived from the run list, once the review app reads that |
| `bot-cost` (876), `bot-actuals` (96), `bot-footer` (221) | token cost from transcripts and runs, written to the board and PR footers | scheduler, small: read from run summaries |
| `bot-land` (486), `bot-git` (800 bash), `upstream-policy` (858), `bot-review-guide` (450) | landing on the bot's own repositories, the bot's git identity and commit lint, the upstream policy gate, review guides | scheduler's `bot` verbs. `bot-git rework` and the policy gate are security sensitive |
| `bot-claude` (805), `bot-opencode` (583), `bot-work` (276 bash) | three ways to run a local agent job, sharing almost nothing | not carried over: a worker is an agent run. They stay until step 7 of the plan |
| `bot-devspace` (769 bash) | interactive devspaces over SSH | neither: an operator's and agent's tool. It belongs with the devspace repository's own Rust (`devspace.rs`) |
| `bot-retro` (928), `bot-feedback` (382 bash), `bot-tmt-number` (611), `dco-signoff` (550 bash) | transcript mining, reaction scanning, bootc's test numbers, the operator signing off by hand | neither. `bot-tmt-number` is one upstream project's and should not be in the core; `dco-signoff` is superseded by `bot-pr signoff` |
| `bot-operator` (94), `lib/operator.js` (309), `operator.sh`, `gh-http.sh` | the operator config for Node and for shell, and a shell HTTP helper | go with their last caller; the loader in `crates/sched` is the one that stays |
| `bot-board-migrate` (538 bash), `install.sh` | a finished one-off whose header says to delete it; a byte-for-byte copy of `install-dotfiles.sh` | delete |
| `crates/bot-poll` (5,028 Rust, 1,078 of tests) | a poller that parses the text reports of `bot-watch`, `bot-notify` and `bot-pr inbox` | not carried over: see below |

What is wrong with it, plainly:

- **The interface between tools is prose.** `bot-watch` prints a report
  for people, and `bot-poll-loop` (grep, sed, awk), the `drive` rule,
  `bot-supervisor` and all of `bot-poll` parse it back; its source has
  "keep the wording" comments for that reason. `bot-sweep` reads its
  children's results with regular expressions on their stdout.
- **`bot-poll` runs nowhere.** CI builds and tests it; no unit, tool or
  workflow starts it, and it is not installed on the workstation. Most
  of its 5,000 lines parse those reports.
- **One decision, many copies.** "The operator approved this exact head"
  is implemented seven times (a jq string in `bot-pr`, twice; JavaScript
  in `bot-promote-due`, `bot-signoff-due`, `bot-drive` and `bot-land`;
  Rust in `bot-poll`). An issue or PR URL is parsed by at least twelve
  regular expressions, the operator's login compared in eight places
  with two case rules, ETag caching written seven times, an atomic file
  write about twenty, the operator config loaded by three loaders. The
  review app copies the ask format and the verdict rules a further time,
  and says so in its comments.
- **Executables are libraries.** Six tools `require` `bin/bot-priority-health`
  for its REST helpers; `bot-heartbeat` requires `bin/bot-cost`, and
  `lib/heartbeat-register.js` requires `bin/bot-heartbeat` back.
- **Logic lives in shell.** Six bash tools hold 10,170 lines, with jq
  programs as strings. `bot-pr` decides sign-offs there.
- **The tests mostly test a mock.** About 70% of the real test files
  check a tool against a hand-written `gh` stub, a bash heredoc of 40
  to 180 lines per test; about 10% test a pure function. 29 of the 57
  `.sh` tests are eight-line wrappers around `node --test`.
- **The board is read, thrown away and read again.** The board's REST
  listing carries every item's issue or PR whole (state, head, labels,
  assignees, requested reviewers, when it changed). `bot-board` keeps
  the fields and drops that; `bot-watch` then asks for each of about 360
  URLs again, about 200 seconds a sweep, and keeps its own state file
  for them.
- **Dead code**: `bot-board draft` only prints an error; `bot-board
  assign-migrate`, `bot-priority-propagate --dedupe` and the legacy-state
  paths in `bot-pr`, `bot-watch` and `bot-notify` are finished
  migrations; grep finds no caller for `bot-pr repo-kind` and
  `refresh-meta`.

### Layout

One crate, `crates/sched`, a library and two binaries:

- **`bot-sched`**, the unattended pass: `observe`, `reconcile`, `emit`,
  `report`, and `pass` for all of it. It is what the controller workflow
  runs, and it never writes to the forge.
- **`bot`**, the verbs a person or an agent types: `bot board ...`, `bot
  pr ...`, `bot land`, `bot git check`. It replaces the `bot-*` tools
  that are commands rather than steps, over the same library, and is the
  only place that writes with a token of its own.

The library's modules, each with one job: `operator` (the config;
there since the first slice), `model` (the snapshot), `observe`,
`rules` (a file per rule), `action` (actions and writes), `pace` (pool
math), `approval` (the exact-head rule, once) and `markers` (every
hidden marker and body format the review app reads, as types). None of
those names a forge. `forge` holds the traits of
[The trait](#the-trait) and one module per forge under it:
`forge::github` has the REST client, the board's decoding, URL parsing,
the gh-aw form of a write and, for the workstation, the direct writer.
Two binaries and one crate are enough; `bot-poll` leaves when
`bot-poll-loop` does, its ETag cache moved into `forge::github`.

It stays in homegit while the old tools exist, because each step below
deletes its original in the same commit, and moves to a repository of
its own once nothing in `bin/` is left (decision C).

### The model

A pass reads the forge once into a **snapshot** and nothing after that
touches the network. It is the protocol's state as one value, and holds
nothing a forge would recognize as its own: an issue or PR is a
reference the forge made (its URL, repository, kind and number), an id
is an opaque string. `crates/sched/src/model.rs` has the start of it;
the whole is:

- **items**: a board item with its typed fields (`Status` as an enum
  that keeps an unknown option as data, `Priority`, `Lead`, `Run`,
  `Branch` as parsed PR URLs, `Why`, `News`, `Workflow`, the token
  fields) and its **content**: the issue or PR with its state, head
  commit, labels with who applied them, assignees and requested
  reviewers. On GitHub all of it but the label events comes with the
  board listing.
- **pulls**: for the PRs the bot drives, the reviews (who, what, on
  which commit, when), checks, mergeability and base. `approval(pull,
  operator)` is the one function that says whether the operator
  approved the exact head.
- **runs**: the agent runs, with their caller id (the item), state,
  and the summary of the ended ones.
- **asks**: question and chore issues, parsed into a type: what each
  blocks, its options, who must answer, whether and how they did. An
  item that waits with no ask and no PR in the operator's queue is
  found from this.
- **pools**: each inference pool's usage and reset, from the broker's
  `/usage`, with its target from the config.
- **policies**: the upstream-policy record of each repository, from the
  checkout.
- **now**. The time is part of the snapshot, so a rule that asks how
  old something is stays a pure function, and a recorded snapshot gives
  the same answer tomorrow.

What cannot be read is not guessed: the snapshot marks it unknown and
lists it as a problem, and a rule treats unknown as "do nothing" (the
first slice's `linked` states work this way).

### The loop

```
observe(&dyn Forge, config) -> Snapshot
reconcile(&Snapshot, &Config) -> Vec<Action>      // pure: every rule is fn(&Snapshot, &Config) -> Vec<Action>
edge(&State, &[Action], now) -> (fired, State)    // pure: which actions are news
outbox.send(&[Write]) -> Sent                     // to a file for the apply job, or directly for a tool with a token
```

An **action** has a stable key, a kind, the item, what to do in a
sentence, and optionally a **write**: `SetFields`, `ClearField`,
`AddLabels`, `RemoveLabels`, `Comment`, `CreateIssue`, `Assign`,
`Archive`, `StatusUpdate`, `Dispatch`. A write says what the protocol
wants changed, in its own terms. An action with a write needs no
judgment. One without is for a reader: in the target, the input of the
dispatcher's agent run.

A write leaves in one of two ways, each an `Outbox` of the forge. In
Actions, GitHub's emitting one turns writes into gh-aw safe-output items
(`update_project`, `add_labels`, `dispatch_workflow` and the others in
"What the writes become"), which the apply job's handlers carry out
under the App token; the pass holds read access only. On the
workstation during the migration, its direct one makes the same writes
with the bot's token.
A write with no safe-output type (clearing a field, archiving; see "No
type today") is reported as such and applied only directly, until a
handler exists. The first slice already emits `update_project` items
for `closed-not-done` and reports `stale-lead`'s clear as having no
type; `Outbox` itself is
[tracker#423](https://github.com/cgwalters-forge/tracker/issues/423).

### Crates

- **HTTP**: for GitHub, `ureq` 3, synchronous, with a thin client of
  ours inside `forge::github`: REST by
  path, pagination, ETags, GitHub's refusals as typed errors, and a
  plain POST for the few GraphQL queries REST lacks (only on the
  direct-apply side; observing is REST only, since the GraphQL quota is
  shared). Not `octocrab`: it brings an async runtime for a job that
  makes a few hundred requests in sequence, has no Projects v2 REST
  types, and hides the transport, which is exactly where conditional
  requests and recording belong. Not `gh`: parsing `gh api -i` output,
  as `bot-poll` does, is the kind of thing this rewrite ends. Fan-out
  where needed is `std::thread::scope`. Another forge's module picks
  its own when it is written; there is no forge-neutral Rust client to
  adopt (`forgejo-api` and `gitlab` are per forge, and the Forgejo
  community's F3 is a data format for mirroring with no Rust
  implementation).
- **Data, CLI, errors**: `serde`, `clap` derive, `anyhow`, as `bot-poll`
  uses; typed errors only where a caller branches (a spent quota).
- **Time**: `jiff` for new code; `chrono` leaves with `bot-poll`.
- **Config**: `operator.json` through the loader now in `crates/sched`;
  in Actions the file is written from a repository variable, as the
  plan says. No config framework.

### Tests

Four kinds, none with a network or a fake `gh`:

- **Rule tables**: `(snapshot, expected actions)` rows, the form
  `lib/reconcile.js`'s tests already have; each port carries its table
  over.
- **Recorded passes**: `bot-sched observe --record FILE` saves GitHub's
  answers by path, and `--recorded FILE` replays them, so a real board
  that misbehaved becomes a fixture. A path outside the recording is an
  error, so a test cannot read more than it shows. Recordings are a
  forge module's own; the fixture every forge shares is a saved
  snapshot.
- **Neutrality**: a pass over an in-memory forge whose references look
  like another forge's, and a check that the core's sources name no
  forge (`tests/neutral.rs`).
- **Parity while two copies exist**: a ported rule's old copy stays
  until its write moves, and `bot-sched parity` runs both on one board
  (in CI on the recorded one, hourly in the report on the live one).

Formats the review app parses get shared case files that both sides
test, as `tests/fixtures/operator/cases.json` already is for the config.

### What stays outside Rust

The workflow YAML, kept to steps that call a binary. gh-aw's safe-output
handlers, which are upstream's JavaScript, reused and pinned, by the
operator's decision. Skills and prompts. The upstream-policy records,
which are data. The operator's own tools in `bin/`. Nothing else: the
remaining shell is under ten lines or goes.

### Order

Each step lands with its original deleted and its callers switched.
Sizes are of new Rust: S under 300 lines, M under 1,000, L under 2,500.
"Parallel" means separate remote agent runs can do them at once, since
they touch different files but for one line in a registry.

| Step | What | Deletes | Size | When |
| --- | --- | --- | --- | --- |
| R0 | crate, config, board snapshot, two rules, emit, the report | `bot-controller-report` | M | done |
| R1 | the forge trait: reading behind `Forge`, GitHub in `forge::github` | nothing | M | done (homegit#171) |
| R1a | `forge::github` complete (ETags, typed refusals, GraphQL POST); `thread`, `pull` and content details in the trait and the snapshot; `approval()` with a shared case file | nothing yet | M | serial, first |
| R1b | writes behind `Outbox`; the operator config says which forge | nothing | S | parallel with R1a |
| R2 | the binaries reach the workstation (decision D) | the `install-crates` hand step | S | serial |
| R3 | the rules, one per run: `heartbeat` and `lead-orphan`; `escalate`, `patch-ready` and `answer-unapplied` (with `asks`); `midstream`; pool pace and `capacity` (`pools.js`, `pacing.js`, `capacity.js`, `bot-capacity`); `dispatch` (the brief and its trust check, with who applied the label); a wait with no object; an item over budget as an ask | each rule's JavaScript, then `bot-reconcile` | S to L each, about 3,000 in all | parallel after R1 |
| R4 | `bot board`: list and show on the model, then the writes and asks | `bot-board`, three `lib/` files, `bot-pace`, `bot-board-migrate` | L | parallel with R3 |
| R5 | change detection as a diff of two snapshots; health and drive as rules | `bot-watch`, `bot-priority-health`, `bot-drive`, `bot-priority-propagate`, `bot-poll-loop`, `bot-sweep`, `crates/bot-poll` | L | serial, after R3 |
| R6 | runs in the snapshot; `Dispatch` as a write | `bot-runs` (its apply goes at step 5 of the plan), `lib/run-watch.js` | M | after agentic-job's cutover (step 9 of its plan) |
| R7 | `bot pr`, promote and sign-off on `approval()`; `bot land`, `bot git` | `bot-pr`, `bot-promote-due`, `bot-signoff-due`, `bot-land`, `bot-git`, `dco-detect.sh` | L, twice | serial, last, each PR reviewed by the operator |
| R8 | notifications as an observation with routing rules | `bot-notify`, `bot-operator-activity` | L | parallel with R7 |
| R9 | cost from run summaries; liveness from the run list | `bot-cost`, `bot-actuals`, `bot-footer`, `bot-heartbeat` | M | after the review app reads runs (decision G) |
| R10 | stretch: a second forge, read-only (Forgejo), with the board's stand-in | nothing | L | after R5 and decisions I and J |
| R11 | stretch: an applier for `agent_output.json` on a forge with no gh-aw | nothing | M | after R10 and decision K |

R3 to R5 are the plan's steps 2 to 4 seen from the code: a rule ported
with parity shown is a write ready to move. The local workers and
`bot-supervisor` go at the plan's steps 6 and 7, with no Rust written
for them. R10 and R11 are the stretch goal and block nothing: every
step before them is written against the trait, which is what keeps them
possible, and none of them waits for a second forge.

How old and new avoid acting twice: every rule is in one of three modes,
`off`, `report` or `act`, and exactly one side has `act`. A port lands
in `report` (computed, listed, compared with the old tool); the commit
that sets it to `act` is the commit that removes the old rule, or turns
its step off locally when the write moves to Actions, as the plan's
step 4 says. Rules are level-triggered and their writes set a field to
a value, so a mistaken overlap repeats a write rather than doubling it;
dispatch is guarded as the plan describes.

### What is not carried over

- Reports for people as the interface between programs, and every
  parser of them, `bot-poll` first.
- The key-value store in archived draft items (`bot-board state-get`,
  `state-put`): the pass's memory is one file it carries over.
- A cache, a lock and an atomic write per tool: one of each, in `forge`
  and `state`.
- `bot-supervisor`'s pending-batch recovery and `bot-poll-loop`'s
  seen-sets. A level-triggered pass that failed runs again.
- The heartbeat and usage comments, once the review app reads the run
  list and the broker.
- A model call inside the deterministic pass (`bot-operator-activity`).
- `bot-work`'s launcher and its lease in a board item; three local job
  runners; the finished migrations; `bot-board-migrate`; `install.sh`.
- `bot-tmt-number`, which is bootc's and belongs with bootc's tooling
  or a skill; `bot-retro`'s regular expressions over transcripts, to be
  rethought on run summaries; `dco-signoff`.

### Decisions for the operator

Reworked with the protocol and the forge: B and E changed, I to K are
new, and the rest stand as they were.

**A. Where agent-run lives.** Decided 2026-10-06:
cgwalters-forge/agentic-job, under that name.

**B. How a workflow calls agent-run.** Decided 2026-10-06: the Rust
binary is the interface and a reusable workflow wraps it on GitHub.
Both are in agentic-job's plan (see devspace-agent-runs.md).

**C. Where the scheduler lives.**
1. `crates/sched` in homegit, two binaries (`bot-sched`, `bot`), moved
   to its own repository when `bin/` is empty of harness tools
   (recommended).
2. Its own repository now.
3. One binary for everything.

**D. How the Rust reaches the workstation while tools still run there.**
The first slice avoided the question by replacing a tool that only runs
in Actions; R2 cannot.
1. `bot-sweep`'s update step runs `make install-crates` when `crates/`
   or `Cargo.lock` changed (recommended: no new trust path and a build
   of about a minute; it bends the rule that nothing builds on the
   workstation, which is his to bend).
2. CI publishes a release binary per commit of `main` and the sweep
   downloads it by commit.
3. Nothing local is ported: each write moves to Actions first.

**E. The HTTP client.** The first slice uses option 1, at the cost of
34 packages in `Cargo.lock`. It is now a choice for GitHub's module
only; another forge's is made when that module is written.
1. `ureq` with a thin client of ours (recommended).
2. `octocrab`.
3. Keep shelling out to `gh`.

**F. `crates/bot-poll`.**
1. Delete it with `bot-poll-loop` at R5, keeping its ETag cache
   (recommended).
2. Finish it as the poller.

**G. The heartbeat and usage comments**, which the review app reads.
1. The review app reads the run list and the broker's `/usage`; then
   `bot-heartbeat` is deleted (recommended).
2. The scheduler keeps publishing them.

**H. The order of the two halves.** The epic says agent-run first.
1. Both in parallel: agentic-job is written in its own repository,
   R1 to R5 touch nothing of it, and only R6 needs its cutover
   (recommended).
2. All of agent-run, then the scheduler.

**I. How far forge-agnostic goes now.** He called it a stretch goal.
1. The trait and a neutral core now (done for reading in homegit#171),
   GitHub the only implementation, and one read-only pass on a second
   forge (R10) as the proof once R5 is in (recommended: the trait costs
   little while the code is being written anyway, and an abstraction
   with one implementation is a guess until a second one tests it).
2. Build a second forge fully now, before the rules are ported.
3. No trait: write for GitHub and abstract when a second forge is
   real.

If 1 or 2, which forge second: Forgejo is the nearer (its API and
Actions follow GitHub's, and it has OIDC and a per-run credential) but
has no board API; GitLab is where the neighbouring projects are and
lacks events, a per-run write token and an approval tied to a commit.
Forgejo is recommended as the proof for that reason, not as a
statement of where it will be used.

**J. The board where a forge has no Projects API.**
1. Exclusive labels for Status, Priority and Workflow, and the text
   fields in a marked comment the bot keeps on each item (recommended).
2. Labels only: no Why, News or Run; the reasons go in comments.
3. Wait for Forgejo's projects API and GitLab's paid custom fields.

**K. Applying safe outputs off GitHub.**
1. A small applier of ours that reads gh-aw's schema, with a backend
   per forge; GitHub keeps gh-aw's own handlers (recommended: it is his
   stated position on fullsend#6614, and keeps the decision of
   tracker#401).
2. That applier on GitHub too, for one code path. Not recommended: it
   gives up "reuse the GHA safe-outputs code directly".
3. Off GitHub, apply directly with a stored bot token and no separate
   job. Not recommended: it is the model tracker#401 moved away from.

## Open points

What stands in on GitLab for an approval of an exact commit, and for a
write token minted per run: both are unsolved, and listed with the
other gaps under [The forge](#the-gaps-and-what-stands-in).

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

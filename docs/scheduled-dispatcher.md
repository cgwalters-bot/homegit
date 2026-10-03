# The dispatcher as a scheduled job

Today the controller loop is a session: `bin/bot-poll-loop --until-actions`
wakes a Sonnet "dispatcher" (the `dispatcher` skill) when
`bin/bot-reconcile` has something to do, and the Opus coordinator is
needed only for what the dispatcher escalates. The goal the operator set
is to move this to a scheduled job that edge-activates on events ("don't
block on me, improve dispatch, bear in mind our goal is to move this to a
scheduled job alongside edge activation on events"). Nothing hosted
exists yet; this note says how today's pieces map onto a GitHub Actions
workflow, so that what is built now doesn't need redoing. It follows
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
agent target, the lanes, the week's capacity scope and the opencode share
of the mix (`pacing.opencode_share`, 1 in 4, rounded up so that at least
one remote run is allowed while any agent is; `agent.yml` runs only
opencode). Each dispatch also gets its token budget, and a task past it is
a `budget` action.
What it can't decide it reports as an action, which the dispatcher
handles by kind, or escalates.

State lives in three kinds of places. The shared, durable state is
already GitHub's: the board (Status, Lead, Run, Why, News, budgets),
issues and their labels (`dispatch`, `escalate`), PRs, and the run
artifacts of `agent.yml` (`summary.json`, `agent-out`). The per-loop state
is local files: `bot-reconcile --state FILE` (which actions fired and
when, the edge-triggering), `bot-poll-loop`'s seen-sets, the sweeps under
`~/.local/state/bot-sweep`, and the heartbeat's local input. Those are
the only state to move: `--state FILE` is already the whole interface for
the actions (read it at the start, write it at the end), so a job can
keep it as a file on a state branch of a repository, or an artifact of
its previous run, and the rest is recomputable from GitHub.

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

## Credentials

The job needs only what the bot's session has today, held as repository
or organization secrets and never given to a run's sandbox:

- the bot's GitHub token (a fine-grained PAT, or a GitHub App's
  installation token): contents and pull requests on the bot's and the
  forge org's repositories, issues and labels on the tracker, write on the
  org's Projects v2 board, and `actions: write` on the devspace repository
  to dispatch `agent.yml`. The default `GITHUB_TOKEN` is not enough: events
  its pushes cause don't start workflows.
- model access for Sonnet and Opus. Through the praxis broker's per-run
  tokens, as `agent.yml` does, rather than a raw API key on the runner.
- never the operator's credentials or sign-off: `bot-pr promote` adds
  their sign-off only after a verified approval of the exact head, as now.

The apply step opens draft fork PRs or homegit PRs and never merges;
merging stays with the review step: homegit and the devspace stack after
an independent review, upstream only on the operator's approval.

## Open points

The runners for the job itself are the self-hosted question of
[tracker#287](https://github.com/cgwalters-forge/tracker/issues/287): the
controller is cheap and holds credentials, so it should not run on the
CNCF runners the agent runs use. The `projects_v2_item` trigger, and where
the `--state` file lives (a state branch of the tracker, or an artifact),
are decided when it is built.

Trust is of an issue's author, not of whoever edited it last: a dispatched brief is read from the live issue, but an edit by a third party to the operator's issue is not detected. Tighten that if edits by others become common.

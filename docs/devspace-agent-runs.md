# Devspace agent runs: artifact and summary contract

An agent run is one run of the `agent.yml` workflow in
[bootc-dev/cgwalters-devspace-sandbox](https://github.com/bootc-dev/cgwalters-devspace-sandbox):
an agent CLI working one board item on a devspace runner, with its
transcript in the Actions log. The design is in the
[devspace agent runs plan](https://gist.github.com/cgwalters-bot/3d0b10312e6d6170f8e07967b7795bed),
tracked in [cgwalters-bot#11](https://github.com/cgwalters-bot/cgwalters-bot/issues/11).

This document is the contract between the workflow, which writes the
files below, and `bin/bot-runs`, which reads them. It is the source of
truth: the `summary.json` inside an Actions artifact is only its
transport. Change this file first (in the same PR as the side that
needs the change), and keep both sides to it. `tests/bot-runs.sh`
checks `bot-runs` against fixtures in `tests/fixtures/bot-runs/` that
follow it.

## Opencode runner profile

`dotfiles/.config/opencode/opencode-runner.json` is an overlay on the shared
opencode configuration. Its build agent implements and tests directly (as
permitted by the task brief), with low reasoning effort and at most one
optional read-only general reviewer at medium effort. Explore and fast use
Luna with read-only tools and no shell execution; architect is disabled.
The reviewer can execute permitted checks but cannot edit source or delegate.
The one-review limit is an agent instruction, not a task-call quota.
Interactive opencode retains the architect/implementation/review chain in
`opencode.json`; shared policy is in `dotfiles/.config/AGENTS.md`.

`bin/bot-opencode` selects the overlay with a wrapper-owned absolute
`OPENCODE_CONFIG` after filtering inherited overrides, and reports an
unreadable or missing profile before creating a worktree. Its local-worker
brief still assigns builds and tests to the caller's devspace.

The remote `agent.yml` launcher lives outside this repository and needs a
separate change to select this overlay explicitly after filtering inherited
configuration overrides. Changing homegit does not select it for remote
runs automatically. Restart opencode to pick up configuration changes.

## Controller review and fix flow

`node bin/bot-flow --help` describes the maintained review, fix, apply,
collect and landing-queue commands. They capture subprocess output internally:
the controller does not need to read a diff, artifact, review body or log.
Dispatch uses `bot-runs dispatch`; collection and application use
`bot-runs apply`, including its run-origin, artifact and safe-output checks.
For non-patch outputs, `apply --json` includes the validated `base` and
`base_commit`; comment outputs retain `target` and `issue_number` as well as
their text, so collection can check the destination and reject stale reviews.

Reviews begin with `VERDICT: APPROVE`, `VERDICT: CHANGES` or `VERDICT: REJECT`,
then `REASON: ...` (the reviewer's own one-sentence reason, at most 200
characters). Collect takes review TSV rows `repo<TAB>pr<TAB>run` and fix
rows `repo<TAB>pr<TAB>branch<TAB>run`. It posts a validated review on its PR
and prints just `repo#pr run-URL conclusion VERDICT reason`, one line per run.
Failed, empty, malformed and stale reviews are not posted; their line says
`none not posted: ...`. A repeat collection recognizes its own run-attempt
marker. This avoids duplicate posts on sequential retries, not simultaneous
collectors. An LLM verdict is not a human review or permission to merge.

Fix reads a named comment directly from the PR. Apply refuses a patch not
based on the current PR head or targeting the repository's default branch,
and pushes with an explicit SHA lease; squash
uses the PR base and preserves Agent-run trailers. Apply and land refuse
upstream and midstream writes. Land maintains only PRs already authorized
for auto-merge; it does not enable it or replace `bot-land`'s authorization
policy. A behind PR is rebased only with the inspected head SHA as an
expected-head precondition; a concurrent head replacement stops the queue.
The new entry point can be invoked with Node without executable mode.

Controller wait options must be finite and positive: `--timeout` is at most
330 minutes, and `--poll` at most 300 seconds. Collect defaults to 200 minutes
and land to 50 minutes, both polling every 20 seconds. Their deadline also
caps subprocess waits, including validation and posting, not just polling.
Every direct subprocess has a two-minute limit; child output remains suppressed
on failure or timeout. This is not process-tree cancellation: descendants and
remote mutations may continue after the direct child is killed. Inspect remote
state before retrying. Default-branch metadata is rechecked before pushing,
but GitHub offers no atomic default-branch precondition for a Git push.

## Dispatch

`bot-runs dispatch` calls the REST
[workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
on `agent.yml` at `BOT_RUNS_REF` (`bot/agent-run-praxis` until the workflow lands on `main`) with `return_run_details: true`, which answers
`200` with `workflow_run_id`, `run_url` and `html_url` instead of `204`,
so no polling is needed to find the run. The inputs are all strings:

| Input      | Meaning |
|------------|---------|
| `item`     | the board item id (`PVTI_...`) |
| `repo`     | the target repository, `OWNER/REPO` |
| `base`     | its base ref |
| `agent`    | `opencode`, `fake` (scripted, no inference) or `claude` (Claude Code, through the praxis broker) |
| `model`    | the model, as `provider/model` for opencode (`bot-runs dispatch` sends `praxis/gpt-6.1-sol`, GPT-6.1 Sol through the broker, unless `--model` or `BOT_RUNS_MODEL` says otherwise), a Claude Code model name or alias for claude (Opus by default); empty for the agent's own default |
| `cores`    | `4`, `16` or `64` |
| `timeout`  | minutes, at most 330 (`bot-runs dispatch` sends `75`) |
| `max_requests` | the most model requests the run may make, subagents' included, as the broker counts them; `0` for no cap (the workflow's default is `150`; `bot-runs dispatch` sends it only with `--max-requests`) |
| `max_tasks` | the most subagent tasks the agent may start; `0` for no cap (default `4`; sent only with `--max-tasks`) |
| `budget`   | the spend cap in AIC (1 AIC = $0.01; `bot-runs dispatch` sends `500`, or `5000` for `claude`, whose AIC are `api-equivalent`) |
| `workflow` | `branch` or `analysis` |
| `outputs`  | the output types the run may hand back, comma separated (`create_pull_request`, `add_comment`, `noop`, `missing_tool`, `missing_data`; `all` for every type allowed to this workflow): `bot-runs dispatch` sends `create_pull_request,noop,missing_tool` for a branch run and `noop,missing_tool,missing_data` for an analysis run |
| `max_outputs` | the most outputs of all types the run may hand back (`bot-runs dispatch` sends `3`) |
| `brief`    | the task text: `bot-runs dispatch` sends the runner-side worker brief (`dotfiles/.agents/skills/coordinator/runner-preamble.md`), the run's target, then the given brief, unless `--no-preamble` |

Dispatch inputs are public in a public repository and capped at 65,535
characters in total, so a brief follows the board's no-private-data rule.

**The restrictions are the inputs.** `repo`, `base`, `outputs` and
`max_outputs` are the run's restrictions. The workflow's first job,
`Restrictions`, checks them against a static allowlist in the devspace
repository (`safe-outputs/allowlist.json`: the owners and bases a run may
target, the output types and their per-type maximums, the largest patch),
before a runner is spent on the agent, and fails the run on anything
outside it: no job after it runs. What they compile to is gh-aw's
safe-outputs configuration (`config.json`), with its default protected-files
policy, which the later checks use. For the bot's own repositories, named
exactly in the allowlist's `unprotected_files` (homegit, the forge's devspace
repository and review), `README.md` and `AGENTS.md` come off that policy's
list, since docs edits are routine there; `.github/` and the other
dot-folders, manifests and secret-shaped content stay refused everywhere, and
upstream repositories keep the default. A new type, owner or bigger limit is a
change to the allowlist in a reviewed commit, never a dispatch.

**Public repositories only.** An agent run's logs and transcripts are
public, so `repo` must be a public repository (devspaces are for
CNCF-adjacent work, never private code). `bot-runs dispatch` refuses a
repository that GitHub doesn't confirm is public, and so does the workflow,
before it clones anything and again before it uploads anything; any error
or doubt refuses.
The workflow sets `run-name: agent ${{ inputs.item }} ${{ inputs.repo }}`:
`bot-runs` reads the item and repository from a run's `display_title`
when nothing else is left of the run.

**Whose runners.** The runners behind `agent.yml` and the devspaces are
provided for CNCF projects, so use them for CNCF or associated work
(bootc, composefs, ostree and so on). The operator allows the bot's own
harness development on them for now, and said the medium term is likely
self-hosted: "There is a bigger picture goal I want to only use cncf
runners for things in CNCF or associated like ostree. We can use them for
our harness dev for now but make a note that the medium term is likely
we'll end up setting up GHA runners on my personal machines as a Kube
cluster or so" (the operator, in the session landing cgwalters-forge/tracker#282). That plan is tracked in
[tracker#287](https://github.com/cgwalters-forge/tracker/issues/287).

### On the board

The run, not the session that dispatched it, is the source of truth for
its item. `bot-runs dispatch` writes the run URL into the item's `Run`
text field (adding the field to the board if it has none) and sets
Status In Progress with a News line. `bot-runs reconcile`, which
`bot-watch` runs on every sweep, follows that field: while the run goes
on the item stays In Progress; once it is over, an item still In
Progress moves to Draft if the run succeeded with a patch (ready for
`bot-runs apply`; `bot-reconcile`'s patch-ready rule then names it, and
a local Sonnet apply worker applies, reviews and proposes it, see
`dotfiles/.agents/skills/coordinator/apply-preamble.md`; it opens a draft
PR and never merges), and back to Todo otherwise (failure, timeout, budget, cancelled, or
no change), with Why and News linking the run. A run the runner stopped
at a limit (`stopped_early`) still hands back its working tree, and Why
then names the partial patch to continue from, in the run's
`safe-outputs` artifact; `bot-runs apply` takes only successful runs. Either way `Run` is
cleared, so an item In Progress without a `Run` is local work, and a
finished run never moves an item twice.

After claiming the item, `bot-runs dispatch` and local `bot-pace assign`
register a starting worker through `bot-heartbeat publish` from the saved
input at `${XDG_STATE_HOME:-~/.local/state}/bot-heartbeat/last-publish.json`.
They preserve existing workers, private `agent_ids`, coordinator state and
the saved session owner, shifting `next_wake_at` with `updated_at`. Missing
or invalid saved state, or a published heartbeat that differs from it,
produces a warning; the claim or dispatch remains in effect. Publish the
full current worker list to recover, rather than rebuilding input from
the public heartbeat, which omits private fields.

## Live run observation and health (consumer implemented, producers missing)

`lib/run-health.js` evaluates sanitized attempt-scoped observations;
`lib/run-watch.js` and `bot-runs watch` consume them. This is a **proposed
`run-observation/v1` producer/consumer contract**, not evidence that telemetry
is deployed. The praxis broker, runner `run.mjs`, and review application
are absent from this checkout. Their producer, transport, and UI changes
still need implementation and deployment. This work does not complete
the end-to-end run-health issue.

The broker must meter actual inference requests and cumulative usage,
bound to the Actions repository, run ID and attempt at registration. The
runner must supply sanitized tool outcomes and actual execution activity
for that same identity. A broker-only inference stream cannot establish
that a tool-only workload is idle. A producer or aggregation service must
combine these sources, expose a complete rolling event window, and update
observation timestamps even during silence without advancing activity.
There is currently no deployed endpoint specified here, no runner emitter,
and no review-app rendering verified by this checkout. Do not infer live
health from old artifacts, Actions log volume, elapsed job time, workflow
start time, or a heartbeat refresh.

### Proposed observation payload

The consumer accepts a JSON **array**, either from a sanitized read-only
endpoint or a local file. There must be exactly one matching observation
per `(repo, run_id, attempt)`; duplicates are unknown, not last-writer-wins.
An example (numbers are illustrative, not observed usage):

```json
[
  {
    "schema": "run-observation/v1",
    "repo": "bootc-dev/cgwalters-devspace-sandbox",
    "run_id": 123456789,
    "attempt": 1,
    "observed_at": "2026-10-05T12:00:00Z",
    "last_activity_at": "2026-10-05T11:59:58Z",
    "window_started_at": "2026-10-05T11:55:00Z",
    "tokens": {"input": 1200, "output": 300, "cache_write": 100},
    "events": [
      {"at": "2026-10-05T11:59:58Z", "kind": "request", "error": false}
    ]
  }
]
```

`repo` is the Actions repository, compared case-insensitively, not the
task's target repository. `run_id` and `attempt` must numerically match the
Actions run and its `run_attempt`. Reruns start new counters and never
inherit suspicion or cancellation intent. All times are UTC strings with
`Z`, optionally fractional seconds. `observed_at` is the producer's
snapshot time, no later than evaluation time and no more than five minutes
old. `last_activity_at` is actual execution activity, at or after the active
execution step's start and no later than `observed_at`. Before the producer
has a usable activity time, omit the observation or report unusable/null
fields; the result is unknown, not zero usage or healthy.

`window_started_at` asserts complete coverage from that time through the
snapshot, including periods with no events. It must be no later than
`max(execution step start, evaluation time minus five minutes)`. Every
event is an object with `at`, `kind` (`request` or `tool`) and Boolean
`error`. Events must be within the current execution step and no later
than `last_activity_at`; older events may be retained but only those at or
after evaluation time minus five minutes count. Producers must record
each relevant request/tool outcome once, including errors, and must not
label partial coverage as complete. Activity during a long-running tool
needs a genuine execution-progress signal; an observation refresh alone
is not one. No prompt, response, tool arguments/output, error text, session
ID, credential, or broker-private identifier belongs in this payload.
Consumers ignore extra fields; producers should emit only this allowlist.

`tokens.input`, `.output`, and `.cache_write` are nonnegative safe integers,
cumulative **actual metered usage for this attempt**, not estimates,
reservations, a rate-limit percentage, or a rolling-window count. Input is
uncached input, output includes reasoning already counted within output,
and cache write counts written tokens once. Their safe-integer sum is the
watch's `tokens` scalar, called **fresh tokens**. Cache-read tokens are
excluded; do not substitute praxis `tokens.total`, whose cap accounting
may include cache reads, or add reasoning a second time. Missing/unmetered
usage is unknown, never a fabricated zero. If a provider cannot supply
these semantics, its producer must leave telemetry unusable until a
versioned accounting contract resolves it. This scalar differs from local
heartbeat transcript usage, which reports four token categories including
cache read, and from dispatch `budget` in AIC.

### Eligibility, thresholds and cancellation

Watch considers only unique board-owned runs on In Progress items, with
workflow other than `manual` and Lead absent or `coordinator`, whose Run
URL belongs to the configured Actions repository. Runs must be
`in_progress`, with exactly one active step named `Run agent` in an active
job named `Agent`. Queueing, checkout/setup, artifacts, validation, an
ambiguous step, missing metadata, stale/malformed/duplicate observations,
or incomplete counters/window coverage produce `unknown`. Unknown never
authorizes cancellation and breaks continuous suspicion.

Default stall threshold is ten minutes since execution activity
(inclusive). Failing means at least five request/tool events in the
rolling five-minute window, at least half errors (inclusive). Runaway
means fresh tokens strictly exceed a positive board **Budget tokens**
field; no positive value means no token-health cap. Precedence is runaway,
then failing, then stalled, then healthy. Healthy means usable evidence
below those thresholds, not proof of task quality or completion. The
evaluator can return partial activity/counters with an unknown result;
heartbeat deliberately clears these per-run unknown fields.

The same suspect health class must persist across evaluations for five
minutes before cancellation is eligible. Recovery, unknown evidence or a
change in class resets the grace; a different attempt has a separate key.
This is sweep-observed continuity, not continuous monitoring between
sweeps. After grace, apply rechecks fresh board ownership, run attempt,
execution step and fresh telemetry before POSTing cancellation. Durable
intent is saved before the POST, so an ambiguous transport failure is not
retried as another cancellation request. Watch polls a pending request
even if the run leaves the active listing. Only confirmed `completed` /
`cancelled` on the same attempt permits setting the still-owned item to
Todo, recording Why/News, and clearing Run. An ownership change refuses
that board write. Other terminal outcomes go through reconcile. There is
no separate cancellation-confirmation deadline or automatic retry of an
ambiguous POST; the grace knob is **before** cancellation, not an allowance
for a process to terminate after it.

`bot-runs watch` supports `--stall-minutes` (default 10),
`--grace-minutes` (default 5), and `--execution-step` (default `Run agent`,
also `BOT_RUNS_EXECUTION_STEP`). Nonnegative minutes, including zero, are
accepted. Freshness and event-window length are fixed at five minutes in
the CLI; library callers can pass `freshnessMs` and `windowMs`. The error
minimum/fraction are fixed at five/one-half. Source knobs are `--read-url`
or `BOT_RUNS_WATCH_URL`, and `--observations-file` or
`BOT_RUNS_WATCH_OBSERVATIONS`; a file wins if both are set. Read URLs accept
HTTP(S), refuse embedded credentials and redirects, and time out after
ten seconds. Read errors degrade to unknown without echoing transport
details. Endpoint reachability and deployment remain producer work.

`--board-file`, `--runs-file`, `--now` and `--state-file` support offline
evaluation; offline run fixtures refuse real apply. State defaults to
`${XDG_STATE_HOME:-~/.local/state}/bot-runs/watch.json`
(`BOT_RUNS_WATCH_STATE` overrides it). A nonblocking state lock prevents
concurrent watchers. Report mode can persist suspicion but does not
cancel or change the board; `--dry-run` changes neither persistent state
nor the board and reports eligible actions; `--apply` permits the guarded
writes. `bot-watch` runs watch before reconcile on each sweep, uses its
Lead-filtered board scope, refreshes that board between the two for live
apply, combines both reports into `devspace_runs`, and marks the section
failed if either fails. Without telemetry, ordinary completion reconcile
still works while live health remains unknown. No background sampling is
implied; cancellation can occur only on a subsequent eligible sweep.

### Heartbeat publication

`lib/heartbeat-register.js` exports a locked updater for existing remote
`run-ID` workers. Live `bot-runs watch --apply` calls it after fresh
evaluation and ownership checks, using the unique board owner (including
its content URL):

```js
const { updateRun } = require("./heartbeat-register.js");
// Only live --apply, never report, --dry-run, or offline fixtures.
// Refresh ownership before calling; do not update a cleared/reassigned Run.
const ok = updateRun(freshItem, result, {
  evaluatedAt: new Date(evaluationTimeMs).toISOString(),
  // Optional: heartbeat: process.env.BOT_RUNS_HEARTBEAT
});
```

`evaluationTimeMs` must be the time used for that result, not publication
time. `result` is a watch result containing `repo`, `run_id`, `attempt`,
`item`, `run`, `health`, `observed_at`, `last_activity_at` and `tokens`. A metadata-error
result without identity cannot update a worker; leave it alone to age to
unknown. Pass post-revalidation evidence if cancellation revalidation
changed the evaluation. Prefer calling before a successful cancellation
clears board ownership; existing reconcile/apply cleanup removes finished
workers. A false return is a best-effort publication failure to report,
not grounds to undo cancellation or a board claim. The helper returns true
for a no-op (no matching worker, changed ownership, or older evaluation).
It never creates a worker or looks up board ownership itself; the caller
must enforce unique fresh ownership and provide trustworthy watch output.
Watch reports publication failures without suppressing cancellation. Confirmed
cancellation removes the worker; failed cleanup is durably retried on later
live applies, even after Run is cleared, while protecting newer attempts.

The helper merges from saved private input under the same registration
lock through remote publication and state save, preserves `agent_ids`,
other worker metadata and the saved session owner (including null), and
uses the existing strict published-state comparison. It updates only the
remote worker whose name and item URL match. Older attempts/evaluations
are ignored. A new attempt clears prior attempt activity. Unknown clears
per-run activity/tokens and does not advance worker activity; previous
genuine activity can remain for expiry within the same attempt.

The additive worker `run_health` input holds `repo`, `run_id`, `attempt`,
`evaluated_at`, optional producer `observed_at`, `health`, `last_activity_at`, and scalar `tokens`. Public
`bot-heartbeat/v1` exposes those fields **except tokens**, filtering both
item and run repositories for public visibility. Private `bot-usage/v1`
adds `runs` entries with the worker name and all those fields, including
fresh tokens; these are separate from local transcript `workers` sums.
Neither publication includes watch reasons/events or private agent IDs.
`bot-heartbeat show`/`show --usage` return the corresponding JSON, and
comment text renders the run state. This makes status available to a
consumer but does not implement the absent review UI.

Refresh never advances execution activity, `evaluated_at`, or `observed_at`.
On a publication more than five minutes after either evaluation or producer
observation, per-run public health/activity and private run tokens become
unknown/null; saved input retains the original evidence. A null observation
is unknown; older inputs without that optional field use the evaluation-age
bound. A review consumer must also apply these bounds at read time, even if
heartbeat `updated_at` is fresh; absent `run_health` is unknown.
Worker expiry is separate: prune drops
workers after six hours (inclusive) without genuine activity, falling back
to `started_at`, configurable via positive `BOT_HEARTBEAT_STALE_HOURS`.
Prune also drops Done/closed items and keeps unreadable items until expiry.
Prune does not cancel Actions runs; a heartbeat refresh does not postpone
expiry. `done run-ID` explicitly removes a finished/cancelled worker.

## Artifacts

Each run uploads two artifacts. Everything in them has been through the
redaction below first.

**`agent-run`**, with `retention-days: 90` (the public-repository
maximum), holds small, unencrypted files at its root:

- `summary.json`: the machine-readable summary, described below;
- `summary.md`: exactly the Markdown the run appended to
  `$GITHUB_STEP_SUMMARY` (the REST API can't read a step summary back);
- `condensed.log`: the condensed transcript, one line per event, the
  same lines the job log shows;
- `outcome.json`: the agent's own outcome, which it writes to
  `~/out/outcome.json` (at most 64 KiB): `summary`, `tests`
  (`{command, exit_code, duration_s}`, copied into `summary.json`),
  `questions` and `stopped_early`, as the runner-side worker brief asks.

**`safe-outputs`**, with `retention-days: 30`, is uploaded when the run
handed anything back. It is [gh-aw's safe
outputs](https://github.github.com/gh-aw/reference/safe-outputs/), so that
swapping the interim runner for the gh-aw fork's sandbox mode changes who
applies the output, not its format:

- `outputs.jsonl`: one JSON object per line, each a request with a `type`
  (the agent wrote them to `~/out/safe-outputs.jsonl`): `create_pull_request`
  (`title`, `body`, and the `branch` the supervisor sets to
  `agent-run-RUNID`), `add_comment`, `noop`, `missing_tool`, `missing_data`,
  with the fields gh-aw's validation rules name. A branch run that changed
  files without asking for a pull request gets one made from
  `outcome.json`'s `summary`.
- `aw-agent-run-RUNID.patch`, for a `create_pull_request`: the supervisor's
  own `git format-patch` of one commit of the working tree against the
  run's starting commit (new files included, nothing the agent committed
  lost, at most 8 MiB), with gh-aw's `X-GH-AW-Base-Commit` header. The
  agent doesn't make it, as gh-aw's safeoutputs server makes it from the
  git state.
- `base.json`: `{repo, ref, commit}`.

The runner has no credentials, so it can't create anything. The patch isn't
redacted, because that would corrupt it; a secret-shaped string in the
artifact fails the upload instead. Two checks follow, both by gh-aw's own
code, vendored in the devspace repository (`vendor/gh-aw/`, whose
`UPSTREAM.json` names the cgwalters-forge/gh-aw commit and the sha256 of
every file) and run by `safe-outputs/safe-outputs.mjs`:

- the last job of the run, `Safe outputs`, on a fresh runner that never ran
  the agent: `collect_ndjson_output.cjs` parses, validates and sanitizes
  the requests under the policy of the inputs, the protected-files policy
  (`manifest_file_helpers.cjs`: README.md, AGENTS.md, manifests, CODEOWNERS
  and top-level dot-folders such as `.github/` can't be changed) runs on
  the patch, and the checks gh-aw doesn't make: secret-shaped strings,
  symlinks, submodules, binaries, mode changes and new executables, plain
  relative paths, git, CI and hook configuration anywhere;
- `bot-runs apply RUN --repo OWNER/REPO --slug SLUG --message FILE`, which
  treats all of it as untrusted and does it again with the code of the
  commit that ran (fetched from the runs repository by `head_sha`; the
  checkout `BOT_RUNS_SAFE_OUTPUTS_DIR` names replaces it, for tests and
  development). That code is as trusted as the workflow, since whoever
  can push to such a branch can change both, and it runs with an empty
  environment under node's permission model (reads its own directory and
  a scratch directory, writes only the scratch directory, starts no
  process: git's view of the applied change is handed to it as files). The run must be a
  successful `workflow_dispatch` of `.github/workflows/agent.yml` in the
  configured devspace repository, with matching head and run repository ids,
  from `bot/agent-run-*` (a nonempty suffix; `BOT_RUNS_REF` selects the
  dispatch branch and does not widen this) and dispatched by the configured bot or operator
  (the run's `actor`), for the declared repository (its title, summary and `base.json` all agreeing),
  all three of its jobs (`Restrictions`, `Agent`, `Safe outputs`) must have
  succeeded, and the artifact must be the only `safe-outputs` of that run
  and head, made during the `Agent` job (the one running the agent as
  `runner-sandbox`). The checker unpacks it (regular files with the three
  names at the root, within their caps as declared and as unpacked) and
  checks it under the allowlist for that repository and base
  (`--outputs TYPES` narrows the types); the base commit must be on the
  base branch (never fetched by id, since GitHub serves fork commits that
  way). The patch is applied with hooks and the caller's git configuration
  off, in a managed `bot-work` worktree backed by a fresh isolated clone whose
  `origin` pushable only for the bot's own repositories (any other has no
  usable push URL), and checked again
  as git sees it (`checkFileProtectionPostApply` and the mode, link and
  binary checks), then committed as the bot on `bot/SLUG` with an
  `Agent-run:` trailer linking the run attempt. The agent's own title and
  body are printed (and in `--json`) for the fork PR; the other outputs
  (`noop`, `missing_tool`, `add_comment`, `missing_data`) are listed, never
  posted. Nothing is pushed: after review, `bot-pr fork-pr --from DIR`
  opens it on the forge, or, for the bot's own repositories, ordinary `bot-land`
  publishes it through `origin`. A refused change's worktree and clone are removed.

Apply uses `bot-work worktree add REPO_DIR SLUG --base COMMIT`, defaulting
to `${XDG_CACHE_HOME:-~/.cache}/bot-work/SLUG/REPO`. Its `--dir DIR` option
passes a custom destination to that helper, which registers it under the
same cache entry; a custom destination outside the worktree cache must
not already exist; missing parent directories are created. The backing clone is
`${XDG_CACHE_HOME:-~/.cache}/bot-runs/apply/sources/RUN_ID-SLUG/REPO`, even
with `--dir`; keep it while the linked worktree exists. A refusal removes
the managed worktree and then its backing clone; if worktree removal
fails, the clone is preserved for recovery. After the PR is open, use
`bot-work worktree rm SLUG --dir DIR` (or omit `--dir` to remove all that
slug's managed worktrees), then remove the backing clone once nothing
needs its commits. The helper prunes Git registrations and preserves
branches in the backing clone; it refuses tracked or untracked changes
unless `--force` is given after verifying they can be discarded.

Before this, a branch run uploaded `agent-out` with `changes.patch` and
`bot-runs apply` checked it in shell. That format is gone: runs from before
the change have no `safe-outputs` artifact, so `apply` refuses them, and
their artifacts expire after 30 days.

**`agent-transcript`**, with `retention-days: 30`, holds one file,
`transcript.tar.zst`: a zstd-compressed tar, public like the rest, since the
target repository is public and redaction takes care of credentials. The
tar holds
`raw.jsonl` (the agent CLI's stream-json output), `sessions/` (the
agent's session files, subagent transcripts included), `token-usage.jsonl`
(the inference shim's per-request log), `access.log` (the egress proxy's,
once there is one; egress is open for now) and `test-logs/` (tails of the agent's test logs). Readers also accept
`transcript.tar.zst.age`, encrypted with `age`, should a run ever need it.

**In the job log**, the condensed lines are printed between
`::group::agent (condensed)` and `::endgroup::`. That group is what
`bot-runs log` falls back to once `agent-run` has expired (job logs are
kept as long as the repository's log retention allows). The full
stream-json never goes to the log: it runs to megabytes, and the log is
public.

## summary.json

A single JSON object. The `schema` field names the version; adding a
field keeps the version, while removing, renaming or changing the
meaning of one needs `agent-run-summary/v2`. Readers ignore fields they
don't know, and treat a missing or `null` field as unknown, never as
zero.

| Field | Type | Meaning |
|-------|------|---------|
| `schema` | string | `agent-run-summary/v1` |
| `run_id`, `run_attempt` | integer | the Actions run and attempt |
| `run_url` | string | the run's HTML URL |
| `item`, `repo`, `base`, `workflow`, `agent`, `model` | string | as dispatched (`model` resolved to the one used) |
| `cores` | integer | the runner size |
| `started_at`, `finished_at` | string | RFC 3339, of the agent step |
| `duration_s` | integer | the agent step's wall time |
| `result` | string | `success`, `failure`, `timeout`, `budget` (cut off by the budget), `cancelled` or `noop` (stopped with nothing to do) |
| `turns` | integer | model turns |
| `tokens` | object | `input`, `output`, `cache_read`, `cache_write`: integers |
| `tokens_source` | string | where `tokens` come from: `praxis` (the broker's record of the run), `proxy` (the job's inference proxy log) or `unverified` (the agent's own report); `null` with no counts |
| `praxis` | object | for runs registered with the praxis broker, its usage record's numbers, else `null`: `schema` (`praxis-run-usage/v2`), `state` (`active`, `finished` or `expired`), `requests` (metered), `unmetered` (successful responses whose usage never arrived; the cap keeps their reservation), and `tokens` with `input` (uncached), `cache_read`, `output`, `reasoning` (within `output`) and `total` (what the broker's per-run cap counts): integers |
| `aic` | number | estimated cost in AIC |
| `aic_budget` | number | the dispatched budget |
| `aic_pricing` | string | `api` (billed), `api-equivalent` (a subscription run priced at API rates, as a claude run is), `subscription` (no per-token price; the praxis broker caps tokens instead) or `mock` |
| `tools` | object | per tool name: `calls`, `errors` and `duration_s` (integers) |
| `slowest` | array | at most 10 of `{tool, summary, duration_s}`, slowest first |
| `failures` | array | `{kind, message}`, `kind` one of `tool_error`, `timeout`, `budget`, `validation`, `agent_exit` |
| `stopped_early` | boolean | the runner stopped the session at a limit (`result` is `timeout` or `budget`); absent in older runs. Not `outcome.json`'s `stopped_early`, the agent's own reason as text, which the runner fills in for a run it stopped |
| `handed_back` | boolean | stopped early, the agent finished the turn it was given to hand back in, so `outcome.json` and the patch are its own account of a partial change |
| `notices` | array | the budget notices the runner sent the agent, in order: `60%`, `80%`, `last task`, `hand back` |
| `limits` | object | the limits the harness ran with: `timeout_s`, `budget_aic`, `max_tool_calls`, `max_requests`, `max_tasks` (`null` for none) |
| `tests` | array | `{command, exit_code, duration_s}` from `outcome.json` |
| `files` | array | paths the agent changed, relative to the repository |
| `patch` | object | branch runs that changed files: `base` (the commit the change is against), and `bytes` (of the patch) or `error` (why no change was handed back); else `null` |
| `egress_denied` | array | `{domain, count}` from the proxy log (empty while egress is open) |
| `outcome` | object | `status` (`Draft`, `Needs human` or `null`), `url` (the forge PR or write-up, once applied, else `null`) and `why` |
| `redactions` | integer | how many strings the redaction pass replaced |

When an outcome has no status or URL yet, `bot-runs` displays its `why`
as the final outcome. `bot-runs show` retains every reported test attempt,
including its exit code and duration, and labels a failed attempt superseded
only if a later attempt of the exact same command succeeds. These test lines
are shown even when the artifact includes `summary.md`.

Free text (`summary`, `message`, `why`, `command`) is redacted and cut
to 200 characters. A `tests/fixtures/bot-runs/` summary is a complete
example.

## Run footer

Artifacts expire; the footer is the durable record. When the apply step
proposes a run's result, it adds one footer per run to the forge PR's
bot-meta section (between `<!-- bot-meta -->` and `<!-- /bot-meta -->`,
where only the apply step writes), or the end of an analysis write-up: a
human-readable line, then the same data as JSON in an HTML comment:

```
Agent run [123456789](https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/123456789): claude/claude-sonnet-4-5, 1.2M in / 40k out tokens, ~123 AIC (est.), 42m, success
<!-- agent-run-summary/v1 {"run_id":123456789,"run_attempt":1,"run_url":"...","item":"PVTI_...","repo":"...","agent":"claude","model":"...","result":"success","duration_s":2520,"turns":37,"tokens":{...},"aic":123.4,"aic_budget":500,"outcome":{"status":"Draft","url":"..."}} -->
```

The JSON is a subset of `summary.json`: exactly the fields shown, and no
free text, so an HTML comment can't be broken by it; a writer still
escapes any `--` in it as `-\u002d`. `bot-runs` finds the footer by
searching the bot's pull requests in `cgwalters-forge` for the run id,
reads it only from the bot-meta section (the agent writes the rest of
the body), takes the last one for the run and attempt, and marks what it
read from there as partial. Analysis write-ups aren't searched yet: they
have no searchable home until the plan's notes repository exists.

Local coordinator and worker runs have no `summary.json`; their footer
is `bot-run/v1`, which `bin/bot-footer` renders for one task from
`bot-cost --json`. `bot-pr fork-pr --footer FILE` and `set-body --footer
FILE` add it at the end of the bot-meta section, after earlier footers,
and `refresh-meta` keeps both kinds:

```
<sub>Bot run: session 929c7a64, agent afc36173 · claude-opus-5-5 1.2M in (97% cached) / 40k out · ~$12.30 inference + ~$0.50 compute (est., list prices) · 42m wall · 1.3 core-h, Actions run [123456789](https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/123456789)</sub>
<!-- bot-run/v1 {"task":"PVTI_...","item":"PVTI_...","sessions":[...],"agents":[...],"first_message_at":"...","last_message_at":"...","duration_s":2520,"models":{"claude-opus-5-5":{"tokens":{...},"usd":12.3}},"usd":{"inference":12.3,"compute":0.5,"total":12.8},"core_hours":1.3,"run_urls":[...],"window_since":"...","generated_at":"...","estimate":true} -->
```

The same rules hold: ids, numbers, timestamps and URLs only, `--`
escaped. Costs are list-price estimates of the task's messages and
Actions runs within bot-footer's `--since` window (default 2 days), and
the duration is wall time from its first message to its last.

## Redaction

Before anything is printed to the log or uploaded, the supervisor
replaces with `[REDACTED]`:

- the literal value of every token or secret the job minted or read
  (also masked with `::add-mask::`);
- matches of `gh[posu]_[A-Za-z0-9_]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`,
  `sk-ant-[A-Za-z0-9_-]{20,}`, `sk-[A-Za-z0-9_-]{20,}`,
  `tskey-[A-Za-z0-9-]{10,}`, JWTs (`eyJ....eyJ....`), and whole
  `-----BEGIN ... PRIVATE KEY-----` blocks.

It deletes symlinks from the tree it uploads, and never collects
environment dumps. Nothing is uploaded unless a final check finds no
secret-shaped string left in the artifacts and the target is still
confirmed public. Redaction is a safety net, not the defense: the agent's
environment holds no secret worth leaking in the first place. `bot-runs`
adds no redaction of its own and never uploads anything; it keeps what it
downloads under `~/.local/state/bot-runs/` (summaries) and
`~/.cache/bot-runs/` (HTTP caches, and unpacked transcripts, removed
after 30 days).

## Opt-in agentic-job caller

The legacy `agent.yml` remains the default. To use agentic-job's shipped
`dispatch.yml` on a caller's `main` branch:

```sh
bot-runs dispatch --backend agentic-job --caller OWNER/CALLER \
  --repo OWNER/TARGET --item 458 --kind implement task.md --dry-run
bot-runs show RUN --backend agentic-job --caller OWNER/CALLER
bot-runs list --backend agentic-job --caller OWNER/CALLER
bot-runs log RUN --backend agentic-job --caller OWNER/CALLER
```

`--item` is the target issue number (a PR number for `--kind review` and
`--kind fix`), not a board item id. Kinds are `implement` (the default),
`review`, `triage`, `research` and `fix` (one commit pushed to the branch of a
pull request that `apply` opened from the bot's fork). The caller supplies the
preamble and fixed output routing. Its
current dispatch interface exposes only `repo`, `item`, `kind` and `task`:
model, agent, runner size, budget, timeout and caps are caller configuration.
Explicit overrides are refused rather than dropped or sent as unknown inputs.
This is a remaining caller-interface gap before per-run model/limit selection.
The adapter does not write board fields for numeric issue identifiers.

Readers use the caller's `dispatch-KIND-` artifacts and keep its cache separate
from legacy runs. JSON includes the run's `applied.json`
(`agentic-job-applied/v1`) as `applied` and an `application` status and URL.
Only a successful `run / apply` job with a valid applied record reports
`applied`, `partial` or `refused`; failed/skipped/missing apply is not delivery.
The URLs come from that record, not the agent's proposed outcome. These records
are display data, never permission to write. Local `apply` refuses this
backend: its runs apply themselves. Board reconciliation and watch support
are intentionally not part of this adapter.

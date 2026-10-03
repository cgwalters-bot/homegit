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
| `agent`    | `opencode`, `fake` (scripted, no inference) or `claude` (once the broker holds its credential) |
| `model`    | the model, as `provider/model` for opencode (`bot-runs dispatch` sends `praxis/gpt-6.1-sol`, GPT-6.1 Sol through the broker, unless `--model` or `BOT_RUNS_MODEL` says otherwise); empty for the agent's own default |
| `cores`    | `4`, `16` or `64` |
| `timeout`  | minutes, at most 330 |
| `budget`   | the spend cap in AIC (1 AIC = $0.01) |
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
policy, which the later checks use. A new type, owner or bigger limit is a
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
no change), with Why and News linking the run. Either way `Run` is
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
| `aic_pricing` | string | `api` (billed), `api-equivalent` (a subscription run priced at API rates), `subscription` (no per-token price; the praxis broker caps tokens instead) or `mock` |
| `tools` | object | per tool name: `calls`, `errors` and `duration_s` (integers) |
| `slowest` | array | at most 10 of `{tool, summary, duration_s}`, slowest first |
| `failures` | array | `{kind, message}`, `kind` one of `tool_error`, `timeout`, `budget`, `validation`, `agent_exit` |
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

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
| `model`    | the model name, empty for the agent's default |
| `cores`    | `4`, `16` or `64` |
| `timeout`  | minutes, at most 330 |
| `budget`   | the spend cap in AIC (1 AIC = $0.01) |
| `workflow` | `branch` or `analysis` |
| `brief`    | the task text: `bot-runs dispatch` sends the runner-side worker brief (`dotfiles/.agents/skills/coordinator/runner-preamble.md`), the run's target, then the given brief, unless `--no-preamble` |

Dispatch inputs are public in a public repository and capped at 65,535
characters in total, so a brief follows the board's no-private-data rule.

**Public repositories only.** An agent run's logs and transcripts are
public, so `repo` must be a public repository (devspaces are for
CNCF-adjacent work, never private code). `bot-runs dispatch` refuses a
repository that GitHub doesn't confirm is public, and so does the workflow,
before it clones anything and again before it uploads anything; any error
or doubt refuses.
The workflow sets `run-name: agent ${{ inputs.item }} ${{ inputs.repo }}`:
`bot-runs` reads the item and repository from a run's `display_title`
when nothing else is left of the run.

### On the board

The run, not the session that dispatched it, is the source of truth for
its item. `bot-runs dispatch` writes the run URL into the item's `Run`
text field (adding the field to the board if it has none) and sets
Status In Progress with a News line. `bot-runs reconcile`, which
`bot-watch` runs on every sweep, follows that field: while the run goes
on the item stays In Progress; once it is over, an item still In
Progress moves to Draft if the run succeeded with a patch (ready for
`bot-runs apply`, which isn't run unattended until
[homegit#82](https://github.com/cgwalters-bot/homegit/pull/82) hardens
it), and back to Todo otherwise (failure, timeout, budget, cancelled, or
no change), with Why and News linking the run. Either way `Run` is
cleared, so an item In Progress without a `Run` is local work, and a
finished run never moves an item twice.

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

**`agent-out`**, with `retention-days: 30`, is uploaded only by a
`branch` run that changed files. It holds `changes.patch`, the change as
a binary `git diff` against the run's starting commit (new files
included, nothing committed, at most 8 MiB), and `base.json`
(`{repo, ref, commit}`). The runner has no credentials, so it can't push.
The patch isn't redacted, because that would corrupt it; a
secret-shaped string in it fails the upload instead.
`bot-runs apply RUN --slug SLUG --message FILE` checks it again locally
(size, base, secret-shaped strings, no `.github/`, `.git` or
`.gitmodules` paths, no symlinks or submodules). It then commits it as
the bot on `bot/SLUG` in a fresh clone of the target. After review,
`bot-pr fork-pr --from DIR` opens it on the forge.

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
| `patch` | object | branch runs that changed files: `base` (the commit the change is against), and `bytes` (of `changes.patch`) or `error` (why no change was handed back); else `null` |
| `egress_denied` | array | `{domain, count}` from the proxy log (empty while egress is open) |
| `outcome` | object | `status` (`Draft`, `Needs human` or `null`), `url` (the forge PR or write-up, once applied, else `null`) and `why` |
| `redactions` | integer | how many strings the redaction pass replaced |

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

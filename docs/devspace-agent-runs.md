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
on `agent.yml` at `main` with `return_run_details: true`, which answers
`200` with `workflow_run_id`, `run_url` and `html_url` instead of `204`,
so no polling is needed to find the run. The inputs are all strings:

| Input      | Meaning |
|------------|---------|
| `item`     | the board item id (`PVTI_...`) |
| `repo`     | the target repository, `OWNER/REPO` |
| `base`     | its base ref |
| `agent`    | `claude` or `opencode` |
| `model`    | the model name, empty for the agent's default |
| `cores`    | `4`, `16` or `64` |
| `timeout`  | minutes, at most 330 |
| `budget`   | the spend cap in AIC (1 AIC = $0.01) |
| `workflow` | `branch` or `analysis` |
| `brief`    | the task text |

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
- `outcome.json`: the agent's own outcome (tests run, early-stop
  reasons); step 3 of the plan defines it along with the rest of
  `outputs/v1`, which travels in a separate `agent-out` artifact.

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
| `aic` | number | estimated cost in AIC |
| `aic_budget` | number | the dispatched budget |
| `aic_pricing` | string | `api` (billed), `api-equivalent` (a subscription run priced at API rates) or `mock` |
| `tools` | object | per tool name: `calls`, `errors` and `duration_s` (integers) |
| `slowest` | array | at most 10 of `{tool, summary, duration_s}`, slowest first |
| `failures` | array | `{kind, message}`, `kind` one of `tool_error`, `timeout`, `budget`, `validation`, `agent_exit` |
| `tests` | array | `{command, exit_code, duration_s}` from `outcome.json` |
| `files` | array | paths the agent changed, relative to the repository |
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

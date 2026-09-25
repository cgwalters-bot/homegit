# Agent retros

A retro reads what the bot's agents actually did, from their logs, and
looks for problems worth fixing in the tooling, the skills or the
workflow: the things nobody notices in a single run but that repeat
across dozens. `bin/bot-retro` does the mechanical part; a person or an
agent reads its report and decides what to act on.

## What a retro looks for

- **Tool errors and retries**: failed tool calls by class (rate limits,
  shell syntax errors, CLI flags that don't exist, missing files, git
  errors, exit codes), and identical failing commands run again unchanged.
- **Policy violations** of the worker preamble and AGENTS.md: builds and
  tests on the coordinator machine instead of a devspace, pushes with a
  `fixup!`/`squash!` commit still pending, `Signed-off-by` added (by
  `-s`/`--signoff` or by hand), branch-changing git in a shared clone
  under `~/src/github/cgwalters-bot/` instead of a worktree, and
  prompt-injection: instruction-shaped text arriving from GitHub or the
  web, and subagent output the harness flagged as instruction-shaped.
- **Wasted loops and long waits**: sleeps the harness blocked, the same
  command polled over and over, tool calls or wait loops blocking for
  over 10 minutes, idle gaps over 30 minutes, messages sent to agents the
  user had stopped.
- **Reviewer-caught bugs**: each reviewer's verdict and its numbered
  findings, sorted into rough categories (correctness, tests, error
  handling, security, commit message, claims, docs, cleanup), so the
  categories reviewers keep catching can move into the worker checklist.
- **Stopped or interrupted agents**: agents the user stopped, tool calls
  rejected or interrupted, and transcripts that end inside a tool call.
- **Repeated manual steps**: command shapes (`gh api repos/O/R/pulls/N`,
  `git worktree add`) that many agents type by hand, candidates for a
  `bot-*` tool or a skill recipe.
- **Claims without test evidence**: a final report saying tests pass
  with no successful test command in that agent's transcript, and
  devspace runs proposed as Draft with no tests recorded.

All of these are heuristics over command lines and text, tuned against
real transcripts: expect some false positives, and read the examples
before acting on a count.

## Sources

**Local transcripts.** Today most work runs as subagents of a
coordinator session on this machine. Claude Code keeps each session's
transcript as JSONL under
`~/.claude/projects/-var-home-sandbox-walters-src-github-cgwalters-bot/`:
`SESSION.jsonl` for the coordinator, and
`SESSION/subagents/agent-ID.jsonl` with `agent-ID.meta.json` (its task
description) for each subagent. `bot-retro` reads the files changed in
the window and the records inside it.

**Devspace agent runs.** Runs of `agent.yml`
([devspace-agent-runs.md](devspace-agent-runs.md)) are read through
`bot-runs list` and `bot-runs show`: result, failures, egress denials,
the slowest tools, budget use and recorded tests from `summary.json`.
With `--run-transcripts`, `bot-runs transcript` unpacks each run's
`agent-transcript` artifact and its `sessions/` JSONL is scanned like a
local transcript (builds are expected there, so the local-build check is
off). Transcripts expire after 30 days, summaries after 90.

## Output

`bot-retro` builds a structured summary (`--json`, schema
`bot-retro-summary/v1`) and renders it as a dated Markdown report:
counts per signal with a few examples each, reviewer findings, repeated
steps, devspace runs, and up to five proposed board drafts ranked by
weight (policy over claims over stops and waste over plain errors) and
by how many agents each touched.

Transcripts hold private text: prompts, tool output, other people's
comments. The report quotes at most 120 characters per example,
replaces token-shaped strings (the patterns of the devspace redaction,
plus any long digit-bearing run that is neither hex nor a path) with
`[REDACTED]`, and still belongs in a **secret** gist, never in a public
issue. Board drafts carry only the generic proposal text and the gist
link, since the board is visible to more people than the gist.

```bash
bot-retro --since 24h > retro.md          # read it first
bot-retro --since 24h --json > summary.json
bot-retro --from-summary summary.json --narrate --gist --drafts 3
```

`--narrate` hands the summary (never the raw logs) to an agent,
`claude -p` by default (`BOT_RETRO_AGENT`), for a short narrative at the
top of the report. `--gist` posts the report as a secret gist and prints
its URL; `--drafts N` adds the top N proposals to the board as drafts
with no Status (so they wait for triage), Priority P1 and Org
cgwalters-bot. Curating the proposals by hand (`bot-board draft`) is
often better than filing them blind.

## Where this goes

Once agents run in devspaces rather than as local subagents, their
transcripts live in Actions artifacts, and the local source fades out.
Transcripts of runs on non-public repositories must then be encrypted
(`transcript.tar.zst.age`, which `bot-runs transcript` already
decrypts with `BOT_RUNS_AGE_IDENTITY`), so only a holder of the age
identity can read them.

The retro then becomes a scheduled workflow: weekly, it runs
`bot-retro --since 7d --run-transcripts --narrate --gist --drafts 3`,
posting the report as a secret gist and filing drafts for triage. That
needs a job that can decrypt transcripts, create gists and write to the
board, so it needs secrets (the age identity, a token for the bot) that
no workflow holds yet; until they are provisioned deliberately, the
retro runs by hand from this machine. Nothing here is wired into a
workflow, and nothing should be until that step is designed with the
secrets it needs.

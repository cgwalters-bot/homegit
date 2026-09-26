cgwalters-bot
-------------

This is a fork of [cgwalters/homegit](https://github.com/cgwalters/homegit)
used as the dotfiles and prompt repository for the
[cgwalters-bot](https://github.com/cgwalters-bot) GitHub account, an agentic
bot that helps with upstream contributions. Commits made from this
environment are authored as `Colin Walters <walters+llm@verbum.org>` (see
`bin/bot-git`), and the agents' work is
coordinated through the [Workstream](https://github.com/users/cgwalters-bot/projects/1)
project board: a human moves items into Todo, the bot claims them, pushes
tested branches to forks in the [cgwalters-forge](https://github.com/cgwalters-forge)
organization and proposes them there as draft PRs (Draft),
and only once cgwalters approves one does it go upstream (In Review);
only a human's acceptance makes something Done.

Install with `make install` as usual. The shared agent prompt is still
[AGENTS.md](AGENTS.md), and the skills in `dotfiles/.claude/skills` are
picked up by both agent CLIs: `workstream` (using the board),
`backlog-planning` (refilling the board from recent GitHub activity),
`bot-feedback` (surfacing reactions on the bot's work), `bot-notify`
(routing mentions of and requests to the bot),
`upstream-pr` (how to contribute as the bot, with `bot-pr`), `devspace-work` (building
and testing on a remote runner), `coordinator` (running a top-level
session that polls, dispatches worker and reviewer subagents, and writes
the morning brief; the preambles it briefs them with live next to it), plus the upstream ones like
`commit-review`.

The bot uses two agents, each on its own subscription. opencode is
configured for OpenAI only; authenticate it with `opencode auth login` and
pick OpenAI (ChatGPT Plus/Pro). Claude Code uses a Claude subscription; for
headless runs generate a long-lived token with `claude setup-token` and
export it as `CLAUDE_CODE_OAUTH_TOKEN`. (Anthropic subscription credentials
must not be used through opencode.) Both need the `gh` CLI logged in as
cgwalters-bot, either via `gh auth login` or a `GH_TOKEN`, with the
`project` scope in addition to the usual repo access.

To run a single unattended session, use `bot-work`, which by default runs
opencode and picks up or advances the next board item; `bot-work --agent
claude` uses Claude Code instead, and any extra arguments are passed along
as additional instructions. `bot-work --plan` instead reviews recent GitHub
activity (the last week, or `--since YYYY-MM-DD`) and adds candidate items
to the board for triage. Only one session runs at a time, across all
machines: besides a local lock, `bot-work` holds a lease in an archived
board item (`bot-state: lease`) while the agent runs, which lapses 20
minutes after its machine stops renewing it.

People often react to the bot with an emoji rather than a comment, so
the `bot-feedback` skill has an agent review each new 👎 or 😕 on
everything cgwalters-bot wrote and file it, with an assessment, as an
issue on [cgwalters-bot/cgwalters-bot](https://github.com/cgwalters-bot/cgwalters-bot/issues)
for cgwalters; `backlog-planning` runs it first, and a scheduled job to
run it is planned.

Likewise `bot-notify` polls the bot's notifications: a mention, review
request or assignment by cgwalters becomes a Todo item on the board,
while one by anyone else is filed as an issue for cgwalters and never
acted on. GitHub doesn't reliably notify the bot, so it also checks
cgwalters' public events and searches for mentions. Its poll state lives
on the board itself, in an archived draft item (`bot-state:
notifications`), so any machine can pick up where the last run stopped. Agents run it at the start of each session and planning
pass for now; running it on a schedule comes later.

Pings are only part of it: `bot-watch` sweeps the issues and PRs of the
items on the board and reports what changed on each since it last
looked (new comments and reviews, merges and closes, pushes by others,
CI going red), and with `--apply`, when it sees an item's upstream PR
merge or close, moves it to Done or Needs human (from Todo, Draft or In
Review only). Its last-seen state is another archived item,
`bot-state: watch`. Every sweep also lists the bot's PRs that just need
a rebase (behind their base with CI failing, or conflicting); `bot-pr
rebase URL` does that for a conflict-free one, keeping my sign-off, and
the coordinator runs it on its own.

### Overnight working model

The agents run on a trusted machine that holds the clones and the bot's
credentials, and borrow compute for building and testing. `bot-devspace`
(installed by `make install` like the rest of `bin/`) dispatches an
ephemeral RHEL 10 runner from
[bootc-dev/cgwalters-devspace-sandbox](https://github.com/bootc-dev/cgwalters-devspace-sandbox),
waits for it to be reachable over the tailnet and hands out an
ssh_config for its unprivileged `runner-sandbox` user (the workflow installs the
toolchain: podman, gcc, Rust, bcvk, ...), so an agent edits
locally, pushes its branch to the devspace with plain git over SSH, runs
the project's tests there (KVM is available for VM tests), and pushes the
tested branch to the forge fork from the local machine. No credentials are
ever copied to a devspace, and the SSH user can't reach the runner's
own (see the `devspace-work` skill); `tests/bot-devspace.sh` tests which
user `bot-devspace` picks. `bot-devspace stop` cancels the runner, since
they're billed while they run.

The next step moves the agents themselves onto devspaces: an `agent.yml`
workflow runs an agent on one board item, with its condensed transcript
in the Actions log and a summary artifact per run
([plan](https://gist.github.com/cgwalters-bot/3d0b10312e6d6170f8e07967b7795bed)).
`bot-runs`, modeled on `gh aw logs` and `gh aw audit`, dispatches those
runs and reads them back (`list`, `show`, `log`, `transcript`, `diff`
and `stats`, over REST only). What a run leaves behind is specified in
[docs/devspace-agent-runs.md](docs/devspace-agent-runs.md), and
`tests/bot-runs.sh` tests the tool offline against fixtures that follow
it.

`bot-cost` estimates what all of this costs, per UTC day and per task:
runner time of the devspace and agent workflows (core-hours at GitHub's
published per-minute Linux runner rates, a notional figure for runners
that may be self-hosted), and inference tokens from the local
transcripts and agent runs' `token-usage.jsonl`, at the per-model prices
from [models.dev](https://models.dev). The coordinator puts yesterday's
estimate in the morning brief. `bot-footer` turns one task's share into
a run footer that fork PRs carry in their bot-meta section (see "Run
footer" in the same doc).

`bot-board` is a small CLI over `gh project` for the Workstream board
(`list`, `show`, `add`, `draft`, `set`, and `state-get`/`state-put` for
the scripts' state items), which caches reads because the
bot's GraphQL quota is shared by every agent. The state items are what
lets any machine run a session: nothing a script needs to remember lives
only on one machine, and `state-put --checked` merges the changes of two
machines writing the same item at once. `tests/bot-state.sh` tests that
state handling offline, against a fake `gh`. Each item's Workflow field
says what the bot delivers: a tested branch proposed as a draft PR on a
forge fork (`branch`, the default), a write-up in a secret gist (`analysis`), a
draft PR straight upstream (`pr`, set only by a human), or nothing
(`manual`). In the morning, Draft items link to what's ready for review.

### Reviewing the bot's work

The bot doesn't open upstream PRs on its own. A finished `branch` item is
a draft PR from `bot/<slug>` into the upstream base branch of a fork in
[cgwalters-forge](https://github.com/cgwalters-forge) (`cgwalters-forge/REPO`),
linked from the item's Branch field, whose title and description are
already written as the upstream PR. A trailing section between
`<!-- bot-meta -->` markers names the upstream repository and base
branch, and the board item. On that PR:

- **Approve** it, or comment **`/promote`** on a line of its own, to have
  it opened upstream, ready for review. Other wording ("go ahead", "ship
  it") is not an approval; the bot's inbox flags it so you get asked for
  `/promote`.
- Add a **`/draft`** line (in the `/promote` comment, or earlier) to have
  it opened upstream as a draft (a later `/ready` takes that back).
- **Comment** (inline or on the PR) to ask for changes, including commit
  message rewording; the bot answers with squashed fixups and a reply.
  An approval or `/promote` covers the commits pushed before it, so
  changes pushed after it need another one.
- **Edit** the title and description as you like: they are copied
  upstream as they stand at approval, minus the bot-meta section.
- **Close** it to drop the change; the item becomes Done as dropped.

Forge forks start with a clean `main` synced from upstream, and both
accounts can push to them. They run no CI: every workflow is disabled
(`bot-pr fork-setup`), because the forks share one runner pool that a
single bootc PR's matrix fills, and the bot tests every change on a
devspace, whose results the PR description gives. Upstream CI runs once
the PR is promoted. A change to a workflow itself is exercised by opting
that workflow in (`bot-pr fork-setup REPO --ci FILE`, undone with
`--no-ci`). The bot's
personal forks (`cgwalters-bot/REPO`) are only for scratch work.

`bot-pr` implements the bot's side: `fork-pr` creates the
forge fork if needed and opens the fork PR, `get-body` and `set-body`
update its description without overwriting your edits, `refresh-meta`
brings its bot-meta section up to date when the template changes,
`inbox` lists your activity on them since its last run (only the `cgwalters` login
counts, so the bot's own edits, pushes and comments are left out), and
`promote` rebases onto upstream, opens the
upstream PR, closes the fork PR and moves the item to In Review. Agents
run `bot-pr inbox` at the start of every session. What inbox has already
reported is kept in the archived `bot-state: pr-inbox` board item, so it
doesn't matter which machine runs it.

### The bot's own repositories

The bot's own repositories (this one, cgwalters-bot/cgwalters-bot,
debug-bootc-to-disk-virtiofsd, ostree-missing-refs and
praxis-credential-broker, plus cgwalters-forge/review and
cgwalters-forge/.github) take changes only as pull requests: a ruleset
on main requires one with a green `ci` check, up to date with main,
and linear history, with no bypass, and blocks force-pushes and
deleting main. They only allow rebase merges, to keep the commits as
written, with auto-merge on and branches deleted on merge. `bot-land`
lands a branch: it pushes it, opens the pull request, enables
auto-merge and waits, rebasing when main moved on. A rebase merge
re-commits the commits unsigned, with the merging account (the bot) as
committer. Here `ci` (`.github/workflows/ci.yml`) runs shellcheck,
`node --check` and every `tests/*.sh`.

### Contribution policy gate

Some projects accept AI-assisted code but want the PR text to be a
human's, and some want no AI contributions at all. So `promote` and
`signoff` first run `upstream-policy check OWNER/REPO`, which reads the
record in `upstream-policy/OWNER/REPO.md` here: a verdict (`bot-ok`,
`human-text`, `human-only` or `no-go`), the AI trailer and DCO
expectations, and the blob ids of every policy file it was based on
(CONTRIBUTING, AGENTS.md, PR templates, AI policies, the org's `.github`
defaults), with the quotes and rationale in its body. They refuse
unless the record is committed, every source is unchanged on upstream's
default branch, no new policy file has appeared, and the verdict is
`bot-ok`. A separate read-only subagent writes the records
(`dotfiles/.claude/skills/coordinator/policy-check.md`); to overrule
one, I have the bot open a pull request that edits its verdict, and
approve it. Records count only as merged to homegit's main, and a
commit there that loosens a verdict (say human-text to bot-ok) must
come from a pull request whose merged head I approved (or be one of
mine that GitHub shows as verified), so the bot can record and tighten
verdicts but not loosen them: a record's verdict
may be no looser than the strictest it held since I last loosened it,
across edits, deletions and moves (git's rename detection, and paths
that differ only in case), so anyone else's loosening blocks the gate
until it's tightened back. Records must be regular files, not symlinks.
A ruleset on this repository blocks force-pushes to main and deleting
it (and takes changes only as pull requests, see below), and the
check also refuses a main that doesn't descend from the last one it
accepted (kept in `~/.local/state/upstream-policy/`), since rewritten
history could make a loosened record look newly created.

For `human-text`, I retitle the fork PR, rewrite its body and reword
the commits myself, push them myself, and approve with a `/promote
--human-text` line; promote checks that GitHub shows me as the pusher
of the approved head and the last editor of the title and body, and
adds nothing to the body. Or I open the upstream PR myself.
`tests/upstream-policy.sh` tests the check offline.

Open decision: a project whose policy files say nothing about AI is
recorded as `human-text` for now, to be safe. If that turns out too
strict, the policy-check prompt is where to change it.

### Signing off the bot's PRs (DCO)

The bot never adds `Signed-off-by` itself. When I approve a fork PR (or
comment `/promote`) for a project that requires DCO (bootc-dev, among
others), that approval is my sign-off: `bot-pr promote` adds my
`Signed-off-by` to the bot's commits, with me as committer, before opening
the upstream PR, and names the approval in its body. Others' commits get it
only with `--include-others`. A project requires DCO if its branch rules
require the DCO check or if the DCO app's check runs there anyway. For an
upstream PR promote opened without my sign-off, `bot-pr signoff
<upstream-pr-url>` adds it on the same approval, as long as the PR's head
is still what promote opened it with.

Upstream PRs that didn't go through promote still sit with a failing DCO
check until a human signs off. `bin/dco-signoff`, run by me with my own git
identity and gh login, finds them and fixes that:

```
dco-signoff --dry-run      # list them and prepare the rewrite, push nothing
dco-signoff                # ask before pushing each one
dco-signoff https://github.com/bootc-dev/bootc/pull/2494 --yes
```

It looks at the open PRs authored by cgwalters-bot and those from
cgwalters-forge branches, keeps those whose base branch requires a DCO
status check, and for each one missing my sign-off rebases its commits
with `git rebase --signoff` onto their existing merge-base (hooks off),
checks that every rewritten commit has the original tree and author,
and force-pushes with a lease on the head it fetched. It refuses to run
as the bot, and to sign off other people's commits without
`--include-others`; `tests/dco-signoff.sh` tests it offline.

To pick up changes from the upstream repository:

```
git fetch upstream && git merge upstream/main
```

Colin's dotfiles and misc. scripts
----------------------------------

I keep basic config files like `~/.emacs` and `~/.bashrc` in git.
There might be something useful in there for you.  I also have a
collection of miscellaneous scripts in `bin/`, mostly git wrappers.

If you like this repository, you might also find my personal
Ansible https://github.com/cgwalters/ansible-personal repository
useful.

## Agent configuration

This repository also contains [AGENTS.md](AGENTS.md), my default system prompt for agents.

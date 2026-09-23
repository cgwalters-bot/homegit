cgwalters-bot
-------------

This is a fork of [cgwalters/homegit](https://github.com/cgwalters/homegit)
used as the dotfiles and prompt repository for the
[cgwalters-bot](https://github.com/cgwalters-bot) GitHub account, an agentic
bot that helps with upstream contributions. Commits made from this
environment are authored as `cgwalters-bot`, and the agents' work is
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
and testing on a remote runner), plus the upstream ones like
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
to the board for triage.

People often react to the bot with an emoji rather than a comment, so
the `bot-feedback` skill has an agent review each new 👎 or 😕 on
everything cgwalters-bot wrote and file it, with an assessment, as an
issue on [cgwalters-bot/cgwalters-bot](https://github.com/cgwalters-bot/cgwalters-bot/issues)
for cgwalters; `backlog-planning` runs it first, and a scheduled job to
run it is planned.

Likewise `bot-notify` polls the bot's notifications: a mention, review
request or assignment by cgwalters becomes a Todo item on the board,
while one by anyone else is filed as an issue for cgwalters and never
acted on. Its poll state lives on the board itself, in an archived draft
item (`bot-state: notifications`), so any machine can pick up where the
last run stopped. Agents run it at the start of each session and planning
pass for now; running it on a schedule comes later.

### Overnight working model

The agents run on a trusted machine that holds the clones and the bot's
credentials, and borrow compute for building and testing. `bot-devspace`
(installed by `make install` like the rest of `bin/`) dispatches an
ephemeral RHEL 10 runner from
[bootc-dev/cgwalters-devspace-sandbox](https://github.com/bootc-dev/cgwalters-devspace-sandbox),
waits for it to be reachable over the tailnet, installs a toolchain
(podman, gcc, Rust, ...) and hands out an ssh_config, so an agent edits
locally, pushes its branch to the devspace with plain git over SSH, runs
the project's tests there (KVM is available for VM tests), and pushes the
tested branch to the forge fork from the local machine. No credentials are
ever copied to a devspace; see the `devspace-work` skill. `bot-devspace
stop` cancels the runner, since they're billed while they run.

`bot-board` is a small CLI over `gh project` for the Workstream board
(`list`, `show`, `add`, `draft`, `set`), which caches reads because the
bot's GraphQL quota is shared by every agent. Each item's Workflow field
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

- **Approve** it to have it opened upstream, ready for review.
- Comment **`/draft`** and approve to have it opened upstream as a draft
  (a later `/ready` takes that back).
- **Comment** (inline or on the PR) to ask for changes, including commit
  message rewording; the bot answers with squashed fixups and a reply.
  An approval covers the commit you approved, so changes pushed after it
  need another approval.
- **Edit** the title and description as you like: they are copied
  upstream as they stand at approval, minus the bot-meta section.
- **Close** it to drop the change; the item becomes Done as dropped.

Forge forks start with a clean `main` synced from upstream, both accounts
can push to them, and PRs into them run the project's own CI. The bot's
personal forks (`cgwalters-bot/REPO`) are only for scratch work.

`bot-pr` (REST only) implements the bot's side: `fork-pr` creates the
forge fork if needed and opens the fork PR, `inbox` lists your activity on them since its last run (only the
`cgwalters` login counts), and `promote` rebases onto upstream, opens the
upstream PR, closes the fork PR and moves the item to In Review. Agents
run `bot-pr inbox` at the start of every session.

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

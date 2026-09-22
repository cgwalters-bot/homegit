cgwalters-bot
-------------

This is a fork of [cgwalters/homegit](https://github.com/cgwalters/homegit)
used as the dotfiles and prompt repository for the
[cgwalters-bot](https://github.com/cgwalters-bot) GitHub account, an agentic
bot that helps with upstream contributions. Commits made from this
environment are authored as `cgwalters-bot`, and the agents' work is
coordinated through the [Workstream](https://github.com/users/cgwalters-bot/projects/1)
project board: a human moves items into Todo, the bot claims them, opens
draft PRs from its forks, and moves them through In Progress, Needs human
and In Review; only a human's acceptance makes something Done.

Install with `make install` as usual. The shared agent prompt is still
[AGENTS.md](AGENTS.md), and the skills in `dotfiles/.claude/skills` are
picked up by both agent CLIs: `workstream` (using the board),
`backlog-planning` (refilling the board from recent GitHub activity),
`upstream-pr` (how to contribute as the bot), plus the upstream ones like
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
to the board for triage. For now these runs happen locally; running them
remotely in a sandbox via
[bootc-dev/cgwalters-devspace-sandbox](https://github.com/bootc-dev/cgwalters-devspace-sandbox)
is planned.

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

# Bootstrapping a new operator

This harness runs one bot account on behalf of one human, the
*operator*: the bot acts only on the operator's asks and reviews, and
only the operator's approval sends its work upstream. It was written for
cgwalters and cgwalters-bot. Another operator needs the accounts and
repositories below, and an operator config naming them. Without a config
file, every tool uses cgwalters' setup.

## The operator config

The tools read one JSON file: `$BOT_OPERATOR_CONFIG` if that is set, else
`${XDG_CONFIG_HOME:-~/.config}/bot-harness/operator.json`. Every key is
optional, and a missing file means the defaults (unless
`$BOT_OPERATOR_CONFIG` names it: then it must exist). An unknown key, an
invalid value, or a bot login or git email equal to the operator's is an
error, not a silent fallback. `bot-operator` prints
the resolved config (`bot-operator --json`, `bot-operator get KEY`,
`bot-operator path`).

A typical config for another operator only names the people and the
forge org, and the rest is derived:

```json
{
  "operator": {"login": "jmarrero", "name": "Joseph Marrero", "email": "jmarrero@example.com"},
  "bot": {"login": "jmarrero-bot"},
  "forge_org": "jmarrero-forge",
  "heartbeat_issue": 1,
  "devspace": {"repo": "jmarrero-forge/devspace-sandbox", "host_prefix": "jmarrero-devspace-"}
}
```

| Key | Default | Used for |
|---|---|---|
| `operator.login` | `cgwalters` | the only login whose asks, reviews, `/promote` and answers count; questions are assigned to it |
| `operator.name`, `operator.email` | `Colin Walters`, `walters@verbum.org` | the `Signed-off-by` that `bot-pr promote` and `bot-pr signoff` add on the operator's approval |
| `bot.login` | `cgwalters-bot` | the account `gh` must be logged in as; the bot's PRs, comments and forks |
| `bot.git_name`, `bot.git_email` | `operator.name`, and `operator.email` with `+llm` | the identity `bot-git` commits as; the email is what marks a commit as the bot's |
| `bot.issue_repo` | `BOT/BOT` | where `bot-notify` and `bot-feedback` file pings and reactions from others |
| `bot.homegit_repo` | `BOT/homegit` | the homegit whose main holds the upstream-policy records |
| `forge_org` | `cgwalters-forge` | the org holding the forks that fork PRs are opened on |
| `tracker_repo` | `FORGE/tracker` | work items, epics, and the question and ask issues |
| `heartbeat_issue` | 176 for cgwalters' tracker, else none | the pinned issue `bot-heartbeat` writes to |
| `board.owner_type`, `board.owner`, `board.number` | `orgs`, `forge_org`, 1 | the Workstream board |
| `board.state_items` | none (bot-board knows cgwalters' board's) | ids of the archived `bot-state:` items; see below |
| `board.epics` | `composefs-stable` for cgwalters' board, else none | milestone boards, by `bot-board --project` name; `bot-priority-health` sweeps the first |
| `generated_by_url` | `https://github.com/OPERATOR/#llms` | the `Generated-by:` line `bot-pr fork-pr` expects in PR bodies |
| `devspace.repo` | `bootc-dev/cgwalters-devspace-sandbox` | the repository whose `devspace.yml` `bot-devspace` dispatches, and `bot-runs` reads |
| `devspace.host_prefix` | the repository's name without `-sandbox`, plus `-` | the runners' MagicDNS host names, `PREFIX` + run id |
| `pacing.agents` | 4 | how many work agents the coordinator keeps busy (`bot-pace slots`) |
| `pacing.harness_agents` | half of `pacing.agents`, rounded down | how many of them work on the harness (the bot's and the forge org's repositories); the rest on upstream work |
| `pacing.budgets` | `{"P0": "M", "P1": "S", "P2": "S"}` | the Est. cost bucket (XS to XL) an item without one is budgeted at, by priority; merged over the defaults |
| `pacing.opencode_share` | `0.25` | the share of the agents that are devspace runs, of either agent (the name is from when `agent.yml` ran only opencode; a run is claude while the claude pool is behind its pace and the openai one held or ahead), 1 in 4, as a number from 0 to 1; the target is rounded up, so one remote run is allowed while any agent is. `bot-reconcile`'s dispatch rule auto-dispatches only while the remote runs are under it |
| `pacing.opencode_runs` | `2` | the most devspace runs going at once, whatever the share says: a hard limit that needs no usage reading |
| `pacing.pools` | `{"claude": {"target": 0.95, "burst": 3}, "openai": {"target": 0.95, "burst": 3}}` | each inference pool's pace, merged over the defaults: `target` is the share of the pool's window to have used by its reset (above 0, up to 1; the rest is the operator's reserve), `burst` the percent points of slack over an even pace, so that work can start right after a reset (it never reaches past the target). `claude` is the Claude subscription (local workers, the apply and review steps, devspace runs of claude), `openai` the Codex one through the praxis broker (devspace runs of opencode). `bot-capacity` shows each pool's pace; one over it holds only the work routed to it |

Node tools load it with `lib/operator.js`, shell tools by sourcing
`bin/operator.sh` (which runs `bot-operator --shell`), and `bot-poll`
with `crates/bot-poll/src/operator.rs`; `tests/fixtures/operator/cases.json`
holds the cases both loaders are tested against.

## Accounts and token

- The bot's own GitHub account, separate from the operator's.
- A classic personal access token for the bot with the scopes `repo`,
  `project`, `workflow`, `gist`, `notifications` and `read:org`, given to
  `gh` as `GH_TOKEN` or with `gh auth login`. It stays on the machine that
  runs the agents; it is never copied to a devspace.
- The operator's own `gh` login is only needed for `dco-signoff`, which
  runs as the operator.

## Forge org, tracker and board

Create an org for the forks (`forge_org`), with the bot as a member that
can create repositories, and a tracker repository in it (`tracker_repo`).
The bot needs write access to the tracker. For the heartbeat, open an
issue titled "Bot heartbeat" in the tracker, pin and lock it, and set
`heartbeat_issue` to its number.
`bot-heartbeat publish` also writes a usage snapshot, which must not be
public: create a private repository `bot-ops` in the forge org, with the
bot able to write to it, and a locked issue #1 titled "Bot usage" (or
publish with `--no-usage`).

The Workstream board is an org-owned Projects (v2) board (GitHub Apps and
fine-grained tokens can't write a user's), with the bot able to edit it.
The tools look fields and options up by name, so these must match
exactly. Create them in the board's settings, or with
`bot-board field-ensure [--number] NAME`, which adds a text field (a
number field with `--number`) unless one exists. It cannot create a
single-select: those, with their options, are always made by hand.

| Field | Type | Options | Needed | Created | Read or written by |
|---|---|---|---|---|---|
| `Status` | single select | Todo, In Progress, Draft, Needs human, In Review, Done | required | by hand | everything |
| `Priority` | single select | P0, P1, P2 | required | by hand | `bot-board`, `bot-pace`, `bot-capacity`, `bot-priority-health` |
| `Workflow` | single select | branch, analysis, pr, manual | required | by hand | `bot-board`, the workstream skill |
| `Org` | single select | one per upstream org the bot works on, plus one named after the bot's login, one after the forge org, and `other` | required | by hand | `bot-board` (`fill-org`) |
| `Why`, `Branch` | text | | required | by hand | `bot-board set`, `bot-pr`, `bot-watch`, `bot-reconcile` |
| `Gist` | text | | required | by hand | `bot-board set`, `bot-notify`, `bot-retro` |
| `News` | text | | required | by hand | `bot-board set --news` (one dated line), `bot-watch`, `bot-runs`, the review app |
| `Lead` | text | | required | by hand | `bot-pace assign` (`coordinator`), topic sessions, `bot-reconcile`, `bot-board` |
| `Est. cost` | single select | `XS (<200k tok)`, `S (<1M tok)`, `M (<5M tok)`, `L (<20M tok)`, `XL (>20M tok)` | required for pacing | by hand | `bot-pace` (budgets), `bot-capacity` |
| `Budget tokens` | number | | required for pacing | automatically, by `bot-pace` | `bot-pace`, `bot-reconcile` |
| `Actual tokens` | number | | required for pacing | automatically, by `bot-actuals` | `bot-actuals`, `bot-reconcile`, `bot-pace` |
| `Run` | text | | required for devspace runs | automatically, by `bot-runs dispatch` | `bot-runs`, `bot-reconcile`, `bot-pace` |
| `Theme` | single select | one per theme you group work by | optional | by hand | `bot-priority-propagate` only |
| `Verdict`, `Verdict target` | | | unused | not needed | nothing in homegit; legacy fields of cgwalters' board that a new board can leave out |

The options of `Est. cost` are the strings in `lib/capacity.js`; a
different spelling is not found and the item counts as unestimated.
`Needs human` is a Status option, not a field.

Two labels drive the dispatcher (create them in the tracker and in each
of the bot's repositories whose issues are on the board): `dispatch`, which
opts an issue in to `bot-reconcile`'s auto-dispatch of a devspace run, and
`escalate`, which marks an issue the dispatcher filed for the coordinator.

Assignees say whose turn an issue or PR in the forge org, the bot's
repositories or the tracker is (the `workstream` skill's "Whose turn"):
the bot assigns the operator each time something waits on them, and
assigns itself when they act. GitHub emails and notifies the operator on
each of those assignments; that is the point, but they can route them
in their notification settings (assignments come with the reason
`assign`). Both must be assignable in each of those repositories, as
members of the forge org or collaborators; `bot-board assign` says so
when GitHub drops an assignee.

The views in the `workstream` skill are optional; the Projects API can't
create them, so they are made by hand.

The tools keep their shared state in archived draft items on the board
(`bot-state: notifications`, `watch`, `pr-inbox`, `lease`, `tmt-numbers`).
`bot-board state-put` creates one the first time it is written and caches
its ids on that machine, then prints them: add them to `board.state_items`
so that every machine finds the same items.

## Devspaces

All builds and tests run on devspaces, ephemeral GitHub Actions runners
reached over a Tailscale tailnet (see `bot-devspace --help` and the
`devspace-work` skill). They need a repository with the `devspace.yml`
workflow, like a copy of
[cgwalters-devspace-sandbox](https://github.com/bootc-dev/cgwalters-devspace-sandbox),
with its Tailscale variables (`TS_OAUTH_CLIENT_ID`, `TS_AUDIENCE`) set and
runners it may use; the bot needs to be able to dispatch and cancel its
workflows. Set `devspace.repo` to it, and `devspace.host_prefix` to the
host name prefix its workflow gives the runners (the default derives it
from the repository name, which only matches if the workflow was renamed
the same way). The machine running the agents must be on the tailnet and
able to reach the runners on port 22.

## homegit and the agents

Clone homegit where the skills expect it, `~/src/github/BOT/homegit`, and
install the tools with `make install-bin` (symlinks into `~/.local/bin`)
and `make install-crates` (`bot-poll`, with cargo). The coordinator's
sweeps run from the `bot-sweep.timer` systemd user unit in
`dotfiles/.config/systemd/user`: copy both `bot-sweep.*` units to
`~/.config/systemd/user`, put any host settings in
`~/.config/bot-sweep.env` (see `bin/bot-sweep --help`: the toolbox to
sweep in, and the existing file holding the bot's gh token if `GH_TOKEN`
isn't in the user manager's environment), then `systemctl --user
daemon-reload && systemctl --user enable --now bot-sweep.timer`, and
`loginctl enable-linger` so that it runs without a login session.
`make install` and
`make install-dotfiles` also copy `dotfiles/` into the home directory,
which includes cgwalters' own `.bashrc`, `.gitconfig` and `AGENTS.md`;
install the skills by hand instead: `dotfiles/.agents/skills` as
`~/.agents/skills`, with a `~/.claude/skills/NAME` symlink to each skill
for Claude Code.

For Claude Code, the shared `AGENTS.md` (`dotfiles/.config/AGENTS.md`)
holds the commit and attribution rules, and the skills and the
coordinator's preambles say "the operator" wherever they mean the role;
the org, repository and board names in their examples are the default
config's. `dotfiles/.claude/agents/builder.md` defines the builder
subagent. Headless runs (`bot-work --agent claude`) need a token from
`claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN`.

Agent shell commands use Bash without changing the operator's interactive
shell (which may be nushell). The installed `~/.claude/settings.json` sets
`env.CLAUDE_CODE_SHELL` to `/bin/bash`, Claude Code's dedicated shell
override (see [environment variables](https://code.claude.com/docs/en/env-vars)). For a
manual installation, merge `"CLAUDE_CODE_SHELL": "/bin/bash"` into the
existing `env` object in that file, creating the object or file if absent;
preserve all other settings and environment entries. Restart Claude Code
after updating it. `bot-opencode` already sets `SHELL=/bin/bash` only for
its agent subprocess. Write Bash commands directly rather than routinely
wrapping them in `bash -c`.

## Upstream policy

`bot-pr promote` only opens an upstream PR for a repository with a
record in `upstream-policy/` on `bot.homegit_repo`'s main, and only
`operator.login` can loosen a verdict there (in a commit GitHub verified,
or by approving the pull request that merged it). A fork of homegit
starts with cgwalters' records; review them before relying on them.

## Checking the setup

These only read:

```
bot-operator --json
bot-board list
bot-watch --dry-run
bot-notify --dry-run
```

## Tests

The tests in `tests/` assume the default config. On a machine with an
operator config, run them with
`BOT_OPERATOR_CONFIG=tests/fixtures/operator/default.json`;
`tests/operator-config.sh` runs the tools under another operator's
config.

## Not configurable yet

`bot-cost` and `bot-retro` still name cgwalters' runner repositories and
checkout path. The review app (cgwalters-forge/review) reads cgwalters'
board and heartbeat issue, and `bot-review-guide` links to it as
`https://FORGE.github.io/review/`, which another forge org doesn't have
until it deploys its own copy.

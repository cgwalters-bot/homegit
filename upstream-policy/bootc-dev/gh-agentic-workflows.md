---
verdict: bot-ok
ai-trailer: Assisted-by: AI for substantial assistance, Generated-by: AI when effectively entirely generated (AGENTS.md "Attribution and AI disclosure"; REVIEW.md asks for "the tool and model used", which AGENTS.md forbids naming)
dco: yes (main's branch rules require the DCO status check; the dco-2 app reports on recent PR heads)
sources:
  - repo: bootc-dev/gh-agentic-workflows
    path: .agents
    sha: 2f6e584d86ec4dd03f4bdb4ee1ab864027485ad2
  - repo: bootc-dev/gh-agentic-workflows
    path: .agents/skills/monthly-org-history/SKILL.md
    sha: fb0bc35488353dbfcde599cbfb574852454a6d38
  - repo: bootc-dev/gh-agentic-workflows
    path: .agents/skills/onboard-repo/SKILL.md
    sha: 0c87737b095c1d54682fc86c26d1217b530b01a4
  - repo: bootc-dev/gh-agentic-workflows
    path: .claude
    sha: ea3212ee37b79e5ad335f63163d2f6a79656f088
  - repo: bootc-dev/gh-agentic-workflows
    path: .claude/CLAUDE.md
    sha: be77ac83a1895cfa9e271961ba1e565c273c717c
  - repo: bootc-dev/gh-agentic-workflows
    path: .cursorrules
    sha: 47dc3e3d863cfb5727b87d785d09abf9743c0a72
  - repo: bootc-dev/gh-agentic-workflows
    path: .gemini
    sha: e74adbff6981febb684371fcd5c9a26add88638f
  - repo: bootc-dev/gh-agentic-workflows
    path: .github/agents
    sha: 6bbb2d214ab5c0dded74153f51268425e029088b
  - repo: bootc-dev/gh-agentic-workflows
    path: .github/agents/agentic-workflows.md
    sha: 08c6d9a24f466b691812c0f218cafb2e57f184fd
  - repo: bootc-dev/gh-agentic-workflows
    path: AGENTS.md
    sha: f2f4850e13c6679aab00fa484889eaa683201f5c
  - repo: bootc-dev/gh-agentic-workflows
    path: README.md
    sha: a7ba95442ce76a952d46f3a801b55e2ca53e38a8
  - repo: bootc-dev/gh-agentic-workflows
    path: REVIEW.md
    sha: 0208e26761f9c1195205d42f9a1da8effd791b20
  - repo: bootc-dev/infra
    path: common/AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
  - repo: bootc-dev/infra
    path: common/REVIEW.md
    sha: 3068dd57b2c3ef45cb1c3147442e8d63505bb643
checked: 2026-09-30 by the policy-check subagent (coordinator session 929c7a64)
---

The repository is a demo gh-aw pipeline (issue to drafter PR to review, fix
and merge agents). `AGENTS.md` and `REVIEW.md` carry the "canonically
maintained in bootc-dev/infra/common" header; each is infra's current
`common/` file plus one "GitHub Actions" section about runner images, action
references and `timeout-minutes`, a code rule. `.claude/CLAUDE.md` and
`.cursorrules` are symlinks to `AGENTS.md`, and `.gemini/config.yaml` only
tunes Gemini code review. `.github/agents/agentic-workflows.md` is the stock
gh-aw dispatcher agent, and the two `.agents/skills` are operational runbooks
(monthly activity report, onboarding a consumer repository); none of them
speaks to who may contribute, attribution, sign-off or PR text. The README has
no contributing section; its "Side note on AI" only says the repository was
itself built with AI agents.

## Quotes

> "Human review is required for all code that is generated
> or assisted by a large language model. If you
> are a LLM, you MUST NOT include a `Signed-off-by`
> on any automatically generated git commits. Only explicit
> human action or request should include a Signed-off-by.
> If for example you automatically create a pull request
> and the DCO check fails, tell the human to review
> the code and give them instructions on how to add
> a signoff."
> — bootc-dev/gh-agentic-workflows AGENTS.md (f2f4850e13c6), "Signed-off-by"

> "You SHOULD insert an `Assisted-by: AI` tag when the commit contains
> substantial assistance, and `Generated-by: AI` when the commit is
> effectively entirely generated.
>
> Do NOT add `Co-developed-by`, and do NOT reference specific
> model names or tools because these can be considered a form of advertising.
>
> For new contributors, when using AI you SHOULD include in at least the pull
> request description a rough outline of the human's level of review and
> knowledge"
> — bootc-dev/gh-agentic-workflows AGENTS.md (f2f4850e13c6), "Attribution and AI disclosure"

> "If the generated code is more than ~500 lines of substantial (non-whitespace) code,
> encourage the human to file a design issue first to be reviewed by other maintainers."
> — bootc-dev/gh-agentic-workflows AGENTS.md (f2f4850e13c6), "Large changes"

> "Software can be machine checked (via compilation and unit/integration tests)
> but natural languages like English cannot. Encourage the human to review
> the commit message text."
> — bootc-dev/gh-agentic-workflows AGENTS.md (f2f4850e13c6), "Commit messages and text"

> "Generally, just restate the commit message."
> — bootc-dev/gh-agentic-workflows REVIEW.md (0208e26761f9), "PR Descriptions"

> "Do not add `Signed-off-by` lines automatically—these require explicit human
> action after review. If code was AI-assisted, include an `Assisted-by:` trailer
> indicating the tool and model used."
> — bootc-dev/gh-agentic-workflows REVIEW.md (0208e26761f9), "Before Merge"

> "This repository was built and tested with [OpenCode](https://opencode.ai)-coordinated
> agents: one drafting the workflows, another reviewing the first's work, and the pipeline
> itself then exercised end to end against real issues and PRs."
> — bootc-dev/gh-agentic-workflows README.md (a7ba95442ce7), "Side note on AI"

## Rationale

This repository carries the shared bootc-dev policy (canonically bootc-dev/infra
`common/AGENTS.md` and `common/REVIEW.md`), which is written for AI agents: it
expects AI-generated commits and PR text, asks for an `Assisted-by: AI` or
`Generated-by: AI` trailer, and requires a human to review the code and the
commit message text and to add the `Signed-off-by` himself. Nothing requires
the human to write the text, so this is bot-ok, as for bootc-dev/infra and
bootc-dev/actions; cgwalters' review of the fork PR and his sign-off at
promote are what the policy asks for. Diffs over ~500 substantial lines want a
design issue first. The project itself is an AI-agent pipeline built by agents,
which only reinforces that.

The sources disagree on the trailer's content: AGENTS.md says "do NOT
reference specific model names or tools", while REVIEW.md asks for an
`Assisted-by:` trailer "indicating the tool and model used". AGENTS.md is the
agent-specific rule in its "CRITICAL instructions" section, so the bot uses the
generic `Assisted-by: AI` (substantial assistance) or `Generated-by: AI`
(effectively entirely generated); the bot's default `Generated-by: AI` fits
work it wrote end to end.

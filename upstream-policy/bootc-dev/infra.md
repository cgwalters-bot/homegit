---
verdict: bot-ok
ai-trailer: Assisted-by: AI for substantial assistance, Generated-by: AI when effectively entirely generated (AGENTS.md "Attribution and AI disclosure"; REVIEW.md asks for "the tool and model used", which AGENTS.md forbids naming)
dco: yes (the bootc-dev org ruleset requires the DCO status check on main; the dco-2 app reports on recent PR heads)
sources:
  - repo: bootc-dev/infra
    path: .gemini
    sha: 5668b26af7e55549683f96c33a07a1ba7d936a1b
  - repo: bootc-dev/infra
    path: .github/agents
    sha: 6bbb2d214ab5c0dded74153f51268425e029088b
  - repo: bootc-dev/infra
    path: AGENTS.md
    sha: ef8d0fd4f6236cf15e28c291ad2033b634156b34
  - repo: bootc-dev/infra
    path: REVIEW.md
    sha: 2acbb1013e730757fc403273548dd6c4f4d145ad
  - repo: bootc-dev/infra
    path: common/.claude/CLAUDE.md
    sha: be77ac83a1895cfa9e271961ba1e565c273c717c
  - repo: bootc-dev/infra
    path: common/.cursorrules
    sha: 47dc3e3d863cfb5727b87d785d09abf9743c0a72
  - repo: bootc-dev/infra
    path: common/AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
  - repo: bootc-dev/infra
    path: common/REVIEW.md
    sha: 3068dd57b2c3ef45cb1c3147442e8d63505bb643
  - repo: bootc-dev/infra
    path: common/REVIEW_GOLANG.md
    sha: 11993395d60a99bd907bb42ef4e8ba69a83080d5
  - repo: bootc-dev/infra
    path: common/REVIEW_RUST.md
    sha: ac7983b541797fe01d8d2eb8427a0aac5fa4e6bd
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

This repository is the canonical home of the shared policy: `common/AGENTS.md`
and `common/REVIEW.md` are synced to the bootc-dev and composefs org
repositories by the `sync-common` workflow, and the top-level `AGENTS.md`,
`REVIEW.md` and `.gemini` are symlinks into `common/`. `REVIEW_RUST.md` and
`REVIEW_GOLANG.md` are code style only; `.github/agents/agentic-workflows.md`
is a gh-aw workflow helper.

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
> — bootc-dev/infra common/AGENTS.md (61261301421a), "Signed-off-by"

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
> — bootc-dev/infra common/AGENTS.md (61261301421a), "Attribution and AI disclosure"

> "If the generated code is more than ~500 lines of substantial (non-whitespace) code,
> encourage the human to file a design issue first to be reviewed by other maintainers."
> — bootc-dev/infra common/AGENTS.md (61261301421a), "Large changes"

> "Software can be machine checked (via compilation and unit/integration tests)
> but natural languages like English cannot. Encourage the human to review
> the commit message text."
> — bootc-dev/infra common/AGENTS.md (61261301421a), "Commit messages and text"

> "Generally, just restate the commit message."
> — bootc-dev/infra common/REVIEW.md (3068dd57b2c3), "PR Descriptions"

> "Do not add `Signed-off-by` lines automatically—these require explicit human
> action after review. If code was AI-assisted, include an `Assisted-by:` trailer
> indicating the tool and model used."
> — bootc-dev/infra common/REVIEW.md (3068dd57b2c3), "Before Merge"

## Rationale

The shared bootc-dev policy (canonically bootc-dev/infra `common/AGENTS.md`
and `common/REVIEW.md`, synced into the bootc-dev and composefs org
repositories by infra's `sync-common` workflow) is written for AI agents: it
expects AI-generated commits and PR text, asks for an `Assisted-by: AI` or
`Generated-by: AI` trailer, and requires a human to review the code and the
commit message text and to add the `Signed-off-by` himself. Nothing requires
the human to write the text, so this is bot-ok; cgwalters' review of the fork
PR and his sign-off at promote are what the policy asks for. Diffs over ~500
substantial lines want a design issue first.

The sources disagree on the trailer's content: AGENTS.md says "do NOT
reference specific model names or tools", while REVIEW.md asks for an
`Assisted-by:` trailer "indicating the tool and model used". AGENTS.md is the
agent-specific rule in its "CRITICAL instructions" section, so the bot uses the
generic `Assisted-by: AI` (substantial assistance) or `Generated-by: AI`
(effectively entirely generated); the bot's default `Generated-by: AI` fits
work it wrote end to end.

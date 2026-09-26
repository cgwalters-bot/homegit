---
verdict: bot-ok
ai-trailer: Assisted-by: AI for substantial assistance, Generated-by: AI when effectively entirely generated (AGENTS.md "Attribution and AI disclosure"; REVIEW.md asks for "the tool and model used", which AGENTS.md forbids naming)
dco: yes (the bootc-dev org ruleset requires the DCO status check on main; the dco-2 app reports on recent PR heads)
sources:
  - repo: bootc-dev/containers-image-proxy-rs
    path: .claude
    sha: ea3212ee37b79e5ad335f63163d2f6a79656f088
  - repo: bootc-dev/containers-image-proxy-rs
    path: .claude/CLAUDE.md
    sha: be77ac83a1895cfa9e271961ba1e565c273c717c
  - repo: bootc-dev/containers-image-proxy-rs
    path: .cursorrules
    sha: 47dc3e3d863cfb5727b87d785d09abf9743c0a72
  - repo: bootc-dev/containers-image-proxy-rs
    path: .gemini
    sha: e74adbff6981febb684371fcd5c9a26add88638f
  - repo: bootc-dev/containers-image-proxy-rs
    path: AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
  - repo: bootc-dev/containers-image-proxy-rs
    path: REVIEW.md
    sha: 3068dd57b2c3ef45cb1c3147442e8d63505bb643
  - repo: bootc-dev/infra
    path: common/AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
  - repo: bootc-dev/infra
    path: common/REVIEW.md
    sha: 3068dd57b2c3ef45cb1c3147442e8d63505bb643
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
rebase: any
---

The repository has no CONTRIBUTING.md. `AGENTS.md`, `REVIEW.md`,
`.claude/CLAUDE.md` and `.cursorrules` are the bootc-dev/infra `common/`
files; `.gemini/config.yaml` only tunes Gemini code review.

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
> — bootc-dev/containers-image-proxy-rs AGENTS.md (61261301421a), "Signed-off-by"

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
> — bootc-dev/containers-image-proxy-rs AGENTS.md (61261301421a), "Attribution and AI disclosure"

> "If the generated code is more than ~500 lines of substantial (non-whitespace) code,
> encourage the human to file a design issue first to be reviewed by other maintainers."
> — bootc-dev/containers-image-proxy-rs AGENTS.md (61261301421a), "Large changes"

> "Software can be machine checked (via compilation and unit/integration tests)
> but natural languages like English cannot. Encourage the human to review
> the commit message text."
> — bootc-dev/containers-image-proxy-rs AGENTS.md (61261301421a), "Commit messages and text"

> "Generally, just restate the commit message."
> — bootc-dev/containers-image-proxy-rs REVIEW.md (3068dd57b2c3), "PR Descriptions"

> "Do not add `Signed-off-by` lines automatically—these require explicit human
> action after review. If code was AI-assisted, include an `Assisted-by:` trailer
> indicating the tool and model used."
> — bootc-dev/containers-image-proxy-rs REVIEW.md (3068dd57b2c3), "Before Merge"

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

## Rebasing

Rebase the bot's PRs here whenever they need it, conflicting or not:
cgwalters maintains this repository and wants PRs that are merely behind
rebased so that CI passes (he said so on
https://github.com/bootc-dev/bootc/pull/2495). This overrides the merge
queue detection (.github/workflows/ci.yaml runs on merge_group).

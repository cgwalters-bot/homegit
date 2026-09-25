---
verdict: bot-ok
ai-trailer: Assisted-by: AI for substantial assistance, Generated-by: AI when effectively entirely generated (AGENTS.md "Attribution and AI disclosure"; REVIEW.md asks for "the tool and model used", which AGENTS.md forbids naming)
dco: yes (the dco-2 app runs on PR heads, reporting action_required on two recent ones; main has no branch rules and none of its last 100 commits has a Signed-off-by, so it is not enforced)
sources:
  - repo: bootc-dev/cgwalters-devspace-sandbox
    path: AGENTS.md
    sha: 92a9499b1be65d3d761f5a081701caaa998a53a8
  - repo: bootc-dev/cgwalters-devspace-sandbox
    path: SECURITY.md
    sha: e1c0b5e88e8aa10c4278b589e50f8b53c366048e
  - repo: bootc-dev/infra
    path: common/AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

The repository has no CONTRIBUTING, AI policy, PR template or REVIEW.md, and
bootc-dev has no `.github` repository. Its own AGENTS.md is operational only;
SECURITY.md has nothing on AI or contributions. The bootc-dev/infra
`sync-common` workflow hasn't brought the shared `common/AGENTS.md` here, but
it is the bootc-dev org's policy.

## Quotes

> "The development-runner workflow intentionally remains `in_progress` as a
> keepalive for the requested duration. After `cargo devspace start` returns, do
> not wait for the workflow or its keepalive job to complete before connecting."
> — bootc-dev/cgwalters-devspace-sandbox AGENTS.md (92a9499b1be6), "Agent instructions"

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

## Rationale

bot-ok, inferred from the org-wide bootc-dev policy rather than a file in this
repository: the shared AGENTS.md expects AI-generated commits with an
`Assisted-by: AI` or `Generated-by: AI` trailer and only asks that a human
review the code and text and add the sign-off. This is cgwalters' own sandbox
repository, and AI trailers are already merged on main (last 100 commits:
Assisted-by 2, Generated-by 3). Nothing here says anything against AI. If the
org policy should not be read as covering a repository it wasn't synced to,
the stricter reading of this silence would be human-text; cgwalters can
change the verdict here.

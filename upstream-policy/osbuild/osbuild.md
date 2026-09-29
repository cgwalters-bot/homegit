---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, though recent commits on main carry Assisted-by and Co-Authored-By AI trailers
dco: no (no branch rules or protection on main, and no DCO check on any of the 8 recent PR heads sampled)
sources:
  - repo: osbuild/osbuild
    path: README.md
    sha: 3056e70f1d78dd303c425613dc95414329cd310a
  - repo: osbuild/.github
    path: README.md
    sha: aeb712c5fc2477efe145a83e7861b6b7a7cf1a1d
  - repo: osbuild/.github
    path: SECURITY.md
    sha: f0c5c46d21baadf95e02a91c3ddc00523949111f
  - repo: osbuild/.github
    path: profile/README.md
    sha: f4b6bce801c585822d8a7b2db3ac0980f279d76b
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/00-index.md
    sha: 6da0f326907e38c1b581ec0c6f5e63bd10831997
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/01-general/code-style.md
    sha: c3829eaa07f8a738e5cf8b50fcad8fd2f51cf0ae
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/01-general/workflow.md
    sha: afe4c7f80c59133416e52ff67c6eee7dd8ef943d
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/02-projects/osbuild/contributing.md
    sha: 2819fef07f4d2f28e9085e71ea17468f25332cc5
  - repo: osbuild/pr-best-practices
    path: README.md
    sha: 2270bfa204b0569e4fc7931d42e8e244485ad999
checked: 2026-09-28 by the policy-check subagent (coordinator session 929c7a64)
---

osbuild/osbuild has no CONTRIBUTING, AGENTS.md, PR template or other policy
file of its own; its README's "Contributing" section defers to the osbuild
developer guide (osbuild/osbuild.github.io), which has a general workflow page
and an osbuild-specific contributing page. The workflow page links
osbuild/pr-best-practices, the CI action that enforces some of its PR rules.
The org's .github repository has only README, SECURITY and profile files.
None of these mention AI, LLMs, bots or disclosure trailers.

## Quotes

Nothing bears on AI. The rules on commit text and PRs:

> "Please refer to the [developer guide](https://osbuild.org/docs/developer-guide/index) to learn about our workflow, code style and more."
> — osbuild/osbuild README.md (3056e70f1d78), "Contributing"

> "2. The commit message should explain clearly what it's trying to do and why. Refer to the format we prefer below.
> 3. A Jira issue or - where applicable - a GitHub issue reference should be added to automatically link and potentially close a related issue if it exists."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Commits"

> "4. The pull request title shall contain [a reference to the relevant Jira ticket](https://issues.redhat.com).
> 5. Every pull request shall have a clear summary."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

> "1. Pull requests should be opened from a developer's own fork to avoid random branches on the origin."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

> "For new stages to be contributed we require unit tests and integration tests to be included in your pull request."
> — osbuild/osbuild.github.io docs/developer-guide/02-projects/osbuild/contributing.md (2819fef07f4d), "Stages"

## Rationale

human-text, and the verdict comes from silence: no source says anything about
AI-assisted code or about who must write PR descriptions and commit messages,
so policy-check.md's conservative default applies until cgwalters decides
otherwise. It is not bot-ok because nothing explicitly allows AI-assisted
contributions. Practice leans permissive: among the last 100 commits on main
there are `Assisted-by:` trailers (OpenCode/Claude) and `Co-Authored-By: Claude`
lines, so a case for loosening exists if cgwalters wants to make it. PR titles
are expected to reference a Jira ticket (checked by the pr-best-practices CI
action), and new stages need unit and integration tests. No merge queue
(no workflow runs on merge_group, no branch rules), so no rebase setting.

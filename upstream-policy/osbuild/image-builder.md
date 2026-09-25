---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and no AI trailers in the last 100 commits on main
dco: no (no branch rules on main, and no DCO check on any of the 8 recent PR heads sampled)
sources:
  - repo: osbuild/image-builder
    path: CONTRIBUTING.md
    sha: 009e5c5b078978c7a03e17efde0fba107812bd4c
  - repo: osbuild/image-builder
    path: HACKING.md
    sha: 1f3313081ecbb686d586e80c763d6b1bd3f88ea4
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
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

`osbuild/images` redirects here (the CLI repository osbuild/image-builder-cli
is archived); the record is under the canonical name, which is what
`bot-pr promote` checks. Nothing read mentions AI, LLMs or disclosure trailers:
not CONTRIBUTING.md, not HACKING.md, and not the osbuild developer guide
CONTRIBUTING.md links (osbuild/osbuild.github.io). The osbuild/.github
repository has only SECURITY.md and README/profile files.

## Quotes

Nothing bears on AI. The rules on commit text and PRs:

> "* The commits in the PR should be minimal and well documented:"
> — osbuild/image-builder CONTRIBUTING.md (009e5c5b0789), "Creating a PR"

> "* The commit message should start with the module you work on, like:
>     `manifest:`, or `distro:`"
> — osbuild/image-builder CONTRIBUTING.md (009e5c5b0789), "Creating a PR"

> "1. Pull requests should be opened from a developer's own fork to avoid random branches on the origin."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

> "4. The pull request title shall contain [a reference to the relevant Jira ticket](https://issues.redhat.com)."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

## Rationale

human-text, because nothing is written down. Silence alone would pass as bot-ok under policy-check.md, but these records were seeded conservatively: with no written word on AI-written PR text or commit messages, the bot drafts the code and cgwalters writes the text. There is no AI precedent
either (no Assisted-by, Generated-by or Claude trailers in the last 100
commits on main), and cgwalters is not a core maintainer, so it's worth asking
the osbuild maintainers before sending bot-written text. PR titles are expected
to reference a Jira ticket.

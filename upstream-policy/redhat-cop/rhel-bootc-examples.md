---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and precedent on main is Assisted-by (5 of the last 100 commits, all cgwalters)
dco: no (no branch rules on main, and no DCO check on any of the 8 recent PR heads sampled)
sources:
  - repo: redhat-cop/rhel-bootc-examples
    path: README.md
    sha: e27a0134cab3c770c92901f4bb0eb46521513e22
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

The repository has no CONTRIBUTING, AGENTS.md, AI policy or PR template, and
there is no redhat-cop/.github repository. README.md has no contribution rules.

## Quotes

Nothing bears on AI. README.md's only mention of contributions:

> "There are more community-contributed examples available in the [upstream Fedora-bootc project](https://gitlab.com/fedora/bootc/examples)."
> — redhat-cop/rhel-bootc-examples README.md (e27a0134cab3)

## Rationale

human-text, because nothing is written down. Silence alone would pass as bot-ok under policy-check.md, but these records were seeded conservatively: with no written word on AI-written PR text or commit messages, the bot drafts the code and cgwalters writes the text. redhat-cop is a Red Hat
Community of Practice organization, whose unwritten norms may matter too.

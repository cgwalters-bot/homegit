---
verdict: human-text
ai-trailer: default (Generated-by: AI)
dco: no (no DCO check among the branch rules, master's check runs or the latest PRs' check runs)
sources:
  - repo: nickel-lang/nickel
    path: CONTRIBUTING.md
    sha: 098a6515855185dd15b6f429b1e1afb7b57ee1a0
checked: 2026-09-30 by the policy-check subagent (coordinator session 2026-09-30)
---

## Quotes

> "Before contributing any non-trivial change to this repository, please first
> check for the existence of related work such as issues or open pull requests. If
> there are none, it's better to discuss the change you wish to make via an issue,
> by email, or using any other method with the maintainers of this repository
> (listed below) before actually submitting something."
> — nickel-lang/nickel CONTRIBUTING.md (098a6515855a), "Preamble"

> "The conditions to merge a PR are whatever GitHub branch protection rules are
> currently set by the Nickel repository."
> — nickel-lang/nickel CONTRIBUTING.md (098a6515855a), "The review process"

Nothing in CONTRIBUTING.md, the README, HACKING.md or the repository's
`.github` directory (no AGENTS.md, no PR template, no CLA or sign-off
workflow; the org has no `.github` repository) mentions AI, LLMs, bots,
automated contributions, authorship, a CLA or sign-off.

## Rationale

The sources are silent about AI and automated contributions, so the verdict
comes from silence: human-text until the operator decides otherwise. The
Preamble asks contributors to discuss non-trivial changes with the
maintainers first, which a bot-written PR description does not do on its own.
No CLA or DCO is enforced, so none blocks the operator from taking over the
text and promoting with `/promote --human-text`.

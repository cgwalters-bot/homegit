---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and precedent on main is Assisted-by (3 of the last 100 commits)
dco: no (no branch rules on main, and no DCO check on any of the 8 recent PR heads sampled)
sources:
  - repo: coreos/cargo-vendor-filterer
    path: README.md
    sha: ca359dab9cae1351a5b4a4b6f038c5ebe47ea43b
  - repo: coreos/.github
    path: README.md
    sha: a46ae92d6be3af621898326ec6d32d78dafa5854
  - repo: coreos/.github
    path: SECURITY.md
    sha: 8fa6f4a6e4beaa96ef30bef22f13a3b724fbc675
  - repo: coreos/.github
    path: profile/README.md
    sha: 3022b18e4dee0a57b61261cbbc19f2a5b858af52
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

The repository has no CONTRIBUTING, AGENTS.md, AI policy or PR template, and
README.md covers only usage. The coreos/.github repository has only
SECURITY.md and README/profile files.

## Quotes

Nothing in the sources bears on AI, bots, authorship or PR text.

## Rationale

human-text, because nothing is written down. Silence alone would pass as bot-ok under policy-check.md, but these records were seeded conservatively: with no written word on AI-written PR text or commit messages, the bot drafts the code and cgwalters writes the text. One commit on main is
already authored by cgwalters-bot, and cgwalters maintains this repository, so
an AGENTS.md here would settle it as bot-ok.

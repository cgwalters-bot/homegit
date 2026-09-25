---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and precedent on main is Assisted-by (2 of the last 100 commits)
dco: no (no branch rules on main, and no DCO check on any of the 8 recent PR heads sampled)
sources:
  - repo: coreos/bootupd
    path: .gemini
    sha: a7f847866af7b0595b5eb56421289bd2dd0dbfce
  - repo: coreos/bootupd
    path: README-devel.md
    sha: 5d74c1bd0e7742c3745cb65867f6cce50a2e4414
  - repo: coreos/bootupd
    path: README.md
    sha: 172cfcd8086c137796376445a2d438819e06c697
  - repo: coreos/bootupd
    path: code-of-conduct.md
    sha: a234f3609d09ad5dedda772ad1da05dd0ee91a46
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

The repository has no CONTRIBUTING, AGENTS.md, AI policy or PR template.
README.md, README-devel.md and code-of-conduct.md have no rules on AI, commit
text or sign-off; `.gemini/config.yaml` only tunes Gemini code review; the
coreos/.github repository has only SECURITY.md and README/profile files.

## Quotes

Nothing in the sources bears on AI, bots, authorship or PR text.

## Rationale

human-text, because nothing is written down. Silence alone would pass as bot-ok under policy-check.md, but these records were seeded conservatively: with no written word on AI-written PR text or commit messages, the bot drafts the code and cgwalters writes the text. Precedent is thin (2 of
the last 100 commits carry Assisted-by). bootupd is closely tied to bootc;
adopting the bootc-dev common AGENTS.md would make it bot-ok.

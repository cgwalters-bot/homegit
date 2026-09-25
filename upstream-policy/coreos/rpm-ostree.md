---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and precedent on main is Assisted-by (28 of the last 100 commits)
dco: no (no branch rules on main, and no DCO check on any of the 8 recent PR heads sampled)
sources:
  - repo: coreos/rpm-ostree
    path: .gemini
    sha: a7f847866af7b0595b5eb56421289bd2dd0dbfce
  - repo: coreos/rpm-ostree
    path: .github/PULL_REQUEST_TEMPLATE
    sha: 7eb83071d150dcc99ddd34754bd8b04693d8df70
  - repo: coreos/rpm-ostree
    path: CONTRIBUTING.md
    sha: fc7716160139922b055d6c054d0d2e2a69043f70
  - repo: coreos/rpm-ostree
    path: HACKING.md
    sha: 142a070454591ba5479a1ad2fc62c07149b63d17
  - repo: coreos/rpm-ostree
    path: docs/CONTRIBUTING.md
    sha: 9f4223627b3871379f63889005762f413c989b6d
  - repo: coreos/rpm-ostree
    path: docs/HACKING.md
    sha: 61f53af9cb4d770ab1e5fafc37b5b59ebf81be06
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

No file mentions AI, LLMs, bots or disclosure trailers. CONTRIBUTING.md and
HACKING.md point to their `docs/` versions; `.gemini/config.yaml` only tunes
Gemini code review; the coreos/.github repository has only SECURITY.md and
README/profile files, with no contribution text.

## Quotes

Nothing bears on AI. The only rules on commit text and PRs:

> "Please look at `git log` and match the commit log style."
> — coreos/rpm-ostree docs/CONTRIBUTING.md (9f4223627b38), "Submitting patches"

> "If you are adding functionality to tree composes, please add
> a corresponding test to the compose-test suite."
> — coreos/rpm-ostree .github/PULL_REQUEST_TEMPLATE (7eb83071d150)

## Rationale

human-text, because nothing is written down. Silence alone would pass as bot-ok under policy-check.md, but these records were seeded conservatively: with no written word on AI-written PR text or commit messages, the bot drafts the code and cgwalters writes the text. AI-assisted code is
routine here (28 of the last 100 commits on main carry Assisted-by, from three
authors, more than the 14 with a Signed-off-by), so this is the likeliest
repository to move to bot-ok, for example by adopting the bootc-dev common
AGENTS.md.

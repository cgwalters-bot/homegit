---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and precedent on main is Assisted-by or Generated-by (12 of the last 100 commits, four authors)
dco: no (docs/CONTRIBUTING.md says Signed-off-by is not required, the main ruleset has no status checks, and no DCO check ran on the 8 recent PR heads sampled)
sources:
  - repo: ostreedev/ostree
    path: .gemini
    sha: 88df54196690e5750f622b07aaa84a91abbaec7a
  - repo: ostreedev/ostree
    path: CONTRIBUTING.md
    sha: 49d1b98f97e06d65fd653f76d26aecc174771064
  - repo: ostreedev/ostree
    path: docs/CONTRIBUTING.md
    sha: 3574c9e2aa507a3f0150fb44e8bd028901da6c21
  - repo: ostreedev/ostree
    path: docs/contributing-tutorial.md
    sha: 0bcf8feb5f35b9683eb2ef2cc6c812cbe0c0bb78
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

No file mentions AI, LLMs or disclosure trailers. There is no AGENTS.md, no PR
template, and no ostreedev/.github repository. The top-level CONTRIBUTING.md
is a symlink to `docs/CONTRIBUTING.md`; `docs/contributing-tutorial.md` is a
build walkthrough; `.gemini/config.yaml` only tunes Gemini code review.

## Quotes

> "Instead, we use an instance of
> [Homu](https://github.com/servo/homu), currently known as
> `cgwalters-bot`."
> — ostreedev/ostree docs/CONTRIBUTING.md (3574c9e2aa50), "Submitting patches"

> "Please look at `git log` and match the commit log style, which is very
> similar to the
> [Linux kernel](https://git.kernel.org/cgit/linux/kernel/git/torvalds/linux.git).
>
> You may use `Signed-off-by`, but we're not requiring it."
> — ostreedev/ostree docs/CONTRIBUTING.md (3574c9e2aa50), "Commit message style"

The first quote is historical: the `cgwalters-bot` account was the project's
Homu merge bot, which says nothing about AI contributions from it now.

## Rationale

human-text, because nothing is written down. Silence alone would pass as bot-ok under policy-check.md, but these records were seeded conservatively: with no written word on AI-written PR text or commit messages, the bot drafts the code and cgwalters writes the text. Precedent favors
AI-assisted commits (12 of the last 100 on main carry Assisted-by or
Generated-by, from four authors), but none of it speaks to bot-written PR text.
cgwalters is an ostree maintainer; landing the bootc-dev common AGENTS.md here
would make it bot-ok on re-check.

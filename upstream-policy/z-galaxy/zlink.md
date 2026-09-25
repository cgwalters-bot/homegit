---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and precedent on main names the model (Assisted-by: Claude ..., Co-Authored-By: Claude ...)
dco: no (the main ruleset requires only build, lint and test checks, and no DCO check ran on the 8 recent PR heads sampled)
sources:
  - repo: z-galaxy/zlink
    path: .github/pull_request_template.md
    sha: b4a31b68a377c95da0f2860b6dbf75ef1b6b6be5
  - repo: z-galaxy/zlink
    path: AGENTS.md
    sha: c8174da39ebac886820164d35b499ea1284137ef
  - repo: z-galaxy/zlink
    path: CLAUDE.md
    sha: 47dc3e3d863cfb5727b87d785d09abf9743c0a72
  - repo: z-galaxy/zlink
    path: CONTRIBUTING.md
    sha: eec38a4514cd2e41bb300aab30861cac7537a1b5
  - repo: z-galaxy/zlink
    path: SECURITY.md
    sha: 247db4c2a3883328aca3985c25db419a65006038
  - repo: z-galaxy/.github
    path: profile/README.md
    sha: c5d0216b9929b8f9a427828d9b7188d3b7b45cee
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

AGENTS.md addresses AI agents and defers to CONTRIBUTING.md; CLAUDE.md is a
symlink to it. The PR template only links the contributing guide; SECURITY.md
and the org profile README have nothing on AI.

## Quotes

> "This file provides guidance to AI coding agents when working with code in this repository."
> — z-galaxy/zlink AGENTS.md (c8174da39eba), "AGENTS.md"

> "For contribution conventions — commit-message format, atomic commits, code layout, and
> more — follow the guidelines in [`CONTRIBUTING.md`](CONTRIBUTING.md)."
> — z-galaxy/zlink AGENTS.md (c8174da39eba), "AGENTS.md"

> "- **Changelog-skip trailer**: end a commit message with a `Changelog: skip` git trailer to
>   keep it out of the user-facing changelog (use for AI-workflow artifacts such as design docs
>   and implementation plans)."
> — z-galaxy/zlink AGENTS.md (c8174da39eba), "AGENTS.md"

> "When contributing to this project, you **implicitly** declare that:
>
> * you have authored 100% of the content,
> * you have the necessary rights to the content, and
> * you agree to providing the content under the [project's license](LICENSE)."
> — z-galaxy/zlink CONTRIBUTING.md (eec38a4514cd), "Legal Notice"

## Rationale

human-text, because the sources pull two ways. AI is plainly welcome in
practice: there is an AGENTS.md, and 37 of the last 100 commits on main carry
Assisted-by and 22 Co-Authored-By: Claude, mostly from the maintainer. But the
only written legal term has contributors declare they "have authored 100% of
the content", which bot-drafted text doesn't literally meet. It's probably
boilerplate given the maintainer's own AI use, but it is ambiguous, so the
stricter verdict applies; asking the maintainer (zeenix) would likely move
this to bot-ok.

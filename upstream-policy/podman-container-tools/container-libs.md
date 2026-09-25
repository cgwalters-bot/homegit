---
verdict: human-text
ai-trailer: none (the org LLM policy says "Remove unnecessary comments and LLM metadata"; no AI trailers in the last 100 commits on main)
dco: yes (the repository ruleset on main requires the Total Success and DCO status checks; dco/DCO passed on all 8 recent PR heads sampled)
sources:
  - repo: podman-container-tools/container-libs
    path: .github/CONTRIBUTING.md
    sha: 2ef6ded1a6e26f97686d4e921ab7e84c9b3ecea3
  - repo: podman-container-tools/container-libs
    path: .github/PULL_REQUEST_TEMPLATE.md
    sha: 494a8c97185f18bb7d6692d456a8e50bbe8eebe7
  - repo: podman-container-tools/container-libs
    path: CONTRIBUTING.md
    sha: 94a06c6687a33fa8d4afb58c436b17b30658acaa
  - repo: podman-container-tools/container-libs
    path: GOVERNANCE.md
    sha: b78038cf8d26e79d0ef9fd313e8a7d14b973f45f
  - repo: podman-container-tools/container-libs
    path: LLM_POLICY.md
    sha: 39299e443b148940971c060d37681d6d6f6076f5
  - repo: podman-container-tools/container-libs
    path: MAINTAINERS.md
    sha: e7106163dc748085acbed36747ba174057721d13
  - repo: podman-container-tools/container-libs
    path: SECURITY.md
    sha: 366b53fb64c7f0e1dd2a3759365da4b944b63cbb
  - repo: podman-container-tools/container-libs
    path: image/AGENTS.md
    sha: 91c60bc33f3be82dce2bdb73cdbfc942cc8de4c0
  - repo: podman-container-tools/community
    path: CONTRIBUTING.md
    sha: 19c85a699c44191c91f49e4f056de6fef1bda151
  - repo: podman-container-tools/community
    path: LLM_POLICY.md
    sha: 34642b443c8679d9684a81ac3b3805c1e6f11e20
  - repo: podman-container-tools/.github
    path: profile/README.md
    sha: 183f33417299db6102513a89d9b97667e30e7a01
checked: 2026-09-25 by the policy-check subagent (coordinator session 929c7a64, converted from an earlier read-only survey and re-read against current upstream)
---

`containers/container-libs` redirects here; the record is under the canonical
name, which is what `bot-pr promote` checks. The repository's CONTRIBUTING.md
and LLM_POLICY.md only point to the organization-wide ones in
podman-container-tools/community; `.github/CONTRIBUTING.md` and the PR
template only link a contributing guide, and `image/AGENTS.md` covers API
stability and refactoring style. GOVERNANCE.md, MAINTAINERS.md, SECURITY.md and
the org profile README have nothing on AI or authorship.

## Quotes

> "Please read our organization wide contributing guide here: https://github.com/podman-container-tools/community/blob/main/CONTRIBUTING.md."
> — podman-container-tools/container-libs CONTRIBUTING.md (94a06c6687a3), "Podman Container Tools Contributing Guide"

> "Please read our organization wide policy here: https://github.com/podman-container-tools/community/blob/main/LLM_POLICY.md"
> — podman-container-tools/container-libs LLM_POLICY.md (39299e443b14)

> "The policy applies to all our repositories in this GitHub Organization."
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), introduction

> "LLM output cannot be used verbatim in:
> - Issues, comments, or pull request content
> - Forum or chat posts
> - Security reports
>
> All communication must be in your own words and demonstrate understanding.
>
> **Exceptions:**
> - Language translation must be clearly stated
> - Maintainer-configured LLM bots may suggest PR changes (suggestions only)
>
> Violations may result in submission closure or permanent project bans."
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), "No LLM-Generated Direct Communication"

> "You may use LLMs to assist with code, but you're fully responsible for submissions."
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), "LLM Code Contributions"

> "- Remove unnecessary comments and LLM metadata"
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), "LLM Code Contributions", "Requirements"

> "- Review all generated code
> - Explain changes in your own words
> - Be able to discuss and justify modifications"
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), "LLM Code Contributions", "Understanding and Ownership"

> "- Don't paste feedback into LLMs and blindly resubmit
> - Respond thoughtfully using your own words"
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), "LLM Code Contributions", "Handling Review Feedback"

> "Do not prompt an LLM vaguely. Do not commit the LLM results unchanged. And do not submit them as-is."
> — podman-container-tools/community LLM_POLICY.md (34642b443c86), "The Golden Rule"

> "If your contribution is aided by LLMs or other AI tools, please read the [LLM Policy](LLM_POLICY.md).
> This project follows this LLM policy, which includes comments, issues, PRs, and any other interactions with the team."
> — podman-container-tools/community CONTRIBUTING.md (19c85a699c44), "LLM ("AI") Policy"

> "Commits without a correct DCO Signed-off-by line cannot be merged or even considered."
> — podman-container-tools/community CONTRIBUTING.md (19c85a699c44), "DCO Sign-off"

## Rationale

human-text. The organization's LLM policy "applies to all our repositories"
and allows LLM help with code, but forbids LLM output verbatim in "pull request
content", issues and comments: all communication "must be in your own words".
So the bot may draft the code, and cgwalters must write the PR title and body,
the commit messages and every review reply himself. The one exception,
"Maintainer-configured LLM bots may suggest PR changes (suggestions only)",
doesn't cover cgwalters-bot. It is not human-only: "You may use LLMs to assist
with code" is explicit. Leave AI trailers off ("Remove ... LLM metadata"), and
don't have the bot answer review there.

Unlike podman, this repository's PR template has no "human-written" checkbox,
but the organization policy applies without it.

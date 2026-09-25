---
verdict: human-text
ai-trailer: none (the org LLM policy says "Remove unnecessary comments and LLM metadata"; no AI trailers in the last 100 commits on main)
dco: yes (the repository ruleset on main requires the DCO and Total Success status checks; dco/DCO passed on all 8 recent PR heads sampled)
sources:
  - repo: podman-container-tools/podman
    path: .github/PULL_REQUEST_TEMPLATE.md
    sha: b8fa4510c417746b69a1ee4c628bc20e6e4247cd
  - repo: podman-container-tools/podman
    path: AGENTS.md
    sha: 529e374a027ba8d422fd67f8ee1b49f1f58fa91a
  - repo: podman-container-tools/podman
    path: CONTRIBUTING.md
    sha: 4eec7fa6a54b2ecd5b2860d74354acd9273461dd
  - repo: podman-container-tools/podman
    path: GOVERNANCE.md
    sha: 2adfa90ee2ee8d3a41f919d162f583c4a3b542c0
  - repo: podman-container-tools/podman
    path: LLM_POLICY.md
    sha: 39299e443b148940971c060d37681d6d6f6076f5
  - repo: podman-container-tools/podman
    path: MAINTAINERS.md
    sha: 85ac7cea20629fb9cf6a36cc8104e81f374c59f5
  - repo: podman-container-tools/podman
    path: REVIEWING.md
    sha: a7e74838c611153ac03ead693e6d495d2ff78a1a
  - repo: podman-container-tools/podman
    path: SECURITY.md
    sha: 04c4293bd7c88bbe1ca7ebf0f920d477257cd67c
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

`containers/podman` redirects here; the record is under the canonical name,
which is what `bot-pr promote` checks (it compares the upstream with the fork's
parent, which GitHub reports by its canonical name). The repository's
CONTRIBUTING.md and LLM_POLICY.md defer to the organization-wide ones in
podman-container-tools/community. GOVERNANCE.md, MAINTAINERS.md, REVIEWING.md,
SECURITY.md and the org profile README have nothing on AI or authorship.

## Quotes

> "- [ ] PR description, commit message, and GitHub comments are human-written, per [LLM Policy](https://github.com/podman-container-tools/community/blob/main/LLM_POLICY.md)
> - [ ] Certify you wrote the patch or otherwise have the right to pass it on as an open-source patch by signing all
> commits. (`git commit -s`)."
> — podman-container-tools/podman .github/PULL_REQUEST_TEMPLATE.md (b8fa4510c417), "Checklist"

> "AI-assisted contributions must follow **[LLM_POLICY.md](LLM_POLICY.md)**."
> — podman-container-tools/podman AGENTS.md (529e374a027b), "Persona"

> "- **Commits**: Must be signed (`git commit -s`) and follow [DCO](CONTRIBUTING.md#sign-your-prs)
> - **Reviews**: Two approvals required for merge"
> — podman-container-tools/podman AGENTS.md (529e374a027b), "Code Standards"

> "Please first read our organization wide contributing guide: https://github.com/podman-container-tools/community/blob/main/CONTRIBUTING.md."
> — podman-container-tools/podman CONTRIBUTING.md (4eec7fa6a54b), "Podman Contributing Guide"

> "Please read our organization wide policy here: https://github.com/podman-container-tools/community/blob/main/LLM_POLICY.md"
> — podman-container-tools/podman LLM_POLICY.md (39299e443b14)

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

The PR template also has the submitter tick that the "PR description, commit
message, and GitHub comments are human-written", an attestation only
cgwalters can make.

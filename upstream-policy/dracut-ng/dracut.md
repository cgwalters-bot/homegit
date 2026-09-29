---
verdict: human-text
ai-trailer: default (Generated-by: AI)
dco: no (main's ruleset requires two approving reviews and linear history but no status checks; no DCO check runs on main's head or on recent PR heads; recent commits carry no Signed-off-by)
sources:
  - path: .github/pull_request_template.md
    sha: 7a14fc5c82556f1a60c0989787c8cffac0fe2a43
  - path: README.md
    sha: 9a50beb40af918142974526d1c5352a34d6860c3
  - path: MAINTAINERS.md
    sha: 45fdf504dd5310d9cf6f99b83ee54026e567981d
  - path: doc_site/modules/ROOT/pages/developer/contributing.adoc
    sha: 4591425d6e3403d4bdeba8d5d864b577002a9c9f
  - path: doc_site/modules/ROOT/pages/developer/hacking.adoc
    sha: 50234cc2e5f80eec7243335a01f6e06830892871
  - path: doc_site/modules/ROOT/pages/developer/reviews.adoc
    sha: 4e168703b617e623f806a500599ed16b42f90afc
  - path: doc_site/modules/ROOT/pages/developer/code_of_conduct.adoc
    sha: 978fe86579ead9cb90199f2f85961c6a95c64e60
checked: 2026-09-29 by the policy-check subagent (coordinator session 929c7a64)
---

The repository was renamed from dracut-ng/dracut-ng; GitHub redirects the old
name. There is no top-level CONTRIBUTING, AGENTS.md or DCO file, and no
dracut-ng/.github repository. The README defers to the developer guide, whose
pages live under `doc_site/modules/ROOT/pages/developer/`. None of the sources
mentions AI, LLMs, bots, automated contributions or sign-off; the Code of
Conduct is the stock Contributor Covenant 2.0 and MAINTAINERS.md only lists the
three maintainers (Laszlo Gombos, Neal Gompa, Benjamin Drung).

## Quotes

> "See the developer guide at https://dracut-ng.github.io/ for information on
> reporting issues, contributing code via pull requests and guidelines for how to
> get started contributing to dracut."
> — dracut-ng/dracut README.md (9a50beb40af9), "Contributing"

> "We welcome contributions from everyone. However, please follow the following guidelines when posting a GitHub Pull Request or filing a GitHub Issue on the dracut project:"
> — dracut-ng/dracut doc_site/.../developer/contributing.adoc (4591425d6e34), "Contributing"

> "### Checklist
> - [ ] I have tested it locally
> - [ ] I have reviewed and updated any documentation if relevant
> - [ ] I am providing new code and test(s) for it"
> — dracut-ng/dracut .github/pull_request_template.md (7a14fc5c8255)

> "The commit message is primarily the place for documenting the why.
>
> Commit message titles should follow https://www.conventionalcommits.org/en/v1.0.0/[Conventional Commits]."
> — dracut-ng/dracut doc_site/.../developer/hacking.adoc (50234cc2e5f8), "Commit Messages"

> "Commit messages are checked with https://github.com/tomtom-international/commisery[Commisery]."
> — dracut-ng/dracut doc_site/.../developer/hacking.adoc (50234cc2e5f8), "Commit Messages"

## Rationale

The verdict comes from silence: no source says anything about AI-assisted or
bot contributions, so it is human-text by the conservative default rather than
bot-ok, which would need an explicit allowance. The PR template also asks the
submitter to tick first-person attestations ("I have tested it locally"),
which points the same way: a human should fill in and stand behind the PR
text. Not no-go or human-only, since contributions are welcomed "from
everyone" and nothing excludes AI-written code. Practical notes for the bot:
commit titles must be Conventional Commits (`type(scope): description`,
scope the module name without its number), enforced by Commisery in CI; main
needs two approvals and merges by rebase only.

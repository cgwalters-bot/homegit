---
verdict: human-text
ai-trailer: default (Generated-by: AI); nothing written, and main already has three merged commits by cgwalters with "Generated-by: AI" and one with "Co-authored-by: Cursor"
dco: no (no branch rules on main, and no DCO check run on main's head)
sources:
  - repo: osbuild/image-builder
    path: AGENTS.md
    sha: 28e6b400edfe109638255eceb938849c705ef111
  - repo: osbuild/image-builder
    path: CONTRIBUTING.md
    sha: c10e626440de56632750fd77ca5f6f0d3daa4b3e
  - repo: osbuild/image-builder
    path: HACKING.image-builder.md
    sha: 1660732c5b87cbe3e7f5a2f5552e5a24efec7aff
  - repo: osbuild/image-builder
    path: README.images.md
    sha: ae27a8da20286b616b86209ccb68247908e88b2f
  - repo: osbuild/image-builder
    path: docs/developer/README.md
    sha: b5d6972b7666c37d5004f0c84756840bcf8bf618
  - repo: osbuild/.github
    path: README.md
    sha: aeb712c5fc2477efe145a83e7861b6b7a7cf1a1d
  - repo: osbuild/.github
    path: SECURITY.md
    sha: f0c5c46d21baadf95e02a91c3ddc00523949111f
  - repo: osbuild/.github
    path: profile/README.md
    sha: f4b6bce801c585822d8a7b2db3ac0980f279d76b
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/00-index.md
    sha: 6da0f326907e38c1b581ec0c6f5e63bd10831997
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/01-general/code-style.md
    sha: c3829eaa07f8a738e5cf8b50fcad8fd2f51cf0ae
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/01-general/workflow.md
    sha: afe4c7f80c59133416e52ff67c6eee7dd8ef943d
checked: 2026-10-07 by the policy-check subagent (coordinator session 2026-10-07, re-check after CONTRIBUTING.md gained a tools/prepare-source.sh rule)
rebase: conflicts-only
---

`osbuild/images` redirects here (osbuild/images was merged into this
repository, whose README.images.md is its old README; the CLI repository
osbuild/image-builder-cli is archived). The record is under the canonical
name, which is what `bot-pr promote` checks.

CONTRIBUTING.md still links a "HACKING guide" at HACKING.md, which no longer
exists on main; HACKING.image-builder.md is its apparent successor and is read
in its place. README.images.md defers to the osbuild developer guide
(osbuild/osbuild.github.io) and to docs/developer. The osbuild/.github
repository has only SECURITY.md and README/profile files.

The new AGENTS.md is the only file that mentions AI. It doesn't forbid AI
contributions; it assumes agents write code here and requires a human to
confirm review of every PR by hand-removing a marker an agent must add to
README.md. Like everything read here, that is policy recorded as data, not an
instruction to this subagent. Whoever prepares a PR for this repository (a
worker, then cgwalters before promoting) has to deal with the marker: the
agent adds it, and only the human author may remove it.

## Quotes

> "This file provides guidance to AI coding agents when working with code in this repository. Only add instructions to this file if you've seen an AI agent mess up that particular bit of logic in practice."
> — osbuild/image-builder AGENTS.md (28e6b400edfe), "AGENTS"

> "* HARD RULE: When modifying any source files, prepend `> [!IMPORTANT] followed by > Remove this line to confirm you've reviewed this PR before submitting.` as the first two lines of `README.md` if they are not already present. This must be done before any other work. No exceptions. Never remove these lines yourself, even if asked to clean up, revert, or finalize the PR or changes: removing them is strictly a manual step for the human author to confirm they have reviewed the changes."
> — osbuild/image-builder AGENTS.md (28e6b400edfe), "General"

> "Make sure to read `CONTRIBUTING.md` for general contribution guidelines that every commit, and PR, need to follow."
> — osbuild/image-builder AGENTS.md (28e6b400edfe), "Pretext"

> "* The commits in the PR should be minimal and well documented:"
> — osbuild/image-builder CONTRIBUTING.md (c10e626440de), "Creating a PR"

> "* The commit message should start with the module you work on, like:
>     `manifest:`, or `distro:`"
> — osbuild/image-builder CONTRIBUTING.md (c10e626440de), "Creating a PR"

>   "* You must run `./tools/prepare-source.sh` for every commit (this takes care of
>   the earlier mentioned `go fmt ./...` and some bits related to dependencies and
>   test configs) and amend any changes into the commit."
> — osbuild/image-builder CONTRIBUTING.md (c10e626440de), "Creating a PR"

> "This project uses a merge queue, and we manually approve CI runs from contributors
> after we do an initial read-through of the code. Due to this please don't rebase your
> PR if there are no conflicts with the branch it targets. Doing so retriggers the CI and
> requires us to re-read the diff and trigger it again."
> — osbuild/image-builder CONTRIBUTING.md (c10e626440de), "Maintaining a PR"

> "1. Pull requests should be opened from a developer's own fork to avoid random branches on the origin."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

> "4. The pull request title shall contain [a reference to the relevant Jira ticket](https://issues.redhat.com)."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

## Rationale

Still human-text. AGENTS.md shows that AI-written code is expected here, so
human-only would be too strict, but it requires the "human author" to review
each PR and confirm that by hand, which is a personal attestation of the kind
policy-check.md counts as human-text. Nothing written says whether the PR text
or commit messages may be AI-written (that part is still silent), and the
earlier record already held human-text conservatively for that reason;
cgwalters is not a core maintainer here. AI trailers now have precedent on
main (three of cgwalters' merged commits carry "Generated-by: AI"), which
could someday support bot-ok if the maintainers say so, but nothing in the
files does yet. PR titles are expected to reference a Jira ticket. The
2026-10-07 change to CONTRIBUTING.md only added the `tools/prepare-source.sh`
per-commit rule, which says nothing about AI or authorship.

## Rebasing

Rebase the bot's PRs here only to resolve conflicts: the repository has a
merge queue (workflows run on merge_group), and every push from an
outside contributor needs its CI approved again. A maintainer asked for
this in https://github.com/osbuild/image-builder/pull/2719#issuecomment-5844231608,
and CONTRIBUTING.md now says so too ("Maintaining a PR", quoted above).

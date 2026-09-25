Batch task: turn Draft board items into review-ready forge draft PRs

Goal: cgwalters reviews everything as draft PRs on https://github.com/cgwalters-forge, one per item, each quick to judge. Your batch of board items is listed in your task. Process them one at a time, highest priority first. Follow `worker-preamble.md` throughout.

For each item:
1. `bot-board show ITEM`: read Why, Branch and Gist. Skip it (and say why in your report) if Branch is already a cgwalters-forge PR, or if the status isn't Draft when you start.
2. Triage against current upstream (REST): is the issue/PR closed, already fixed on main, superseded, or duplicated by another board item? If so, don't make a PR: set Status "Needs human" with a one-sentence Why proposing to close it as Done/duplicate, and give the evidence in your report. Analysis-only items (Workflow analysis) don't get PRs.
3. Rebase the branch onto current upstream main in your own worktree (bot identity env per the worker preamble; commits by humans other than cgwalters keep their content untouched). Squash any `fixup!`/`squash!` commits or fix-up noise into the commits they belong to, per "Fixes and review feedback" in the shared AGENTS.md, so the result is clean logical commits. Commit messages: kernel style, why-focused, the project's trailer policy (Generated-by: AI by default).
4. Re-verify on your devspace (one devspace for your whole batch, sized for the repo, with per-branch build caches; stop it at the end): the repo's lint/fmt/unit tests at minimum, plus the targeted test that proves the change (as the earlier Why/Gist describe). If it no longer passes, or the change is no longer right, fix it if the fix is small. Otherwise set Status "Needs human" with the question.
5. Don't write a DCO note in the body: `bot-pr promote` adds cgwalters' sign-off on his approval, and says so in the upstream body, when the branch rules require DCO. Only claim CI results you can link to. Update bodies later with `bot-pr get-body`/`set-body`, never `gh pr edit`.
   Write the PR title and body as the future upstream PR: why, what, how it was tested (numbers, devspace), caveats. Keep it concise prose. Link the upstream issue ("Closes #N" only if it fully fixes it). End with "Generated-by: https://github.com/cgwalters/#llms".
6. `bot-pr fork-pr --repo OWNER/REPO --base main --branch bot/SLUG --item ITEM --title ... --body-file ... --from WORKTREE` (see `bot-pr --help`).
7. Board: Status Draft, Branch = the forge PR URL, and a fresh one- or two-sentence Why (no "| was:" chaining). Keep Gist.

Budget: work steadily through the batch, and don't get stuck on one item for more than ~60 minutes. If blocked, park it as Needs human with a precise question and move on.

Final report: one line per item with the item, the result (forge PR URL / Needs human + question / skipped + reason), tests run, and anything cgwalters must decide.

---
name: devspace-time
description: Keep track of how long a devspace has before its runner is killed (bot-devspace remaining, DEVSPACE_DEADLINE), and save results, push and stop cleanly before then instead of losing the work. Read it with devspace-work, before starting any long step on a devspace and whenever a wait on one runs long.
---

# devspace-time — Finish before the devspace is killed

A devspace is a GitHub Actions job with a time limit: the `--duration` it
was started with (30, 60, 120 or 240 minutes). When that runs out the
runner goes away with everything on it: builds, logs, test results,
uncommitted fixes. There is no way to extend it, so keep track of the
time yourself.

```bash
bot-devspace remaining NAME           # "NAME: 87 min left, until ... (started ...)"
bot-devspace remaining --json NAME    # .minutes_left, .deadline, .started_at
```

The devspace sets its own deadline in every SSH session, as
`DEVSPACE_DEADLINE` (and `DEVSPACE_STARTED`) in epoch seconds, so a
command running there can check it too (`$(( (DEVSPACE_DEADLINE -
$(date +%s)) / 60 ))` minutes). A devspace from a workflow revision that
predates it shows "unknown": plan with the duration you asked for,
counted from when `start` returned.

This skill is the interim for sessions that drive devspaces over SSH.
Agents run under bot-harness are to get time-remaining messages
injected into their session instead
(cgwalters-forge/workflow-compiler#51).

`bot-devspace ssh` warns on stderr when less than 20 minutes are left.
Don't ignore that warning: it means act now (see below). Plain `ssh -F
"$CFG"`, `scp`, rsync and git over the ssh_config don't warn, so when
you mostly use those, run `bot-devspace remaining` yourself.

## Before a long step

Check `bot-devspace remaining` before starting anything that takes more
than a few minutes (a full build, `just test-tmt`, a set of tmt legs, a
container build), and don't start a step that can't finish, with time
left to copy its results off, before the deadline. Start a fresh devspace
for it instead (`bot-devspace start`, with a `--duration` that covers the
remaining work), and stop the old one once what you need is off it.

`bot-devspace ssh --min-left N NAME CMD` refuses to run CMD when less
than N minutes are left, so the check can go with the command:

```bash
bot-devspace ssh --min-left 60 "$NAME" "tmux kill-session -t tmt 2>/dev/null; cd src/bootc && tmux new-session -d -s tmt 'just test-tmt ... > ~/tmt.log 2>&1; echo EXIT=\$? >> ~/tmt.log'"
```

## While waiting

Check the time left each time you poll a long run, and pull partial
results back as they come (e.g. each finished tmt leg's log), not only at
the end.

A wait must end in a result or an explicit timeout report: never let a
monitor or poll loop just stop, or expire with the devspace. Bound every
wait by the devspace's deadline, and when it is reached, report what
finished, what didn't and where the logs are.

## With about 20 minutes left

Stop starting work and save what you have:

1. Copy results and logs off the devspace (`scp -O`, `rsync -e "ssh -F
   $CFG"` or `ssh ... cat`, per devspace-work), including partial ones.
2. Fetch any commits made there, review them, and push what is ready
   (see "Push early" below).
3. Record which runs didn't finish, and why (killed by the deadline, not
   failed), in the fork PR's body or a PR comment, and in your report.
4. `bot-devspace stop NAME`.

If more testing is needed, start a fresh devspace for it afterwards.

## Push early

Don't hold a push for long runs. Once a head has passed the project's
validation and unit tests, propose it (`bot-pr fork-pr`) with the runs
still pending listed in the PR body, e.g. "tmt: readonly and
image-upgrade-reboot passed; composefs sealed still running". This is
the default: a pushed head with pending runs loses nothing if the
devspace dies, and a held one loses everything. The item goes to Draft
as usual; the pending list tells the operator and the reviewer what isn't
verified yet. If you keep waiting on those runs, update the body as they
finish (`bot-pr get-body`/`set-body`); if you can't, the list is what a
follow-up picks up.

For the bot's own repositories, where `bot-land` merges once `ci` is
green, land with `bot-land --no-auto` while devspace runs are still
pending, and say which in the PR body.

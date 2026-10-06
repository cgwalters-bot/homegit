# Rationalizing the agent runtimes (design)

Status: **proposal** for the operator's decision
([tracker#394](https://github.com/cgwalters-forge/tracker/issues/394)),
researched 2026-10-05. Nothing here is implemented by this document.
Statements about current state were checked against the code at the
commits named; what is a reading rather than a fact is marked
*(inferred)*, and what could not be checked is listed at the end.

The harness has three overlapping ways to run or define a sandboxed
agent job: a hand-written `agent.yml`, a fork of
[gh-aw](https://github.com/github/gh-aw), and a workflow compiler of our
own. **Recommendation:** make gh-aw the one workflow layer (format,
compiler, job graph, safe-outputs), keep the parts that are really ours
as small standalone components that gh-aw calls (the uid sandbox with
its egress proxy, the praxis broker, the ACP harness), keep the board
controller in homegit, and freeze the workflow compiler. The order
below gets there without a cutover day.

## The measure: forge native in both halves

The operator's goal, as recorded in
[tracker#305](https://github.com/cgwalters-forge/tracker/issues/305) and
summarized in the [principles](../README.md#principles-and-direction),
is "something a bit like Paperclip.ing except with an external project
tracking system", with "sandboxed agents running in forge native way".
That is two halves, and each runtime is judged on both:

- **Tracking**: the forge's issues, PRs and project board are the
  tracker and the control plane. Paperclip has its own.
- **Runners**: the forge's Actions runners execute the agents, in a
  sandbox, and the forge's own jobs and tokens apply what they produce.
  Paperclip runs its own agent processes.

A runtime is forge native on the runner half only if *everything*
privileged happens in a forge job: an agent that runs on a runner but
whose output is applied from a laptop with a personal token is half
way there.

## What exists today

### 1. The custom agent job

`agent.yml` in bootc-dev/cgwalters-devspace-sandbox, driven by
[bin/bot-runs](../bin/bot-runs); the contract is
[devspace-agent-runs.md](devspace-agent-runs.md). **This is the only one
of the three doing real work.** Its latest 100 runs, from 2026-10-03 on,
include 93 dispatches, of which 71 succeeded, against homegit,
composefs-rs, review, tracker and bootc.

What `bot-runs` dispatches is the branch `bot/agent-run-praxis`
(78254f5), not `main` and not the forge's `bot/agent-yml`, which has
diverged from it and has no Claude support. The repository's `main` has
no `agent.yml`; the
workflow is registered through a "spike only" `push:` trigger, and forge
PR #3 that would land it has been open since 2026-09-25. Its tests
(node, Python and Rust, run by `just test`) are not run by any CI
workflow.

How it works: `bot-reconcile --apply` picks `dispatch`-labelled Todo
items within the pacing rules and calls `bot-runs dispatch`, a
`workflow_dispatch` carrying the board item id, repository, agent, model
and caps. The job holds no repository secrets. It creates a
`runner-sandbox` user and runs the agent as it through `run0`, on RHEL
10 runners; that uid's network is closed by nftables except loopback and
the broker, and its HTTP goes through a mitmproxy that leaves reads open
(minus a threat feed) and allowlists writes, which today means
`git-upload-pack` and npm audit. The runner trades its OIDC token for a
praxis run token; the
[broker](https://github.com/cgwalters-bot/praxis-credential-broker)
holds the Codex and Claude subscription credentials and caps each run at
20M tokens per API, so the agent never holds an inference credential.
Both agents (opencode, the `bot-runs` default, and Claude Code) run over
ACP under the Rust `bot-harness`, which enforces time, budget and
request caps and answers permission requests from a policy file.

The agent hands back gh-aw-format safe outputs. They are checked by
gh-aw's own validator, vendored byte for byte (about 7,900 lines, from
the fork at c6be697), plus our own checks, in a credential-free
job. Then `bot-runs apply` downloads the artifact **on the operator's
machine**, re-checks it, and commits it locally with the bot's token;
`bot-pr fork-pr` opens the draft PR. Only `create_pull_request` is
applied; an `add_comment` is printed and dropped.

Honest state: it works, and it has the best sandbox of the three (the
only one with egress control, and its read-open, write-allowlisted
proxy is close to the one the operator suggested for the fork, quoted
below). But it is about 8,500 lines of our own non-test code plus the
1,692-line bash `bot-runs`. Of that script the operator said "Nothing
security relevant should ever be in shell script that's past 5 lines"
and "we should be aligning with safe-outputs in general ... the way the
GH-AW compiler works is to insert a followup job in the workflow that
processes the artifact there"
([tracker#286](https://github.com/cgwalters-forge/tracker/issues/286)).
The broker's README calls it "an architecture spike, not a
production-ready service". Several statements in
homegit's docs are stale (for example "`agent.yml` runs only opencode"
and "egress is open for now").

### 2. The gh-aw fork

[cgwalters-forge/gh-aw](https://github.com/cgwalters-forge/gh-aw) is
four commits on top of upstream, all from 2026-10-01. They add
`sandbox.agent.runtime: host-user`: the agent runs as `runner-sandbox`
through `run0` on the runner VM rather than in gh-aw's firewall
container, so that rootless podman, multi-uid `podman build` and
`/dev/kvm` work, which bootc needs and the container rules out without
weakening it
([why](https://github.com/cgwalters-forge/gh-aw/issues/1)). A last
commit lets such an engine talk to an inference endpoint of its own,
which is how opencode reached praxis.

Honest state: a proof of concept with two passing demo runs and no
consumer. Both ran on ubuntu-26.04; the custom job runs on RHEL 10
runners, where gh-aw fails at setup for want of docker, podman and git
(tracker#254). It has no egress control, so gh-aw's strict mode refuses
it;
the agent shares the runner's checkout while the runner keeps sudo
(fork #7); its sandbox setup is a 463-line generated shell script.
Nothing has been proposed upstream: there are no issues or PRs from the
operator or the bot in github/gh-aw. Four days on, the fork is 207
commits behind, and upstream has changed 20 of the files it touches
*(a conflicting rebase is inferred)*. No work has landed on it since
2026-10-01; decisions #6, #7 and #8 there are open.

Two corrections to how this is usually described. First,
**bootc-dev/gh-agentic-workflows does not use the fork.** It runs stock
upstream gh-aw v0.90.1 with the built-in Claude engine in the firewall
container on GitHub-hosted runners, applying through a GitHub App: five
workflows (drafter, review, fix and two CI triagers) triggered by
labels and PR events, live but low volume, and also installed in bootc,
bcvk, infra and actions. Second, the vendored validator in the custom
job is pinned to a *fork* commit, but the fork changed nothing in those
files, so it is upstream's code at the merge base *(inferred from the
diff's file list)*.

The operator's direction on the fork is his comment of 2026-10-02:
"Neat! So...let's keep working on cutting over to this?", with "perhaps
we should change the firewall to default deny the tailnet" and "I think
it would be a good idea though to have an opt-in HTTP proxy enforced
which disallows HTTP POST except to an allowlist." The earlier
"direction change" comment on
[tracker#254](https://github.com/cgwalters-forge/tracker/issues/254)
(fork gh-aw rather than replace it) is the bot's summary of him, not
his text.

### 3. The workflow compiler

[cgwalters-forge/workflow-compiler](https://github.com/cgwalters-forge/workflow-compiler)
(`wfc`) is Rust embedding Nickel: it compiles a job written as
privileged, sandboxed and publishing phases into a lock file where the
sandboxed steps run as `runner-sandbox`. It is not an agent-task
compiler; its own docs say it "compiles an ordinary job, not an agent
task". Its strongest part is the requirements document: sixteen
requirements with a status and a proof each, written on the assumption
that prompt injection succeeds.

Honest state: by its own README "a proof of concept". The only agent it
runs is the scripted `fake` one; there is no inference, no egress
control (the PR adding it was closed), and safe-outputs exist only in
unmerged PRs that reimplement gh-aw's format. Nothing outside its own
CI consumes it. The last commit is 2026-09-30, and five PRs wait on a
label and ruleset that were never created
([tracker#212](https://github.com/cgwalters-forge/tracker/issues/212)).
tracker#254 records its cutover as superseded by the fork. The sibling
cgwalters-forge/agentic-job is an empty shell (licenses and CI).

## Where they duplicate each other

| | Custom `agent.yml` | gh-aw fork (`host-user`) | Workflow compiler |
| --- | --- | --- | --- |
| Real agent runs | daily, from the board | two demos | none (`fake` only) |
| Runner | RHEL 10 | ubuntu-26.04 | ubuntu-26.04 or RHEL 10 |
| Sandbox | `runner-sandbox` via run0 (node scripts) | the same idea, again (generated shell) | the same idea, a third time (node runtime) |
| Egress | nftables + L7 proxy, writes allowlisted | none | none |
| Inference credential | praxis run token; none on the runner | AWF api-proxy, or a bare endpoint | design only |
| Agents | Claude and opencode over ACP (`bot-harness`) | gh-aw's Claude adapter; opencode as a sample engine | `fake` over ACP |
| Safe-outputs | gh-aw's validator, vendored; 2 types that matter | gh-aw's, complete (dozens of types) | own reimplementation, unmerged |
| Who applies | bash on the operator's machine, bot token | a `safe_outputs` job, forge or App token | a publish phase, job token |
| Authoring | hand-written YAML, 634 lines | markdown + frontmatter, compiled (Go) | Nickel, compiled (Rust) |
| Started from the board | yes (`bot-runs dispatch`, `Run` field) | forge events; nothing board-aware | nothing |
| Non-GitHub forges | none | none | none |

The uid sandbox is written three times and the safe-outputs apply path
three times, while egress control and real inference exist once each,
both in the runtime that is officially "interim". The fork and the
compiler each spent their effort re-deriving what the custom job
already had, and neither got to the two things only gh-aw has: the
complete safe-outputs implementation and applying inside the workflow.

## Judged as forge native, against Paperclip

How Paperclip works was checked in its source
([paperclipai/paperclip](https://github.com/paperclipai/paperclip) at
72ff3a9); the UI comparison is in the review repository's
[command-ui-design.md](https://github.com/cgwalters-forge/review/blob/main/docs/command-ui-design.md)
and is not repeated. It is a Node server, React UI and PostgreSQL. Its
own database is the tracker; a protocol for external trackers is a
draft with no implementation found. By default agents are child
processes of the server, and its docs say "Local CLI adapters run
unsandboxed on the host machine" and "Treat any secret you bind to an
agent as exposed to that agent". Sandboxes are opt-in provider plugins.
So Paperclip is strong exactly where we are thin (one coherent control
plane) and thin exactly where our three runtimes pile up (isolating the
agent). What it provides, and where each piece belongs for us:

**Tickets.** The forge gives this natively: issues, sub-issues, PRs and
the board. Nothing to build, and none of the three runtimes should hold
ticket state. The `Run` field pointing at the Actions run is the only
link needed.

**Assignment and checkout.** Paperclip sets one assignee and takes an
atomic lock with a conditional SQL update. The forge gives assignees
([tracker#348](https://github.com/cgwalters-forge/tracker/issues/348):
whose turn) and, for mutual exclusion, an Actions `concurrency` group
per item, which `agent.yml` already uses (`agent-<item>`). What the
forge lacks is compare-and-swap for *choosing* among items and slots;
that is the reservation ref in the agent-slots design
([tracker#372](https://github.com/cgwalters-forge/tracker/issues/372),
[homegit#143](https://github.com/cgwalters-bot/homegit/pull/143)). It
lives in the homegit controller, not in any runtime.

**Org chart and roles.** In Paperclip's code only the `ceo` role
changes behavior; every other role is a prompt. The forge-native
equivalent of a role is *a workflow plus the identity it applies with*:
gh-agentic-workflows already has drafter, reviewer and fixer as three
workflows. gh-aw lets each workflow's `safe_outputs` job use its own
GitHub App, so per-role identity
([tracker#304](https://github.com/cgwalters-forge/tracker/issues/304))
becomes configuration there. The custom job cannot offer this:
everything it produces is applied by one bot token on one machine. No
reporting tree is proposed; the board's epics and the operator are the
hierarchy.

**Heartbeats.** A Paperclip heartbeat is a bounded run of an agent,
started by a timer, an assignment, on demand or by automation. That is
an Actions run
started by `schedule`, `workflow_dispatch` or an event: native. Our
[bot-heartbeat](https://github.com/cgwalters-forge/tracker/issues/176)
is a different thing (liveness), and it becomes derivable from the run
list once the run is the source of truth. Paperclip resumes sessions
across heartbeats; we start each run fresh and keep state on the issue
and PR.

**Budgets.** Paperclip budgets dollars per agent, project or company
from cost the agent's CLI reports, and pauses the scope afterwards. The
forge gives nothing here. Ours is built and is stricter where it
matters: the broker caps tokens per run at the inference proxy, which
the agent cannot bypass or misreport, `bot-harness` enforces the
per-run caps, and the per-pool pacing in homegit decides admission.
This stays ours: broker, harness and controller.

**Governance and approvals.** Paperclip has approval records, pause and
terminate, and an activity log. The forge gives PR review, required
checks, rulesets, cancelling a run, and the issue timeline; the
operator's exact-head approval already is our approval record. One
native piece we do not use yet: gh-aw can put the `safe_outputs` job
behind an Actions `environment:`, whose required reviewers would be an
approval gate on writes with no code of ours. The gap is durability:
artifacts and logs expire, so outcomes must be written to the issue or
PR.

Against that measure: the **custom job** is forge native on tracking
(item in, `Run` field out) and only half on runners, since admission
and apply both run on the operator's machine. The **gh-aw fork** is
fully native on runners and knows nothing of the board, slots or
budgets. The **workflow compiler** is native on runners for arbitrary
jobs and has no tracking half at all. None is forge-neutral; all three
are GitHub Actions only.

## Recommended end state

One runtime, in four layers, each with one owner.

1. **Workflow layer: gh-aw.** Agent jobs are gh-aw markdown, compiled
   by gh-aw, with its job graph: a read-only agent job, threat
   detection, and a `safe_outputs` job that applies with a scoped App
   token. `agent.yml`, the vendored validator, `bot-runs apply` and the
   compiler's safe-outputs PRs all go away. The markdown sources and
   their lock files live where `agent.yml` does now; the bot edits them
   by pull request, CI recompiles with a pinned gh-aw and fails on
   drift, as gh-agentic-workflows does. This is the operator's own
   argument to fullsend ("it should be feasible to actually reuse the
   implementation code ... and this also means we reuse the *exact same
   schema*",
   [fullsend#6614](https://github.com/fullsend-ai/fullsend/pull/6614#issuecomment-5478383657)),
   applied at home.
2. **Sandbox: one implementation of ours, outside the compiler.** The
   custom job's uid sandbox, nftables rules and write-allowlisting proxy
   become one reusable action (the sandbox repo's own roadmap already
   says to move them to bootc-dev/actions). gh-aw's `host-user` runtime
   calls it instead of emitting 463 lines of shell. This closes the
   fork's open gaps (#6 egress, #7 shared checkout) with code that
   already runs daily, makes the upstream change small (a runtime that
   delegates to an action, not a sandbox to maintain), and keeps the
   sandbox usable from a plain workflow, which is all the compiler's
   generic-job use case needs. It carries today's policy (reads open,
   writes allowlisted, tailnet closed); whether gh-aw's domain
   allowlist also applies under `host-user` is fork #6, still open.
3. **Inference and agents: praxis and `bot-harness`.** The broker stays
   the only holder of inference credentials. `bot-harness` becomes the
   single engine gh-aw sees, declared through gh-aw's `engine.behaviors`
   mechanism for third-party CLIs, driving Claude Code or opencode over
   ACP. Then caps, permission policy and the transcript format are the
   same for both agents, and we do not depend on upstream adopting
   opencode, which it ships only as an unsupported sample. *(That
   `engine.behaviors` can wrap the harness is inferred from its docs
   and from the fork already admitting such engines under `host-user`;
   it has not been tried.)*
4. **Control plane: the board and a controller in homegit.** Admission
   stays a deliberate `workflow_dispatch` from the controller, because
   it must pick a slot and fit a budget before anything starts, which a
   label-triggered workflow cannot do. The controller becomes the
   scheduled job of [scheduled-dispatcher.md](scheduled-dispatcher.md);
   slots and pacing follow the agent-slots design. Event triggers
   (labels, PR events) remain right for repositories with no board, as
   gh-agentic-workflows uses them.

**Upstream versus ours.** To gh-aw: the two prep refactors already on
the fork, a `host-user` (or bring-your-own-sandbox) runtime, and the
small safe-outputs reuse asks in fork #23. Ours for good: the sandbox
action, the egress policy, the broker, the harness, the board
controller and slots. The fork should exist only as the branch those
upstream PRs are cut from, rebased weekly, never a product.

**Forgejo and the standalone deployable.** gh-aw has no support for
other forges, and the operator's view is that a forge-agnostic system
"does really want a `generic-safe-outputs` tool that has its own
dedicated backends for gitlab/forgejo/etc", while "People who know they
are using a specific forge should be able to do forge-native things"
([fullsend#6614](https://github.com/fullsend-ai/fullsend/pull/6614#issuecomment-5516264793)).
The layering above is chosen so this stays possible: layers 2 and 3 do
not depend on GitHub beyond the runner's OIDC token, and layer 1's
schema is the portable part. A Forgejo deployment would replace gh-aw's
apply job with a Forgejo backend speaking the same schema, and the
board controller's forge client. That is not small: a gh-aw lock file
is GitHub-specific throughout (github-script, the GitHub MCP server,
App tokens), so on Forgejo layer 1 is replaced, not ported. Nothing
should be built for it now.

**What this means for related work.** packit/ai-workflows already has
the same shape on other infrastructure (an MCP gateway holding
credentials so agent containers do not), and fullsend is being argued
toward gh-aw's safe-outputs by the operator himself. Standing on stock
gh-aw schema and a small sandbox action is what makes our pieces
reusable there; a private compiler or a hand-written job is not.

## Migration order

Steps 1 to 3 are worth doing whatever is decided about the rest.

1. **Make what runs legitimate.** Land `agent.yml` on the sandbox
   repo's `main`, run its tests in CI, drop the `push:` trigger, fix
   the stale statements in homegit's docs. From then on it gets no new
   features, only fixes and the changes below.
2. **Ask upstream before building more.** A design issue on
   github/gh-aw, in the operator's words: would they take a `host-user`
   or delegating runtime, and does their preview `cloud-hypervisor`
   microVM runtime already cover podman and nested KVM? The answer
   decides how thin the fork can be. This qualifies his "let's keep
   working on cutting over to this?": the cutover continues, but
   through steps 3 and 4 rather than by growing the fork's own sandbox.
3. **Extract the sandbox action** from the custom job and switch
   `agent.yml` to it: no behavior change, and it proves the action on
   real runs. It must work on ubuntu-26.04 as well as RHEL 10, since
   gh-aw needs the former today.
4. **Bring the fork to parity**: rebase, make `host-user` call the
   action, declare `bot-harness` as the engine with praxis as its
   endpoint. Compile one `agent-run` workflow taking `agent.yml`'s
   inputs and run it on the `fake` agent, then on one lane, on
   ubuntu-26.04 runners.
5. **Apply in the workflow.** Give the `safe_outputs` job a GitHub App
   that opens the draft PR on the forge fork. `bot-runs` switches
   workflow; `bot-runs apply` and the vendored validator are deleted.
   What is left of `bot-runs` (dispatch and reconcile) moves to Rust
   per tracker#286.
6. **Retire** `agent.yml`. Move the controller to a scheduled workflow
   and add slots.
7. **Converge bootc-dev/gh-agentic-workflows** onto the same runtime
   where its agents need podman or KVM. It stays on stock gh-aw until
   the runtime is upstream.

The workflow compiler is frozen at step 1: close its open PRs, keep
the repository read-only for its requirements document, and move that
document's threat model into the sandbox action's docs at step 3.

## Alternatives considered

**Keep the custom job as the product.** It works today and needs no
upstream. But it keeps apply on the operator's machine, grows a
vendored copy to gain each output type (applying a PR with gh-aw's own
code pulls in about 70 more modules), has no per-role identity, and is
the opposite of what the operator tells other projects to do.

**Finish the workflow compiler.** It is the only one that sandboxes
arbitrary jobs and the only one in Rust. But it needs inference,
egress, safe-outputs and a task layer before it matches what the other
two have between them, and it would be a second compiler for a format
only we use. It is the one option where we own the generated output,
which would matter for Forgejo; the sandbox action covers its real use
case in the meantime.

**Carry the fork as ours, never upstream.** Fastest in the short term.
At about 50 upstream commits a day, with the sandbox implemented inside the
compiler's most-churned files, the rebase cost is permanent.

**Drop `host-user`; use upstream's container or microVM.** No fork at
all. The container was measured and needs AWF weakened for multi-uid
podman. The microVM runtime was not evaluated; step 2 asks.

**Adopt Paperclip.** It gives the org chart, checkout, budgets and
approvals in one product, but as a second tracker beside the forge, and
with agents unsandboxed by default. That contradicts both halves of the
measure.

## Decisions for the operator

**D1. The end state.**
A. gh-aw is the one workflow layer; sandbox action, broker, harness and
controller are ours (recommended).
B. The custom `agent.yml` is the product and keeps vendoring gh-aw.
C. The workflow compiler is the product.

**D2. The workflow compiler.**
A. Freeze now: close its PRs (the five waiting on you in tracker#212
included), re-scope tracker#88 and #270, keep the requirements document
(recommended).
B. Keep it alive only as a sandbox for non-agent jobs.
C. Keep developing it.

**D3. Where the sandbox implementation lives.**
A. One standalone action that the custom job, then gh-aw's runtime,
call (recommended).
B. Inside the gh-aw compiler, as on the fork today.
C. Neither: drop `host-user` and use upstream's microVM runtime, if the
answer to D4 shows it covers podman and KVM.

**D4. Upstream timing.**
A. Open the design issue on github/gh-aw now, before more fork work
(recommended; the text is yours to write, the bot can draft the facts).
B. Reach parity on the fork first, then propose.
C. Do not upstream.

**D5. The engine.**
A. `bot-harness` over ACP as the single gh-aw engine for Claude and
opencode (recommended).
B. gh-aw's built-in Claude engine plus its opencode sample.

**D6. Who applies, with what identity.** This widens where a write
credential lives, so it is yours whatever else is delegated.
A. A `safe_outputs` job with a GitHub App scoped to the forge org,
opening draft PRs there; one App now, per role later (recommended).
B. The same, behind an Actions environment with you as required
reviewer.
C. Keep applying locally with the bot token.

**D7. The interim.**
A. Land `agent.yml` on `main` with CI and freeze it (recommended).
B. Leave it on its branch until the cutover.

**D8. The runner OS for gh-aw runs.**
A. ubuntu-26.04, as the demos used; the sandbox action supports both
(recommended).
B. Make the RHEL 10 runner image carry what gh-aw's setup needs.

## Not verified

- That gh-aw's `engine.behaviors` can run `bot-harness`, and that its
  cross-repository safe-outputs (`target-repo`, `allowed-repos`) fit a
  dispatch whose target repository varies per run. Both are documented
  features; neither was tried.
- How gh-aw's threat-detection job, which runs an engine of its own,
  gets inference when praxis is the only credential holder: through the
  same runtime and broker, or replaced by deterministic checks.
- Whether gh-aw's `cloud-hypervisor` runtime supports podman and nested
  KVM; its reference documents only that it exists, in preview.
- Whether upstream would accept a `host-user` runtime. No such issue
  exists; their visible direction is rootless Docker and microVMs.
- Forgejo: whether its Actions offers an OIDC token the broker could
  trust, `run0`-capable runners, or anything like environments.
- The custom job's runners being provider-hosted ephemeral VMs is
  inferred from the scripts. A few recent runs came from other
  `bot/agent-run-*` branches.
- Paperclip: the CEO-strategy approval gate was found only in
  constants, CLI and docs; whether a budget stop kills an in-flight run
  was not traced; no installation was exercised.

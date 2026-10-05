# Named agent slots (design)

Use a fixed pool of named slots, with one git state ref as the reservation
authority and issue resources, board fields and heartbeat as projections.
Proposal for [#342](https://github.com/cgwalters-forge/tracker/issues/342), not a deployed scheduler/API,
with turn ownership from [#348](https://github.com/cgwalters-forge/tracker/issues/348)
and role identities from [#304](https://github.com/cgwalters-forge/tracker/issues/304).

## Pool, identity and lifecycle

Proposed defaults: `opus-0..1`, `sonnet-0..1`, `sol-0..3`; global `maxActive=4`.
Configuration sets inclusive N per family (`opus-0..N`, etc.) and the cap.
Names persist; shrinking drains occupied slots first. Empty slots stay visible.
The cap counts assigned, queued, running and stopping slots across all locations.

Each slot specifies engine, exact model, location and subscription pool.
Defaults pair opus/sonnet with `claude` and sol with `opencode` plus
`praxis/gpt-6.1-sol`; resolve Claude aliases to an exact model at launch.
Remote means a devspace `agent.yml` run; local means a detached
[bot-claude](../bin/bot-claude) job (or the existing opencode launcher for sol).
Location changes retain names; remote Claude needs the external broker/workflow
described in the [dispatch contract](devspace-agent-runs.md#dispatch).

An item has `assignedSlot`, and a slot has `assignedItem`; both refer to the
same reservation generation. Idle slots have neither, `runURL=null`,
`started=null`, and `tokens=null`. Assigned slots reserve capacity before
launch; running slots add start time and execution identity. Tokens are
attempt-scoped input/output/cache-write/cache-read counters, unknown until
observed; fresh tokens exclude cache reads. Keep completed attempt records
before returning the slot to idle. Stopping retains its reservation.

Carry the stable name into the run title, logical job identifier, `Agent-slot`
trailer and heartbeat worker name. Preserve the existing title's item/repo
prefix until [bot-runs](../bin/bot-runs) parsing is migrated; append the slot
and reservation ID. Keep its existing `Agent-run` trailer too. Local job IDs
can be `sol-0.g17`; never reuse an attempt directory. GitHub Actions YAML
`jobs.<job_id>` keys are static, not dynamic slot names: use a static job key,
a slot-bearing display name and a recorded logical identifier. Consumers
must migrate together because bot-runs currently checks job display names.
Fence all observations and cleanup by `(slot, generation, execution, attempt)`;
an old completion must never free a newly occupied slot.

Assignees express whose turn it is: operator while waiting for human action,
bot during a bot turn (#348). Neither assignee is a slot or a model.
Track executor/reviewer/coordinator role identities separately (#304), with
the actual actor login; changing role does not create capacity or change
authorship. A topic Lead is routing context, not necessarily a worker claim.

## Subscription pacing

Use sanitized praxis `/usage` percent-used plus reset windows per subscription
pool, including shared and model-specific windows. This is a **proposed external
interface**: no deployed endpoint, authentication scheme or producer is verified
here. Require window ID, scope, observed time, used percentage, reset time and
an accounting watermark identifying included spend. Percent is capacity, not AIC.

For each applicable window w, default reserve `r_w=5` percentage points.
With observed usage `u_w`, gross availability is `G_w=max(0,100-r_w-u_w)`.
`O_w` is the sum of remaining future-cost reservations plus actual spend not
yet covered by the usage watermark, across all controller attempts in that
window (including prior-day attempts). Each cost portion belongs to exactly
one of future reservation, unobserved actual or observed usage.
Admission headroom is independently `H_w=max(0,G_w-O_w)`.

Persist a **fixed daily total ceiling** B per `(pool, window ID, UTC date)`.
Select it once at UTC opening or a confirmed pool-window reset:
`B_w=G_w*min(1,D/(reset_w-opening))`, where D is time from opening to the
next UTC midnight, at most 24h. Use gross G **before carried reservations**,
not H. Late initialization uses the remaining day; all times use the same
units. Hourly observations update u/O/H, never increase or recompute B.
Unused daily credit expires. Target full use minus reserve by reset; shorter
windows may spend their headroom before reset, subject to daily and slot caps.

In that daily epoch, S is actual spend incurred since opening, even if already
included in u; C is remaining future cost of its active reservations.
At opening set S=0 and charge carried remaining reservations to C exactly once.
Daily credit is `max(0,B_w-S_w-C_w)`; also require new cost to fit H.
Consumption transfers future cost C to actual S once, adjusting for estimate
error; actual remains in O until its watermark is covered, then leaves O
without changing S. Duplicate observations/events never charge S again.
Cancellation releases only unspent future cost. Carrying C above B blocks
new work, not a larger B. Prior-day unobserved actual stays in O, not new S/C.
Shared outside usage reduces G/H; it does not replenish B.

At midnight, suppose gross G=70 (reserve already excluded), seven days/168h
remain and a live attempt carries future O=2. Then B=70*24/168=10, C=2,
S=0, daily credit=8 and H=68; subtracting O when forming B would double-charge
the carry. Starting at G=95/168h gives B=13.57; spending it in hour one leaves
zero daily credit, even though hourly usage refresh still shows headroom.

Each applicable shared/model window has its own ceiling and ledger; test all
windows, never add their percentages together. A confirmed new window ID
archives only that window's epoch and recharges carried *remaining* cost once;
unaffected windows retain B/S/C. Midnight plus reset opens one epoch, not two.
Old-window actual remains historical and cannot be charged to the new window.
Until a fresh confirmed reset observation arrives, dispatch stays blocked.
Reject missing/duplicate windows, nonfinite or out-of-range percentages,
future observations, readings older than one hour, nonfuture/invalid reset
times, regressing watermarks, or changed reset times under the same window ID.
Recovery within the same epoch preserves its ceiling/ledger, never opens a
fresh allowance. If spend coverage cannot be established, retain conservative
O and block automatic dispatch rather than guess a watermark from timestamps.

Estimate a task's conservative percent cost `c_w` from per-model/window
calibration against fresh tokens; retain uncertainty margin. Unknown costs
or readings older than one hour block automatic dispatch. Bootstrap calibration
requires fresh usage and a configured bound (default zero, maximum 1 percentage
point/day/window), charged to the same B/C/O ledger and under all caps.
Tokens are not provider percentages; bootstrap cannot waive invalid telemetry.

**Dispatch rule:** choose the highest-priority eligible unassigned bot-turn
item and an idle compatible slot; dispatch only if active count is below
`maxActive`, and `c_w` fits both headroom and today's credit for **every**
applicable window. Atomically reserve item, slot and all budget charges.
Keep existing lane/policy eligibility, but do not let separate lanes or
engines each spend the global cap. Reserve exhaustion permits no automatic
exception, even for P0. A blocked item waits in the unreserved pending queue;
assigned/Actions-queued executions still count toward maxActive. Re-evaluate
on UTC opening, confirmed reset, released commitment or confirmed slot exit,
using every window and cap again; these wakeups do not replenish B. Apply
per-attempt fresh-token, AIC and timeout caps independently; stop at the cap
and retain ownership until exit confirms. A new attempt must pass admission.

## Storage choices and concurrency

**(a) One issue per resource.** Store one JSON `apiVersion/kind/metadata/
spec/status` envelope in the issue body or the bot's pinned comment.
`metadata.resourceVersion` is an application revision, not a forge CAS token.
Read body, revision, `updated_at` and available edit-history head; immediately
before PATCH, reread and abort/recompute if any differ from the baseline.
After PATCH, reread and compare the entire expected JSON/revision/write ID;
inspect available edit history for intervening edits, flag conflicts and
reconcile rather than blindly restoring the old body. Timestamps alone can
miss same-tick writes; edit history is not uniformly available for comments.
Both writers can pass preflight; A can verify before B overwrites A.
Postflight detects only some losses. There is **no CAS** or atomic multi-issue reservation.

**(b) Append-only comments.** Events with unique IDs, base revision, actor,
generation and type fold deterministically in server order with deduplication.
Concurrent appends overwrite no events, but two claim events still need
arbitration before either worker starts: event durability is not exclusive
ownership. A single arbitrator or CAS authority must select a winner.
Compact to a checkpoint with last included event ID/digest; retain audit events,
paginate completely and fold later events only, including concurrent appends.

**(c) Project fields.** Convenient filtering and UI for Assigned slot, Run,
Status and budgets; current field mutations and draft-body state provide
neither multi-field transactions nor server-side conditional writes. Local
flock is not a cross-host lock. Treat these as rebuildable projections.

**(d) Git refs/notes.** A ref update is real server-side old-OID/new-OID CAS.
Use `refs/heads/bot-state/agent-slots` in the existing forge repository, with
a small JSON tree for the entire pool, slot state, item index and budgets.
Read tip T, validate invariants, build one commit whose sole parent is T,
then push normally, without force. A concurrent sibling update is rejected
as non-fast-forward (NFF); fetch, recompute and retry, never merge competing
claims mechanically. Notes can use the same ref discipline but complicate
inspection/merging without improving exclusivity. A single ref gives atomic
pool/slot/item/budget reservation; independent per-slot refs would not.

Recommend (d) for authority and (a)/(c) for resources and board projections:
use the existing forge's git/issues, with no new datastore service. Restrict
writers to this protocol; prohibit ref deletion/rewrites. After an ambiguous
push result, read the tip/history for the reservation ID before retrying.
Reservation precedes launch, but git and workflow dispatch are not one
transaction: persist a launch intent, discover an existing execution by its
reservation ID after a timeout, and do not blindly dispatch again. Unknown
launch state holds the slot until reconciled. Worker startup checks the
current reservation; renewals/releases also use CAS and generation fencing.
Lease expiry alone cannot free capacity while execution might still live.

## Resource sketch and consumers

Sketch uses family counts, omits idle siblings/history; `resourceVersion` is the OID
supplied on read, not stored self-referentially; projections copy it.

```json
{
  "apiVersion": "homegit/v1alpha1",
  "kind": "AgentPool",
  "metadata": {"name": "default", "generation": 1, "resourceVersion": "<git-tip-oid>"},
  "spec": {
    "maxActive": 4, "reservePercent": 5,
    "families": {"opus": 2, "sonnet": 2, "sol": 4},
    "slots": {"sol-0": {"engine": "opencode", "model": "praxis/gpt-6.1-sol", "location": "remote", "pool": "codex"}}
  },
  "status": {
    "observedGeneration": 1,
    "slots": {"sol-0": {"state": "assigned", "generation": 17,
      "reservation": "r17", "assignedItem": "PVTI_example",
      "runURL": null, "started": null, "execution": null, "attempt": null, "tokens": null}},
    "items": {"PVTI_example": {"assignedSlot": "sol-0", "reservation": "r17"}},
    "budgets": {"codex": {"windows": []}}, "conditions": []
  }
}
```

The controller validates spec, reserves, launches, observes, reconciles budgets
and retries projections. Spec changes bump a generation; status records the
reconciled generation and blocked/stale conditions. Issue `AgentSlot` resources
carry slot spec/status and the same revision. The app's **proposed external interface**
reads revision-stamped snapshots: all slots (including idle), assignments,
execution links, start times, freshness and separately authorized usage.
It submits desired changes through the controller with an expected revision;
it does not edit status or claim via a board field. The app is outside this
checkout; local heartbeat publishing is not proof of app implementation.

Forgejo and GitLab can host the same git-ref protocol and issue/comment JSON.
Verify server ref protection and NFF behavior before enabling multiple writers.
Adapters map Actions IDs to Forgejo jobs or GitLab pipelines/jobs and fields
to boards/labels; Projects/edit history are optional. The schema stays shared.

## Grounding and replacement phases (#342)

Today [pacing](../lib/pacing.js) counts In Progress items with Lead or Run.
[bot-capacity](../bin/bot-capacity) reads cached Claude seven-day statusline
usage or a token budget; [capacity math](../lib/capacity.js) projects burn and
uses 80% P0-only/100% stop thresholds, not the proposed reset-target rule.
[bot-runs dispatch](../bin/bot-runs) starts before setting Run; board failure
leaves a live unrecorded run. Its AIC cap differs from pacing's fresh tokens.
[Checked state writes](../bin/bot-board) implement `state-put --checked
--strict` (the state-set-checked concept), reread/merge, not CAS;
[bot-work's lease](../bin/bot-work) explicitly admits the remaining race.
[Reconcile](../lib/reconcile.js) reports orphan Leads/heartbeat drift and
preserves topic Leads. [Run watch](../lib/run-watch.js) rechecks ownership and
attempts before cancellation recovery and retries heartbeat cleanup.
[Heartbeat](../bin/bot-heartbeat) publishes engine/model/location but keeps
`agent_ids` and usage local/private; [board summaries](../lib/board-status-update.js)
scope saved heartbeat workers to board items. Preserve that privacy split.

Phase 1 adds names/projections alongside heartbeat, Lead and Run; backfill live executions.
Phase 2 routes every local/remote claim through atomic reservations and budget
accounting, counts legacy executions toward the cap, and moves orphan recovery
to fenced slot state. Phase 3 replaces heartbeat ownership and worker Lead/Run
authority with slot resources; retain heartbeat freshness, topic routing and
human-turn assignees as distinct concerns. Remove legacy writers after all
launchers, watchers and the external review app consume the new contract.

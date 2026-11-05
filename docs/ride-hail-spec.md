# Ride hail — product requirements and specification

**Status:** definition, registries, and subject schema landed and validated; runtime integration not started
**Definition id:** `ride-hail-demo`, version 1
**Owner:** flowkit-demo maintainers
**Source:** `packages/domain/src/ride/`, verified by `test/ride-definition.test.ts`

---

## 1. Summary

`flowkit-demo` ships one reference workflow: leave approval. It is a good first proof — a linear
approval with one review gate — and it is precisely the shape FlowKit was extracted from. That
makes it a weak second data point. A framework proven only against the process it was designed for
has not been proven to generalize; it has been proven to still work.

This document specifies a second reference workflow in the same repository: an on-demand ride hail.
A ride is not an approval. Nothing waits politely in a queue, the actor holding the process changes
mid-flight and can hand it back, two clocks run against real people rather than office SLAs, and
money moves in both directions from four different stages. It is chosen for the parts of FlowKit it
stresses that leave approval never touches.

The deliverable is a domain module, not a product. The rider never sees a map. The point is the
flow definition and what building it revealed about the kernel.

---

## 2. Why a ride

Each row is a FlowKit capability, the ride mechanic that exercises it, and what leave approval does
with the same capability today.

| Capability | Ride mechanic | Leave approval today |
|---|---|---|
| Tracks (parallel state) | `driver` custody and `payment` position advance independently of the stage | Declares no tracks at all — the feature is untested by the demo |
| SLA escalation to an action | 15s driver acceptance window, 2m quote expiry, 5m pickup wait | One SLA, escalating to a notification, not an action |
| Rule-driven system routing | Five rules across quote, dispatch, settlement, capture, and fee assessment | Two rules, one of which returns a constant |
| Cycles in the stage graph | `driver_offer → driver_matching` re-dispatch; `support_review → trip_in_progress` | Acyclic apart from a single `return` to draft |
| Actor reassignment mid-flow | The offer holder changes on every re-dispatch; `offeredDriver` scopes to the current one | Approver is fixed at submission |
| Guards over live facts | `driverOnline`, `riderOnboard` gate transitions on state the definition cannot see | One guard, on task claim ownership |
| Multi-terminal outcomes | Six terminals, three of which are failure modes with different money positions | Three terminals, all approval outcomes |
| Money after the process ends | `payment_recovery` outlives the trip by up to 24h | No financial state |

The honest summary: leave approval exercises the transition kernel. The ride exercises the
interpreter.

---

## 3. Goals and non-goals

### Goals

1. **G1 — Prove the DSL generalizes.** Express a genuinely different process shape using only
   `defineFlow` and the published registry contracts, with no framework changes required to model it.
2. **G2 — Exercise the untested surface.** Put tracks, action-escalating SLAs, graph cycles, and
   multi-rule routing under a lint-clean, validated definition.
3. **G3 — Surface framework gaps as evidence, not opinion.** Where the ride cannot be expressed
   cleanly, record the specific interpreter behaviour responsible with a proposed contract change.
4. **G4 — Stay inside the consumer boundary.** No edits to `node_modules`, no framework source
   imports, no parallel copy of a `@naakwu/flowkit-*` package.
5. **G5 — Preserve the tenant invariant.** Every subject, task, transition, and notification stays
   organization-scoped, matching `docs/architecture.md`.

### Non-goals

- **Not a dispatch engine.** `dispatchNearestDriver` picks a candidate from seeded data. There is no
  geospatial index, no ETA model, no supply-demand pricing.
- **Not a payments integration.** Authorization and capture are activity stubs that record intent.
  No PSP, no card data, no PCI surface.
- **Not a live-tracking product.** No location streaming, no map, no driver app.
- **Not a replacement for leave approval.** Both reference workflows ship. The comparison is the
  point.
- **Not Phase 3 work.** The definition is compiled TypeScript, consistent with the current phase of
  `flowkit/docs/vision.md`.

---

## 4. Personas and roles

Three roles, declared in the definition as `['rider', 'driver', 'support']`.

| Role | Holds the flow at | Cares about |
|---|---|---|
| **Rider** | `trip_draft`, `rider_confirmation`, `payment_recovery`, `rating` | A fixed price before committing, an accurate arrival, and never being charged for someone else's failure |
| **Driver** | `driver_offer`, `driver_en_route`, `driver_arrived`, `trip_in_progress` | Deciding on an offer in seconds, not being penalized for a rider who never appears, and being released cleanly when a trip ends |
| **Support** | `support_review` | Pulling a live trip to a human without losing the fare or stranding either party |

The rider and the driver are both external, mutually distrusting parties. Neither is an employee of
the operator. This is the substantive difference from leave approval, where every actor sits inside
one organization's hierarchy — and it is why `tripParticipant` exists as a distinct policy from
`riderOwnsTrip` and `assignedDriver`.

---

## 5. User stories and acceptance criteria

Each story names the actions that satisfy it, so the definition can be read against the requirement.

### R1 — A rider gets a fixed price before committing

> As a rider, I want a price I can accept or walk away from, so I am never surprised by the fare.

- `request_ride` moves to `fare_quote`, which runs `estimateRoute`, `priceTrip`, and
  `authorizePaymentMethod` before anything is shown.
- `offer_quote` sets `payment: authorized`. A quote the rider can see is a quote already backed by
  an authorization.
- If authorization fails, `decline_payment` terminates at `payment_failed` with `payment: failed`
  and notifies `ride.payment_failed`. The rider is never offered a price they cannot pay.
- **Acceptance:** no path reaches `rider_confirmation` with `payment: none`.

### R2 — A held quote expires rather than waiting forever

> As the operator, I want an unaccepted quote to expire, so a stale price is never honoured.

- `rider_confirmation` declares `sla: { after: '2m', escalate: { action: 'expire_quote' } }`.
- `expire_quote` terminates at `expired` and releases the authorization.
- **Acceptance:** the authorization is released on every exit from `rider_confirmation` that is not
  `confirm_ride`.

### R3 — A driver decides in seconds, and a refusal costs the rider nothing but time

> As a driver, I want a short, unambiguous acceptance window. As a rider, I want a refusal to be
> invisible to me.

- `driver_offer` declares `sla: { after: '15s', escalate: { action: 'decline_timeout' } }`.
- Both `decline_ride` (explicit) and `decline_timeout` (silent) return to `driver_matching` and set
  `driver: unassigned`. They are separate actions so the audit trail distinguishes a driver who
  refused from one who never looked.
- `payment` is untouched by a re-dispatch. The rider's authorization survives the loop.
- **Acceptance:** after any number of declines, `payment` is still `authorized` and the stage is
  `driver_matching`.

### R4 — Dispatch gives up rather than searching forever

> As a rider, I want to be told no driver is coming, so I can make another plan.

- `routeDispatch` returns `offer_ride` while a candidate exists and `dispatchAttempt` is below
  `MAX_DISPATCH_ATTEMPTS` (5), otherwise `no_drivers_available`.
- `no_drivers_available` terminates at `unfulfilled`, releases the authorization, and notifies
  `ride.no_drivers`.
- **Acceptance:** the re-dispatch loop terminates. **This criterion is not currently satisfiable —
  see §8, FK-1.**

### R5 — Cancellation cost depends on what the cancellation destroyed

> As a rider, I want free cancellation until a driver is actually coming. As a driver, I want to be
> compensated when a rider cancels after I have committed.

- Before commitment — `cancel_quote`, `cancel_during_match` — go straight to `cancelled` with
  `payment: released`. No fee stage, no charge.
- After commitment — `rider_cancel_en_route`, `rider_cancel_at_pickup`, and the `report_no_show`
  escalation — route through `cancellation_fee_assessment`, where `routeCancellationFee` decides
  between `charge_cancellation_fee` and `waive_cancellation_fee`.
- A driver-caused cancellation (`driver_cancel_en_route`) returns to dispatch and never charges the
  rider.
- **Acceptance:** no path charges a fee before `driver` has reached `assigned`.

### R6 — The meter does not start before the rider is in the car

> As a rider, I want to be certain I am not billed for a trip I was not on.

- `start_trip` carries `guards: ['riderOnboard']`, which requires `facts.pickupVerified === true`.
- **Acceptance:** `start_trip` is rejected with a guard rejection when verification is absent.

### R7 — Either party can pull a live trip to a human

> As a rider or a driver, I want a way out of a trip that has gone wrong.

- `report_incident` is available to `tripParticipant` — the only policy either party satisfies — and
  moves to `support_review`, notifying support.
- Support may `resume_trip` (requires `supportTaskClaimed`) or `terminate_trip`.
- `support_review` escalates to `terminate_trip` after 10m so an unstaffed queue cannot strand a
  trip mid-route.
- **Acceptance:** `support_review` has no exit that leaves the fare unresolved.

### R8 — A failed capture does not vanish

> As the operator, I want an unpaid fare to remain actionable after the trip ends.

- `routeCapture` sends a failed capture to `payment_recovery`, which holds the rider for up to 24h.
- The rider may `update_payment_method` and re-enter `payment_settlement`; otherwise the SLA
  escalates to `write_off_fare`.
- `driver: released` is set on entry to recovery. The driver's involvement ends with the trip, not
  with the debt.
- **Acceptance:** the driver track reaches `released` on every terminal path.

### R9 — Rating never blocks completion

> As a rider, I want to skip rating without leaving the trip open.

- `rating` escalates to `skip_rating` after 24h. Both `submit_rating` and `skip_rating` reach
  `completed`.
- **Acceptance:** no non-final stage can hold a trip indefinitely without an SLA.

---

## 6. Flow model

### 6.1 Stage graph

```text
                                 trip_draft ──discard_draft──▶ abandoned
                                     │
                                request_ride
                                     ▼
                                fare_quote ──decline_payment──▶ payment_failed
                                     │
                                 offer_quote
                                     ▼
     expired ◀──expire_quote── rider_confirmation ──cancel_quote──▶ cancelled
                                     │                                  ▲
                                confirm_ride                            │
                                     ▼                                  │
  unfulfilled ◀─no_drivers_available─ driver_matching ◀────┐            │
                                     │                     │            │
                                 offer_ride                │            │
                                     ▼                     │            │
                              driver_offer ──decline_ride──┤            │
                                     │      decline_timeout┤            │
                                     │   cancel_during_match────────────┤
                                accept_ride                │            │
                                     ▼                     │            │
                            driver_en_route ─driver_cancel_en_route─────┘
                                     │      │                           │
                            arrive_at_pickup└─rider_cancel_en_route─┐    │
                                     ▼                              ▼    │
                              driver_arrived ─report_no_show──▶ cancellation_fee
                                     │       rider_cancel_at_pickup  _assessment
                                 start_trip                          │
                                     ▼                    charge/waive_fee
                            trip_in_progress ◀─resume_trip─┐         │
                                     │                     │         ▼
                              complete_trip          support_review  cancelled
                                     │   report_incident──▶│
                                     │       terminate_trip│
                                     ▼◀─────────────────────
                             fare_finalization ──waive_fare──────┐
                                     │                           │
                                capture_fare                     │
                                     ▼                           │
                            payment_settlement                   │
                                     │      retry_settlement     │
                            settle_payment  └─▶ payment_recovery │
                                     │            │   │          │
                                     │  update_payment_method    │
                                     │            │   write_off  │
                                     ▼◀───────────┘   └──────────┤
                                  rating ◀────────────────────────
                                     │
                       submit_rating / skip_rating
                                     ▼
                                 completed
```

### 6.2 Stage reference

| Stage | Holder | Entry work | SLA | Exits |
|---|---|---|---|---|
| `trip_draft` | rider | — | — | `request_ride`, `discard_draft` |
| `fare_quote` | — | `estimateRoute`, `priceTrip`, `authorizePaymentMethod`, rule `routeQuote` | — | `offer_quote`, `decline_payment` |
| `rider_confirmation` | rider | — | 2m → `expire_quote` | `confirm_ride`, `cancel_quote`, `expire_quote` |
| `driver_matching` | — | `dispatchNearestDriver`, rule `routeDispatch` | — | `offer_ride`, `no_drivers_available` |
| `driver_offer` | driver | — | 15s → `decline_timeout` | `accept_ride`, `decline_ride`, `decline_timeout`, `cancel_during_match` |
| `driver_en_route` | driver | — | — | `arrive_at_pickup`, `rider_cancel_en_route`, `driver_cancel_en_route` |
| `driver_arrived` | driver | — | 5m → `report_no_show` | `start_trip`, `report_no_show`, `rider_cancel_at_pickup` |
| `trip_in_progress` | driver | — | — | `complete_trip`, `report_incident` |
| `support_review` | support | — | 10m → `terminate_trip` | `resume_trip`, `terminate_trip` |
| `fare_finalization` | — | `computeFinalFare`, `applyPromotions`, rule `routeSettlement` | — | `capture_fare`, `waive_fare` |
| `payment_settlement` | — | `captureRiderPayment`, rule `routeCapture` | — | `settle_payment`, `retry_settlement` |
| `payment_recovery` | rider | — | 24h → `write_off_fare` | `update_payment_method`, `write_off_fare` |
| `cancellation_fee_assessment` | — | `assessCancellationFee`, rule `routeCancellationFee` | — | `charge_cancellation_fee`, `waive_cancellation_fee` |
| `rating` | rider | — | 24h → `skip_rating` | `submit_rating`, `skip_rating` |
| `completed` `cancelled` `abandoned` `expired` `unfulfilled` `payment_failed` | — | final | — | — |

Twenty stages, six terminal. Every non-final stage declares at least one action and every
human action declares a policy, so `lintInterpreterFlow` returns clean.

### 6.3 Tracks

Two facts about a ride do not belong on the stage axis, because the same stage can be reached with
either value and the same value can be reached from opposite stages.

```ts
driver:  unassigned → offered → assigned → arrived → released
payment: none → authorized → captured | failed | released
```

A completed trip and a rider who cancelled at the kerb both end with `payment: captured`, from
`payment_settlement` and `cancellation_fee_assessment` respectively. A trip that never found a
driver and a quote the rider let expire both end with `payment: released`, from opposite ends of the
graph. Modelling either as a stage would mean duplicating the tail of the graph once per money
outcome — six terminals become fifteen, and every future action has to be declared on each copy.

`driver: released` is set on the same actions that resolve the money, which is what lets
`payment_recovery` hold a rider for 24h after the driver has been freed to take other trips.

Track values are validated by the kernel: `InvalidTrackValueError` is thrown for any value outside
the declared set, so a typo in an action's `tracks` map fails at transition time rather than
silently writing a bogus state.

### 6.4 Timing

| Stage | Window | Escalates to | Why this number |
|---|---|---|---|
| `driver_offer` | 15s | `decline_timeout` | A driver deciding at a junction. Long enough to read, short enough that the rider does not notice a re-dispatch |
| `rider_confirmation` | 2m | `expire_quote` | The price and the driver supply behind it are both stale after this |
| `driver_arrived` | 5m | `report_no_show` | Industry-standard grace period before a no-show is chargeable |
| `support_review` | 10m | `terminate_trip` | An unstaffed queue must not strand a live trip |
| `payment_recovery` | 24h | `write_off_fare` | Recovery is worth one retry cycle; beyond that, collection is not a workflow problem |
| `rating` | 24h | `skip_rating` | Ratings decay in value; an open trip costs more than a missing rating |

Durations use the interpreter's own format (`15s`, `2m`, `24h`), not ISO-8601. See §8, FK-2.

### 6.5 Rules

Rules are pure and may return only system actions declared on the stage they run in — both are
enforced by `validateFlowkit` at boot.

| Rule | Returns | Decides on |
|---|---|---|
| `routeQuote` | `offer_quote` \| `decline_payment` | `paymentAuthorized` |
| `routeDispatch` | `offer_ride` \| `no_drivers_available` | `candidateDriverId`, `dispatchAttempt` vs `MAX_DISPATCH_ATTEMPTS` |
| `routeSettlement` | `capture_fare` \| `waive_fare` | `finalFareCents`, `serviceCreditApplied` |
| `routeCapture` | `settle_payment` \| `retry_settlement` | `captureSucceeded` |
| `routeCancellationFee` | `charge_cancellation_fee` \| `waive_cancellation_fee` | `cancellationFeeCents` |

Every routing input is read through a `routingInput` helper that prefers `facts` and falls back to
`subject`. That indirection exists solely because of FK-1 below; with FK-1 resolved the fallback
becomes dead code and can be deleted without touching a single rule body.

### 6.6 Guards and policies

Guards answer *is this transition allowed given the state*. Policies answer *is this actor allowed
to attempt it*. FlowKit keeps them separate on purpose (`vision.md` §5.3) and the ride keeps that
separation visible.

| Guard | Requires | Used by |
|---|---|---|
| `driverOnline` | actor id in `facts.onlineDriverIds` | `accept_ride` |
| `riderOnboard` | `facts.pickupVerified === true` | `start_trip` |
| `supportTaskClaimed` | `facts.supportTaskAssigneeId === actor.id` | `resume_trip` |

| Policy | Requires |
|---|---|
| `riderOwnsTrip` | role `rider` and `actor.id === subject.riderId` |
| `offeredDriver` | role `driver` and `actor.id === subject.driverId` — scoped to the *current* offer holder |
| `assignedDriver` | role `driver` and `actor.id === subject.driverId` |
| `tripParticipant` | actor is either the rider or the driver |
| `supportAgent` | role `support` |

`offeredDriver` and `assignedDriver` are deliberately separate names despite an identical body
today. They diverge the moment `driverId` becomes a candidate list rather than a single id, and a
policy rename is a smaller change than splitting a policy that two lifecycle phases share.

Guards receive `facts` supplied by the `resolveActionContext` activity, which is free to do I/O.
This is the seam that lets a pure definition gate on driver presence and pickup verification without
either fact appearing in the definition.

---

## 7. Data and integration contracts

### 7.1 Subject

`rideRequestSchema` (`ride.types.ts`) is strict and rejects a dropoff identical to the pickup.
Fields: `riderId`, nullable `driverId`, `pickup`/`dropoff` coordinates with labels, `productTier`,
`paymentMethodId`, `quotedFareCents`, `estimatedDistanceMeters`, `estimatedDurationSeconds`,
`surgeMultiplier`, nullable `riderRating`, and `metadata`.

`driverId` is nullable and re-written on every dispatch. It is the one subject field whose value is
not stable for the life of the flow, which is what makes `offeredDriver` a moving target.

**Constraint:** the interpreter passes `subject.metadata` — not the subject — to rules and to the
transition context. Any field a policy or rule reads must be present in `metadata`, mirroring how
the leave demo seeds `employeeId` and `managerId`. Persisting the ride record and projecting it into
metadata is application work, not framework work.

### 7.2 System steps

Eight declared refs, all resolved by the consumer's `executeSystemStep` activity. Each must be
idempotent per `(workflowId, entryEpoch, stepIndex)`, because a workflow replay re-runs entry work.

| Ref | Stage | Does | Produces |
|---|---|---|---|
| `estimateRoute` | `fare_quote` | Distance and duration for the pair | `estimatedDistanceMeters`, `estimatedDurationSeconds` |
| `priceTrip` | `fare_quote` | Applies tier and surge | `quotedFareCents`, `surgeMultiplier` |
| `authorizePaymentMethod` | `fare_quote` | Places a hold | `paymentAuthorized`, `authorizationId` |
| `dispatchNearestDriver` | `driver_matching` | Selects a candidate, increments the attempt counter | `candidateDriverId`, `dispatchAttempt` |
| `computeFinalFare` | `fare_finalization` | Actual vs. quoted, waiting time | `finalFareCents` |
| `applyPromotions` | `fare_finalization` | Credits and promo codes | `finalFareCents`, `serviceCreditApplied` |
| `captureRiderPayment` | `payment_settlement` | Captures the hold | `captureSucceeded`, `receiptId` |
| `assessCancellationFee` | `cancellation_fee_assessment` | Fee from custody state and elapsed time | `cancellationFeeCents` |

Outputs land in `execution.stepResults` and are recorded for audit. They are **not** visible to the
rule that runs immediately after them — see FK-1.

### 7.3 Notifications

Ten templates over three channels (`inbox`, `push`, `email`).

| Template | Fired by | Channels | To |
|---|---|---|---|
| `ride.payment_failed` | `decline_payment`, `retry_settlement` | push, inbox | rider |
| `ride.driver_offer` | `offer_ride` | push | driver |
| `ride.no_drivers` | `no_drivers_available` | push, inbox | rider |
| `ride.driver_assigned` | `accept_ride` | push, inbox | rider |
| `ride.driver_arriving` | `arrive_at_pickup` | push | rider |
| `ride.trip_started` | `start_trip` | inbox | rider |
| `ride.incident_raised` | `report_incident` | inbox | support |
| `ride.receipt` | `settle_payment` | email, inbox | rider |
| `ride.cancellation_fee` | `charge_cancellation_fee` | push, inbox, email | rider |
| `ride.cancelled` | `waive_cancellation_fee` | push, inbox | rider |

`push` is a new channel for this repo; the existing notify worker delivers `inbox` and `email` only.
Adding a channel that has no delivery adapter is deliberate — it tests whether the notification
contract fails loudly at boot rather than silently dropping messages.

### 7.4 Work outstanding

The domain module is complete and validated. Runtime integration is not started.

1. `apps/worker/src/workflows.ts` — export `rideWorkflow` via `createFlowkitWorkflow` bound to the
   ride registries.
2. `apps/worker/src/activities.ts` — implement the eight system steps and extend
   `resolveActionContext` to supply `onlineDriverIds`, `pickupVerified`, and
   `supportTaskAssigneeId`.
3. `packages/database` — ride tables, tenant-scoped repository, forward-only migration.
4. `apps/api` — a ride controller mirroring `flow.controller.ts`, deriving the organization from the
   session and carrying idempotency keys.
5. `apps/notify-worker` — a `push` adapter, or an explicit decision to drop the channel.
6. `apps/web` — a request form and a trip view.

Steps 1–3 are enough to run the flow end to end from `scripts/run-scenario.ts` without any UI.

---

## 8. Framework findings

These came out of building the definition, not out of reviewing the framework. Each is reproducible
from the code in this repository.

### FK-1 — Rules cannot observe entry-step output *(blocking R4)*

`runEntry` in `@naakwu/flowkit-temporal@0.2.0` evaluates rules with a hard-coded empty fact set:

```ts
const action = config.registries.rules?.[step.ref]?.run({
  definition, state: execution.state,
  subject: input.subject.metadata ?? {},
  facts: {},                       // ← system step output is not passed through
  priorTransition,
});
```

System step results are written to `execution.stepResults` and never read back. So a stage that runs
`authorizePaymentMethod` and then asks `routeQuote` whether authorization succeeded cannot be told.
The same applies to `captureSucceeded`, `finalFareCents`, `cancellationFeeCents`, and
`dispatchAttempt` — every runtime outcome in this flow.

Leave approval does not surface this because `routeLeaveRequest` reads `subject.businessDays`, a
value known at submission. `completeFulfillment` returns a constant. The demo's only two rules are
both decidable without I/O, which is exactly why the gap survived.

The consequence for R4 is concrete: the re-dispatch loop has no terminating condition. `subject` is
fixed for the life of a run, so a subject-sourced `dispatchAttempt` never increments and
`routeDispatch` returns `offer_ride` forever. `maxAutomaticTransitionsPerTurn` does not help — the
counter resets whenever the command queue drains, and every loop iteration passes through a human
or SLA command.

A guard on `offer_ride` is not a workaround. Guards do receive live facts, but a rule-origin command
that throws is swallowed: the `catch` only rethrows `FLOWKIT_AUTOMATIC_LOOP`, and rule-origin
envelopes carry no `completion` to reject. A rejected guard would park the workflow in
`driver_matching` with no pending role and no queued command — a silent permanent stall, which is
worse than the infinite loop it was meant to prevent.

**Proposed change.** Pass the current entry epoch's step output into `RuleContext.facts`:

```ts
const facts = Object.fromEntries(
  Object.values(execution.stepResults)
    .filter((r) => r.entryEpoch === execution.entryEpoch && r.status === 'completed')
    .flatMap((r) => Object.entries(r.output ?? {})),
);
```

This is replay-safe — `stepResults` is already workflow state — and backward compatible, since rules
that ignore `facts` are unaffected. It would let the `routingInput` fallback in `ride.registries.ts`
be deleted outright.

### FK-2 — The leave demo's SLA duration does not parse

`leave.definition.ts` declares `sla: { after: 'PT10S' }`, but `parseSlaDuration` accepts only
`ms|s|m|h|d`:

```ts
const parts = input.match(/(\d+)(ms|s|m|h|d)/g);
if (!parts || parts.join('') !== input) return undefined;
```

`'PT10S'` matches nothing, so `validateFlowkit` reports `invalid-sla-duration` and the interpreter
throws `FLOWKIT_INVALID_SLA` when arming the timer. The manager-review escalation in the shipped
demo cannot fire. `test/definition.test.ts` does not call `validateFlowkit`, which is how it passed.

Two things worth fixing independently: the duration in the leave definition, and the missing
`validateFlowkit` assertion in its test. `test/ride-definition.test.ts` includes that assertion.

### FK-3 — `sla.escalate.notify` is a role to the linter and a template to the interpreter

`lintFlow` treats the value as a role name (`usedRoles.add(stage.sla.escalate.notify)`), while
`workflow.ts` passes it straight through as a notification template:

```ts
notification: { template: sla.escalate.notify, channels: [] }
```

A value cannot be both, and neither reading is validated against the other registry. The leave demo
passes `'manager'`, satisfying the linter while sending a notification for a template that does not
exist — with an empty channel list, so nothing is delivered either way.

The ride flow sidesteps this by escalating to actions everywhere and never using
`escalate.notify`. That is an avoidance, not a fix. The contract needs to pick one meaning; if it is
"template", `validateRegistryRefs` should check it against `templates` and lint should stop counting
it as role usage.

### FK-4 — Two registry shapes for the same references

The kernel's `validateRegistryRefs` expects `{ steps }` covering both system steps and rules. The
interpreter's `validateFlowkit` expects `{ systemSteps, rules }` as separate keys. Passing the
kernel shape to the interpreter yields a full page of `missing-system-step-ref` errors for refs that
are correctly registered — the failure mode is loud but the message points at the wrong problem.
`test/ride-definition.test.ts` builds both shapes explicitly and comments why.

---

## 9. Verification

`test/ride-definition.test.ts` covers:

| Check | Asserts |
|---|---|
| Kernel lint | `lintFlow` and `lintInterpreterFlow` return `[]` |
| Registry refs | `validateRegistryRefs` returns `[]` against the kernel shape |
| Interpreter boot | `validateFlowkit` returns `[]` against the published snapshot |
| Snapshot | `verifyPublishedDefinition` passes and the snapshot is frozen |
| Initial state | `trip_draft` / `draft` / rider, tracks `unassigned` + `none` |
| Happy path | Eleven transitions to `completed` with `driver: released`, `payment: captured` |
| Re-dispatch | `decline_timeout` returns to `driver_matching` with the authorization intact |
| Late cancellation | Routes through fee assessment and ends `captured` |
| Early cancellation | Ends `released` |
| Guard rejection | `start_trip` throws without `pickupVerified` |
| Rule determinism | Every rule terminates on subject metadata alone, pinning FK-1 |

Not yet covered, and blocked on §7.4: replay determinism under `continueAsNew`, SLA timers firing in
a real worker, tenant isolation for ride rows, and a browser scenario.

The stage graph is machine-checked for reachability, dead ends, duplicate action names, and missing
policies, so a structural regression fails the test rather than surviving to review.

---

## 10. Open questions

1. **Should `driverId` be a candidate list?** Today it is a single nullable id overwritten per
   dispatch, which loses the history of who refused. A list would let `routeDispatch` avoid
   re-offering to a driver who already declined — but it needs FK-1 first.
2. **Where does surge belong?** `surgeMultiplier` is on the subject, fixed at request time. Real
   surge moves between quote and dispatch. Re-quoting mid-flow has no representation in the current
   model.
3. **Is `payment_recovery` really the same flow?** It outlives the trip by 24h and involves neither
   the driver nor the vehicle. It may belong in a separate collections flow keyed to the same
   subject — which would raise the question of how FlowKit composes flows at all, currently unanswered.
4. **Should `push` ship without an adapter?** Leaving it unbacked tests boot-time validation; adding
   a stub adapter makes the demo runnable. These pull in opposite directions.
5. **Does the ride replace or accompany leave approval in `customizing.md`?** The customization guide
   is written around a single example. Two reference workflows either strengthen it or make it
   ambiguous.

---

## 11. References

- `packages/domain/src/ride/` — definition, registries, subject schema, workflow type
- `test/ride-definition.test.ts` — verification described in §9
- `docs/architecture.md` — ownership boundaries and the tenant invariant
- `docs/customizing.md` — the replacement order this module follows
- `flowkit/docs/vision.md` — why a second independent consumer matters (§4, §5.3, §5.5)

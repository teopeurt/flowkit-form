# Worker enrolment — product requirements and specification

**Status:** definition, registries, and subject schema landed and validated; runtime integration not started
**Definition id:** `worker-enrolment-demo`, version 1
**Owner:** flowkit-demo maintainers
**Source:** `packages/domain/src/enrolment/`, verified by `test/enrolment-definition.test.ts`

---

## 1. Summary

`flowkit-demo` now carries two reference workflows. Leave approval is a linear approval with one
review gate — the shape FlowKit was extracted from. The ride hail is a fast, adversarial,
money-moving process that proved the interpreter generalizes beyond approvals
(`docs/ride-hail-spec.md`).

Neither exercises the thing FlowKit's own vision document calls out as the reason the framework
exists: *maker-checker controls*. Leave approval has a single approver. The ride has a support agent
who can resume a trip alone. In both, one person's decision is final, and the demo therefore never
touches `@naakwu/flowkit-tasks`' four-eyes primitive at all.

This document specifies a third reference workflow: worker enrolment and standing for a contingent
labour platform. An adverse decision here removes someone's ability to earn, so no single actor may
make one. Every rejection and every suspension is a two-actor chain, an appeal is a three-actor
chain, and consent is a precondition that can be withdrawn at any point under a data-protection
regime that does not care where the workflow currently sits.

It is also the first reference workflow with a **steady state**: `active` is a non-final stage the
flow is supposed to rest in for years, re-entered by asynchronous fraud signals and scheduled
re-verification. Leave and ride both race to a terminal. A worker profile does not.

The deliverable is a domain module, not a product. There is no NIMC integration, no biometric
stack, and no reviewer console. The point is the flow definition and what building it revealed
about the kernel.

---

## 2. Why worker enrolment

Each row is a FlowKit capability, the enrolment mechanic that exercises it, and what the two
existing reference workflows do with the same capability.

| Capability | Enrolment mechanic | Leave and ride today |
|---|---|---|
| Maker-checker / separation of duties | Every rejection and suspension needs a second actor; appeals need a third | Neither declares one. `flowkit-tasks/maker-checker.ts` is untouched by the demo |
| Non-terminal steady state | `active` rests indefinitely and is re-entered from three places | Both race to a terminal; every non-final stage has a clock |
| Three-way rule routing | `routeVerification` returns pass, exception, or hard failure | Every rule in both flows is binary |
| Preconditions vs. steps | `consentCurrent` gates capture on a fact that can go stale mid-flow | No precondition guards; guards check momentary state only |
| Re-entrant entry work | `identity_verification` is entered from three stages and re-runs its steps | Ride re-enters `driver_matching`, but its entry work is idempotent by accident, not by contract |
| Escalation direction as policy | Ten SLAs, each deliberately resolving for or against the operator | Ride's six escalations are neutral; leave has one |
| Three tracks | `identity`, `consent`, and `commission` advance independently | Ride declares two; leave declares none |
| Regulated erasure | Withdrawal routes to a rule that weighs a legal hold against a deletion request | No data-subject rights surface anywhere |

The honest summary: leave approval exercises the transition kernel, the ride exercises the
interpreter, and enrolment exercises the governance spine — the part of FlowKit that its own vision
document says is hardest to retrofit and is, until now, the part the demo never proved.

---

## 3. Goals and non-goals

### Goals

1. **G1 — Prove separation of duties is expressible.** Model a two-actor rejection chain and a
   three-actor appeal chain using only `defineFlow`, guards, and policies, with no framework change.
2. **G2 — Prove a steady state is expressible.** Show that a flow can rest in a non-final stage
   indefinitely and be re-entered by external signals without the definition becoming a queue.
3. **G3 — Surface framework gaps as evidence, not opinion.** Where the process cannot be expressed
   cleanly, record the specific kernel or interpreter behaviour responsible with a proposed change.
4. **G4 — Stay inside the consumer boundary.** No edits to `node_modules`, no framework source
   imports, no parallel copy of a `@naakwu/flowkit-*` package.
5. **G5 — Preserve the tenant invariant.** Every subject, task, transition, and notification stays
   organization-scoped, matching `docs/architecture.md`.

### Non-goals

- **Not an identity integration.** `verifyNin` and `matchLiveness` are activity stubs that record
  intent. No NIMC connection, no vendor contract, no biometric processing.
- **Not a biometric stack.** `screenDuplicateBiometric` returns a seeded verdict. The flow carries a
  hash of an evidence bundle, never a template or an image.
- **Not a reviewer console.** The exception and Trust & Safety queues are task projections; no UI
  is specified here.
- **Not a fraud-detection system.** `flag_for_fraud_review` is an inbound signal. What decides to
  send it — GPS trails, duplicate-face heuristics, registration pace — is out of scope and has no
  FlowKit component.
- **Not a replacement for leave or ride.** All three reference workflows ship. The comparison is the
  point.
- **Not Phase 3 work.** The definition is compiled TypeScript, consistent with the current phase of
  `flowkit/docs/vision.md`.

---

## 4. Personas and roles

Four roles, declared in the definition as `['worker', 'agent', 'reviewer', 'supervisor']`.

| Role | Holds the flow at | Cares about |
|---|---|---|
| **Worker** | `consent_capture`, `identity_capture`, `resubmission_wait`, `appeal_window` | Knowing how long a review will take, being told why a rejection happened, and being able to contest it |
| **Agent** | — (acts at `identity_capture`, never holds a queue) | Being paid for a registration that stands up, and being told promptly when one does not |
| **Reviewer** | `exception_review`, `integrity_review` | Clearing a queue without being the person who ends someone's livelihood alone |
| **Supervisor** | `supervisor_backstop`, `rejection_review`, `supervised_review`, `suspension_review`, `appeal_review` | Confirming or refusing an adverse decision someone else proposed |

The worker is not an employee of the operator and has no other route to the outcome. That asymmetry
is the substantive difference from leave approval, where a rejected request costs an employee some
annual leave and every actor sits inside one hierarchy. It is why the escalation direction in §6.4
is a policy statement rather than a tuning parameter.

**The agent never holds a pending role.** They act on a stage the worker holds. This is deliberate:
the registration belongs to the worker even when an agent operates the device, which is what makes
`workerOwnsProfile` and `assistingAgent` two policies over the same stage rather than one.

---

## 5. User stories and acceptance criteria

### R1 — Nothing is captured before a lawful basis exists

> As a worker, I want to know what is collected and why before any of it is collected.

- `consent_capture` is the initial stage. No system step runs and no identity field is required to
  reach it.
- `grant_consent` sets `consent: granted` and issues `konfam.consent_receipt`.
- `decline_consent` terminates at `consent_declined` with `identity: unverified`.
- **Acceptance:** no path reaches `identity_verification` with `consent: pending`.

### R2 — Stale consent stops further processing

> As the operator, I want a worker who consented to an older notice to re-consent before we
> process more of their data.

- `consentCurrent` guards `submit_assisted_capture`, `submit_self_capture`, and `submit_correction`.
  It compares `facts.consentVersionAccepted` against `facts.currentConsentVersion`.
- **Acceptance:** capture is rejected with a guard rejection when the accepted notice version is
  absent or behind.

### R3 — A worker waiting on a human is told how long

> As a worker, I want a stated turnaround when my verification cannot be decided automatically.

- `verification_exception` notifies `konfam.verification_pending` on entry to `exception_review`.
- `exception_review` declares `sla: { after: '24h', escalate: { action: 'flag_stale_exception' } }`,
  which makes the stated turnaround a property of the definition rather than a support promise.
- This closes gap 1 in `Konfam — Onboarding Processes & Workflows` §5, which records the review SLA
  as undefined.
- **Acceptance:** every stage that holds a worker waiting on the operator declares an SLA.

### R4 — An unstaffed queue never becomes a silent rejection

> As a worker, I want the operator's staffing problem to be the operator's problem.

- `flag_stale_exception` moves a stale case to `supervisor_backstop`, not to a rejection.
- If the backstop also lapses after 48h, `backstop_auto_clear` sets `identity: verified` and sends
  the worker to `supervision_gate`. The worker is cleared, not dropped.
- **Acceptance:** no SLA escalation anywhere in the graph moves a worker toward a terminal they did
  not choose, except where the worker themselves is the party who went silent (§6.4).

### R5 — No single actor can end a worker's standing

> As the operator, I want every adverse decision reviewed by someone who did not make it.

- `propose_rejection` (reviewer) and `confirm_rejection` (supervisor) are separate stages and
  separate actors. `confirm_rejection` carries `guards: ['independentRejectionChecker']`.
- The same shape governs suspension: `propose_suspension` then `confirm_suspension` with
  `independentSuspensionChecker`.
- Role separation alone is **not** sufficient and the guard is not redundant. At Phase 1 volume one
  person plausibly holds both `reviewer` and `supervisor`; the policies would admit them and only
  the guard refuses. This case is pinned by test.
- **Acceptance:** an actor holding both roles who proposes a rejection cannot confirm it.

### R6 — An unreviewed adverse proposal is returned, not upheld

> As a worker, I want silence from the operator to work in my favour, not against me.

- `rejection_review` escalates after 48h to `return_rejection_for_rework`, sending the case back to
  `exception_review` rather than confirming.
- `suspension_review` escalates identically to `return_suspension_for_rework`.
- **Acceptance:** no SLA that resolves the *operator's* inaction reaches `rejected` or `suspended`.
  Exactly one escalation in the graph reaches a terminal — `expire_appeal_window` — and it resolves
  the *worker's* silence after a 14-day window, not the operator's.

### R7 — A suspended worker can appeal, to a third person

> As a worker, I want the person who hears my appeal to be neither the person who accused me nor
> the person who agreed with them.

- `confirm_suspension` moves to `appeal_window`, held by the worker for 14 days.
- `file_appeal` moves to `appeal_review`, where `allow_appeal` and `deny_appeal` carry
  `guards: ['independentAppealAdjudicator']` — rejecting both the proposer and the confirmer.
- An appeal nobody adjudicates within 10 days escalates to `appeal_timeout_reinstate`, returning the
  worker to `active` with `identity: verified`.
- **Acceptance:** the actor who confirmed a suspension cannot adjudicate its appeal.

### R8 — An agent's first registrations are supervised

> As the operator, I want to catch a badly trained agent before their work reaches scale.

- `routeSupervision` returns `require_supervised_review` while the agent has cleared fewer than
  `SUPERVISED_REGISTRATION_QUOTA` (5) registrations, otherwise `activate_profile`.
- Self-serve registrations carry no `agentId` and bypass supervision entirely.
- `flag_agent_registration` reverses the commission and returns the worker to `exception_review`,
  notifying the agent on `konfam.commission_reversed`.
- This implements the supervision gate recorded as gap 5 in Onboarding Workflows §5.
- **Acceptance:** the commission track never reaches `cleared` from a supervised registration that
  a supervisor flagged.

### R9 — A live profile is a resting state, not a queue item

> As the operator, I want an enrolled worker to stay enrolled without anything holding a task open.

- `active` declares no `pendingRole` and no SLA, and is re-entered from `supervision_gate`,
  `supervised_review`, `integrity_review`, `suspension_review`, and `appeal_review`.
- `open_reverification` returns a live worker to `identity_verification` for a scheduled re-check;
  `flag_for_fraud_review` pulls them to `integrity_review`.
- **Acceptance:** `active` has no clock, and every path out of it is either an external signal or a
  worker's own withdrawal.

### R10 — Withdrawal of consent leads to erasure, not to a flag

> As a worker, I want withdrawing consent to actually remove my data unless the law says otherwise.

- `withdraw_consent` (from `active`), `withdraw_during_resubmission`, and the `abandon_capture`
  escalation all route to `erasure_pending`.
- `erasure_pending` runs `revokeConsentTokens`, `assessLegalHold`, and `scheduleErasure`, then
  `routeErasure` chooses `complete_erasure` or `retain_under_legal_hold`.
- **Acceptance:** every withdrawal path reaches a terminal with `identity: revoked`, and the
  distinction between erased and retained is a rule outcome rather than an operator choice.
- **Partially satisfied.** Withdrawal is unavailable from the seven stages in between — see §8,
  KF-3.

---

## 6. Flow model

### 6.1 Stage graph

Twenty-one stages do not fit one readable block, so the graph is drawn as two panels that meet at
`active`. Nothing is elided.

**Panel A — enrolment**

```text
  consent_capture ──decline_consent──▶ consent_declined
        │
   grant_consent
        ▼
  identity_capture ──abandon_capture──▶ erasure_pending ─┬─complete_erasure─▶ erased
        │                                    ▲            └─retain_under_hold▶ retained
   submit_assisted_capture                   │
   submit_self_capture                       │
        ▼                                    │
  identity_verification ◀──submit_correction─┤
    │      │      │                          │
    │      │      └──verification_failed───┐ │
    │      │                               │ │
    │      └──verification_exception──┐    │ │
    │                                 ▼    ▼ │
    │                        exception_review │
    │                          │  │  │  │     │
    │        ┌─clear_exception─┘  │  │  └─flag_stale_exception─▶ supervisor_backstop
    │        │                    │  │                              │        │
    │        │   request_resubmission │                 backstop_manual_clear │
    │        │        ▼               │                              │  backstop_propose
    │        │  resubmission_wait ────┼──withdraw_during_resubmission┘        │
    │        │    │        │          │                                       │
    │        │    │  expire_resubmission ──▶ lapsed                           │
    │        │    └─submit_correction─┘                                       │
    │        │                        │                                       │
    │        │              propose_rejection                                 │
    │        │                        ▼                                       │
    │        │              rejection_review ◀──────────────────────────────────
    │        │                │      │      │
    │        │  confirm_rejection    │  return_rejection_for_rework ─▶ exception_review
    │        │        ▼              │
    │        │     rejected   overturn_rejection
    │        │                       │
    ▼        ▼                       ▼
  supervision_gate ◀─────────────────┘
    │            │
    │      require_supervised_review
    │            ▼
    │      supervised_review ──flag_agent_registration──▶ exception_review
    │            │        │
    │   approve_supervised_registration
    │   supervision_timeout_release
    ▼            ▼
      a c t i v e
```

**Panel B — standing**

```text
      a c t i v e ──withdraw_consent──▶ erasure_pending
        │      ▲
        │      └──────────────────────────────┐
  flag_for_fraud_review              uphold_profile
        ▼                        close_integrity_review
  integrity_review ─────────────────────────────┘
        │        ▲
  propose_suspension  return_suspension_for_rework
        ▼        │
  suspension_review ──dismiss_suspension──▶ active
        │
  confirm_suspension
        ▼
  appeal_window ──accept_suspension──────▶ suspended
        │       └─expire_appeal_window───▶ suspended
   file_appeal
        ▼
  appeal_review ──deny_appeal────────────▶ suspended
        │      └─allow_appeal────────────▶ active
        └────────appeal_timeout_reinstate─▶ active

  active ──open_reverification──▶ identity_verification  (Panel A)
```

### 6.2 Stage reference

| Stage | Holder | Entry work | SLA | Exits |
|---|---|---|---|---|
| `consent_capture` | worker | — | — | `grant_consent`, `decline_consent` |
| `identity_capture` | worker | — | 72h → `abandon_capture` | `submit_assisted_capture`, `submit_self_capture`, `abandon_capture` |
| `identity_verification` | — | `verifyNin`, `matchLiveness`, `screenDuplicateBiometric`, `sealVerificationEvidence`, rule `routeVerification` | — | `verification_passed`, `verification_exception`, `verification_failed` |
| `exception_review` | reviewer | — | 24h → `flag_stale_exception` | `clear_exception`, `request_resubmission`, `propose_rejection`, `flag_stale_exception` |
| `supervisor_backstop` | supervisor | — | 48h → `backstop_auto_clear` | `backstop_manual_clear`, `backstop_propose_rejection`, `backstop_auto_clear` |
| `resubmission_wait` | worker | — | 72h → `expire_resubmission` | `submit_correction`, `expire_resubmission`, `withdraw_during_resubmission` |
| `rejection_review` | supervisor | — | 48h → `return_rejection_for_rework` | `confirm_rejection`, `overturn_rejection`, `return_rejection_for_rework` |
| `supervision_gate` | — | `scoreAgentQuality`, rule `routeSupervision` | — | `require_supervised_review`, `activate_profile` |
| `supervised_review` | supervisor | — | 24h → `supervision_timeout_release` | `approve_supervised_registration`, `flag_agent_registration`, `supervision_timeout_release` |
| `active` | — | — | none, by design | `flag_for_fraud_review`, `open_reverification`, `withdraw_consent` |
| `integrity_review` | reviewer | — | 72h → `close_integrity_review` | `uphold_profile`, `propose_suspension`, `close_integrity_review` |
| `suspension_review` | supervisor | — | 48h → `return_suspension_for_rework` | `confirm_suspension`, `dismiss_suspension`, `return_suspension_for_rework` |
| `appeal_window` | worker | — | 14d → `expire_appeal_window` | `file_appeal`, `accept_suspension`, `expire_appeal_window` |
| `appeal_review` | supervisor | — | 10d → `appeal_timeout_reinstate` | `allow_appeal`, `deny_appeal`, `appeal_timeout_reinstate` |
| `erasure_pending` | — | `revokeConsentTokens`, `assessLegalHold`, `scheduleErasure`, rule `routeErasure` | — | `complete_erasure`, `retain_under_legal_hold` |
| `consent_declined` `lapsed` `rejected` `suspended` `erased` `retained` | — | final | — | — |

Twenty-one stages, six terminal. Forty-three actions, every name unique across the graph — a
constraint imposed by lint rather than chosen, see §8, KF-3. `lintFlow`, `lintInterpreterFlow`, and
`validateRegistryRefs` all return `[]`.

### 6.3 Tracks

```ts
identity:   unverified → provisional → verified | disputed | revoked
consent:    pending → granted | withdrawn
commission: none → held → cleared | reversed
```

The three axes are genuinely independent, and each is reached from opposite ends of the graph.

`identity: verified` is set from seven actions — `verification_passed`, `clear_exception`,
`backstop_manual_clear`, `backstop_auto_clear`, `overturn_rejection`, `allow_appeal`, and
`appeal_timeout_reinstate` — spanning automatic verification, human clearance, an operator's own
timeout, and a successful appeal. `active` itself is reached from eight distinct actions. Modelling
either as a stage would mean copying the entire `supervision_gate → active` tail once per route.

`consent` is the only track that can move *backwards* in legal significance without the stage
changing: a worker withdrawing at `active` transitions the flow, but a worker whose consent notice
version goes stale changes nothing about the stage while making the next capture inadmissible. That
is why `consentCurrent` is a guard over facts rather than a track comparison.

`commission` outlives the decision that triggered it. `flag_agent_registration` reverses an agent's
commission and returns the *worker* to `exception_review` — one action resolving one party's money
while reopening another party's case. On the self-serve path `commission` moves `none → cleared`,
where `cleared` reads as "no outstanding hold" rather than "an agent was paid".

Track values are validated by the kernel: `InvalidTrackValueError` is thrown for any value outside
the declared set, so a typo in an action's `tracks` map fails at transition time.

### 6.4 Timing

Ten SLAs, twice the ride's count. The number matters less than the direction: **every escalation
that resolves an operator's inaction favours the worker, and every escalation that resolves a
worker's inaction closes the case.** That is a policy statement encoded in the definition, not a
tuning parameter.

| Stage | Window | Escalates to | Direction | Why this number |
|---|---|---|---|---|
| `exception_review` | 24h | `flag_stale_exception` | for worker | The turnaround stated to the worker on `konfam.verification_pending` |
| `supervised_review` | 24h | `supervision_timeout_release` | for worker | A supervision backlog must not withhold an agent's commission |
| `supervisor_backstop` | 48h | `backstop_auto_clear` | for worker | Second unstaffed queue in a row: clear rather than reject |
| `rejection_review` | 48h | `return_rejection_for_rework` | for worker | An unread rejection proposal is returned, never rubber-stamped |
| `suspension_review` | 48h | `return_suspension_for_rework` | for worker | Same principle applied to standing rather than enrolment |
| `integrity_review` | 72h | `close_integrity_review` | for worker | A flag nobody acted on is not evidence |
| `appeal_review` | 10d | `appeal_timeout_reinstate` | for worker | An unheard appeal succeeds; the operator carries its own staffing cost |
| `identity_capture` | 72h | `abandon_capture` | closes case | An unfinished capture holds PII with no lawful purpose |
| `resubmission_wait` | 72h | `expire_resubmission` | closes case | Matches the capture window; long enough for a worker on 2G |
| `appeal_window` | 14d | `expire_appeal_window` | closes case | Deliberately long: a low-bandwidth worker may not see an SMS for days |

Durations use the interpreter's own format (`24h`, `14d`), not ISO-8601 — see `ride-hail-spec.md`
§8, FK-2 for why that distinction is load-bearing.

### 6.5 Rules

| Rule | Returns | Decides on |
|---|---|---|
| `routeVerification` | `verification_passed` \| `verification_exception` \| `verification_failed` | `duplicateBiometricFound`, `ninMatched`, `livenessScore` vs `IDENTITY_MATCH_THRESHOLD` |
| `routeSupervision` | `require_supervised_review` \| `activate_profile` | `agentId`, `agentClearedRegistrations` vs `SUPERVISED_REGISTRATION_QUOTA` |
| `routeErasure` | `complete_erasure` \| `retain_under_legal_hold` | `legalHoldActive` |

`routeVerification` is the repository's first three-way rule. A hard failure (a duplicate biometric,
meaning someone is already enrolled on this face) and an ambiguous result (a NIN that did not match,
commonly a digit transposition) have different due-process consequences: one goes to a rejection
chain, the other to a human who can ask for a resubmission. Collapsing them into one `failed` edge
with a reason code would put both on the same path and make the difference a UI concern.

Every routing input is read through the same `routingInput` helper the ride uses, for the same
reason — see §8, KF-1.

### 6.6 Guards and policies

| Guard | Requires | Used by |
|---|---|---|
| `reviewTaskClaimed` | `facts.reviewTaskAssigneeId === actor.id` | six review actions |
| `consentCurrent` | `facts.consentVersionAccepted === facts.currentConsentVersion` | `submit_assisted_capture`, `submit_self_capture`, `submit_correction` |
| `independentRejectionChecker` | `facts.rejectionProposedBy` present and ≠ actor | `confirm_rejection`, `overturn_rejection` |
| `independentSuspensionChecker` | `facts.suspensionProposedBy` present and ≠ actor | `confirm_suspension`, `dismiss_suspension` |
| `independentAppealAdjudicator` | actor is neither proposer nor confirmer | `allow_appeal`, `deny_appeal` |

| Policy | Requires |
|---|---|
| `workerOwnsProfile` | role `worker` and `actor.id === subject.workerId` |
| `assistingAgent` | role `agent` and `actor.id === subject.agentId` |
| `verificationReviewer` | role `reviewer` |
| `verificationSupervisor` | role `supervisor` |
| `trustSafetyReviewer` | role `reviewer` |
| `trustSafetyAdjudicator` | role `supervisor` |

`verificationReviewer` and `trustSafetyReviewer` have identical bodies today, as do
`verificationSupervisor` and `trustSafetyAdjudicator`. They are kept apart because they are
different consoles staffed by different people in the target operating model — Verification
Operations and Trust & Safety are separate surfaces with separate access requirements. At Phase 1
volume both are one founder; splitting them later is then a policy edit, not a graph edit.

**The independence guards are not redundant with the role split.** A reader may object that
`propose_rejection` requires `reviewer` and `confirm_rejection` requires `supervisor`, so the actors
must already differ. They must not: nothing prevents one principal holding both roles, and at
launch that is the expected case. The guards are what actually enforce separation, and the test
suite pins exactly this — a dual-role principal who proposes is refused with a
`GuardRejectionError` from `independentRejectionChecker`, while a second supervisor succeeds.

Guards receive `facts` supplied by the `resolveActionContext` activity, which is free to do I/O.
`rejectionProposedBy` and `suspensionProposedBy` are expected to be produced by
`evaluateMakerChecker` from `@naakwu/flowkit-tasks` rather than by a bespoke query — with the
caveat in KF-2.

---

## 7. Data and integration contracts

### 7.1 Subject

`enrolmentRequestSchema` (`enrolment.types.ts`) is strict and cross-validates the enrolment channel
against the agent: `agent_assisted` requires an `agentId`, `self_serve` forbids one and forbids
`consent.explainedInPerson`.

The NIN is a string matched against `/^\d{11}$/`, never a number — leading zeros are significant and
arithmetic on an identifier is always a bug. `evidenceBundleHash` is a sha256 hex reference to
sealed evidence in encrypted object storage; **no biometric template or image is ever a subject
field.** Consent is a nested object carrying the notice version the worker actually saw, the
delivery language (`en`, `ha`, `ig`, `yo`, `pcm`), and whether an agent explained it in person.

`agentId` is fixed for the life of the flow once set, unlike the ride's `driverId`. The moving
target here is not the subject but the facts: `consentVersionAccepted` can go stale underneath a
flow that has not moved.

**Constraint:** the interpreter passes `subject.metadata` — not the subject — to rules and to the
transition context. Any field a policy or rule reads must be present in `metadata`, mirroring the
leave and ride modules.

### 7.2 System steps

Eight declared refs, all resolved by the consumer's `executeSystemStep` activity.

| Ref | Stage | Does | Produces |
|---|---|---|---|
| `verifyNin` | `identity_verification` | NIN lookup against the identity vendor | `ninMatched`, `ninVendorId` |
| `matchLiveness` | `identity_verification` | Liveness and face match against the NIN record | `livenessScore` |
| `screenDuplicateBiometric` | `identity_verification` | Checks the face against enrolled workers | `duplicateBiometricFound`, `duplicateWorkerId` |
| `sealVerificationEvidence` | `identity_verification` | Hashes and stores provider responses | `evidenceBundleHash` |
| `scoreAgentQuality` | `supervision_gate` | Agent's cleared-registration count and quality score | `agentClearedRegistrations`, `agentQualityScore` |
| `revokeConsentTokens` | `erasure_pending` | Invalidates outstanding Level 2 consent tokens | `tokensRevoked` |
| `assessLegalHold` | `erasure_pending` | Checks for an open dispute or regulatory hold | `legalHoldActive`, `legalHoldReason` |
| `scheduleErasure` | `erasure_pending` | Queues deletion across stores | `erasureScheduledAt` |

**Idempotency is a hard requirement here, not a nice-to-have.** `identity_verification` is entered
from three places — initial capture, `submit_correction`, and `open_reverification` — so its entry
work re-runs many times over a profile's life. Each step must be idempotent per
`(workflowId, entryEpoch, stepIndex)`. A `verifyNin` that bills per call and is not keyed on the
entry epoch will bill once per replay.

Outputs land in `execution.stepResults` and are recorded for audit. They are **not** visible to the
rule that runs immediately after them — see KF-1, which is total rather than partial in this flow.

### 7.3 Notifications

Eleven templates over three channels (`inbox`, `sms`, `whatsapp`).

| Template | Fired by | Channels | To |
|---|---|---|---|
| `konfam.consent_receipt` | `grant_consent` | sms, inbox | worker |
| `konfam.verification_pending` | `verification_exception` | sms, inbox | worker |
| `konfam.resubmission_requested` | `request_resubmission` | sms, whatsapp, inbox | worker |
| `konfam.profile_active` | `activate_profile` | sms, inbox | worker |
| `konfam.enrolment_rejected` | `confirm_rejection` | sms, whatsapp, inbox | worker |
| `konfam.commission_reversed` | `flag_agent_registration` | sms, inbox | agent |
| `konfam.integrity_flag_raised` | `flag_for_fraud_review` | inbox | supervisor |
| `konfam.suspension_confirmed` | `confirm_suspension` | sms, whatsapp, inbox | worker |
| `konfam.appeal_allowed` | `allow_appeal` | sms, inbox | worker |
| `konfam.appeal_denied` | `deny_appeal` | sms, whatsapp, inbox | worker |
| `konfam.erasure_completed` | `complete_erasure` | sms, inbox | worker |

`sms` and `whatsapp` are new channels for this repo and neither has a delivery adapter — the notify
worker delivers `inbox` and `email` only. This repeats the ride's deliberate `push` gap for the same
reason: it tests whether the notification contract fails loudly at boot rather than silently
dropping messages. It is also an accurate model of the real gap, since `@naakwu/flowkit-notify`
ships planning, dedupe, retry, and outbox contracts but no channel adapters at all.

Note that `approve_supervised_registration` and `supervision_timeout_release` reach `active` without
a notification, because `konfam.profile_active` is declared on `activate_profile` and an action may
declare only one binding. A worker approved through supervision is therefore never told their
profile went live. **This is a defect in the definition, not a framework limitation** — see §10,
question 2.

### 7.4 Work outstanding

The domain module is complete and validated. Runtime integration is not started.

1. `apps/worker/src/workflows.ts` — export `enrolmentWorkflow` via `createFlowkitWorkflow` bound to
   the enrolment registries.
2. `apps/worker/src/activities.ts` — implement the eight system steps and extend
   `resolveActionContext` to supply `reviewTaskAssigneeId`, `consentVersionAccepted`,
   `currentConsentVersion`, `rejectionProposedBy`, `suspensionProposedBy`, and
   `suspensionConfirmedBy`.
3. `packages/database` — worker, consent-grant, and review-decision tables; tenant-scoped
   repository; forward-only migration.
4. `apps/api` — an enrolment controller mirroring `flow.controller.ts`, **with explicit
   authorization on the two externally-signalled system actions** (KF-4).
5. `apps/notify-worker` — `sms` and `whatsapp` adapters, or an explicit decision to drop them.
6. `apps/web` — a capture form, a worker status view, and a reviewer queue.

Steps 1–3 are enough to run the flow end to end from `scripts/run-scenario.ts` without any UI.

---

## 8. Framework findings

These came out of building the definition. Each is reproducible from the code in this repository.

### KF-1 — Rules cannot observe entry-step output *(reproduction of FK-1, and total here)*

`ride-hail-spec.md` §8, FK-1 documents that `runEntry` in `@naakwu/flowkit-temporal@0.2.0` evaluates
rules with a hard-coded `facts: {}`, so a rule cannot see the output of the system steps that ran
immediately before it.

This flow reproduces the finding and sharpens it. In the ride, some routing inputs were knowable at
submission — `subject.businessDays` in leave, `surgeMultiplier` in the ride — so a subject-sourced
fallback was degraded but coherent. Here it is not. **Every input to `routeVerification` is produced
by a step in the same entry block**: `duplicateBiometricFound` by `screenDuplicateBiometric`,
`ninMatched` by `verifyNin`, `livenessScore` by `matchLiveness`. There is no submission-time value
for any of them, because the entire purpose of the stage is to find out.

Under current interpreter behaviour, `routeVerification` reads seeded subject metadata and therefore
returns a verdict decided by the command side rather than by the verification providers. The flow is
structurally correct and operationally inert until FK-1 is resolved. The same applies to
`routeErasure`, whose `legalHoldActive` comes from `assessLegalHold` in its own entry block.

The proposed change is unchanged from FK-1: pass the current entry epoch's completed step output
into `RuleContext.facts`. It is replay-safe, backward compatible, and would let the `routingInput`
fallback here be deleted outright.

### KF-2 — `MakerCheckerRule` models two parties; an appeal needs three

`@naakwu/flowkit-tasks` exposes the four-eyes primitive as:

```ts
export interface MakerCheckerRule { makerStage: string; checkerStage: string; makerRole?: string; checkerRole?: string; factKey: string; }
export function evaluateMakerChecker(input: { rule: MakerCheckerRule; actorId: string; latestMakerCompletion: TaskEvent | null }): MakerCheckerDecision
```

One maker, one checker, one prior completion. That covers `propose_rejection → confirm_rejection`
exactly, and `propose_suspension → confirm_suspension` exactly.

It does not cover the appeal. `allow_appeal` must exclude *two* prior actors — the reviewer who
proposed the suspension and the supervisor who confirmed it — and `evaluateMakerChecker` accepts a
single `latestMakerCompletion` and returns a single `makerId`. Composing two evaluations is possible
in the consumer but the composition is not expressible in the rule type, so the invariant lives in
guard code where the framework cannot validate it. `independentAppealAdjudicator` is consequently
hand-written and correct only by test.

**Proposed change.** Generalize the rule to a chain: `excludedStages: string[]` (or
`priorCompletions: TaskEvent[]`) with a decision that reports every conflicting actor rather than
one `makerId`. A three-stage separation of duties is not exotic — it is the standard shape for any
adjudication with an appeal, which is most regulated review processes.

### KF-3 — There is no cross-cutting action, and lint makes the workaround visible

A worker may withdraw consent at any moment. That is not a product preference; under NDPA 2023 it is
a right that does not pause while a flow sits in a queue.

FlowKit has no way to express it. Actions are declared per stage, and declaring the same action name
on several stages raises `duplicate-action-source` from `lintFlow` — a warning, but one that fails
any gate asserting a clean lint, which is what the ride's test and this one both do. The
consequences are visible in the definition:

- The same intent appears three times under three names — `withdraw_consent`,
  `withdraw_during_resubmission`, and the `abandon_capture` escalation.
- Withdrawal is simply **absent** from the seven other non-final stages. A worker sitting in
  `appeal_window` has no modelled way to withdraw.

Adding it everywhere would mean fifteen differently-named actions for one right, each duplicating
the same target and track updates, with no way for the definition to say they are the same thing.

**Proposed change.** Support stage-independent actions — a top-level `actions` map on the
definition, applying to every non-final stage unless a stage opts out. Guards and policies would
work unchanged. This is a kernel change, not an interpreter change, and it is the difference between
a compliance obligation being modelled once and being modelled fifteen times or not at all.

### KF-4 — `kind: 'system'` does not mean "not externally invokable"

`transition()` in `@naakwu/flowkit-core` enforces authorization only when the action declares a
policy, and never inspects `kind`:

```ts
if (actionDefinition.policy) {
  const policy = context.policies?.[actionDefinition.policy];
  if (!policy) throw new MissingPolicyError(...);
  if (!policy(predicateContext)) throw new AuthorizationRejectionError(...);
}
```

`lintInterpreterFlow` then explicitly exempts system actions from the requirement to declare one:

```ts
if ((action.kind ?? 'human') === 'system' || action.policy) continue;
```

Together these mean a `kind: 'system'` action is **unauthenticated at the kernel boundary**. The
kernel treats "system" as a hint about who usually issues the command, not as a restriction on who
may.

For rule-issued and SLA-issued actions that is harmless — the interpreter is the only caller. This
flow is the first in the repository with system actions reachable from outside it:
`active.flag_for_fraud_review` and `active.open_reverification` are issued by an asynchronous fraud
monitor and a re-verification scheduler, both of which reach the flow through the same API surface a
user does. Nothing in the definition or the lint output indicates that `flag_for_fraud_review` —
which pulls a worker's live profile into review — has no authorization check.

The ride has the same exposure and does not note it: `report_no_show` and `terminate_trip` are
policy-free system actions, and only their unreachability from the API keeps that safe.

**Proposed change.** Either (a) allow `policy` on system actions and lint a warning when an action
is `kind: 'system'` without one, or (b) introduce a third kind — `signal` — for externally-issued
non-human commands, and require a policy on it. Until then the guidance belongs in
`docs/customizing.md`: every system action must be treated as public unless the API layer refuses
it, which is why §7.4 item 4 carries an explicit note.

### KF-5 — A steady state is indistinguishable from a missing SLA

`active` has no `pendingRole` and no `sla`, and is meant to rest there for years. A stage that
accidentally lost its SLA looks identical to the linter, the interpreter, and a reviewer reading the
definition.

The ride spec's own acceptance criterion for R9 — "no non-final stage can hold a trip indefinitely
without an SLA" — is a real invariant for the ride and would be wrong here. Neither flow can express
which one it means.

**Proposed change.** A `steady?: true` marker on `StageDef`, purely declarative: lint would then warn
on non-final, non-steady stages that declare no SLA, and the ride's R9 becomes machine-checkable
instead of prose. Low cost, and it turns a comment into a contract.

---

## 9. Verification

`test/enrolment-definition.test.ts` covers:

| Check | Asserts |
|---|---|
| Kernel lint | `lintFlow` and `lintInterpreterFlow` return `[]` |
| Registry refs | `validateRegistryRefs` returns `[]` against the kernel shape |
| Interpreter boot | `validateFlowkit` returns `[]` against the published snapshot |
| Snapshot | `verifyPublishedDefinition` passes and the snapshot is frozen |
| Initial state | `consent_capture` / `draft` / worker, tracks `unverified` + `pending` + `none` |
| Assisted happy path | Consent → assisted capture → pass → supervised review → `active`, commission `cleared` |
| Self-serve exception path | Exception → resubmission → correction → pass → `active` |
| Four eyes, distinct actors | A reviewer proposes, a supervisor confirms, terminal is `rejected` |
| **Four eyes, dual-role principal** | A principal holding both roles who proposed is refused by `independentRejectionChecker`; a second supervisor succeeds |
| Three-actor appeal | The confirming supervisor cannot `allow_appeal`; a third supervisor can |
| Escalation direction | `expire_appeal_window` is the only SLA reaching a terminal; all seven operator-side escalations resolve for the worker |
| Consent precondition | Capture is refused when `consentVersionAccepted` is stale or absent |
| Withdrawal | `withdraw_consent` from `active` reaches `erased` with `consent: withdrawn` |
| Steady state | `active` has `pendingRole: null`, declares no SLA, and is reachable from eight actions |
| Rule determinism | Every rule terminates on subject metadata alone, pinning KF-1 |

Not yet covered, and blocked on §7.4: replay determinism under `continueAsNew`, SLA timers firing in
a real worker, tenant isolation for enrolment rows, idempotency of re-entered entry work, and a
browser scenario.

The stage graph is machine-checked for reachability, dead ends, duplicate action names, and missing
policies, so a structural regression fails the test rather than surviving to review.

---

## 10. Open questions

1. **Should `lapsed` records be erased?** An expired resubmission closes the case with PII still
   held and `consent: granted`. Legally this is probably an erasure path like the others; it is
   modelled as a plain terminal because the retention basis for an incomplete registration is a
   policy question, not an engineering one.
2. **How should a supervised approval notify the worker?** `approve_supervised_registration` and
   `supervision_timeout_release` reach `active` without a notification because
   `konfam.profile_active` is bound to `activate_profile` and an action carries at most one binding.
   Either the binding moves to stage entry, or the template is duplicated across three actions, or
   the interpreter learns to fire on stage entry rather than on transition.
3. **Should a failed re-verification of a live worker route to rejection?** Today
   `verification_failed` always reaches `rejection_review`, whose confirmation is terminal. For an
   already-active worker the correct destination is arguably `suspension_review`, which preserves
   appeal rights. Expressing that needs the rule to know how the stage was entered — which the
   kernel does not expose.
4. **Is `commission` really part of this flow?** It concerns the agent's money, not the worker's
   standing, and `flag_agent_registration` resolves one party's payment while reopening another's
   case. It may belong in a separate agent-commission flow keyed to the same registration — which
   raises the unanswered question of how FlowKit composes flows, also raised by the ride's
   `payment_recovery`.
5. **Do `sms` and `whatsapp` ship without adapters?** Leaving them unbacked tests boot-time
   validation; adding stubs makes the demo runnable. Same tension as the ride's `push`, now for two
   channels that a real deployment cannot do without.
6. **Do three reference workflows strengthen `customizing.md` or fragment it?** The guide is written
   around a single example. The ride already raised this; a third flow settles it either way.

---

## 11. References

- `packages/domain/src/enrolment/` — definition, registries, subject schema, workflow type
- `test/enrolment-definition.test.ts` — verification described in §9
- `docs/ride-hail-spec.md` — the second reference workflow; FK-1 is reproduced here as KF-1
- `docs/architecture.md` — ownership boundaries and the tenant invariant
- `docs/customizing.md` — the replacement order this module follows
- `flowkit/docs/vision.md` — maker-checker as a founding motivation (§1), guards versus
  authorization (§5.3), named refs as the escape hatch (§5.5)

# Spec A: auto-gated AI steps (`gate: auto`)

**Status:** APPROVED, v1.0. Implemented.
**Implementation:** `packages/core`, `-temporal`, `-consumer`, `-definitions`; tests alongside. Written before this spec was approved, then approved unchanged.
**Targets:** `@teopeurt/flowkit-core`, `-temporal`, `-consumer`, `-definitions`.
**Required by:** Spec B (`orchestrate` step), which reuses `gate`, `decide`, and `gateDecision` unchanged.

---

## 1. Problem

An AI entry step must declare `gate: human`. Its output is recorded, but it can never move a flow forward: only a person can. That is a deliberate safety property, but it means a flow that should run autonomously has no clean way to do so.

The only workaround today is to add a separate `rule` step after the AI step. That works mechanically, but:

- the definition declares `gate: human` while the flow actually proceeds without a human, which is misleading to anyone reading or auditing it;
- nothing ties the rule to the AI step it is meant to judge, and boot validation cannot check the pairing;
- a rule step receives only accumulated facts, not the AI step's raw output.

## 2. Goal and principle

Let an AI step release its stage without a person, **only** through a deterministic, reviewed rule that the definition names explicitly. The model never approves its own output. If anything is unclear or goes wrong, a human decides.

Non-goals: letting a model call tools to transition, per-risk-class policy engines, or any change to how human gates behave.

## 3. Definition format

### 3.1 Fields on an `ai` step

| Field | Type | Meaning |
|---|---|---|
| `gate` | `human` \| `auto` | **Required** on `ai` steps (as before). `human`: output is recorded for a person to act on (unchanged). `auto`: the `decide` rule may release the stage. |
| `decide` | string | **Required** with `gate: auto`, **rejected** otherwise. Name of a rule in the consumer's `rules` registry. |

```yaml
entry:
  - { kind: ai, ref: assessChange, gate: auto, decide: lowRiskAutoApprove }
actions:
  proceed: { to: implement, kind: system, guards: [withinBudget] }
  approve: { to: implement, kind: human, policy: reviewerCanApprove }   # fallback
```

### 3.2 Schema rules (Zod `flowSchema`)

1. `gate` is still rejected on any step that is not `ai`.
2. An `ai` step without `gate` is rejected: *"must declare gate "human" or "auto""*.
3. `gate: auto` without `decide` is rejected.
4. `decide` without `gate: auto` is rejected (including on `rule` and `system` steps).
5. Unknown `gate` values are rejected.

The emitted JSON Schema changes `gate` from `{ const: "human" }` to `{ enum: ["human","auto"] }` and adds `decide: string`. As before, the cross-field rules above are Zod-only and cannot be expressed in the JSON Schema.

## 4. Runtime semantics (`flowkit-temporal`)

After an `ai` step with `gate: auto` completes successfully in the entry loop:

1. Look up `decide` in `registries.rules` using an own-property check (so names like `constructor` are not found).
2. Run the rule with the usual `RuleContext` (`definition`, `state`, `subject`, `facts`, `priorTransition`) plus a new field **`gatedOutput`**: the AI step's raw output, whatever its type. The step's output is also merged into `facts` if it is an object, exactly as for `gate: human`.
3. **If the rule returns an action name:**
   - count it against `maxAutomaticTransitionsPerTurn` (exceeding the cap fails the workflow with `FLOWKIT_AUTOMATIC_LOOP`, as for rule steps);
   - record `gateDecision: { outcome: 'auto', action }` on the step result;
   - enqueue a `rule`-origin command `{ action, actorId: 'system' }` with operation id **`gate:<entryEpoch>:<stepIndex>`**.
4. **In every other case** record `gateDecision: { outcome: 'human' }` and do nothing further; the stage waits for a human, as with `gate: human`. That covers: the rule returned nothing, the rule threw, the rule is not registered.
5. If the AI step itself fails after retries, the step result is `degraded_to_human` exactly as today, **no `gateDecision` is recorded, and the rule does not run.**

The queued command is processed by the ordinary command loop. It must name an action of `kind: system` that exists on the stage, passes that action's guards, and is recorded through `resolveActionContext`/`recordTransition` like any other transition. This spec adds **no new way to change state**.

Behavioural note: `human`-gated steps behave exactly as before. The AI-step `try/catch` now also encloses the rule evaluation; a `FLOWKIT_AUTOMATIC_LOOP` error is deliberately rethrown so the loop-limit safeguard is not swallowed as a "degraded" step.

## 5. Boot validation (`validateFlowkit`)

For an `ai` step with `gate: auto`, using the same checks as `rule` steps:

| Code | When |
|---|---|
| `missing-rule-ref` (path `stages.<s>.entry.<i>.decide`) | `decide` names a rule that is not registered |
| `rule-action-unavailable` | the rule's declared `actions` include a name the stage does not define |
| `rule-action-not-system` | the rule's declared `actions` include a human or signal action |

Registration keeps the existing shape `{ run, actions }`. `actions` is the closed set of actions the rule may ever return, so release is bounded at boot.

## 6. Observability

`FlowkitStepResult` (in `-temporal` and the duplicate in `-consumer`) gains `gateDecision?: { outcome: 'auto' | 'human'; action?: string }`. It is present only on `gate: auto` steps whose AI step completed, and is visible in the `getState` query. The transition record's operation id (`gate:…`) lets reports tell auto-released transitions from other rule-origin ones.

## 7. Safety properties

1. **Fails closed.** Every unexpected condition leaves the stage waiting for a human.
2. **Deterministic.** Rules are pure and synchronous and run inside the workflow; a model cannot influence them except through the output they inspect.
3. **Bounded.** A rule can only return actions it declared at boot, all of which are system actions on that stage.
4. **Not self-authorizing.** The release is still subject to the target action's guards and cap on automatic transitions; policy checks (which apply to human and signal actions) are not involved.
5. **Reviewable.** The definition says `gate: auto` and names the rule; there is no way to release silently.

## 8. Known limitations

- **`declined` and `threw` look the same.** Both record `{ outcome: 'human' }`, so an operator cannot tell a rule that deliberately declined from one that crashed. See Q2.
- **A stage with several releasing steps** (several auto gates, or an auto gate plus a rule step) queues several commands. They run in order, and a later one applies to whichever stage is current by then. If its action does not exist there it is rejected and, as for rule steps today, dropped silently. This mirrors existing rule-step behaviour and is not changed; see Q3.
- **`lintFlow` is unchanged.** A stage with an auto gate still needs an SLA, `steady`, or a rule to avoid `unbounded-stage`, because an undecided gate falls back to a human.
- **Runtime lookup of an unregistered rule** degrades to human instead of failing. Boot validation is expected to prevent it.

## 9. Compatibility and versioning

- **Existing definitions are unaffected:** `gate: human` is unchanged and `decide` is optional for them.
- **Forward compatibility is not preserved:** an older runtime rejects `gate: auto` and `decide` (the schema is strict). Upgrade workers before publishing definitions that use them.
- **Replay safety:** the new logic runs only for `gate: auto`, which no existing history contains. The captured-history replay test could not be run to completion here (see §10).
- **Proposed version:** ship with Spec B as a single minor release, **1.1.0**, via the changeset already in the branch (`core`, `temporal`, `consumer`, `definitions` marked `minor`). The format has no version field and none is proposed (D1).
- **Spec document version:** v0.1 now; v1.0 on approval.
- **Docs touched by the implementation:** `docs/definitions-yaml.md` (field table, new "Auto gates" section, validation row) and `packages/definitions/README.md`.

## 10. Verification status (honest)

| Check | Result |
|---|---|
| `flowkit-core` tests (schema cases for all five rules) | pass |
| `flowkit-definitions` tests incl. JSON Schema assertions | pass except 2 failures that also occur on untouched `main` |
| `flowkit-temporal` boot validation (4 new cases) | pass |
| `flowkit-temporal` interpreter test (release / decline / throw / AI failure) | all 12 assertions run and pass; the test is still reported failed |
| Full temporal suite | 80 pass / 22 fail, versus 76 / 21 on untouched `main` |
| Typecheck (all packages) | clean |

The 21 baseline failures, and my one workflow test, fail at **teardown** with `Failed to terminate Worker thread, exit code: 1` in this sandbox. That happens on unmodified code as well, so I could not get a clean green temporal run, **including the captured-history replay test**. Before release, run the whole suite in a healthy environment.

## 11. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | One minor release (1.1.0) covering Specs A and B, no format-version field? | Yes. |
| D2 | Keep `decide` as a rule-registry reference (current), or introduce a distinct "gate rule" registry? | Keep: reuses the existing, already validated pattern. |
| D3 | Should an auto gate be allowed on a stage with neither SLA nor `steady`? | Allowed with the existing lint warning (current behaviour). |
| D4 | Approve the implementation as written, or revise it to match changes made to this spec? | Revise to match. |

## 12. Open questions

- **Q1.** Audit origin: keep `rule`, or add `ai-gate` to `CommandOrigin`? Reuse avoids a type change but makes reporting depend on the `gate:` operation-id prefix.
- **Q2.** Should `gateDecision` distinguish `declined` from `error`, and record the error message?
- **Q3.** Restrict to at most one releasing step (auto gate or rule) per stage entry?
- **Q4.** Should the rule see the whole AI output, or a declared subset (to stop an output from smuggling data a reviewer never intended the rule to read)?
- **Q5.** Should the cap `maxAutomaticTransitionsPerTurn` apply per run (current) or per flow?

---

## 13. Resolution of decisions and open questions (at approval)

| Item | Resolution |
|---|---|
| D1 | One minor release (1.1.0) shared with the orchestrate step spec; no format-version field. |
| D2 | `decide` stays a reference into the existing `rules` registry. |
| D3 | An auto gate is allowed on a stage with neither SLA nor `steady`; the existing lint warning applies. |
| D4 | Implementation approved as written; no revision needed. |
| Q1 | Audit origin stays `rule`; auto releases are identified by the `gate:` operation-id prefix. |
| Q2 | `gateDecision` does not distinguish declined from error (known limitation, §8). |
| Q3 | No restriction on the number of releasing steps per stage (known limitation, §8). |
| Q4 | The rule receives the whole AI output. |
| Q5 | `maxAutomaticTransitionsPerTurn` stays per run. |

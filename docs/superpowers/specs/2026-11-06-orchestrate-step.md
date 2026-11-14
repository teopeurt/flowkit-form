# Spec B: `orchestrate` step (chief-of-staff orchestrator with subagent fan-out)

**Status:** APPROVED, v1.0. Implemented; see §15 for where the implementation clarifies or departs from the text above.
**Depends on:** Spec A, auto-gated AI steps (`gate: auto` + `decide`), `2026-11-06-auto-gated-ai-steps.md`.
**Target:** `@teopeurt/flowkit-core`, `-temporal`, `-consumer`, `-definitions`. Baseline: `main` at `df8a8fc` (all packages 1.0.0).

---

## 1. Problem

FlowKit runs entry steps one at a time. There is no way to express "a chief-of-staff agent plans the work, fans it out to several subagents, and merges their results" as a durable, individually retryable, auditable unit. Today that logic would be hidden inside a single `ai`/`system` activity, which has these consequences:

- the default activity timeout is 1 minute (AI steps: 3 attempts), far too short for orchestration;
- one subagent failing retries the whole step from the start;
- individual subagent results are not durable or visible in the flow's state;
- nothing can limit concurrency, cancel siblings, or show progress.

## 2. Findings in the current interpreter that constrain the design

These come from reading `packages/temporal/src/workflow.ts`, not from assumption.

1. **Entry steps run inline and block the command loop.** `runEntry()` is awaited before the stage's SLA is armed (`armSla()` follows it, both for the initial entry and after each transition). While an entry step is running, human updates, signals, and cancellation only queue up in `commands`. A long orchestration run *inside* `runEntry` would therefore leave the stage unresponsive and without a running SLA timer.
   **Consequence: an `orchestrate` step must not run inline.** It must start and then let the stage return to the command loop, completing asynchronously.
2. **State must survive `continueAsNew`.** `FlowkitExecutionState` is carried across runs, but in-flight promises and activity handles are not.
3. **Steps are identified by `(workflowId, entryEpoch, stepIndex)`** and a stale epoch means the stage has moved on. This is the natural guard against late results.
4. **Rules (`FlowkitRule`) are pure and synchronous** and cannot call models. The only place that can decide an outcome based on AI output without a human is the `decide` rule from Spec A.
5. There is no child-workflow support and no parallelism in the interpreter today.

## 3. Summary of the proposal

Add a fourth entry step kind, `orchestrate`:

```yaml
stages:
  implement:
    pendingRole: reviewer
    steady: true
    sla: { after: 6h, escalate: { notify: reviewer } }
    entry:
      - { kind: orchestrate, ref: buildFeature, gate: auto, decide: allSubagentsClean }
    actions:
      proceed: { to: security, kind: system, guards: [withinBudget] }
      approve: { to: security, policy: reviewerCanApprove }   # human fallback
```

An orchestration has three phases, each a separate Temporal activity supplied by the consumer:

| Phase | Activity | Role |
|---|---|---|
| Plan | `planOrchestration` | The chief of staff (main activity). Returns a bounded list of subagent tasks: `{ id, agent, input }`. |
| Fan out | `runSubagent` (one per task) | The subagents (sub-activities). Run in parallel under a concurrency cap. Each has its own retries, timeout, and heartbeat. |
| Synthesize | `synthesizeOrchestration` | Merges task results into one output. Becomes entry facts and is passed to `decide` when `gate: auto`. |

FlowKit orchestrates and records. It does **not** run agents or choose models (see §11).

## 4. Definition format

### 4.1 Step

| Field | Type | Meaning |
|---|---|---|
| `kind` | `orchestrate` | New value of the `kind` enum (`system \| ai \| rule \| orchestrate`). |
| `ref` | string | Orchestrator registration name, resolved from the consumer's `orchestrators` registry. |
| `gate` | `human \| auto` | **Required**, same meaning and rules as `ai` steps. An orchestrator's output never transitions the flow on its own. |
| `decide` | string | Required with `gate: auto`, rejected otherwise (Spec A). |

No other fields. Limits and timeouts are *registration* data (§5), not definition data, so a definition stays portable and cannot change its own resource limits.

### 4.2 Schema rules (Zod, then regenerated JSON Schema)

- `kind: orchestrate` requires `gate`; `gate: auto` requires `decide`; `decide` is rejected without `gate: auto`.
- `gate`/`decide` remain rejected on `system` and `rule` steps.
- A stage may declare **at most one** `orchestrate` step (open question Q3).

### 4.3 Lint (`lintFlow`)

- New warning `orchestrate-without-sla`: a stage with an `orchestrate` step and no `sla`. Orchestrations are the longest-running thing a stage can do; they should be bounded by an escalation.
- An undecided auto gate falls back to a human, so a stage with an `orchestrate` step still needs `sla`, `steady`, or a rule to avoid `unbounded-stage`.

## 5. Consumer contract

### 5.1 Registration (boot-validated)

```text
orchestrators: {
  buildFeature: {
    agents: ['planner', 'coder', 'tester'],   // finite set the plan may name
    maxTasks: 16,                              // hard cap on tasks from the plan (cap: 64)
    maxConcurrency: 4,
    failFast: false,                           // true: first failed task cancels the rest
    maxOutputBytes: 65_536,                    // cap on the synthesized output
    activityOptions: { startToCloseTimeout: '30 minutes', heartbeatTimeout: '2 minutes', retry: { maximumAttempts: 3 } },
  },
}
```

### 5.2 Activities (a separate optional interface, so existing consumers do not break)

```text
interface FlowkitOrchestrationActivities {
  planOrchestration(i: PlanOrchestrationInput): Promise<{ tasks: OrchestrationTask[] }>;
  runSubagent(i: RunSubagentInput): Promise<{ output?: unknown; outputRef?: string }>;
  synthesizeOrchestration(i: SynthesizeInput): Promise<{ output?: unknown }>;
}
interface OrchestrationTask { id: string; agent: string; input?: unknown }
```

Every input carries the standard step identity (`workflowId`, `ref`, `definition`, `subject`, `state`, `entryEpoch`, `stepIndex`) plus, for subagents, `taskId` and `agent`. The idempotency key is `JSON.stringify([workflowId, entryEpoch, stepIndex, taskId])`, extending the existing pattern. Consumers must make every activity idempotent on that key.

### 5.3 Validation (`validateFlowkit`)

New issue codes: `missing-orchestrator-ref`, `orchestrator-agents-empty`, `orchestrator-limit-invalid` (maxTasks/maxConcurrency out of range). Spec A's `decide` checks apply unchanged. At runtime, a plan that names an agent not in `agents`, repeats a task `id`, or exceeds `maxTasks` is a **plan failure** (§7), not a crash.

## 6. Execution semantics

### 6.1 Non-blocking start

On stage entry, for each `orchestrate` step the interpreter: records the step result as `running`, starts a detached orchestration (tracked in execution state and in a cancellation scope bound to the entry epoch), and **returns from `runEntry` immediately**. The stage proceeds to `armSla()` and the command loop as normal, so humans, signals, and the SLA timer remain live during the orchestration.

### 6.2 Phases

1. `planOrchestration` (retried per registration). Plan failure ⇒ step result `degraded_to_human`.
2. Tasks run in parallel up to `maxConcurrency` using a deterministic semaphore (task start order = plan order). Each task result is recorded as `{ id, agent, status, outputRef? }`. Task outputs themselves are not kept in workflow state; only a bounded summary plus the reference (§6.5).
3. `synthesizeOrchestration` receives all task results (including failures) and returns the merged output. Synthesis failure ⇒ `degraded_to_human`.
4. Output is capped by `maxOutputBytes`; exceeding it is a synthesis failure.
5. Merge the output into entry facts (same as `ai` steps) and, for `gate: auto`, run `decide` with `gatedOutput = output` and a `tasks` summary (§6.4).

### 6.3 Completion enqueues, it does not transition

When an orchestration finishes in the *same* entry epoch, the interpreter updates the step result and, only if `decide` returns a system action, enqueues a `rule`-origin command with operation id `orch:<epoch>:<index>`. That command goes through the normal `commands` queue, the same guards, `resolveActionContext`, and `recordTransition` as every other transition. Nothing in this spec adds a new way to change state.

### 6.4 `decide` input

`RuleContext` gains `tasks?: Array<{ id: string; agent: string; status: 'completed' | 'failed' | 'cancelled' }>` in addition to Spec A's `gatedOutput`, so a rule can require "all tasks completed" without parsing free-form output. A failed task does **not** by itself prevent synthesis (unless `failFast`); the rule sees it and decides.

### 6.5 Cancellation and supersession

If the stage changes (a human action, a signal, or an SLA escalation transitions away), the entry epoch increments and the orchestration's cancellation scope is cancelled. In-flight activities receive Temporal cancellation (`TRY_CANCEL`); consumers should stop agents and release resources in the activity's cancellation handler. The step result is marked `superseded`. Any result that arrives later for a stale epoch is discarded and never enqueues a command.

### 6.6 `continueAsNew`

In-flight orchestrations cannot cross a run boundary. The interpreter will **defer** `continueAsNew` while any orchestration is running (the existing condition `commands.length === 0` gains `&& no orchestration in flight`). The history cost of one orchestration is bounded by `maxTasks` (≤ 64), and the registration's `activityOptions` bound its duration. See Q4 for a more flexible alternative.

### 6.7 Determinism

All branching depends only on recorded activity results and workflow time. The semaphore and result merge are order-stable (plan order). No `Date`, `Math.random`, or I/O outside activities.

## 7. Failure matrix

| Event | Outcome |
|---|---|
| Plan activity fails after retries / invalid plan | `degraded_to_human`; stage waits for a human. |
| One subagent fails after retries | Task `failed`; others continue (or are cancelled with `failFast`). Synthesis still runs and sees the failure. |
| All subagents fail | Same as above; synthesis runs; `decide` sees no completed tasks. |
| Synthesis fails / output over cap | `degraded_to_human`. |
| `decide` returns nothing / throws / unregistered | `gateDecision: { outcome: 'human' }`; stage waits (Spec A). |
| Stage changes mid-orchestration | Cancelled, result `superseded`, no command enqueued. |
| Worker restart mid-orchestration | Temporal replays; completed activities are not rerun; running ones are retried per their options. |

Principle: **anything unexpected leaves the stage waiting for a human; nothing unexpected releases it.**

## 8. Step result and observability

`FlowkitStepResult` (core `consumer` + `temporal` copies):

- `kind` gains `'orchestrate'`.
- `status` gains `'running'` and `'superseded'`.
- new optional `tasks?: Array<{ id: string; agent: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; outputRef?: string }>`.
- `gateDecision` (Spec A) applies unchanged.

`getState` therefore shows live progress per subagent. An optional `recordOrchestrationEvent` activity (open question Q5) can mirror progress to a projection.

## 9. Compatibility and versioning

- **Existing definitions are unaffected.** The new kind is additive; nothing changes for flows that do not use it.
- **Forward compatibility is not preserved.** A definition containing `kind: orchestrate` is rejected by an older runtime (the schema is strict). Deploy the upgraded workers before publishing such a definition.
- **Replay safety:** the new code only runs for the new step kind, so histories of existing executions replay unchanged. FlowKit has a captured-history replay test; it fails in my sandbox for an unrelated Bun worker-shutdown problem on the *unmodified* code. It must be run in a healthy environment before release.
- **Proposed version:** ship Spec A and Spec B in one **minor release, 1.1.0** (lockstep, via Changesets). The definition format has no version field today and I do **not** propose adding one (D1).
- **Spec document versions:** this document is v0.1 (draft). It moves to v1.0 on approval; any later normative change bumps it.
- **Doc changes on approval:** `docs/definitions-yaml.md` (field table, new section, changelog entry), package READMEs, `docs/package-contracts.md`, regenerated JSON Schema.

## 10. Test plan (acceptance criteria)

1. Schema: `orchestrate` without `gate`, `decide` without auto, and `orchestrate` + `gate: auto` without `decide` are all rejected; the valid forms pass.
2. Validation: missing orchestrator, empty `agents`, bad limits, and Spec A `decide` errors are reported with stable codes and paths.
3. **Responsiveness:** while an orchestration runs, a human update on the stage is processed, and the SLA timer fires and escalates.
4. Fan-out respects `maxConcurrency` and plan order; results are recorded per task.
5. A plan naming an unknown agent, duplicate ids, or too many tasks degrades to a human.
6. A single failed subagent: siblings finish (or are cancelled with `failFast`); synthesis sees the failure; `decide` can refuse release.
7. Stage change mid-run cancels activities, marks `superseded`, and enqueues nothing even if an activity result arrives late.
8. `continueAsNew` is deferred while running and proceeds afterwards; state survives it.
9. Replay of a captured history with an orchestration is deterministic.
10. Auto release produces exactly one `rule`-origin transition with operation id `orch:<epoch>:<index>`; the guards on the target action still apply.
11. Regression: all existing tests unchanged.

## 11. Non-goals

- Running agents, sandboxes, git worktrees, or tool permissions (consumer code).
- **Model selection.** FlowKit never names a model. Routing (e.g. a cheap model for copy, a strong model for code, a security-specialist model for pen-testing) is decided by the consumer from `agent` plus task input.
- Nested orchestration (subagents that orchestrate): depth is 1 in this version.
- Dynamic changes to limits from the definition.
- Enforcing "plan and adversarial check before execution" as a framework rule (see §12).

## 12. Template: plan, critique, execute, review

Non-normative. This is how the requested workflow shape is expressed with the primitives above.

```yaml
id: change-request
version: 1
roles: [reviewer]
initialStage: plan
stages:
  plan:       # chief of staff + planner subagents write the plan
    steady: true
    sla: { after: 1h, escalate: { notify: reviewer } }
    entry: [ { kind: orchestrate, ref: planWork, gate: auto, decide: planIsComplete } ]
    actions: { proceed: { to: critique, kind: system }, approve: { to: critique, policy: reviewerCanApprove } }
  critique:   # adversarial subagents try to break the plan
    steady: true
    sla: { after: 1h, escalate: { notify: reviewer } }
    entry: [ { kind: orchestrate, ref: adversarialReview, gate: auto, decide: noBlockingFindings } ]
    actions: { proceed: { to: execute, kind: system }, revise: { to: plan, kind: system }, approve: { to: execute, policy: reviewerCanApprove } }
  execute:    # implementation subagents
    steady: true
    sla: { after: 6h, escalate: { notify: reviewer } }
    entry: [ { kind: orchestrate, ref: buildChange, gate: auto, decide: allTasksClean } ]
    actions: { proceed: { to: security, kind: system }, approve: { to: security, policy: reviewerCanApprove } }
  security:   # pen-test / security subagents
    steady: true
    entry: [ { kind: orchestrate, ref: securityReview, gate: human } ]
    actions: { approve: { to: done, policy: reviewerCanApprove }, reject: { to: execute, policy: reviewerCanApprove } }
  done: { final: true }
```

Whether *every* flow must contain a plan and a critique stage before any mutating work is a **policy**, not a runtime rule. The cleanest enforcement is an opt-in lint profile (for example "every path to a stage with side effects passes through a critique stage"). That needs a way to mark stages as mutating, which is out of scope here. Proposed as a separate Spec C if you want it.

## 13. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Version: one minor release 1.1.0 for Specs A+B, no new format-version field? | Yes. |
| D2 | Run orchestration as parallel activities in one workflow (this spec), or as child workflows? | Activities: simpler history, simpler `continueAsNew`, adequate for depth 1. Revisit if subagents need hour-scale independent lifecycles. |
| D3 | Is `gate` mandatory on `orchestrate` (never self-releasing without an explicit rule)? | Yes, consistent with Spec A. |
| D4 | Limits live in the registration, not the definition? | Yes. |

## 14. Open questions

- **Q1.** Is a per-task `agent` allowlist per orchestrator enough, or should tasks also carry a model-routing hint field that FlowKit passes through opaquely?
- **Q2.** Should `failFast` be per-orchestrator (proposed) or decided by the plan?
- **Q3.** Allow more than one `orchestrate` step per stage? Proposed: no, to keep the epoch/index identity and cancellation simple.
- **Q4.** Defer `continueAsNew` (proposed), or carry in-flight orchestrations across it with child workflows using `ABANDON` and signal-based completion?
- **Q5.** Add an optional projection activity for live orchestration progress, or rely on the `getState` query only?
- **Q6.** Should Spec A's audit origin stay `rule`, or should `ai-gate` / `orchestration` become distinct `CommandOrigin` values for reporting?

---

## 15. Resolution of decisions and open questions (at approval)

| Item | Resolution |
|---|---|
| D1 | One minor release (1.1.0) for Specs A and B; no format-version field. |
| D2 | Parallel activities in one workflow, not child workflows. |
| D3 | `gate` is mandatory on `orchestrate` steps. |
| D4 | Limits live in the registration, not the definition. |
| Q1 | No model-routing hint field; routing is the consumer's, from `agent` plus task input. |
| Q2 | `failFast` is per orchestrator. |
| Q3 | At most one `orchestrate` step per stage (enforced by the schema). |
| Q4 | `continueAsNew` is deferred while an orchestration runs. |
| Q5 | Progress is exposed through the `getState` query only; no projection activity. |
| Q6 | Audit origin stays `rule`; auto releases carry the `orch:` operation-id prefix. |

## 16. Implementation notes

These record behaviour the text above left open, and one departure from it.

1. **Departure: idempotency keys include the phase.** §5.2 gave `[workflowId, entryEpoch, stepIndex, taskId]` for subagents and said plan and synthesize use the step identity. Those would give the plan and synthesize activities the *same* key, and a task named like a phase could collide. The implemented keys are `[workflowId, entryEpoch, stepIndex, "plan"]`, `[…, "synthesize"]`, and `[…, "task", taskId]`.
2. **The triggering update returns when the orchestration has started, not finished.** A human action or signal that enters an orchestrate stage resolves once the stage is entered (§6.1).
3. **Later `rule` steps in the same entry do not see the orchestrator's output.** The orchestration finishes after entry has returned. Only the step's own `decide` rule receives `gatedOutput`, `tasks`, and the facts gathered before the step started.
4. **Loop budget exhaustion fails closed.** If `maxAutomaticTransitionsPerTurn` is reached when an orchestration wants to release, the step records `gateDecision: { outcome: 'human' }` instead of failing the workflow, because a detached orchestration cannot fail the workflow.
5. **An empty plan is valid.** Zero tasks still runs synthesis and `decide`, with an empty `tasks` list. A rule that means "all tasks completed" must therefore also check that the list is not empty, since `every()` is true for an empty list.
6. **Limits are validated twice.** Boot validation rejects registrations outside 1 to 64; at runtime the values are also clamped to 64.
7. **`continueAsNew` waits for cancelled orchestrations.** Right after a transition the orchestrations it cancelled have not settled yet; the interpreter waits for them instead of deferring `continueAsNew` needlessly. An orchestration for the *current* stage still defers it.
8. **The definitions CLI gained an `orchestrators` manifest section** (names, `agents`, and the numeric limits; no activity options) so `flowkit definitions validate --registries` can check orchestrate steps. Without a manifest, orchestrator checks are reported as skipped.
9. **Terminal states of a late result.** A result that arrives for a superseded epoch is dropped; a completed step keeps its recorded `output`, and a superseded one keeps whatever per-task progress it had, with unfinished tasks marked `cancelled`.

## 17. Verification status

See the change description. Every acceptance criterion in §10 has an automated test except the full history-size bound, which is argued from `maxTasks ≤ 64` rather than measured.

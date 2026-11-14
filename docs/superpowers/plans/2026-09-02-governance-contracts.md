# FlowKit Governance Contracts: Remaining Work Plan

**Goal:** Finish the approved governance-contract changes and make worker enrolment a mandatory packed-package release conformance fixture.

**Planning basis:** Three read-only Luna reviews covered framework contracts, demo adoption, and release verification. This plan records the current partially implemented state and only schedules remaining work.

**Repositories:**

- Framework: `flowkit/flowkit`, branch `feat/governance-contracts`
- Demo: `flowkit/flowkit-demo`, branch `feat/worker-enrolment-conformance`
- Design amendment: `konfam_ws/specs/2026-07-09-generic-workflow-framework-design.md`

**Bun:** `/Users/teopeurt/.local/share/mise/installs/bun/latest/bin/bun`

## Decisions locked by this plan

- The public top-level cross-cutting action field is `FlowDefinition.actions`, not `globalActions`.
- `kind: 'signal'` is a distinct, policy-protected command path. Caller-supplied `actorId` is not an authorization boundary; signal ingress resolves a trusted service principal.
- Durable step identity is the tuple `(workflowId, entryEpoch, stepIndex)`. The serialized `idempotencyKey` will include the workflow identifier so stores that key on one string cannot collide.
- Worker enrolment is a required in-memory Temporal conformance fixture executed against packed public packages.
- Database, real enrolment providers, API/UI product surfaces, and delivery adapters are not prerequisites for the conformance fixture.
- Existing leave/ride/demo behavior must migrate cleanly to required organization IDs, `FlowRuntime.signal`, steady-state linting, and notification arrays.

## Already implemented, pending final hardening

- [x] Design status changed from `Approved` to `Revision required` and P0/P1 amendments added.
- [x] Core schemas/types support signals, top-level actions, stage opt-outs, steady stages, entry notifications, and notification arrays.
- [x] Core transition/lint helpers traverse local and top-level actions.
- [x] Temporal interpreter accumulates object entry outputs into rule facts.
- [x] Temporal contracts carry organization scope, signal origin, step identity fields, and transition notification arrays.
- [x] Temporal workflow exposes signal handling, tenant rejection, stable entry epochs, and entry notifications.
- [x] Tasks package includes generalized separation-of-duties evaluation and maker-checker compatibility.
- [x] Worker-enrolment definition adopts steady stages, a top-level withdrawal action, protected signals, and active-stage entry notification.
- [x] Focused framework and definition tests exist for the new behavior.

## Wave 1: Harden the framework contracts

### 1.1 Close core schema and lint gaps

**Files:**

- `packages/core/src/schema.ts`
- `packages/core/src/lint.ts`
- `packages/core/src/schema.test.ts`
- `packages/core/src/lint.test.ts`

- [ ] Add a test proving `sla.escalate.action` may reference an eligible top-level action, then update validation if required.
- [ ] Add an explicit compatibility test fixing the public field name as `actions`.
- [ ] Retain the final/steady exclusion and signal-policy tests.

### 1.2 Make entry-step keys collision-proof

**Files:**

- `packages/temporal/src/workflow.ts`
- `packages/temporal/src/workflow.test.ts`
- `packages/temporal/src/contracts.ts`

- [ ] Write a failing test showing two workflow IDs cannot produce the same `idempotencyKey`.
- [ ] Change the key to include `workflowId`, `entryEpoch`, and `stepIndex`; keep the three structured fields on the activity input.
- [ ] Document that activity persistence must enforce the tuple or the full serialized key.

### 1.3 Enforce the signal trust boundary

**Files:**

- `packages/temporal/src/contracts.ts`
- `packages/temporal/src/workflow.ts`
- `packages/temporal/src/consumer-runtime.ts`
- `packages/temporal/src/workflow.test.ts`
- `packages/temporal/src/consumer-runtime.test.ts`

- [ ] Add a failing test proving a signal cannot self-assert a privileged service identity.
- [ ] Resolve the signal actor through the activity boundary and evaluate its policy and organization scope.
- [ ] Preserve rejection of cross-organization signals.

### 1.4 Finish separation-of-duties edge coverage

**Files:**

- `packages/tasks/src/maker-checker.test.ts`
- `packages/tasks/src/maker-checker.ts`

- [ ] Add missing-history, wrong-stage, and multiple-conflicting-actor tests.
- [ ] Keep `evaluateMakerChecker` as a compatibility wrapper.

**Wave 1 verification:**

```sh
export PATH="/Users/teopeurt/.local/share/mise/installs/bun/latest/bin:$PATH"
bun test packages/core/src/schema.test.ts packages/core/src/lint.test.ts packages/core/src/transition.test.ts
bun test packages/temporal/src/workflow.test.ts packages/temporal/src/consumer-runtime.test.ts packages/temporal/src/validation.test.ts
bun test packages/tasks/src/maker-checker.test.ts
bun run typecheck
```

## Wave 2: Migrate existing demo consumers

This wave prevents the public contract changes from breaking the existing leave and ride demo while enrolment is added.

### 2.1 Propagate organization scope and signal support

**Files to inspect/update:**

- `flowkit-demo/apps/api/src/flow.controller.ts`
- `flowkit-demo/apps/api/src/leave/leave.service.ts`
- `flowkit-demo/apps/api/src/flow/flowkit-demo.consumer.ts`
- `flowkit-demo/packages/domain/src/auth/principal.adapters.ts`
- `flowkit-demo/test/flowkit-demo.consumer.test.ts`
- `flowkit-demo/test/flowkit-demo.tenant-binding.test.ts`
- `flowkit-demo/test/leave-flow-operation-scope.test.ts`

- [ ] Put `organizationId` on every framework subject and resolved actor.
- [ ] Add `signal` to every `FlowRuntime` adapter and fake.
- [ ] Derive organization identity from server-side tenant context, never a request body.

### 2.2 Migrate steady stages and SLA notation

**Files:**

- `flowkit-demo/packages/domain/src/leave/leave.definition.ts`
- `flowkit-demo/packages/domain/src/ride/ride.definition.ts`
- their definition tests

- [ ] Mark intentional resting stages `steady: true` or give them a bounded SLA.
- [ ] Replace unsupported `PT10S` with the duration syntax accepted by `parseSlaDuration`, or deliberately add tested ISO-8601 support in the framework.
- [ ] Keep definition lint results clean.

### 2.3 Preserve every transition notification

**Files:**

- `flowkit-demo/packages/database/src/leave-flow.repository.ts`
- repository/outbox tests

- [ ] Normalize `notify` plus `notifications` into one list.
- [ ] Fan out every binding transactionally so stage-entry notifications are not dropped.
- [ ] Retain compatibility with existing single-notification leave transitions.

**Wave 2 verification:**

```sh
cd ../flowkit-demo
bun run typecheck
bun test test/flowkit-demo.consumer.test.ts test/flowkit-demo.tenant-binding.test.ts test/leave-flow-operation-scope.test.ts
bun test test/ride-definition.test.ts test/enrolment-definition.test.ts
bun test test/durable-leave-service.test.ts test/postgres-outbox-store.test.ts
```

## Wave 3: Complete the required worker-enrolment fixture

### 3.1 Fix the Temporal bundler dependency boundary

**Files:**

- `flowkit-demo/package.json`
- `flowkit-demo/bun.lock`

- [ ] Add direct `@temporalio/workflow: 1.16.2`, matching the demo's Temporal SDK family.
- [ ] Refresh the lockfile with the supplied Bun binary.
- [ ] Verify `bundleWorkflowCode` no longer reports unresolved `@temporalio/workflow/lib/*` modules.

### 3.2 Export the enrolment workflow

**Files:**

- `flowkit-demo/apps/worker/src/workflows.ts`
- `flowkit-demo/test/workflow-type.test.ts`

- [ ] Export `enrolmentWorkflow = createFlowkitWorkflow(...)` with enrolment policies, guards, and rules.
- [ ] Keep the workflow module deterministic and free from config, database, and provider imports.
- [ ] Assert `enrolmentWorkflowType` matches the exported workflow name.

### 3.3 Finalize the conformance test

**Files:**

- `flowkit-demo/test/enrolment-conformance.test.ts`
- `flowkit-demo/packages/domain/src/enrolment/enrolment.registries.ts`
- `flowkit-demo/packages/domain/src/index.ts`, only if an exported published fixture is deliberately chosen

- [ ] Publish `enrolmentDefinition` inside the test, or deliberately export `publishedEnrolmentDefinition`; do not leave the current undefined import.
- [ ] Keep deterministic in-memory activity stubs for all entry steps.
- [ ] Prove entry outputs route verification and erasure.
- [ ] Prove the full workflow-aware idempotency key.
- [ ] Prove active-stage entry notification and the top-level consent withdrawal action.
- [ ] Prove a trusted same-organization signal succeeds and a cross-organization/untrusted signal fails.
- [ ] Remove stale registry comments that claim rule facts are always empty.

**Required fixture boundary:** No production enrolment activities, database migration, API controller, notification provider, or UI is added in this wave.

## Wave 4: Make conformance an explicit release gate

### 4.1 Build and pack a fresh six-package candidate

- [ ] Run framework typecheck, tests, build, version checks, and `pack:check`.
- [ ] Pack `auth consumer core notify tasks temporal` at one lockstep version into a temporary directory.
- [ ] Rebuild generated `dist` immediately before packing.
- [ ] Review generated `auth/dist` changes that have no auth source changes; exclude accidental artifacts from the release diff if appropriate.

### 4.2 Strengthen the candidate script contract

**Files:**

- `scripts/test-demo-candidate.sh`
- `scripts/test-demo-candidate.test.sh`
- `flowkit-demo/package.json`

- [ ] Add a demo script named `test:enrolment-conformance`.
- [ ] Make the candidate script run it explicitly with `FLOWKIT_DEMO_CANDIDATE_TARBALLS=true`, in addition to the full demo suite.
- [ ] Update the shell fixture and expected command order so removing the enrolment gate makes the test fail.
- [ ] Continue rewriting all six package dependencies and overrides only in a disposable demo copy.
- [ ] Assert the source demo manifest and checkout remain unchanged.

### 4.3 Wire release CI

**Files:**

- `.github/workflows/ci.yml` or the release workflow that invokes the candidate script
- `.changeset/worker-enrolment-conformance.md`

- [ ] Add a lockstep changeset for all six public packages with the correct semver level for required organization IDs and new action/signal contracts.
- [ ] Ensure release validation requires exactly the fixed six-package set.
- [ ] Install Chromium before candidate `stack:ci` where the runner does not already provide it.
- [ ] Make publishing unreachable until the exact candidate gate succeeds.

## Final verification matrix

From `flowkit/flowkit`:

```sh
export PATH="/Users/teopeurt/.local/share/mise/installs/bun/latest/bin:$PATH"
bun install --frozen-lockfile
bun run version:check
bun run typecheck
bun test
bash scripts/test-demo-candidate.test.sh
bash scripts/test-release-workflow.test.sh
bun run build
bun run pack:check
```

Then run the real candidate script with six freshly built absolute tarball paths. In its disposable demo copy it must pass:

```sh
bun install --frozen-lockfile
bun run typecheck
FLOWKIT_DEMO_CANDIDATE_TARBALLS=true bun run test
FLOWKIT_DEMO_CANDIDATE_TARBALLS=true bun run test:enrolment-conformance
bun run build
bun run stack:ci
```

## Release acceptance criteria

- [ ] No demo test resolves FlowKit source directly or uses stale `.local-registry` packages.
- [ ] The Temporal worker bundles and exports `enrolmentWorkflow`.
- [ ] Enrolment conformance proves entry facts, collision-proof step identity, global withdrawal, steady state, trusted signals, tenant rejection, entry notifications, and separation-of-duties behavior.
- [ ] Existing leave and ride flows remain type-safe, lint-clean, tenant-scoped, and notification-complete.
- [ ] All six package versions and the Changesets release plan are lockstep.
- [ ] Candidate installation contains no workspace/local links and leaves the real demo checkout untouched.
- [ ] Framework and candidate-demo typecheck, tests, build, pack checks, and disposable stack CI all pass.

## Optional production enrolment phase, not release-blocking

Only schedule this after the conformance release is green:

1. Implement real idempotent enrolment activities and trusted service-principal resolution.
2. Add tenant-owned enrolment tables, migration, repository, and projection.
3. Add explicitly authorized API action/signal endpoints.
4. Add supported SMS/WhatsApp adapters or revise unsupported channels.
5. Add worker, reviewer, supervisor, appeal, and consent UI.
6. Add provider, repository, API, replay, timer, and browser integration tests.

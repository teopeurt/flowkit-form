# FlowKit Document Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect document events and exact evidence references to supported FlowKit review processes with independent document/workflow authorization and recoverable delivery.

**Architecture:** A separate portable integration package owns evidence associations and consumer-selected bindings. A document-side SQS adapter calls an authenticated integration gateway alongside the existing supported runtime; the gateway delegates to public FlowkitConsumer/FlowRuntime contracts. Existing Temporal/PostgreSQL/task infrastructure remains an explicit external runtime dependency, not a Lambda runtime rewrite.

**Tech Stack:** TypeScript/Bun, existing public `@teopeurt/flowkit-*` 1.2.0 packages, DynamoDB integration records, SQS delivery, authenticated HTTP bridge and the existing runtime host; no framework source modifications.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [master waves](2026-11-14-release-waves.md). P1/P2 precede implementation; P3–P5 precede final assembled acceptance.

## Global Constraints

- “Workflow role or task eligibility alone does not confer document access”.
- “document access alone does not authorize a workflow transition.”
- “A document ID, version ID, and metadata revision are passed by reference, not binary content.”
- “FlowKit remains authoritative for transition decisions.”
- “An approval of version A must never implicitly approve replacement B.”
- No runtime backend, public framework APIs or application-wide approval policy added to document core.

## Review Focus

- Event service identity self-asserts privileged actor/tenant: authenticated identity is resolved at gateway (Task 3).
- Duplicate delivery after a lost response acts twice: stable operation ID deduplicates at runtime boundary (Task 3).
- Version B uploaded while A under review: A's pinned content and metadata stay authoritative (Tasks 2 and 5).
- Workflow role granted without document permission, or vice versa: both checks independently apply (Task 4).
- Runtime unavailable/deleted evidence: retain failures/references without rolling back documents or restoring content (Tasks 3–5).

### Task 1: Public contract compatibility and external-dependency inventory

**Files:** Create `docs/decisions/flowkit-document-runtime.md`, `test/documents-flowkit/public-contracts.test.ts`; inspect `apps/api/src/flow/flowkit-demo.consumer.ts`, `apps/api/src/flow/temporal.client.ts`, `apps/worker/src/activities.ts`, `test/package-contracts.preflight.test.ts`, manifests and installed public declarations.

**Interfaces:** Confirm supported `FlowRuntime.start/act/signal/get/health`, `createFlowkitConsumer`, actor resolution, task stores and operation ID propagation directly from installed 1.2.0 exports. Planning environment currently has no installed node_modules; do not invent exact SDK signatures. Add compile-time adapter assignments in the new test after the approved frozen install. Existing app consumer is the repository example, not an API specification substitute.

- [ ] Add an export/preflight test that imports only released package exports and checks the adapter method parameter/return types via `Parameters`/`ReturnType`. Assert signal ingress has a trusted actor-resolution path and stable operation identity, and document functions do not import the Temporal client.
- [ ] Run `bun test test/documents-flowkit/public-contracts.test.ts`; expect missing fixture/adapter failure after dependencies are installed, never treat absent dependencies as an implemented feature failure.
- [ ] Record runtime host, Temporal endpoint/namespace/task queue, task/projection PostgreSQL store, notification dependencies, public contract mappings and identity issuer/trust boundaries. Choose gateway deployment alongside current supported runtime. If supported exports cannot meet a binding, disable that binding and document blocker; do not extend framework or bypass transition policy. Record known existing conformance failures from baseline and resolve compatibility before integration completion.
- [ ] Run package-boundary/public-contract tests and typecheck; expect correct public imports with no vendor source edits. Inventory actual prerequisites needed for live integration and required credential references.
- [ ] Commit: `docs: pin supported document workflow integration contracts`.

### Task 2: Evidence binding model and persistent exact-review references

**Files:** Create `packages/documents-flowkit/package.json`, `packages/documents-flowkit/src/{contracts,bindings,service,index}.ts`, `packages/documents-aws/src/flowkit/binding-store.ts`, `test/documents-flowkit/bindings.test.ts`; update root manifests/lockfile.

**Interfaces:** `EvidenceRef = { document: DocumentRef; versionId: string; metadataRevision: number }`; `ReviewBinding = { id: string; tenantId: string; businessRecord: { type: string; id: string }; flowId: string; reviewRef: string; evidence: readonly EvidenceRef[]; decisionRef?: string }`. `EvidenceBindingStore.create(context, binding): Promise<CommitReceipt>`, `read(scope, bindingId): Promise<ReviewBinding | null>`, `recordDecision(context, { bindingId, decisionRef }): Promise<CommitReceipt>`, `list(scope, { documentId?, flowId?, cursor? }): Promise<Page<ReviewBinding>>`. P2 DynamoDB atomic receipts/audit/outbox semantics apply to this store; binding payloads contain references, not sensitive metadata snapshots.

- [ ] Test consumer business-record IDs remain external, multiple evidence versions/metadata revisions can be pinned, absent/cross-tenant versions fail, duplicate binding is idempotent, changed operation payload conflicts, replacement metadata/content does not mutate prior binding, and historical metadata remains retrievable with current grants.
- [ ] Run `bun test test/documents-flowkit/bindings.test.ts`; expect missing model/store.
- [ ] Implement exact-evidence validation through P1 read services and persist bindings. Do not make approval a document-wide mutable property or assume one running workflow per document. Consumer flow definitions decide replacement/continuation behavior and task eligibility. Pin binding validation/commit to source lifecycle revisions so deletion cannot be raced by an untracked new review reference.
- [ ] Run focused tests with P1 history/access suites and typecheck; expect PASS, no binaries/text in bindings/events.
- [ ] Commit: `feat: pin workflow reviews to exact document evidence`.

### Task 3: Authenticated runtime gateway and durable event/action bridge

**Files:** Create `packages/documents-flowkit/src/{bridge,event-bindings}.ts`, `apps/api/src/documents/{gateway.controller,gateway.module,gateway-auth}.ts`, `packages/documents-aws/src/flowkit/{gateway-client,delivery-store}.ts`, `apps/document-api/src/workers/flowkit.ts`, `test/documents-flowkit/bridge.test.ts`; modify `apps/api/src/app.module.ts` to import optional configured integration module only; update CDK.

**Interfaces:** `ConsumerEventBinding = { eventKind: string; action: string; mode: 'start' | 'act' | 'signal'; serviceIdentityRef: string }`; configuration is trusted consumer code, not an arbitrary API payload. `FlowkitDocumentBridge.deliver(envelope: EventEnvelope): Promise<void>` maps only registered bindings. `WorkflowGateway.invoke({ bindingId, operationId, mode, action }): Promise<{ flowId: string; operationId: string; decisionRef?: string }>` resolves actor/tenant/evidence from authenticated service and stored bindings; input never supplies an accepted privileged actor ID. Gateway adapts these repository-owned types to the installed public contracts verified in Task 1.

- [ ] Test wrong issuer/audience/service subject, spoofed tenant, unmapped event, duplicate delivery, gateway success/lost response, retry under runtime outage and cross-workflow operation collision. Assert same event+binding produces same operation ID, document commit is unaffected by gateway failure and unsafe signals cannot impersonate a human reviewer.
- [ ] Run `bun test test/documents-flowkit/bridge.test.ts`; expect missing bridge/gateway.
- [ ] Implement scoped service authentication, current document permission checks and consumer/runtime authorization through FlowkitConsumer. Gateway is hosted with supported runtime dependencies; document Lambda calls it with credential references. Persist per-binding delivery intent, attempts and outcomes; retry with stable operation ID. Do not mark delivery complete before runtime durable acceptance. Dead-letter failures remain replayable under same identity/binding; unknown/missing runtime contracts are explicit failures, not successful no-ops.
- [ ] Run focused tests, all existing demo consumer/security tests and build; expect no behavior change when optional module is disabled. After authorized runtime deployment verify actual API/runtime acceptance and duplicate operation behavior.
- [ ] Commit: `feat: bridge document events to authorized FlowKit operations`.

### Task 4: Consumer review fixture, API references and cleanup integration

**Files:** Create `packages/documents-flowkit/src/review-fixture/{definition,registries}.ts`, `apps/api/src/documents/review.activities.ts`, `apps/document-api/src/routes/reviews.ts`, `packages/documents-aws/src/flowkit/cleanup.ts`, `test/documents-flowkit/review-policy.test.ts`; modify `apps/worker/src/{workflows,main}.ts` only for optional fixture registration and configure activity selection without replacing leave/enrolment workflows.

**Interfaces:** Produce an opt-in consumer example with maker/checker and explicit approve/reject transitions using the published FlowKit definition model; no policy in core. `ReviewService.start(context, { businessRecord, evidence, definitionRef }): Promise<ReviewBinding>` uses only registered definition refs. GET `/v1/documents/{id}/review-references` returns paged authorized associations; POST `/v1/reviews` starts configured consumer binding. Human actions still go through the runtime's protected task/consumer APIs, never unrestricted action forwarding.

- [ ] Test submitter cannot approve their own review, missing task eligibility denies despite document read access, task eligibility alone cannot fetch evidence, service grant revocation blocks evidence operations, and deletion strips sensitive content but retains permitted decision/reference tombstones. Instantiate P3 owner `flowkit` cleanup suite.
- [ ] Run `bun test test/documents-flowkit/review-policy.test.ts`; expect absent fixture/route/cleanup failures.
- [ ] Implement fixture using public definition/registries and scoped service grants. Projection/task persistence belongs to consumer runtime host; choose explicit store adapters verified in Task 1 rather than inheriting leave-specific repository behavior. Add `review.start` permission for document-side binding creation. Bind service read operations to pinned version+metadata refs. FlowKit owns decision and continuation; document holds always override requested destruction. Cleanup inventory covers integration payloads/delivery records; retain only permitted reference/decision IDs and never recreate document bytes.
- [ ] Run focused fixture tests, public contract lint/typecheck, API OpenAPI checks and existing workflow registration tests; expect PASS without modifying framework source or unconditionally deploying new demo policies.
- [ ] Commit: `feat: assemble exact-evidence consumer review integration`.

### Task 5: Supported-runtime and assembled workflow acceptance

**Files:** Create `test/aws-documents/flowkit.integration.test.ts`, `test/aws-documents/evidence-review.integration.test.ts`, `docs/operations/document-workflows.md`; update release evidence ledger/configuration reference and OpenAPI.

**Interfaces:** Live test configuration adds runtime gateway URL, issuer/audience, service credential reference and configured review definition/identity fixtures. No migrations are performed by tests. Gate tests with the explicit approved AWS/runtime environment convention.

- [ ] Write live scenarios: upload A at metadata revision 1 → start review → upload B/edit metadata → approve A → retrieve decision/evidence association. Verify B remains unapproved, current document grants still apply, maker-checker is enforced and a configured replacement continuation behaves only as defined by fixture.
- [ ] Run offline review suites and run live tests without approval flag to confirm explicit skip. Assert a run with flag but missing runtime fails configuration.
- [ ] Add real outage/recovery, duplicate/reordered event, revoked service grants, deleted evidence and stale decision callback scenarios. Use external supported runtime, actual task/consumer authorization and real AWS records; no mocked runtime as substitute.
- [ ] Run authorized live suites plus P3/P5 integration; record workflow identity, definition hash, evidence versions/metadata revisions and correlation IDs without raw evidence. All prerequisites must be operational before marking P6 complete.
- [ ] Commit: `test: prove document review on supported FlowKit runtime`.

## Self-review and handoff

The integration package is required at product assembly and independent of document core. Consumer/task policy, exact evidence pinning, public exports, service identity, durable retries and external prerequisites are owned explicitly. Task 1 may begin read-only in Wave 0; no installed package declaration was assumed available during planning. Follow master waves for assembly.

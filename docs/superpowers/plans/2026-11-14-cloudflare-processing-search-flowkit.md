# Cloudflare Processing, Search and FlowKit Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supply D1/Workers/Queues/FTS5 adapters for the shared OCR, authorized search and exact-evidence FlowKit integration, with real Cloudflare acceptance.

**Architecture:** P4/P5/P6 own portable services, route modules and engine/consumer contracts. Cloudflare persists job/review/index coordination records in D1, stores artifacts in R2 and dispatches Queues work; FTS5 is a derived search index, never the document authority. The same external supported FlowKit gateway is used by both providers, and selected OCR/inspection/rendering execution is explicitly configured.

**Tech Stack:** TypeScript/Bun, Workers, D1 FTS5, R2, Queues, shared processing/search/FlowKit packages, Worker-compatible or approved remote engine adapters, workerd tests.

**Spec:** [Approved amendment](../specs/2026-11-14-cloudflare-alternative-design.md), [master waves](2026-11-14-release-waves.md). CF3 requires P1/P0, CF1, CF2 governance interfaces and the respective P4/P5/P6 portable task. It does not require AWS provider adapters.

## Global Constraints

- “No native Rust/Python PDF binary or GPU engine is assumed to execute inside Workers.”
- “D1 document/grant rows remain authoritative.”
- “Reauthorize every page”.
- “Cloudflare does not become a new FlowKit runtime.”
- Engine/model/hosting evaluation gates remain in P4; no provider-specific approval policy or public arbitrary endpoint registration.

## Review Focus

- Oversized PDF/text result exhausts Worker memory or D1 row limits: bounded stage/page/artifact handling (Task 1).
- Late duplicate OCR callback publishes into deleted lifecycle: D1 CAS plus registered artifact cleanup (Task 1).
- Stale FTS permission/source leaks a snippet or restores deleted text: primary materialization and epoch cleanup (Task 2).
- Lost gateway response starts/acts twice: stable event/binding operation and target receipt (Task 3).
- Fake engines/runtime counted as full parity: actual evaluated engine and supported runtime required (Task 4).

### Task 1: Durable extraction jobs and evaluated execution transport

**Files:** Create `packages/documents-cloudflare/src/processing/{store,dispatcher,completion,cleanup}.ts`, `packages/documents-cloudflare/src/processing/adapters/{remote-inspector,remote-renderer,remote-parser}.ts`, `apps/document-api/worker-tests/processing.worker-case.ts`, `test/cloudflare-documents/processing.integration.test.ts`, `deploy/cloudflare/migrations/0003_processing_search_reviews.sql`; register shared P4 processing routes and private authenticated callback entrypoint in Worker composition.

**Interfaces:** Implement P4 ProcessingStore, Inspector/NativeExtractor, Renderer, OcrParser, ResultNormalizer composition and owner `processing` CleanupProvider. Use P0 ArtifactStore/UploadVerifier credential bounds, P3 registry/permits and P4 profile revisions. Native/renderer remote adapters are default architectural transport candidates, not approval of a particular remote host; choose measured Worker/WASM execution only if P4 evaluation passes. Job records and attempt/page history are separate bounded rows. Task outputs implement P4 public contracts and shared HTTP transports without importing Lambda/native dependencies; provider adapter files are thin Worker credential/artifact wrappers, not duplicate OCR protocols.

- [ ] Run shared native/scanned/mixed/image/full-document/partial-failure scenarios and add `no_large_result_buffer`, `duplicate_callback_no_second_outcome`, `stale_attempt_preserves_history`, `source_grant_revoked_before_dispatch`, `provider_submit_timeout_reconciled` and `deleted_run_output_is_cleaned`. Cross-job result references and unregistered redirect endpoints fail.
- [ ] Run `bun run test:cloudflare -- processing.worker-case.ts`; expect absent stores/transports.
- [ ] Implement transactional run creation/attempt claims/results with audit/outbox and lifecycle CAS in the tenant D1. Schedule bounded page work/polling through Queues and persisted checkpoints, not waitUntil as durable execution. External submit uses stable provider operation identity, deadline, job-scoped read/write references and allowlisted service config. Stream artifacts to document namespace with CF2 registration/protection; do not use a full arrayBuffer digest for large files. Expose statuses/history/results through P4 shared routes and distinguish machine output from human review.
- [ ] Run local cases plus authorized AWS-independent Cloudflare jobs against fixture services, then evaluated real engines under P4-approved hosting/profile. Record memory/CPU/wall time/cost and corpus fidelity; fixtures validate lifecycle only. Instantiate processing cleanup conformance and prove provider cancellation/reconciliation.
- [ ] Commit: `feat: orchestrate Cloudflare document extraction adapters`.

### Task 2: FTS5 candidate index, authorization and checkpointed rebuild

**Files:** Create `packages/documents-cloudflare/src/search/{fts-index,index-coordinator,catalog,rebuild-store,cleanup}.ts`, `apps/document-api/worker-tests/search.worker-case.ts`, `test/cloudflare-documents/search.integration.test.ts`; extend migration, register P5 shared search route and indexing consumer.

**Interfaces:** Implement P5 SearchIndex, IndexWorkStore, IndexCatalog and RebuildService provider stores. `createD1SearchIndex(deps):SearchIndex` queries tenant+epoch+stable sort key and returns only candidate refs. Store text chunks with source version/run/page/generation and metadata revision. FTS derived tables and catalog reside in tenant's authoritative shard; SQL index work can commit local row/receipt changes atomically, while any R2 text fetch/output still requires publication/cleanup tracking. Support P5 typed filters/sorts and deployment-bound P0 cursors; materializer always uses current primary grants/content permission.

- [ ] Run shared revocation/FTS snippet/cursor cases; add more-than-one-text-chunk, FTS parameter escaping, tenant predicate on every join, stale extraction, failed epoch switch, deletion during rebuild and resumed checkpoint. Assert totals/facets/scores/denied candidate counts are absent, and a copied AWS/other-tenant cursor fails.
- [ ] Run `bun run test:cloudflare -- search.worker-case.ts`; expect missing index/coordinator.
- [ ] Implement FTS5 plus metadata indexes with bound MATCH parameters and validated query syntax, bounded chunks below D1 row/statement/parameter limits and no arbitrary SQL/DSL input. Keep derived text within capacity reservation; oversized query/work fails explicitly rather than scanning unboundedly. Serialize index refresh, load canonical current document/extraction and check lifecycle generation. New-epoch rebuild uses checkpoints, dual refresh/catch-up and atomic catalog activation; deletion covers all epochs and outstanding work. Do not depend on D1 read replicas for current permissions. [D1 FTS5 support](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
- [ ] Run local cases and authorized real D1 FTS queries with P4 artifacts, immediate revocation before FTS refresh, multi-page cursors and rebuild/deletion races. Instantiate owner `search` cleanup conformance. Record observed search lag/budget, not assumed OpenSearch-equivalent relevance.
- [ ] Commit: `feat: search document metadata and text safely with D1 FTS5`.

### Task 3: D1 review bindings and authenticated FlowKit delivery

**Files:** Create `packages/documents-cloudflare/src/flowkit/{binding-store,gateway-client,delivery-store,cleanup}.ts`, `apps/document-api/worker-tests/flowkit.worker-case.ts`, `test/cloudflare-documents/flowkit.integration.test.ts`; register P6 shared review routes/Queues handler and gateway config secret references.

**Interfaces:** Implement P6 EvidenceBindingStore, WorkflowGateway and FlowkitDocumentBridge provider dependencies; D1 keeps exact EvidenceRef (document/version/metadata revision), review/business/flow references, delivery attempts/receipts. Reuse P6 gateway protocol/consumer-selected bindings and external supported runtime; never import Temporal client/worker into Worker bundle. Owner `flowkit` cleanup erases sensitive integration payloads while retaining permitted references.

- [ ] Run shared `review_pins_original_snapshot`, `replacement_does_not_inherit_approval`, `workflow_role_is_not_document_access`, `document_access_is_not_task_eligibility`, `lost_response_retries_same_operation`, `runtime_outage_preserves_document` and `deleted_evidence_never_restored` scenarios.
- [ ] Run `bun run test:cloudflare -- flowkit.worker-case.ts`; expect missing stores/client.
- [ ] Implement scoped gateway authentication, trusted service/tenant binding, current grants and stable event+binding operation IDs. Create binding/receipt/audit/outbox in tenant D1 transaction and coordinate source lifecycle revision; persist failures separately from document success. Callback/decision identity comes from trusted runtime gateway, not caller actor ID. Use shared consumer fixture and configured task/projection store on runtime host; Cloudflare hosts neither a replacement FlowKit engine nor its PostgreSQL task store.
- [ ] Run local cases, public export/type checks and authorized real gateway/runtime integration from Cloudflare. Instantiate P3 owner `flowkit` cleanup cases and prove duplicate delivery produces one logical transition/decision reference.
- [ ] Commit: `feat: connect Cloudflare evidence to supported FlowKit reviews`.

### Task 4: Common extraction/search/review API acceptance

**Files:** Create `test/cloudflare-documents/assembled-evidence.integration.test.ts`, `docs/operations/cloudflare-processing-search-workflows.md`; extend `test/support/document-conformance/{processing,search,reviews}.ts` in coordination with P4–P6 and Cloudflare outputs/evidence.

**Interfaces:** `createCloudflareHarness(profile)` from CF1 runs the same shared scenario functions as P4–P6 AWS wrappers. No provider selector is accepted from an end-user API; provider is deployment context. Live profile requires configured evaluated engine profiles and a real supported runtime fixture.

- [ ] Add full scenario upload→metadata revision→OCR outcomes/text→permitted search→start exact-evidence review→replace bytes/edit metadata→approve original→revoke→delete/reconcile. Assert source/run/page/model provenance and decision references match on both providers, and cross-tenant denial holds throughout.
- [ ] Run the shared scenarios against local fakes on Bun/workerd; newly absent route registrations must fail. Confirm approved-but-missing-engine/runtime profile errors before a live run and unapproved live mode explicitly skips.
- [ ] Register all common route modules and private callback/queue bindings; compare generated route inventory to the same OpenAPI and document any deployment caps as configuration, never hidden behavior changes. Keep missing processing/search/runtime dependencies visible in readiness/operations.
- [ ] Execute authorized real Cloudflare acceptance and CF2 deletion races with actual selected engines, FTS5 and supported runtime. Update common design coverage ledger with provider-specific commands/results and no content/credentials. Any missing engine/provider/runtime keeps CF3 incomplete.
- [ ] Commit: `test: prove full Cloudflare evidence processing and review`.

## Self-review and handoff

CF3 mirrors P4–P6 provider responsibilities while reusing their portable implementations and routes. Search permission materialization and exact review pinning are shared; FTS schema, D1 atomicity, Worker budgets and Queues delivery are specific. CF4 supplies restore/monitoring/release gates; no fake engine/runtime is counted as parallel-release parity.

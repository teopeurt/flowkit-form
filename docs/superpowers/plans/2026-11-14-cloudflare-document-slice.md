# Cloudflare Document Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the same document API/evidence vertical slice as AWS using Workers, D1, R2 and Queues, with no AWS service dependency.

**Architecture:** D1 is the single authority for each tenant's state, receipts, audit and outbox. Isolated Workers inject D1/R2/queue adapters into P0's shared application and upload services. R2 publication uses unique create-only objects; no S3 VersionId or distributed D1/R2 transaction is assumed.

**Tech Stack:** TypeScript/Bun, Wrangler, Cloudflare Workers, D1, R2, Queues, Vitest Workers pool/workerd. Pin compatible current versions at execution; local runtime tests are separate from the Bun suite.

**Spec:** [Approved amendment](../specs/2026-11-14-cloudflare-alternative-design.md), [base design](../specs/2026-11-14-flowkitform-design.md), [master waves](2026-11-14-release-waves.md). CF1 requires P1/P0; initial configuration may be prepared alongside P1.

## Global Constraints

- “D1 as Cloudflare's authoritative store”.
- “No required atomic operation spans D1 databases or R2.”
- “Final object IDs are never reused, including after deletion.”
- “Neither provider may omit a required capability and still count as release-complete.”
- No Durable Objects authority, AWS backend fallback, public evidence bucket or implicit model/native execution.
- Actual cloud writes/migrations require existing or explicit target authorization; local migrations use isolated workerd fixtures only.

## Review Focus

- Zero-row CAS commits audit/outbox anyway: force an SQL assertion failure inside the batch (Task 2).
- Tenant routes to wrong D1 or a replica misses revocation: trusted registry and primary reads (Task 2).
- Reusable presigned URL changes verified bytes: signed create-only upload or trusted multipart completion (Task 3).
- Lost R2 response is treated as failed write: keep output tracked until definitively reconciled (Task 3).
- Queues expiry or send/ack crash loses work: D1 remains replay source (Task 4).

## Verified provider constraints

D1 batches roll back when a statement fails, but zero changes are not an error. [Batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/). D1 limits include database size, SQL bytes, row size and bound parameters; preflight each encoded statement. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
R2 create-only conditions must be on PutObject or CompleteMultipartUpload, not only multipart initiation. [Conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/). An absent object does not prove an earlier unknown write cannot still commit. [Consistency](https://developers.cloudflare.com/r2/reference/consistency/).
Use the supported Workers test integration for actual binding semantics. [Vitest Workers integration](https://developers.cloudflare.com/workers/testing/vitest-integration/). Reverify tools/account limits before deployment.

### Task 1: Worker package, manifests and explicit configuration

**Files:** Create `packages/documents-cloudflare/package.json`, `packages/documents-cloudflare/src/{config,index}.ts`, `deploy/cloudflare/{wrangler.jsonc,vitest.config.ts,tsconfig.json}`, `deploy/cloudflare/src/{bindings,validate-config}.ts`, `docs/decisions/cloudflare-release-config.md`, `apps/document-api/worker-tests/config.worker-case.ts`; modify root manifest/lockfile/scripts/build include for deployment TypeScript.

**Interfaces:** `parseCloudflareConfig(input:unknown): CloudflareDeploymentConfig`; required accountId/environment/deploymentId/compatibilityDate, tenant-to-D1 registry, staging/content bucket map, queue names, issuer/audience/membership endpoint, credential references, upload/worker/SQL/FTS/capacity budgets, maxMonthlyCost, target workload, RPO/RTO and data-location requirements. `CloudflareDeploymentOutputs` holds API URL, account/environment, bindings fingerprint and public resource names, no secrets. `CloudflareBindings` imports scoped types from workers-types, never global types into portable packages. Use separate API/upload/consumer/cleanup/protection Worker surfaces; no caller-provided generic storage/RPC operations.

- [ ] Write `rejects_missing_bindings_or_limits` and `manifests_keep_evidence_private`: assert no r2.dev/public custom domain, no production secret values, no AWS environment dependencies, no unreviewed compatibility-date change and distinct privileged protection-controller configuration. Assert dry-run outputs cannot be used as live deployment outputs.
- [ ] Run newly defined `bun run test:cloudflare -- config.worker-case.ts`; initially expect missing package/configuration. The script invokes Vitest with explicit worker-case includes; root Bun discovery must not execute workerd-only files.
- [ ] Implement Wrangler environment manifests and type-scoped package exports. Add root `test:cloudflare` (`vitest run --config deploy/cloudflare/vitest.config.ts`) and `cloudflare:check` (`wrangler deploy --dry-run --config deploy/cloudflare/wrangler.jsonc`) scripts. Use explicit synthetic config only for offline checks. Review current Workers CPU/memory, queue limits, D1 capacity, R2 limits and pricing in official docs; record source URLs/date and actual plan values.
- [ ] Run local Worker tests, typecheck, root build and dry-run bundle with synthetic configuration; expect PASS without remote provisioning. Fail bundle import checks on AWS SDK clients, Node-only native binaries, demo app/database and Temporal clients.
- [ ] Commit: `build: configure isolated Cloudflare document deployment`.

### Task 2: D1 schema, tenant routing and atomic persistence

**Files:** Create `deploy/cloudflare/migrations/0001_documents.sql`, `packages/documents-cloudflare/src/d1/{routing,document-store,document-reader,upload-store,delivery-store}.ts`, `apps/document-api/worker-tests/persistence.worker-case.ts`, `test/cloudflare-documents/persistence.integration.test.ts`.

**Interfaces:** `createD1DocumentStore(deps:D1StoreDependencies): DocumentStore`; `createD1DocumentReader(deps): DocumentReader & DocumentInventory`; implement P0 UploadStore/DeliveryStore with scoped tenant lookup. `D1StoreDependencies` contains tenant registry, binding resolver and deployment ID, with no database override from clients. Tables separate heads, versions, metadata snapshots, grants, holds/leases/cleanup, operation receipts, audit, outbox and delivery receipts. Tenant/actor/operation receipt key is unique across all documents for that tenant. No tenant spans authoritative databases.

- [ ] Run shared P1/P0 scenarios as worker cases; add `cas_zero_rows_aborts_batch`, `fault_after_audit_rolls_everything_back`, `same_operation_other_document_conflicts`, `primary_revocation_is_immediate`, `immutable_history_is_paged` and `wrong_registry_binding_rejected`. Assert no state/receipt/audit/outbox is left by a losing CAS.
- [ ] Run `bun run test:cloudflare -- persistence.worker-case.ts`; expect absent adapter/schema failures.
- [ ] Implement prepared-statement batch with a first transactional guard row whose CHECK fails when expected head revision/existence is wrong, then state/delta/receipt/audit/outbox writes and guard cleanup. Prove assertion works in local and live D1; do not infer rollback from zero-row update count after commit. Receipt replay is checked under current authorization; fingerprint mismatch conflicts. Keep every statement below current parameter/SQL/row limits, reject oversize before writing, and use primary reads without read replication for authorization/lifecycle. Reserve database capacity for reconciliation/control writes; saturation rejects new nonessential writes without silently moving a tenant.
- [ ] Run local scenario suite/typecheck and, after target authorization/provisioning, `FLOWKITFORM_CLOUDFLARE_TEST_APPROVED=true bun test test/cloudflare-documents/persistence.integration.test.ts` with explicit output/account/environment. Prove real batch rollback, concurrency and routing.
- [ ] Commit: `feat: implement authoritative document persistence in D1`.

### Task 3: R2 immutable upload and verified promotion backend

**Files:** Create `packages/documents-cloudflare/src/r2/{artifact-store,upload-backend,verification,reconciliation}.ts`, `apps/document-api/worker-tests/uploads.worker-case.ts`, `test/cloudflare-documents/uploads.integration.test.ts`; extend manifests/CORS and D1 schema as needed with reviewed forward migration.

**Interfaces:** Implement P0 ArtifactStore/UploadBackend/UploadVerifier and P1 opaque ArtifactRef; generation is server-assigned write-once identity, not ETag. `R2UploadBackend` returns sealed source reference only after completion is known. Trusted multipart server owns completion; users get only part URLs. R2 read output is streamed into an incremental hash/verifier, never full-buffered for large files.

- [ ] Test `signed_single_put_cannot_drop_create_only_header`, `multipart_complete_is_server_owned`, `reused_urls_never_mutate_published_bytes`, `etag_is_not_sha256`, `unknown_copy_cannot_be_forgotten`, `crash_after_promote_is_tracked`, `over_limit_source_stays_quarantined` and `staging_expiry_spares_published_bytes`. Attempt overwrite after deletion using old credentials and prove final keys are never reused.
- [ ] Run `bun run test:cloudflare -- uploads.worker-case.ts`; expect missing backend failures.
- [ ] Implement unguessable staging keys with cryptographically signed If-None-Match for single PUT. If runtime/client path cannot prove the signed condition, expose multipart fallback through the same mode negotiation without weakening immutability. Complete multipart with create-only condition. Persist source/parts/reserved-version identity before remote completion; reconcile unknown outcomes using the documented completion procedure. Run type/size/safety verification and incremental SHA-256 within measured budgets or an explicitly configured external verifier. Register promotion lease/output before create-only destination write; validate identical destination checksum and publish only through D1/P1. Keep staging and final namespaces separate, never reuse keys or expire in-use source objects. Fail closed if verifier is missing or unhealthy.
- [ ] Run local cases and authorized live upload tests with independently computed hashes, concurrent completion, modified signatures and delayed R2 responses. Record memory/CPU/time evidence for the configured maximum file size. No fake scanner counts as deployed verification.
- [ ] Commit: `feat: publish verified immutable R2 evidence`.

### Task 4: Queues relay, consumers and scheduled repair

**Files:** Create `packages/documents-cloudflare/src/delivery/{relay,consumer,receipts,repair}.ts`, `apps/document-api/src/cloudflare-consumer.ts`, `apps/document-api/worker-tests/delivery.worker-case.ts`, `test/cloudflare-documents/delivery.integration.test.ts`; extend D1 schema/manifests.

**Interfaces:** Implement P0 DeliveryStore adapters and provider-side `dispatchPending(now,limit):Promise<RelayReport>` / `consumeQueue(batch):Promise<void>`. Queues event conversion is private to this package. D1 keeps stable event/operation/target identity, per-target attempts and explicit failed intent beyond Queue retention. Cron repair scans due/stalled durable work.

- [ ] Test send-success/ack-crash, concurrent claims, unordered messages, poison schema, individual retry/ack, exhausted retries, queue-retention loss simulation and repair/resend with original IDs. Unknown remote effects must remain tracked instead of being cleared on timeout.
- [ ] Run `bun run test:cloudflare -- delivery.worker-case.ts`; expect missing relay/worker failures.
- [ ] Implement per-target recoverable relay claims, bounded jittered retry, Queue retry/DLQ binding and D1 failed delivery records. Acknowledge each message only after durable handler effect or target receipt; transactionally deduplicate local effects and use stable operations externally. Never depend on queue ordering/exactly-once or on queue retention as permanent storage. Missing required handler configuration leaves delivery visible/failed rather than dropping events. Use explicit private service surfaces for upload verification and later processing/search/FlowKit work.
- [ ] Run local tests plus authorized real Queues outage/DLQ/replay tests. Record logical effect count and retained intent, not just message count. Verify Cron repair actually recovers stalled work in the target environment.
- [ ] Commit: `feat: deliver durable document work with Cloudflare Queues`.

### Task 5: Workers Fetch assembly and shared vertical-slice acceptance

**Files:** Create `apps/document-api/src/cloudflare.ts`, `apps/document-api/worker-tests/application.worker-case.ts`, `test/cloudflare-documents/vertical-slice.integration.test.ts`, `docs/deployment/cloudflare-documents.md`; modify CI with offline Worker checks while preserving AWS/demo checks.

**Interfaces:** Worker `fetch(request,env,ctx)` calls P0 `createDocumentApplication` with CF1 adapters. It does not trust cf-access/user-defined identity headers in place of shared TokenVerifier/IdentityDirectory. `createCloudflareHarness(profile):ProviderHarness` wraps actual deployed Fetch API for P0 shared scenarios. No second route/OpenAPI implementation.

- [ ] Run identical create→upload→verified version→history→download→audit cases and two-tenant denial cases from P0. Add malformed auth headers/JWKS failure, disabled group membership, content type/size limit and deployment-bound cursor tests on the real Worker envelope.
- [ ] Run Worker application cases offline; expect failure until composition exists. Without live approval flag, live suites explicitly skip; with flag and absent output/profile they fail.
- [ ] Assemble Fetch application and worker bindings, document explicit account/plan/data-location/service prerequisites and provision/dry-run steps. Prepare migration diff and resource manifests before requesting any missing target approval; live tests never provision or migrate on their own. Configure URL TTL identically in semantics to AWS, with provider-specific capability notes only in operational docs.
- [ ] Run P1/P0/Bun checks, all Worker cases, dry-run bundle and authorized D1/R2/Queues vertical-slice suites. CF1 completion requires real cloud evidence; missing account/identity/verifier keeps the gate open.
- [ ] Commit: `test: prove Cloudflare document evidence vertical slice`.

## Self-review and handoff

CF1 implements P0 contracts independently of P2. Live authorization uses its own flag/profile; AWS approval cannot provision Cloudflare. Worker runtime cases use `.worker-case.ts` and explicit Vitest includes so ordinary Bun discovery remains intact. CF2 adds governance, CF3 processing/search/FlowKit adapters and CF4 release operations; follow the common waves.

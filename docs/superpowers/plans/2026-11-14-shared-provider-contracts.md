# Shared Provider Contracts and HTTP Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the shared upload, identity, API, delivery and conformance implementation consumed independently by AWS and Cloudflare.

**Architecture:** P1 supplies the document domain and bounded persistence primitives. P0 moves the portable contracts previously assigned to the AWS slice into a shared prerequisite and implements one Request/Response application; provider entrypoints translate envelopes and inject bindings. Scenario functions are independent of Bun/Vitest and run against both provider adapters.

**Tech Stack:** TypeScript, Bun, standard Fetch/Web Crypto/streams, existing workspace build, framework-independent test scenarios. Provider SDKs and Workers globals stay outside shared packages.

**Spec:** [Base design](../specs/2026-11-14-flowkitform-design.md), [approved Cloudflare amendment](../specs/2026-11-14-cloudflare-alternative-design.md), [master waves](2026-11-14-release-waves.md). ID P0 is a shared prerequisite, not a requirement to execute before P1; depends on P1.

## Global Constraints

- “Neither the shared API nor the portable services import AWS SDK clients or Cloudflare bindings.”
- “Cloudflare must not wait for AWS SDK/CDK implementation to discover its required interfaces.”
- “Existing packages must retain their current responsibilities.”
- Mutations retain atomic state/audit/outbox; no portable generation field is defined as an S3 VersionId.
- P0 owns interfaces formerly introduced by P2 Tasks 2–5. Those AWS tasks implement adapters, not a second contract or API.

## Review Focus

- Adapter contract requires an AWS version ID or Node-only stream: compile both synthetic provider implementations (Task 1).
- Replayed completion creates a second version/work item: shared upload service deduplicates stable intent (Task 2).
- Cloudflare request headers impersonate a verified principal: validate access tokens before identity resolution (Task 3).
- Cursor usable on another provider/tenant/user/query: bind deployment as well as scope (Task 3).
- Bun-only conformance cannot run under workerd: plain scenario functions with runner wrappers (Task 4).

### Task 1: Portable artifact, reader, paging and delivery boundaries

**Files:** Create `packages/documents/src/{artifacts,reader,delivery}.ts`, `test/documents/provider-contracts.test.ts`; update exports and P1 store contract test extraction.

**Interfaces:** Produce `Page<T> = { items: readonly T[]; nextCursor: string | null }`; `ArtifactStore.read(ref: ArtifactRef): AsyncIterable<Uint8Array>`, `download(ref, expiresSeconds): Promise<{ url:string; expiresAt:string }>`, `remove(ref): Promise<void>` (only trusted permitted cleanup composition). `DocumentReader.versions/metadataRevisions/audit(scope, ref, cursor?): Promise<Page<Version | MetadataRevision | AuditRecord>>` use the appropriate exact result type for each method. `DocumentInventory.page(tenantId, cursor?): Promise<Page<DocumentRef>>` is service-only. `DeliveryStore.claimDue(now, limit): Promise<readonly DeliveryLease[]>`, `ack(leaseId): Promise<void>`, `retry(leaseId, errorCode, nextAt): Promise<void>`. `DeliveryLease` contains leaseId, target, envelope and attempt number. `EventEnvelope` preserves P2 schemaVersion 1, eventId, tenantId, documentId, lifecycleGeneration, aggregateRevision, kind, occurredAt, correlationId, operationId and string-reference map `refs`. Target receipt keys are `(tenantId, target, eventId)`; external effects use stable operation IDs.

- [ ] Write compile/runtime cases `opaque_generation_is_portable`, `history_is_paged`, `cross_tenant_rows_rejected` and `delivery_retry_preserves_identity`; assert artifact generation accepts an opaque R2 token as well as S3 generation and no API consumes raw SDK/client types.
- [ ] Run `bun test test/documents/provider-contracts.test.ts`; expect absent-contract errors.
- [ ] Implement types and capability boundaries with readonly JSON values. Keep storage-read cursor internals inside adapters and HTTP cursor encryption in Task 3. Raw inventory is never a client discover/list bypass. No removal implementation bypasses P3/CF2 destruction permits.
- [ ] Run focused tests, P1 contracts, typecheck/build; expect PASS and provider-neutral package declaration output.
- [ ] Commit: `feat: establish shared provider document contracts`.

### Task 2: Upload service and trusted verification orchestration

**Files:** Create `packages/documents/src/uploads.ts`, `test/documents/uploads.test.ts`; update exports and memory upload support in `test/support/memory-upload-store.ts`.

**Interfaces:** `UploadService.begin(context, { ref, mediaType, expectedBytes, mode }): Promise<UploadIntent>`; `signParts(context, { intentId, partNumbers }): Promise<readonly SignedPart[]>`; `complete(context, { intentId, generation?, parts? }): Promise<UploadStatus>`; `get(scope, intentId): Promise<UploadStatus>`. `UploadStatus = { intentId:string; status:'verifying'|'available'|'failed'; versionId?:string; errorCode?:string }`; intent additionally holds purpose, actor/tenant/document, expiresAt, reserved versionId and lifecycleGeneration. `UploadStore.create(context,intent)/get(scope,intentId)/compareAndSwap(context,expectedRevision,next)` persist intents atomically with audit/outbox. `UploadBackend.initiate(intent): Promise<UploadDestination>`, `signParts(intent,partNumbers): Promise<readonly SignedPart[]>`, `seal(intent,completion): Promise<UploadSource>`, `verifyAndPromote(source,context): Promise<VerifiedContent>`. `UploadSource` holds intent ID and opaque immutable ArtifactRef; `UploadDestination` holds mode, expiry and optional signed PUT or multipart part-signing information, never general credentials. `UploadVerifier.verify(source): Promise<{ accepted:boolean; reason?:string }>` is required production configuration. UploadBackend owns provider sealing/stream verification; service owns current permission/lifecycle checks and stable IDs.

- [ ] Test `completion_is_idempotent`, `changed_completion_conflicts`, `revocation_blocks_new_completion`, `rejected_verification_never_publishes`, `deletion_fences_promotion`, and `abandoned_intents_remain_cleanup_obligations`. Assert a repeated intent/event produces one version and processing intent, and client checksum/generation is never trusted verifier proof.
- [ ] Run `bun test test/documents/uploads.test.ts`; expect missing-service failures.
- [ ] Implement shared intent lifecycle and async dispatch using P1 publication leases and Task 1 envelope. Backend seal/promotion outcomes are persisted before version publication; retries reconcile the same output rather than create new IDs. Authorization occurs again before publication. Use original authenticated actor for staff upload and explicit capability identity/issuer provenance for external uploads; callback service identity is not the uploader.
- [ ] Run focused and P1 lifecycle tests; expect all duplicate/revoked/deleting scenarios to pass.
- [ ] Commit: `feat: share verified upload orchestration across providers`.

### Task 3: Shared Fetch API, identity, errors and encrypted cursors

**Files:** Create `apps/document-api/package.json`, `apps/document-api/src/{application,router,identity,errors,cursors}.ts`, `apps/document-api/src/routes/{documents,uploads,audit}.ts`, `docs/api/flowkitform.openapi.yaml`, `test/document-api/{identity,routes,cursors,openapi}.test.ts`; update root manifests/build. AWS owns `handler.ts` and Cloudflare owns `cloudflare.ts`, not this task.

**Interfaces:** `createDocumentApplication(deps: DocumentApiDependencies): (request: Request) => Promise<Response>`; dependencies are Task 1 reader/artifact/delivery, Task 2 uploads, P1 store, clock, identity, token verifier and cursor codec, with typed registration hooks for later route modules. `TokenVerifier.verify(token): Promise<{ issuer:string; subject:string; audience:readonly string[]; scopes:readonly string[]; expiresAt:string }>` checks cryptographic signature/algorithm, trusted issuer/audience, expiry and required access-token scopes. `IdentityDirectory.resolve({ issuer,subject,selectedTenantId,token }): Promise<{ scope:Scope; canCreateDocuments:boolean }>` uses trusted live membership/group resolution. Never accept unsigned forwarded identity headers on the shared application. `CursorCodec.encode({ deploymentId,tenantId,actorId,queryHash,after,expiresAt }): string` / `decode(token,binding): CursorState` uses authenticated encryption, key ID rotation and bounded expiry. Worker-compatible vetted JOSE/Web Crypto implementation is pinned during coding, not handwritten JWT cryptography.

**Routes:** Shared base inventory is POST `/v1/documents`; GET/PATCH `/v1/documents/{id}`; GET `/v1/documents/{id}/metadata-revisions` and `/{revision}`; GET `/v1/documents/{id}/versions` and `/{versionId}`; POST `/v1/documents/{id}/uploads`; POST `/v1/uploads/{id}/parts` and `/complete`; GET `/v1/uploads/{id}`; GET `/v1/documents/{id}/versions/{versionId}/content`; GET `/v1/documents/{id}/audit`; GET `/health/ready`. P3–P6 add route modules to this one inventory.

- [ ] Test invalid signature/issuer/audience, expired/ID token, spoofed tenant/groups, disabled membership, service identity, denied create, cross-tenant 404, identity outage fail-closed, deployment/actor/query cursor misuse, stale ETag, mismatched idempotency key payload and download access revoked before URL signing.
- [ ] Run `bun test test/document-api/`; expect absent application/OpenAPI failures.
- [ ] Implement shared handlers and token/directory checks for protected routes; health and P3 capability-redemption routes have explicitly registered alternate authentication, never an implicit global auth bypass. AWS authorizer is an extra ingress check, not the only authentication for reusable code. Mutations require Idempotency-Key; updates require If-Match. Stable errors `{ code,message,correlationId }`: 400 validation, 401 auth, 403 same-tenant denied, 404 missing/cross-tenant, 409 conflict/held/retained, 412 stale revision, 413 size, 429 quota, 503 unavailable. Completion is 202 pending verification. Audit signed-URL issuance separately from content delivery. Apply CORS/configured origin limits without trusting browser-only controls for auth.
- [ ] Run focused tests and root typecheck/build; assert shared sources do not import AWS event types, process-bound config or Cloudflare globals. Validate real routes against OpenAPI.
- [ ] Commit: `feat: implement shared authenticated document HTTP application`.

### Task 4: Provider-independent conformance and live environment harness

**Files:** Create `test/support/document-conformance/{persistence,uploads,api,environment}.ts`, `test/documents/provider-conformance.test.ts`; refactor planned P1 contract case registration to reuse plain functions. Update root scripts without running/provisioning live services.

**Interfaces:** `ProviderHarness = { provider:'aws'|'cloudflare'; deploymentId:string; createStore():Promise<DocumentStore>; request(input:Request):Promise<Response>; resetFixtures():Promise<void> }`. Export named async scenario functions with ordinary throwing assertions; runner-specific describe/test registration stays in Bun or Vitest wrappers. `readLiveProfile(provider): LiveProfile | null` returns null only if that provider's explicit approval flag is absent; flag present with missing account/output/identity fails. AWS profile requires account/region; Cloudflare requires account/environment/bindings fingerprint. A profile never changes tenant/provider based on HTTP input.

- [ ] Test shared scenario registration for both fake harnesses, preserve exact response invariants, reject target mismatch, fail approved-but-unconfigured runs, and prove cleanup touches only isolated fixture namespaces. Assert skip is explicitly reported as no live evidence, not success.
- [ ] Run `bun test test/documents/provider-conformance.test.ts`; expect missing harness/scenario failures.
- [ ] Implement runner-neutral cases for atomic persistence, immutable upload/replay, historical metadata and tenant/API auth. Later P3–P6 append shared scenario functions for governance/processing/search/review; AWS and Workers runners invoke the same case bodies. Keep live flags distinct so approval of one provider never permits the other.
- [ ] Run shared suites/typecheck/build; both fake harnesses must execute identical named cases, and no bun:test import may enter workerd scenario modules.
- [ ] Commit: `test: share document acceptance scenarios across providers`.

## Self-review and handoff

P0 follows P1 and precedes P2/CF1 runtime integration. It replaces the portable ownership portions of P2 rather than duplicating them. Provider-specific storage/promotion/auth ingress/queue tests remain in their lane; all application behavior is shared. Full release readiness needs both live harnesses, not just these fakes. Follow the master waves after plan review.

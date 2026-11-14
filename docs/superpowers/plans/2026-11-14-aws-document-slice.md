# AWS Document Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver real AWS-backed creation, metadata/version history, verified direct uploads, authorized exact-version downloads and audit APIs.

**Architecture:** A separate `apps/document-api` Lambda entrypoint composes portable document services with DynamoDB and S3 adapters; it never imports the demo Nest application. Durable outbox polling feeds SQS workers, with DynamoDB as source of delivery intent. API Gateway validates configured OIDC access tokens and application identity resolution supplies trusted scope.

**Tech Stack:** TypeScript/Bun, Node.js Lambda runtime, AWS SDK v3, AWS CDK v2, API Gateway HTTP API, DynamoDB, S3, SQS, KMS; exact compatible SDK/runtime/CDK versions pinned at execution.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [wave plan and shared contracts](2026-11-14-release-waves.md). Depends on P1.

## Global Constraints

- “Avoid AWS-specific types in portable contracts”.
- “Mutations commit state and durable audit/event intent together.”
- “Outstanding upload credentials must not be able to alter published content.”
- “unverified uploads must not enter normal retrieval or processing.”
- AWS document functions are serverless; existing BetterAuth/PostgreSQL and Temporal are not silently imported or provisioned.
- Region/account, identity endpoints, file/resource limits and budgets are required deployment configuration, not guessed user choices.

## Review Focus

- Signed URL reuse overwrites staging bytes: bind verification to a concrete S3 VersionId (Task 3).
- Multipart ETag/composite checksum mistaken for whole-file SHA-256: compute SHA-256 over exact stored bytes (Task 3).
- Duplicate operations after provider idempotency expiry: persistent operation receipts remain authoritative (Task 2).
- Forged groups/tenant header or ID token: validate access-token scopes and resolve membership at the trusted boundary (Task 4).
- Crash after SQS send and before outbox acknowledgment: resend safely and deduplicate consumers (Task 5).

## Provider facts verified for planning

S3 URLs are reusable and may replace an existing key; use immutable generations rather than assuming single use. [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
DynamoDB transactions are bounded (100 actions, 4 MB); provider request tokens have a 10-minute window, so they do not replace application receipts. [Transaction API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).
GSIs do not provide strongly consistent reads; current authorization uses base-table reads. [Read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html).
Lambda is bounded compute and SQS batches require per-record failure handling. [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [SQS integration](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html).
Reverify applicable runtime/account/region limits at implementation; do not assume current pricing or quota increases.

### Task 1: Isolated AWS package, deployment configuration and CDK skeleton

**Files:** Create `packages/documents-aws/package.json`, `packages/documents-aws/src/index.ts`, `deploy/aws/package.json`, `deploy/aws/cdk.json`, `deploy/aws/src/app.ts`, `deploy/aws/src/document-stack.ts`, `docs/decisions/aws-release-config.md`, `test/documents-aws/infrastructure.test.ts`; modify root `package.json`, `bun.lock`, `tsconfig.json` and `tsconfig.build.json` to include `deploy/aws/src/**/*.ts`.

**Interfaces:** Produce `parseDeploymentConfig(input: unknown): DeploymentConfig` in `packages/documents-aws/src/config.ts`. Required values: account, region, issuer, audience, membership endpoint, credential secret ARN, maxUploadBytes, maxPages, maxRenderPixels, verificationTimeoutSeconds, workerConcurrency, maxMonthlyCost, targetRequestsPerSecond, apiP95Ms, processingDeadlineSeconds, rpoSeconds, rtoSeconds. Validate positive bounded numbers; credentials are references only. CDK consumes this config and emits a non-secret output schema `DocumentDeploymentOutputs` with API URL, bucket/table/queue names and account/region. Do not commit actual outputs.

- [ ] Write assertions that missing region/identity/limits fails config validation; CDK includes encrypted versioned S3, private buckets, on-demand encrypted DynamoDB with PITR, queues/DLQs, distinct function roles, API JWT authorizer and explicit retention policies. Assert no public bucket, wildcard data grants or demo DB/runtime environment variables.
- [ ] Run `bun test test/documents-aws/infrastructure.test.ts`; expect missing-package failures.
- [ ] Implement config and CDK skeleton using Node.js runtime supported by current CDK/AWS documentation. Add `aws:synth` and `aws:diff` root scripts; bundle only the new Lambda entrypoints. Retain production data resources on stack removal. Add ephemeral test-resource policy only behind explicit isolated-test config.
- [ ] Run the focused test, typecheck and `bun run aws:synth` with synthetic non-secret test configuration; expect a valid CloudFormation template without deploying or contacting real data services. Offline synth must use explicit fake endpoints/account placeholders and never masquerade as deployable production configuration. Document calculated service/quota/cost checks and unresolved actual configuration separately.
- [ ] Commit task files: `build: scaffold isolated document AWS deployment`.

### Task 2: Bounded DynamoDB records and atomic adapter

**Files:** Create `packages/documents-aws/src/dynamodb/{keys,document-store,document-reader,delivery-store}.ts`, `packages/documents/src/reader.ts`, `test/documents-aws/dynamodb-store.test.ts`, `test/aws-documents/persistence.integration.test.ts`; update exports and infrastructure.

**Interfaces:** Consume P1 `DocumentStore` and its bounded delta contract. Produce `createDynamoDocumentStore(deps: DynamoStoreDependencies): DocumentStore` and `DocumentReader` with `versions(scope, ref, cursor?): Promise<Page<Version>>`, `metadataRevisions(scope, ref, cursor?): Promise<Page<MetadataRevision>>`, `audit(scope, ref, cursor?): Promise<Page<AuditRecord>>`. `Page<T> = { items: readonly T[]; nextCursor: string | null }`. Also produce service-only `DocumentInventory.page(tenantId: string, cursor?: string): Promise<Page<DocumentRef>>` for cleanup/rebuild, never exposed as an unauthenticated listing API. `DynamoStoreDependencies` contains SDK client and table name only inside AWS package.

**Layout:** Partition on encoded tenant+document, sort by `HEAD`, `VERSION#id`, `META#revision`, `GRANT#id`, `AUDIT#id`, `OUTBOX#eventId`, `LEASE#id`, `CLEANUP#id`; receipts use tenant+actor+operation partition keys. No caller-controlled delimiter concatenation. Audit changes contain operation names/references, with sensitive metadata history stored separately. Cursor keys are sealed at API boundary. Outbox due-index is a candidate source, not an authorization read.

- [ ] Add adapter tests reusing P1 store contracts; assert command size preflight, transaction cancellation commits nothing, strong head/grant reads, immutable rows never overwritten, operation replay beyond ten minutes stays idempotent, and page cursors cannot cross documents/tenants. Add tests for >one page of versions without rewriting prior rows.
- [ ] Run `bun test test/documents-aws/dynamodb-store.test.ts`; expect missing-adapter failure.
- [ ] Implement normalized delta transactions with head CAS, receipt, audit and outbox written atomically. Hydrate only bounded mutable head data; immutable history uses point/page reads. Bound metadata/grants/events per command below provider limits; reject oversize before any write, never truncate. Map conflicts to stable domain errors without exposing SDK data.
- [ ] Run focused tests and the P1 suite; expect PASS. After authorized isolated deployment run `FLOWKITFORM_AWS_TEST_APPROVED=true bun test test/aws-documents/persistence.integration.test.ts` with the explicit output file; assert real AWS transaction cancellation and tenant separation, not just mocked SDK calls.
- [ ] Commit: `feat: persist document commands atomically in DynamoDB`.

### Task 3: Direct and multipart uploads with immutable verification

**Files:** Create `packages/documents/src/{artifacts,uploads}.ts`, `packages/documents-aws/src/s3/artifact-store.ts`, `packages/documents-aws/src/uploads/{upload-store,verify-worker}.ts`, `test/documents-aws/uploads.test.ts`, `test/aws-documents/uploads.integration.test.ts`; update exports and CDK.

**Interfaces:** `ArtifactStore` produces `read(ref: ArtifactRef): AsyncIterable<Uint8Array>`, `download(ref, expiresSeconds): Promise<{ url: string; expiresAt: string }>`, `remove(ref): Promise<void>` (destruction adapter permission required in P3). `UploadService.begin(context, { ref, mediaType, expectedBytes, mode: 'single' | 'multipart' }): Promise<UploadIntent>`; `signParts(context, { intentId, partNumbers }): Promise<readonly SignedPart[]>`; `complete(context, { intentId, generation?, parts? }): Promise<{ intentId: string; status: 'verifying' | 'available' | 'failed'; versionId?: string }>`; `get(scope, intentId): Promise<UploadStatus>`. Define persisted `UploadStore` get/create/CAS using bounded records. Intent has purpose, tenant/document, authorizing actor, expiry, reserved version ID, generation and lifecycle generation. Client generation/part lists are hints checked against intent and storage, never verification proof.

- [ ] Test stale/reused upload URLs, concurrent completions with distinct generations, shuffled/duplicate multipart parts, abandoned uploads, size/type mismatch, cross-tenant intent reads, crash during verification and malware-verifier rejection. Assert original version SHA-256 remains unchanged after staging overwrite and duplicate completion yields one version/job event.
- [ ] Run `bun test test/documents-aws/uploads.test.ts`; expect missing-service failures.
- [ ] Implement versioned staging keys; first completion CAS-pins the exact VersionId before queued verification. Stream that version to calculate full SHA-256, inspect file signatures/limits and run configured `UploadVerifier.verify(source): Promise<{ accepted: boolean; reason?: string }>`; default denies availability if the deployment's verifier is missing/unhealthy. Never equate multipart ETag with content hash. Promote the verified source VersionId to a separate protected content namespace using that exact source generation, validate destination byte identity, and publish the immutable destination VersionId via P1 appendVersion and publication lease. Register promotion output before copying so a failed commit leaves tracked cleanup, not an orphan. Staging expiry never targets published content; cleanup may remove source generations only after promotion/reconciliation. Unverified objects are inaccessible to content/processing roles. Enforce deployment max size proven to fit verification budget; unsupported large sizes fail explicitly. Multipart transfers bypass API payload limits.
- [ ] Run focused tests and live suite after authorized deployment. Verify multipart byte hash independently, overwritten staging still downloads original generation, parts expire/abort and cleanup tracks every staging generation. Failed verification remains quarantined and is audited.
- [ ] Commit: `feat: verify immutable single and multipart document uploads`.

### Task 4: Authenticated /v1 API and public contract

**Files:** Create `apps/document-api/package.json`, `apps/document-api/src/{handler,router,identity,errors,cursors}.ts`, `apps/document-api/src/routes/{documents,uploads,audit}.ts`, `docs/api/flowkitform.openapi.yaml`, `test/document-api/{identity,routes,openapi}.test.ts`; update root scripts/exports/CDK.

**Interfaces:** `IdentityDirectory.resolve({ issuer, subject, selectedTenantId, token }): Promise<{ scope: Scope; canCreateDocuments: boolean }>` uses configured trusted membership/group service; no group/role data from request bodies. `createDocumentHandler(deps: DocumentApiDependencies): (event: HttpApiEvent) => Promise<HttpApiResponse>` is provider-neutral at router boundary; AWS event translation stays in handler. Dependencies: DocumentStore, DocumentReader, UploadService, ArtifactStore, identity, clock, cursor codec; later services register optional route modules. `CursorCodec.encode({ tenantId, actorId, queryHash, after, expiresAt }): string` / `decode(token, binding): CursorState` uses authenticated encryption and configured key reference.

**Routes:** POST `/v1/documents`; GET/PATCH `/v1/documents/{id}`; GET `/v1/documents/{id}/metadata-revisions` and `/{revision}`; GET `/v1/documents/{id}/versions` and `/{versionId}`; POST `/v1/documents/{id}/uploads`; POST `/v1/uploads/{id}/parts` and `/complete`; GET `/v1/uploads/{id}`; GET `/v1/documents/{id}/versions/{versionId}/content`; GET `/v1/documents/{id}/audit`; GET `/health/ready`. No mutable `latest` evidence in review references.

- [ ] Test missing/expired/wrong-issuer/wrong-audience tokens, ID-token scope failure, spoofed tenant/groups, disabled membership, service identities, create without create permission, cross-tenant 404, malformed cursors, stale ETags and same idempotency key/different payload. Validate every route/status against OpenAPI and test auth provider outage fails closed.
- [ ] Run `bun test test/document-api/`; expect missing-handler/schema failures.
- [ ] Implement adapter using validated API Gateway access-token claims plus authoritative directory resolution; produce FlowKit authenticated principal via supported public auth contracts where consumed, without inventing role-based document access. Use `Idempotency-Key` on mutations and `If-Match` for existing-aggregate updates. Return errors `{ code, message, correlationId }`: 400 validation, 401 auth, 403 denied same-tenant operation, 404 non-disclosing cross-tenant/missing, 409 command conflict/held/retained, 412 stale ETag, 413 too large, 429 quota, 503 dependency unavailable. Completion returns 202 until verified. Audit download URL issuance separately from observed content delivery.
- [ ] Run focused tests, typecheck and build; expect PASS. Compare OpenAPI route inventory to actual registrations. Reverify [JWT authorizer guidance](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) for deployed issuer algorithms/access-token scopes.
- [ ] Commit: `feat: expose authenticated versioned document APIs`.

### Task 5: Outbox relay, durable deduplication and worker entrypoints

**Files:** Create `packages/documents/src/delivery.ts`, `packages/documents-aws/src/delivery/{relay,consumer,receipts}.ts`, `apps/document-api/src/workers/{outbox,verification}.ts`, `test/documents-aws/delivery.test.ts`, `test/aws-documents/delivery.integration.test.ts`; update CDK.

**Interfaces:** `EventEnvelope = { schemaVersion: 1; eventId: string; tenantId: string; documentId: string; lifecycleGeneration: number; aggregateRevision: number; kind: string; occurredAt: string; correlationId: string; operationId: string; refs: Readonly<Record<string,string>> }`. `DeliveryStore.claimDue(now, limit): Promise<readonly DeliveryLease[]>`, `ack(leaseId): Promise<void>`, `retry(leaseId, errorCode, nextAt): Promise<void>`; `consumeEvent(envelope, handler): Promise<void>` persists per-handler receipt only with the handler's durable effect or relies on target-side stable operation IDs. Handler keys distinguish processing, search and FlowKit delivery. CDK scheduled relay polls indexed due records and eventually rescans durable pending intent; no sole reliance on stream retention.

- [ ] Test send-then-crash replay, concurrent relay claims, partial batch failure, unknown schema/version, poison event DLQ, bounded retry and replay with the same event/operation IDs. Assert logs exclude tokens/content and document Lambda bundles do not import demo app/database/Temporal client.
- [ ] Run `bun test test/documents-aws/delivery.test.ts`; confirm missing relay failures.
- [ ] Implement polling relay with recoverable claims, jittered bounded retries, per-target delivery records, SQS partial batch responses and durable failure records. Acknowledge intent only after confirmed send. Keep small reference envelopes; out-of-order consumers compare aggregate/lifecycle generation. Register empty-but-durable target routing until later modules arrive, without discarding unmatched required events.
- [ ] Run focused and live delivery tests; expect one logical effect under duplicate delivery and retained failed events after outages. Observe live DLQ and replay receipts, not just queue depth.
- [ ] Commit: `feat: deliver document events durably through SQS`.

### Task 6: Vertical-slice deployment and evidence

**Files:** Create `test/aws-documents/vertical-slice.integration.test.ts`, `docs/deployment/aws-documents.md`, `scripts/documents/read-deployment.ts`; modify `.github/workflows/ci.yml` with synth-only document validation; retain existing demo gates.

**Interfaces:** `readApprovedDeployment(): DocumentDeploymentOutputs` checks explicit flag, account/region/output binding and fails when an approved test run lacks configuration. No test silently provisions infrastructure.

- [ ] Add a test scenario for create → multipart upload → verified version → historical metadata → exact-version download → audit, plus a second tenant denied every read path.
- [ ] Run focused tests without cloud flag; expect live tests explicitly skipped and offline gates PASS, not a live-success claim.
- [ ] Complete configuration, synthesize/diff and prepare deployment instructions; obtain missing authorization for the concrete isolated target, then deploy and execute real tests. Document external membership/verification services and budgets; do not substitute accepting fakes in a deployed release profile.
- [ ] Run all P1/P2 offline suites, root checks and authorized live suites; record commands/environment/results in release evidence ledger. P2 exits only with real AWS evidence; missing environment remains an open gate.
- [ ] Commit: `test: prove AWS document evidence vertical slice`.

## Self-review and handoff

All upload/version/API/persistence/outbox goals have tasks and live gates. Download URLs have a bounded expiry and revocation window to be specified by P3; URL issuance is not proof of reading. P3 adds destructive operations and external submission, P4 processing, P5 search, P6 runtime assembly. Follow the master waves; review this plan with the full set before execution.

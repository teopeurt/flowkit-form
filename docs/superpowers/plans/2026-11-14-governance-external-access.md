# Governance and External Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce purpose-scoped external submission/access, retention, legal holds and complete, observable deletion across originals and derived artifacts.

**Architecture:** Portable grant and cleanup services extend P1; AWS adapters serialize lifecycle changes against real storage operations. All asynchronous integrations register possible artifacts before writes and participate in cleanup reconciliation. External callers get narrowly scoped capabilities, never ordinary tenant listing access.

**Tech Stack:** TypeScript/Bun, DynamoDB conditional transactions, S3 version-level retention/legal holds, SQS cleanup workers, existing API and CDK packages from P2.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [master waves](2026-11-14-release-waves.md). Requires P1 and P2; provider registration hooks are consumed by P4–P6.

## Global Constraints

- “External upload grants are tenant- and purpose-scoped and do not grant broad document listing or retrieval.”
- “Retention and legal holds apply to originals, versions, derived content, and indexes.”
- “legal holds block destruction.”
- “Pending or failed cleanup remains visible and retryable.”
- Retention duration and hold authority are consumer configuration; no universal compliance duration is invented.
- Credentials, external capability tokens and document contents must not appear in logs or durable events.

## Review Focus

- Two simultaneous consumers reuse a single-use external token: reserve its use atomically (Task 1).
- Revoked external capability still has an issued URL: state its exact expiry bound and block new URLs immediately (Task 1).
- Hold acceptance races an irreversible deletion: return pending until prior destruction is known complete (Task 2).
- Timed-out provider writes return late: durable obligations remain until reconciled (Task 3).
- Restore/replay recreates deleted artifacts: tombstones and generation checks survive restore/rebuild (Task 4 and P7).

## Storage protection and ordering decision

Use a pending/active hold state plus durable per-document destructive permits. P1 CAS alone cannot cancel an S3 request already in flight. A pending hold blocks issuance of new destructive permits; an existing permit must settle or be reconciled before acknowledging the hold active. Never infer cancellation from a lease timeout. Hold application also blocks new publication until protected output can be registered. Completed destruction before hold acceptance cannot be undone; report this ordering explicitly.

On S3, apply protections to exact object versions, not keys/delete markers. Object Lock supports retention/legal holds at the version level and requires versioning; it does not prohibit creating other versions. [Official Object Lock behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html). Provision Object Lock capability in the content/artifact bucket for this milestone; deployment config chooses retention mode, with no default retention imposed. Prove required mode behavior in the test account before selecting production policy; ordinary worker roles cannot bypass governance retention. Metadata/history remain protected by the lifecycle service and restricted IAM, with backups governed by P7.

### Task 1: Purpose-scoped external grants

**Files:** Create `packages/documents/src/external-grants.ts`, `packages/documents-aws/src/dynamodb/external-grant-store.ts`, `apps/document-api/src/routes/external.ts`, `test/documents/external-grants.test.ts`, `test/document-api/external.test.ts`; update exports, OpenAPI and CDK.

**Interfaces:** `ExternalGrant = { id: string; ref: DocumentRef; purpose: string; operation: 'upload' | 'download'; versionId?: string; expiresAt: string; maxUses: number; used: number; revokedAt?: string }`; `ExternalGrantService.issue(context, input: Omit<ExternalGrant,'id'|'used'|'revokedAt'>): Promise<{ grant: ExternalGrant; token: string }>`; `redeem({ token, redemptionId }): Promise<{ uploadIntent?: UploadIntent; download?: { url: string; expiresAt: string } }>`; `revoke(context, grantId): Promise<CommitReceipt>`. GrantStore persists digest, reservation/redemption receipts and grant state atomically with audit/outbox. Redemption retries with the same ID return the same logical reservation; a different ID cannot reuse a spent grant. Reservation finalization survives a crash before URL signing.

- [ ] Test expired/wrong-purpose/revoked tokens, concurrent maxUses=1, cross-tenant grant management, upload token cannot download/list, specific-version download only, retry after sign failure, and logs/URLs not leaking token digests. Revocation must prevent new signed access on the next request.
- [ ] Run `bun test test/documents/external-grants.test.ts test/document-api/external.test.ts`; expect missing-service failures.
- [ ] Implement opaque cryptographically random capability tokens stored only by keyed digest; compare digests safely. Issuance requires current `share` plus permission for the granted operation. Each redemption rechecks lifecycle and current issuer authority; revoked issuer permissions invalidate future redemption. Bind upload to preselected document/purpose and run ordinary verification. Audit the external capability subject separately from its issuer, so external submission is not misattributed to the issuing staff member. Register POST `/v1/documents/{id}/external-grants`, DELETE `/v1/external-grants/{id}`, POST `/v1/external/redemptions`; redact Authorization headers and capability bodies. Authenticated grant management and unauthenticated capability redemption are distinct routes.
- [ ] Run focused tests and OpenAPI checks. Add `downloadUrlTtlSeconds` required deployment config with default proposal 60 seconds and hard maximum 300; effective URL expiry is min(grant expiry, configured TTL, signer credentials). Document existing URLs may work until expiry: strict immediate content revocation requires a separately chosen proxy mode. Do not promise revocation of already downloaded bytes.
- [ ] Commit: `feat: scope external evidence grants and redemption`.

### Task 2: Retention and hold state machine with destructive permits

**Files:** Extend `packages/documents/src/lifecycle.ts`; create `packages/documents-aws/src/governance/{protections,destruction-permits}.ts`, `apps/document-api/src/routes/governance.ts`, `test/documents/hold-ordering.test.ts`, `test/aws-documents/holds.integration.test.ts`; update model, config, API schema and CDK.

**Interfaces:** `requestHold(context, { ref, holdId, active }): Promise<{ status: 'pending' | 'active' | 'released'; operationId: string }>`; `authorizeDestruction(context, { ref, artifact, expectedGeneration }): Promise<DestructionPermit>`; `settleDestruction(permitId, outcome: 'deleted' | 'not_deleted' | 'unknown'): Promise<void>`; `applyProtections(ref): Promise<void>`. `DestructionPermit = { id: string; ref: DocumentRef; artifact: ArtifactRef; generation: number; status: 'in_flight' | 'settled' | 'unknown' }`. Only cleanup service identity can acquire/settle permits. P1 `setHold` is the atomic internal activation step after provider protections, not an HTTP promise of immediate activation.

- [ ] Test both race orders for pending hold vs permit, timeout leaves unknown permit and pending hold, provider-protection failure does not activate, retention extension never shortens, releasing one of several holds leaves protection, and output produced while hold is pending cannot escape tracking. Test unprivileged caller cannot release hold or acquire permit.
- [ ] Run `bun test test/documents/hold-ordering.test.ts`; expect missing permit/state-machine failures.
- [ ] Implement pending hold transaction, per-document CAS permit exclusion and provider version protections. Acknowledge active only after all earlier permits resolve and all retained object versions are protected; return 202 while pending. API routes: PUT `/v1/documents/{id}/retention`, PUT/DELETE `/v1/documents/{id}/holds/{holdId}`, GET `/v1/documents/{id}/holds`. `hold.manage` controls holds; `retention.manage` is added as a distinct explicit permission in P1 access model with default deny. Shortening retention remains unsupported (409). Storage lifecycle policies must not independently delete protected content.
- [ ] Run focused suite and authorized live hold suite. Attempt version-specific DeleteObject with worker credentials while active hold/retention applies; assert denial and pending status after simulated ambiguous provider outcome. Record the hold linearization point.
- [ ] Commit: `feat: serialize legal holds against provider destruction`.

### Task 3: Complete cleanup inventory and deletion worker

**Files:** Create `packages/documents/src/cleanup.ts`, `packages/documents-aws/src/governance/{cleanup-registry,deletion-worker}.ts`, `apps/document-api/src/workers/deletion.ts`, `apps/document-api/src/routes/deletion.ts`, `test/documents/deletion.test.ts`, `test/aws-documents/deletion.integration.test.ts`; update exports/CDK/OpenAPI.

**Interfaces:** `CleanupRegistry.register({ ref, lifecycleGeneration, owner, obligationId, artifact? }): Promise<void>`; `acknowledge(obligationId): Promise<void>`; `pending(ref, cursor?): Promise<Page<CleanupObligation>>`. `CleanupObligation = { id: string; ref: DocumentRef; owner: string; artifact?: ArtifactRef; status: 'pending' | 'running' | 'unknown' | 'failed' | 'complete'; errorCode?: string }`. `CleanupProvider = { owner: string; reconcile(ref): Promise<readonly CleanupObligation[]>; destroy(obligation, permit): Promise<'complete' | 'unknown'> }`. `DeletionService.request(context, ref): Promise<{ deletionId: string; status: string }>` and `get(scope, deletionId): Promise<DeletionStatus>`. Provider owner names: `s3`, `metadata`, `uploads`, `processing`, `search`, `flowkit`; missing required provider blocks completion rather than skipping it.

- [ ] Test hidden/noncurrent S3 generations, incomplete multipart uploads, metadata snapshots, quarantine, retained audit sensitive values, still-running OCR provider and stale callback artifact. Verify register-before-write, incomplete provider reconciliation and partial failures prevent completion; paginated inventory cannot omit trailing pages.
- [ ] Run `bun test test/documents/deletion.test.ts`; expect missing cleanup failures.
- [ ] Implement durable deletion operation advancing generation and disabling discovery/new grants/publication. Inventory every storage version/upload and external job/artifact by durable references. Acquire Task 2 permit before each irreversible deletion. Unknown calls require reconciliation; late artifacts register cleanup even for tombstoned documents. Complete only when providers confirm inventories empty and no unresolved publication/destruction operations remain. Remove sensitive metadata/history; keep minimal actor/operation/reference tombstones and sanitize audit changes by construction. API DELETE `/v1/documents/{id}` returns 202 plus operation URL; GET `/v1/deletions/{id}` returns progress/errors.
- [ ] Run focused and authorized live suites; crash between inventory pages and between delete/ack, retry and prove no object version remains. Do not delete backups independently of P7 policy; report recovery-copy obligations accurately.
- [ ] Commit: `feat: reconcile document deletion across artifact owners`.

### Task 4: Cross-module cleanup contracts and governance acceptance

**Files:** Create `test/documents/cleanup-provider.contract.ts`, `test/aws-documents/governance-races.integration.test.ts`, `docs/operations/document-governance.md`; update `docs/api/flowkitform.openapi.yaml` and evidence ledger.

**Interfaces:** `cleanupProviderContract(createProvider)` exercises register/reconcile/destroy/retry and lifecycle generation rejection; P4/P5/P6 instantiate it for their providers. Fake providers prove orchestration; live providers are mandatory at final assembly.

- [ ] Write tests racing deletion with upload completion, OCR callbacks, search indexing/rebuild and event replay. Require old work to fail publication or leave a visible cleanup obligation, never resurrect content. Include exact historical metadata reads denied after permission revocation and after deletion.
- [ ] Run `bun test test/documents/`; newly introduced cleanup contract cases fail before providers implement them.
- [ ] Implement missing orchestration hooks and document retention start point (`createdAt` plus consumer policy), hold authority, pending/active status, partial deletion, provider outage, capability URL window and backup/restore tombstone rules. Consumer disposition approval is optional workflow policy and cannot bypass hold checks.
- [ ] Run P1–P3 offline checks plus real governance races against available providers; rerun full provider matrix when P4–P6 land. Mark integration gate open until every required provider has real acceptance evidence.
- [ ] Commit: `test: validate governance races and document lifecycle operations`.

## Self-review and handoff

External permission scope, hold/destruction ordering, original/derived cleanup and eventual replay are all owned above. Production retention mode, backup expiry and external grant purpose vocabulary are deployment/consumer inputs, not inferred legal policy. Follow master waves; P3 cannot claim complete integration while later provider cleanup remains a fake.

# Portable Document Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a portable, executable document foundation proving evidence identity, historical metadata, authorization and lifecycle safety before implementing AWS and Cloudflare adapters.

**Architecture:** Add an independent document package with application services and provider-neutral persistence contracts. An in-memory reference adapter exercises transaction and concurrency semantics; it is test infrastructure, not production persistence. Existing demo domain, PostgreSQL repositories and FlowKit composition retain their responsibilities.

**Tech Stack:** TypeScript, Bun test, existing workspace compilation; no new runtime libraries for this milestone.

**Spec:** `docs/superpowers/specs/2026-11-14-flowkitform-design.md` (approved 2026-11-14).

## Global Constraints

- “Avoid AWS-specific types in portable contracts”.
- “Existing packages must retain their current responsibilities.”
- “Workflow role or task eligibility alone does not confer document access”.
- “Mutations commit state and durable audit/event intent together.”
- “An approval of version A must never implicitly approve replacement B.”
- “legal holds block destruction.”
- “First-class OCR is required”; this milestone establishes source identity and fencing, not OCR implementation.
- Use public FlowKit exports only; do not modify framework code, run migrations, deploy services or create UI.
- This is milestone 1, not the complete release. The full release is mapped in [the master waves](2026-11-14-release-waves.md) and six accompanying subsystem plans.

## Review Focus

- Reused operation ID with a different request must conflict rather than return an unrelated prior success (Task 2).
- Guessed document IDs and forged tenant context must not reveal another tenant's evidence (Tasks 2–3).
- Competing metadata updates must preserve history and reject stale expected revisions (Task 4).
- Revoked grants must affect subsequent reads, including earlier metadata revisions (Tasks 3–4).
- A writer already in flight when deletion starts must not publish into the deleted lifecycle (Task 5).

## File structure and shared decisions

Create `packages/documents/package.json` as private `@flowkit-form/documents` with source exports matching existing workspace development, and emitted declarations under the existing `dist` build. Do not change existing package exports or rename demo packages. Add it to root dependencies using `workspace:*`; refresh the Bun lockfile with the installed Bun version, without upgrading unrelated dependencies.

Create these focused files under `packages/documents/src/`:

- `model.ts`: portable readonly value types and validation.
- `errors.ts`: `DocumentError` with stable codes and safe messages.
- `persistence.ts`: atomic compare-and-swap command boundary.
- `access.ts`: explicit document grants and current permission evaluation.
- `documents.ts`: metadata and immutable version application services.
- `lifecycle.ts`: retention, holds, deletion generations and publication leases.
- `index.ts`: public exports only.

Create `test/support/memory-document-store.ts` as a deterministic reference implementation. Tests live under `test/documents/`; root `bun run test` already includes them. Avoid importing demo domain/database into the new package.

Portable types use strings for IDs and ISO timestamps, numbers for bounded revisions/generations, and JSON-compatible metadata. `Scope = { tenantId: string; actorId: string; groupIds: readonly string[] }` is trusted input from an authentication adapter, never accepted directly from an HTTP body. `CommandContext` adds `operationId`, `correlationId`, and `now`. No SDK types, streams or binary payloads cross persistence boundaries.

`DocumentRef = { tenantId: string; documentId: string }`.
`ArtifactRef = { store: string; objectId: string; generation: string }` identifies immutable bytes.
`VerifiedContent = { artifact: ArtifactRef; checksum: { algorithm: 'sha256'; value: string }; mediaType: string; size: number; verificationId: string }` is trusted verifier output. Never expose a public API accepting it as proof of verification.
`Version = { id: string; content: VerifiedContent; createdAt: string; createdBy: string }`.
`Metadata = { title: string; type?: string; tags: readonly string[]; custom: JsonObject; issuer?: string; expiresAt?: string; associations: readonly { type: string; id: string }[] }`.
`MetadataRevision = { revision: number; values: Metadata; createdAt: string; createdBy: string }`.
`DocumentState` is a bounded head containing `ref`, `aggregateRevision`, `lifecycleGeneration`, status (`active | deleting | deleted`), current metadata/version IDs, bounded current grants/holds, retention and counters for outstanding publication/cleanup operations. Immutable versions/metadata, individual leases and cleanup obligations are separate paged rows, never arrays of complete history in the head. `JsonObject` is recursively string-keyed JSON, excluding undefined/nonfinite numbers and executable values. `CommandContext = Scope & { operationId: string; correlationId: string; now: string }`.

Planner limits for this milestone: metadata up to 64 KiB UTF-8 JSON, at most 16 current grants and 16 current holds, each command at most 64 persistence actions and 2 MiB encoded total. Reject excess explicitly; these implementation bounds are not claimed user scale requirements. Collections such as versions, attempts, leases and cleanup obligations remain unbounded across paginated rows, not within one command. The AWS adapter must preflight its encoded transaction as well.

### Task 1: Package and validated evidence values

**Files:** Create package manifest, `model.ts`, `errors.ts`, `index.ts`; modify root `package.json` and Bun lockfile; create `test/documents/model.test.ts`.

**Interfaces:** Produces `parseMetadata(input: unknown): Metadata`, `parseVerifiedContent(input: unknown): VerifiedContent`, and the types above. `DocumentError.code` is one of `invalid_input | not_found | forbidden | conflict | held | retained | stale_lifecycle`.

- [ ] Write `model.test.ts`: reject empty tenant/object/generation IDs, negative or non-finite sizes, malformed SHA-256 and timestamps, and non-JSON custom values; accept zero-byte verified content, optional issuer/expiry and consumer record associations. Assert mutations to caller-owned arrays/objects cannot alter parsed snapshots.
- [ ] Run `bun test test/documents/model.test.ts`; confirm failure comes from missing document exports.
- [ ] Implement the package and value parsers; defensively copy and freeze accepted values. Accept only nonnegative safe integer sizes/revisions and canonical SHA-256 hex. Do not infer MIME trust from filenames.
- [ ] Run the focused test, `bun run typecheck`, and `bun run build`; expect exit 0 and generated document declarations. Verify no unrelated dependency upgrades in the lockfile diff.
- [ ] Commit the task files with `feat: define portable document evidence values`.

### Task 2: Atomic state, operation receipts, audit and outbox contracts

**Files:** Create `persistence.ts`, memory reference adapter and `test/documents/persistence.contract.test.ts`; update `index.ts`.

**Interfaces:** Produces `DocumentStore.read(ref: DocumentRef): Promise<DocumentState | null>`, `readVersion(ref, versionId): Promise<Version | null>`, `readMetadataRevision(ref, revision): Promise<MetadataRevision | null>`, `rows(ref, kind, cursor?, limit?): Promise<{ items: readonly DocumentRow[]; nextCursor: string | null }>`, and `commit(input: CommitInput): Promise<CommitReceipt>`. `kind` is `version | metadata | lease | cleanup | audit | outbox`; `DocumentRow` is the corresponding discriminated row union. Raw store reads are internal trusted primitives; exported application reads enforce current permissions.
`CommitInput` contains scope, operationId, canonical request fingerprint, expected aggregate revision (`null` for create), bounded replacement head, append-only version/metadata rows, lease/cleanup row changes, audit records and outbox events. Mutation rows are typed by DocumentRow; no full history rewrite or arbitrary tenant row mutation is allowed. `CommitReceipt` contains operationId and resulting aggregate revision. Audit includes actor, tenant, target version/revision, timestamp and correlation/operation IDs. Outbox envelopes include schemaVersion `1`, stable event ID, tenant, document ID, generation and references only. Receipt uniqueness is `(tenantId, actorId, operationId)`; same ID with changed fingerprint conflicts. Failed optimistic writes commit nothing. Retried identical writes return the receipt without repeating effects.

- [ ] Write a reusable `documentStoreContract(createStore)` suite asserting atomic success, injected failure leaves no state/audit/outbox/receipt, conflicting expected revision loses atomically, duplicate command produces one receipt/event, changed payload conflicts, and the same IDs in two tenants remain isolated. Assert reads return copies, a command scope/ref tenant mismatch is rejected, a second history page is accessible, and head size/transaction write count do not grow with existing history.
- [ ] Run `bun test test/documents/persistence.contract.test.ts`; expect missing-contract failures.
- [ ] Implement interfaces and memory adapter with an atomic synchronous compare-and-swap section; add a failure injection seam for tests. Keep receipts and events separate from document-sensitive history so deletion can sanitize history later. Canonical fingerprint serialization must sort object keys while preserving arrays.
- [ ] Run the contract suite; expect all cases to pass. Export runner-neutral scenario bodies with Bun registration wrappers for later DynamoDB and D1/workerd conformance without importing the reference adapter in production.
- [ ] Commit with `feat: define atomic document persistence contract`.

### Task 3: Current document permissions

**Files:** Create `access.ts` and `test/documents/access.test.ts`; update model and exports.

**Interfaces:** `DocumentPermission = 'discover' | 'metadata.read' | 'content.read' | 'version.create' | 'metadata.write' | 'share' | 'delete' | 'hold.manage' | 'retention.manage' | 'processing.start' | 'review.start'`.
`Grant = { id: string; subject: { kind: 'principal' | 'group'; id: string }; permissions: readonly DocumentPermission[] }`.
Produces `authorize(scope: Scope, state: DocumentState | null, permission: DocumentPermission): void` and `changeGrants(store: DocumentStore, context: CommandContext, input: { ref: DocumentRef; expectedRevision: number; grants: readonly Grant[] }): Promise<CommitReceipt>`.

- [ ] Write tests asserting absent/cross-tenant states return the same `not_found`, same-tenant missing permissions fail, explicit principal/group grants work, unrelated workflow roles give no access, grant edits require `share`, granting a permission the sharer lacks is denied, and removal affects the next read without caching. Every grant mutation must produce one audit record and outbox intent.
- [ ] Run `bun test test/documents/access.test.ts`; confirm expected missing-export failures.
- [ ] Implement default-deny evaluation and transactional grant replacement. `share` permits delegation only of permissions the caller currently holds; it does not allow self-escalation. Consumer-configured privileged service grants are provisioned through trusted assembly, not the ordinary sharing API. Group IDs come only from trusted identity resolution. Use current stored grants; never use workflow eligibility or historical grants as substitutes.
- [ ] Run access and persistence suites; expect all assertions to pass.
- [ ] Commit with `feat: enforce independent document permissions`.

### Task 4: Immutable content and metadata history services

**Files:** Create `documents.ts`, `test/documents/documents.test.ts`; update exports.

**Interfaces:** Produces `createDocument(store, context, input: { documentId: string; metadata: Metadata }): Promise<CommitReceipt>`; `appendVersion(store, context, input: { ref: DocumentRef; expectedRevision: number; versionId: string; verified: VerifiedContent; lifecycleGeneration: number }): Promise<CommitReceipt>`; `reviseMetadata(store, context, input: { ref: DocumentRef; expectedRevision: number; metadata: Metadata }): Promise<CommitReceipt>`; `readMetadata(store, scope, ref, revision?: number): Promise<MetadataRevision>`; `readVersion(store, scope, ref, versionId): Promise<Version>`.
All unannotated leading parameters are `DocumentStore`, `CommandContext`, `Scope`, or `DocumentRef` as named above. Create installs an explicit creator grant for discover, metadata.read, content.read, version.create, metadata.write, share, delete, processing.start and review.start; hold.manage/retention.manage require consumer-configured privileged grants. Production identity adapters must separately authorize tenant-level document creation.

- [ ] Write tests for create, exact-version reads, duplicate append, replacement preserving old checksum/artifact, monotonically increasing metadata revisions, stale-update conflict and historical values after edits. Revoke access then assert historical reads fail. Assert creation and every successful mutation append atomic audit/outbox intent, metadata values never enter event payloads, and identical operation retries do not duplicate versions.
- [ ] Run `bun test test/documents/documents.test.ts`; confirm failure for missing services.
- [ ] Implement services with injected IDs/time and compare-and-swap. Application reads authorize a fresh bounded head before reading the requested immutable row. Authorization runs before returning a stored retry result. Reject reuse of a version ID with different immutable content. `appendVersion` only accepts verifier output within trusted application composition; Provider upload verification is implemented through P0/P2/CF1 later.
- [ ] Run all `test/documents/` tests and `bun run typecheck`; expect exit 0.
- [ ] Commit with `feat: preserve document versions and metadata history`.

### Task 5: Retention, holds and fenced publication/deletion

**Files:** Create `lifecycle.ts`, `test/documents/lifecycle.test.ts`; modify services/model/exports.

**Interfaces:** Produce `setRetention(store, context, { ref, expectedRevision, retainUntil }): Promise<CommitReceipt>` and `setHold(store, context, { ref, expectedRevision, holdId, active }): Promise<CommitReceipt>` using typed input objects (`retainUntil: string`, `holdId: string`, `active: boolean`). Produce `beginDeletion(store, context, { ref, expectedRevision }): Promise<CommitReceipt>`; `acquirePublication(store, context, { ref, expectedRevision, leaseId, lifecycleGeneration }): Promise<CommitReceipt>`; `finishPublication(store, context, { ref, expectedRevision, leaseId, lifecycleGeneration, artifact }): Promise<CommitReceipt>`; and `completeDeletion(store, context, { ref, expectedRevision, reconciled }): Promise<CommitReceipt>`. IDs are strings, revisions/generations numbers, artifact is `ArtifactRef`, and `reconciled` is a readonly list of cleanup obligation IDs acknowledged by a trusted cleanup adapter. State tracks obligation IDs and references before destructive work starts. Processing status is deliberately left to the processing milestone.

- [ ] Write tests: unexpired retention/active holds block deletion; holds and destructive-step authorization share aggregate CAS; deletion increments generation and keeps tombstone; old-generation append/publication fails; outstanding leases prevent completion; late artifacts become cleanup obligations; completion waits for every known obligation; retry does not duplicate cleanup; metadata/content values are absent from tombstones and retained event payloads.
- [ ] Run `bun test test/documents/lifecycle.test.ts`; confirm failure for missing lifecycle operations.
- [ ] Implement serialized lifecycle transitions. Publication lease acquisition durably registers possible output before object creation. Finish after deletion records cleanup without exposing content. Hold changes require `hold.manage`; retention changes require `retention.manage`; deletion requires `delete`. P3 adds pending provider protection and destruction permits before these transitions are exposed as production HTTP operations. Retention may only be extended in this milestone; shortening needs a separately specified administrative policy. Cleanup acknowledgment is not a public client capability. Completed deletion strips sensitive state while retaining minimal IDs/generation/receipts required for replay rejection. Fence authorization is a prerequisite for each cleanup step; a future provider adapter must prove that its destructive operations cannot race an accepted hold.
- [ ] Run `bun test test/documents/`, then root `bun run typecheck`, `bun run test`, `bun run build`; expect exit 0. Record pre-existing failures separately and investigate new failures before claiming completion. Do not start the disposable integration stack or migrate databases as part of this milestone.
- [ ] Commit with `feat: fence document publication and deletion lifecycle`.

## Companion plans and later milestone gates

The complete execution sequence is in [release waves](2026-11-14-release-waves.md). [P0 shared contracts/API](2026-11-14-shared-provider-contracts.md) follows P1 before either provider slice. Cloudflare plans: [CF1 evidence](2026-11-14-cloudflare-document-slice.md), [CF2 governance](2026-11-14-cloudflare-governance.md), [CF3 processing/search/FlowKit](2026-11-14-cloudflare-processing-search-flowkit.md), [CF4 operations](2026-11-14-cloudflare-release-operations.md). Companion implementation plans: [AWS slice](2026-11-14-aws-document-slice.md), [governance](2026-11-14-governance-external-access.md), [processing/OCR](2026-11-14-processing-ocr.md), [search](2026-11-14-authorized-search.md), [FlowKit](2026-11-14-flowkit-integration.md), and [release operations](2026-11-14-aws-release-operations.md).

These are roadmap gates, not permission to implement unspecified later subsystems.

| Milestone | Required planning input | Integration evidence required before completion |
| --- | --- | --- |
| AWS upload slice | Verify official S3 immutable version/checksum/multipart behavior, DynamoDB transaction limits and read consistency, SQS semantics, Lambda/API Gateway limits; choose IaC and identity adapter; write bounded item/access patterns and deployment budgets | Replayed signed upload cannot change published bytes; completion races bind one generation; real DynamoDB atomicity; tenant isolation; abandoned multipart cleanup; version download and audit API |
| Governance/external access | Define grant purpose/expiry/use limits and download URL revocation window; settle provider-level hold/destruction serialization and backup retention boundaries | Expired/consumed grants fail, holds stop subsequent destructive steps, late writers/providers cannot resurrect deleted content, all storage generations cleaned |
| Processing | Evaluate pdf-inspector and Unlimited-OCR without adopting or executing model code by default; obtain representative evaluation inputs and approved hosting choice | Native/scanned/mixed PDFs, images, whole-document mode, page failures, bounded rendering, capability negotiation, async callbacks, history/provenance, stale/deleted results cleanup |
| Search | Select AWS serverless engine after verifying region availability, pricing and limits in official docs; decide bounded candidate scanning and omit totals/facets unless securely computable | Revocation before index refresh hides hits/snippets/counts/facets and later pages; cross-tenant cursors fail; out-of-order index events and rebuild preserve lifecycle fences |
| FlowKit | Inspect installed public `FlowRuntime`/`FlowkitConsumer` contracts; explicitly inventory existing runtime/PostgreSQL/auth dependencies and provision outside the document functions | Supported runtime reviews exact version and metadata revision; authorized service grants; duplicate/out-of-order events; runtime outage leaves stored evidence intact; approval never transfers to a replacement |
| Release operations | Record region, identity integration, quotas, availability/cost, capacity, recovery objectives and OCR/search selections with official sources during that milestone's planning | Real assembled AWS and Cloudflare + FlowKit acceptance, least privilege, encryption, DLQ/replay/reindex, queue/search lag alerts, restore exercise and measured budgets |

The companion plans select CDK and OpenSearch Serverless as planner choices and cite verified AWS constraints. The approved amendment adds D1/R2/Queues/Workers/FTS5. This foundation remains provider-neutral; account-specific limits, region, budgets and engine adoption remain explicit gates. GCP and Azure must reuse the portable contract suite in their own phases.

## Self-review and handoff

The five review findings map to Tasks 3–5 and the search/AWS integration gates. All five Review Focus conditions have owning task tests. Exact content and metadata references are implemented here; OCR, search, external grants, transport APIs, AWS infrastructure and FlowKit assembly remain explicit later deliverables, not claimed foundation functionality. Documentation reconciliation is complete before this plan; approval of the design did not approve implementation method.

Review this plan as part of the full plan set before execution. Native execution is recommended for its tightly related tasks; subagent-driven execution is available if independent per-task review is preferred. Execute later milestones through their companion plans and the master wave gates; foundation completion is not release completion.

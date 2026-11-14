# Authorized Metadata and Full-Text Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver metadata and extracted-text search that never exposes currently unauthorized document information, with safe pagination and rebuildable indexing.

**Architecture:** Portable search services query candidate references and then apply authoritative document access checks before materializing metadata/snippets. A fenced indexing coordinator writes one canonical latest source representation and keeps durable work/cleanup receipts. AWS uses an OpenSearch Serverless SEARCH collection behind its adapter; this is a planner selection subject to regional/cost preflight.

**Tech Stack:** TypeScript/Bun, `@flowkit-form/document-search`, OpenSearch client with AWS SigV4, DynamoDB/SQS coordinators, existing document API and CDK deployment.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [master waves](2026-11-14-release-waves.md). Shared query/materializer/rebuild contracts depend on P1/P0; AWS adapter depends on P2. CF3 Task 2 supplies Cloudflare FTS5. Full text consumes P4 artifacts and cleanup consumes P3.

## Parallel-provider ownership

This plan implements shared services first and the AWS provider portion second.
The [approved Cloudflare amendment](../specs/2026-11-14-cloudflare-alternative-design.md)
and [master waves](2026-11-14-release-waves.md) apply to every task. Commit and
verify portable outputs before AWS adapters so Cloudflare can consume them
without waiting for AWS implementation or deployment. The shared API/identity,
upload/artifact/reader/delivery and runner-neutral test boundaries belong to
[P0](2026-11-14-shared-provider-contracts.md). Do not recreate them in this plan.

## Global Constraints

- “An indexed permission is only a candidate filter”.
- “Permission revocation must take effect for subsequent search requests without waiting for reindexing”.
- “Counts, facets, and aggregations must use the same authorized set or be omitted”.
- “Indexes must be rebuildable from stored documents and extraction results.”
- No arbitrary caller-supplied query DSL, provider endpoints or direct collection access.
- Do not interpret result pagination or omitted totals as proof that unauthorized candidate counts are safe to expose.

## Review Focus

- Stale indexed ACL still matches after revocation: authoritative check suppresses all returned information (Task 2).
- Scores/counts/snippets reveal a denied candidate: omit totals/facets/scores and materialize only authorized records (Task 2).
- Cursor copied across tenants/users/queries: reject without exposing internal offsets or keys (Task 2).
- Old extraction/index event overwrites newer data or follows deletion: serialize registered publication and reconcile canonical state (Task 3).
- Rebuild swaps to an incomplete or resurrected index: checkpoint, catch up, validate and switch epoch atomically (Task 4).

## AWS selection and known limits

OpenSearch Serverless supports a subset of OpenSearch APIs; verify needed collection-generation features, `search_after`, PIT, index operations and permissions in the chosen region before implementation. Avoid `scroll` dependence. [Supported operations](https://docs.aws.amazon.com/en_gb/opensearch-service/latest/developerguide/serverless-genref.html), [client integration](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-clients.html).
Deployment region must be checked against the Serverless endpoint table, not merely managed-domain availability. [Endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html). Record monthly baseline indexing/search/storage and budget alarms using current regional rates; no assumption of free idle capacity or scale-to-zero cost. [Pricing](https://aws.amazon.com/opensearch-service/pricing/), [capacity configuration](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-scaling.html). These verified documents inform the selection; actual account/region/capacity cost remains a deployment gate.

### Task 1: Portable query and candidate index contract

**Files:** Create `packages/document-search/package.json`, `packages/document-search/src/{contracts,query,index}.ts`, `test/document-search/query.test.ts`; update root manifests/lockfile.

**Interfaces:** `SearchQuery = { text?: string; filters?: { type?: string; tags?: readonly string[]; issuer?: string; expiresBefore?: string; association?: { type: string; id: string } }; sort: 'updated_desc' | 'created_desc'; pageSize: number; cursor?: string }`. `SearchIndex.candidates({ tenantId, query, after?, limit, epoch }): Promise<{ refs: readonly SearchCandidate[]; after: string | null }>`; candidate contains DocumentRef, sourceVersionId, metadataRevision, lifecycleGeneration, extractionRunId? and opaque internal sort token, no client-visible snippet. `upsert(snapshot: IndexedSnapshot): Promise<void>` and `remove(ref, epoch): Promise<void>` are coordinator-only. `IndexedSnapshot` contains canonical source versions, tenant/ref/generation/revisions, searchable metadata, normalized text and provenance; engine-specific mapping stays in the respective provider package.

- [ ] Test empty query allowed for authorized listing, unknown filters rejected, custom query DSL rejected, malformed dates, escaped literal text, max page size and stable unique tie-breaker ordering. Use pageSize default 25 and maximum 100 as planner defaults, configurable only downward for API safety.
- [ ] Run `bun test test/document-search/query.test.ts`; expect missing query parser.
- [ ] Implement validation and typed index interfaces with an in-memory candidate fake in `test/support/memory-search-index.ts`. Initially support explicit typed metadata filters, not arbitrary unindexed custom keys. Treat expiry as consumer metadata, not an automatic approval/deletion decision.
- [ ] Run focused tests and root typecheck/build; expect PASS and no AWS imports in portable package.
- [ ] Commit: `feat: define portable document search contracts`.

### Task 2: Current authorization, safe result materialization and cursors

**Files:** Create `packages/document-search/src/service.ts`, `apps/document-api/src/routes/search.ts`, `test/document-search/authorization.test.ts`, `test/document-api/search.test.ts`; update API dependencies/OpenAPI.

**Interfaces:** `SearchService.search(scope: Scope, query: SearchQuery): Promise<{ items: readonly SearchHit[]; nextCursor: string | null }>`; `SearchHit` has documentId, authorized metadata and optional snippet/provenance. It has no score, raw total, facet or provider offset. Consume P0 CursorCodec; bind cursor to deployment, tenant, actor, normalized query hash, sort, epoch and expiry. `SearchMaterializer.load(scope, candidate, includeText): Promise<SearchHit | null>` checks current state and metadata/content permissions from base persistence, reads exact canonical text artifact through authorized storage, and verifies lifecycle/source revisions. `discover` plus `metadata.read` required for a hit; text matches/snippets additionally require `content.read`.

- [ ] Test stale ACL after revocation, missing content permission for a text query, authorization-store outage fails closed, hidden/removed documents yield no IDs/snippets/scores/counts/facets, cursor reuse after revocation and cross-tenant/user/query misuse, sparse authorized results, and changed metadata revision suppresses stale materialization. Assert response never serializes internal candidate count or denied fields.
- [ ] Run `bun test test/document-search/authorization.test.ts test/document-api/search.test.ts`; expect missing-service failures.
- [ ] Implement bounded candidate scanning in fixed batches (planner defaults: 100 candidates/batch, at most 10 batches/request). Empty authorized page may include a next cursor so caller can continue; never include scanned counts. Short-circuit denied content candidates without snippet extraction. Persist only encrypted internal scan position in cursor, reauthorize each page and every materialized hit. Return only metadata authorized at request time; mutations concurrent after the authorization linearization point are not retroactive revocation of already returned data. Register POST `/v1/search`, no unrestricted listing bypass.
- [ ] Run focused tests and OpenAPI route checks; expect PASS. Record that index updates are eventually consistent and cursors can expire/restart; no exact completeness across concurrent content changes is promised.
- [ ] Commit: `feat: authorize every document search response`.

### Task 3: AWS index adapter and fenced indexing coordinator

**Files:** Create `packages/document-search/src/{index-coordinator,index-work-store}.ts` for shared contracts/orchestration, `packages/documents-aws/src/search/{opensearch,index-coordinator,index-work-store,cleanup}.ts` for AWS implementation, `apps/document-api/src/workers/indexing.ts`, `deploy/aws/src/search-resources.ts`, `test/document-search/indexing.test.ts`, `test/aws-documents/search.integration.test.ts`; update CDK/exports/config.

**Interfaces:** `createOpenSearchIndex(config): SearchIndex` uses signed AWS requests and collection/index allowlist. `IndexCoordinator.refresh(event: EventEnvelope): Promise<void>` consumes metadata/version/extraction/grant/lifecycle events. `IndexWorkStore.claim(ref, eventId): Promise<IndexWorkLease>` / `settle(leaseId, outcome): Promise<void>` stores durable per-document exclusive publication state. Index document ID is encoded tenant+document, source fields pin canonical chosen version and extraction run. Latest successful extraction for the canonical current version is selected explicitly; older version text is not mixed into current search. Search across historical versions is deferred; exact-version retrieval remains available.

- [ ] Test duplicate/reordered metadata/extraction events, stale retry after deletion, crash before/after index write, unknown provider outcome, incomplete batch response, tenant routing collision, index refresh delay, and deletion waiting on an in-flight index write. Instantiate P3 cleanup provider contract with owner `search`.
- [ ] Run `bun test test/document-search/indexing.test.ts`; expect missing coordinator.
- [ ] Implement SEARCH collection, least-privilege data/network/encryption policies, explicit metadata mappings and capped text indexing from P4 artifacts. Serialize per-document writes using durable work lease; always load current source rather than copying event payload. Register publication/cleanup obligations before remote write. Do not release ambiguous leases based only on timeout; reconcile provider state first. Lifecycle changes invalidate pending publication; a late write is removed before cleanup acknowledgment. Read current lifecycle before each indexed publication and after provider completion; metadata/grant changes enqueue fresh refresh. Omit unsupported features rather than bypassing authorization.
- [ ] Run focused and authorized live AWS tests: prove stale ACL denial before reindex, real `search_after` paging, no public collection access and cleanup after delayed remote writes. Verify actual chosen collection operation support and record baseline pricing/capacity before deployment approval.
- [ ] Commit: `feat: index document metadata and extracted text in AWS`.

### Task 4: Rebuild, replay and assembled search acceptance

**Files:** Create `packages/document-search/src/rebuild.ts`, `packages/documents-aws/src/search/rebuild-store.ts`, `scripts/documents/reindex.ts`, `test/document-search/rebuild.test.ts`, `test/aws-documents/search-acceptance.integration.test.ts`, `docs/operations/document-search.md`; update root scripts and evidence.

**Interfaces:** `RebuildService.start(context): Promise<{ rebuildId: string; epoch: string }>`; `step(rebuildId): Promise<{ status: 'running' | 'validating' | 'complete' | 'failed'; checkpoint: string }>`; `activate(rebuildId): Promise<void>`. An authoritative `IndexCatalog` stores active epoch and rebuild checkpoint. Cursor epoch is immutable; retiring index invalidates its cursor with a safe restart error. Rebuild scans authoritative paged document refs via a service-only `DocumentInventory.page(tenantId, cursor): Promise<Page<DocumentRef>>`, defined by P0 and implemented by each provider, never a client bypass.

- [ ] Test restart between pages, mutation/deletion during scan, queued refresh catch-up, tombstone dominance over restored source, failed validation leaves active epoch unchanged, superseded extraction ignored and cursor epoch retirement. Acceptance includes native/OCR text queries across two tenants, expired evidence filter, record association filter and revocation during pagination.
- [ ] Run `bun test test/document-search/rebuild.test.ts`; expect missing rebuild service.
- [ ] Implement checkpointed new-epoch indexing, dual publication of new mutations while rebuilding, catch-up/high-water validation and atomic catalog switch. Serialize catalog activation against mutation-enqueue watermark so no source change falls between catch-up and switch. Deletion reconciliation checks every active/building/retiring epoch, not just current index. Rebuild requires operational service identity, fixed configured target and audit; no client-provided endpoints. Retire old epoch only after cursor TTL and no unresolved publication.
- [ ] Create shared cases in `test/support/document-conformance/search.ts`; run all search/offline checks, authorized AWS live acceptance and P3 race suite, with CF3 Task 4 running the same cases on Cloudflare; record search lag, denial correctness and restart/reindex evidence. Update runbook with no-total/facet behavior and bounded pagination contract.
- [ ] Commit: `feat: rebuild authorized search from durable evidence`.

## Self-review and handoff

Metadata/full-text query, current permission checks, safe aggregates by omission, cursor isolation, stale-event fencing and rebuild have owning tasks. SEARCH collection selection is justified by official docs but actual deployment cost/region remains an explicit preflight. Follow master waves; P5 exits only after real P4 artifacts and P3 cleanup participate in acceptance.

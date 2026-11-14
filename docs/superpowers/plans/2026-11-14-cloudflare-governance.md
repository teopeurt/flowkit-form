# Cloudflare Governance and External Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the shared external grant, retention/hold and complete deletion behavior on D1/R2 without weakening the AWS release contract.

**Architecture:** P3 owns portable governance services/routes and provider interfaces. CF2 implements those stores/protections/cleanup with tenant-scoped D1 transactions and R2 namespace lock rules. Per-bucket configuration serialization uses the same authoritative D1 shard as the bucket's resident tenants; no Durable Objects authority or cross-database document transaction is added.

**Tech Stack:** TypeScript/Bun, D1 SQL migrations, R2 bucket lock API, Workers private service bindings, Queues cleanup, Vitest Workers tests and shared live scenarios.

**Spec:** [Approved amendment](../specs/2026-11-14-cloudflare-alternative-design.md), [master waves](2026-11-14-release-waves.md). Depends on P1/P0, CF1 and P3 portable tasks; AWS-specific protection adapters are not prerequisites.

## Global Constraints

- “Accepted holds serialize against irreversible operations”.
- “Capacity exhaustion cannot downgrade protection”.
- “R2 locks do not protect SQL rows.”
- “Runtime upload/index/processing roles cannot change lock configuration.”
- Client capability tokens/values and sensitive historical metadata never enter audit/outbox/logs.
- Do not claim R2 prefix locks are S3 per-version regulatory WORM protection.

## Review Focus

- Token redemption raced/replayed across tenants: same grant semantics as P3 (Task 1).
- Full bucket-lock update accidentally drops another tenant's rules: durable serialized merge/reconcile (Task 2).
- Rule exhaustion silently accepts an unprotected hold: pre-reserve capacity and remain pending/failed (Task 2).
- Hold accepted while provider deletion remains unknown: no active acknowledgment until settled (Tasks 2–3).
- Late uploads/OCR/search writes survive a deletion completion: all providers/in-flight work reconcile first (Task 3).

### Task 1: External grant persistence and common route integration

**Files:** Create `packages/documents-cloudflare/src/d1/external-grant-store.ts`, `apps/document-api/worker-tests/external.worker-case.ts`, `test/cloudflare-documents/external.integration.test.ts`; add `deploy/cloudflare/migrations/0002_governance.sql`; register shared P3 route module in Cloudflare assembly.

**Interfaces:** Implement P3 `ExternalGrantStore.create/read/reserveUse/revoke` and `ExternalGrantService` via D1; method input/return definitions live in P3. Consume P0 UploadService/ArtifactStore; no provider-specific external API. Preserve atomic grant/use reservation, redemption receipt, audit and outbox in the tenant shard.

- [ ] Run shared `external_grant_expires`, `single_use_redemption_has_one_winner`, `revoked_issuer_cannot_redeem`, `upload_grant_cannot_download_or_list` and `retry_resumes_failed_signing` cases. Verify capability identity and staff issuer are distinct in audit and unsigned token values never persist.
- [ ] Run `bun run test:cloudflare -- external.worker-case.ts`; expect missing store/schema failures.
- [ ] Implement keyed-digest lookup, transactional reservation and bounded signed access from P3. Recheck current issuer permission/lifecycle on every redemption. Match effective expiry and documented already-issued-URL window; no global listing or bucket credentials returned. No new grant API routes outside P3 inventory.
- [ ] Run local cases, shared route/OpenAPI suite and authorized live token-concurrency/expiry tests against D1/R2. Revocation blocks subsequent redemption before any asynchronous index/delivery update.
- [ ] Commit: `feat: persist scoped external evidence grants in D1`.

### Task 2: R2 rule capacity, pending holds and destruction ordering

**Files:** Create `packages/documents-cloudflare/src/governance/{protection-store,bucket-locks,destruction-permits}.ts`, `deploy/cloudflare/src/protection-config.ts`, `apps/document-api/worker-tests/holds.worker-case.ts`, `test/cloudflare-documents/holds.integration.test.ts`; extend governance migration/configuration.

**Interfaces:** Implement P3 `ProtectionProvider.apply(ref,desiredGeneration):Promise<ProtectionOutcome>`, `inspect(ref):Promise<ProtectionSnapshot>` and `DestructionPermitStore`; P3 owns exact types/statuses. `BucketProtectionStore.claim(bucketId,operationId):Promise<BucketPermit>` / `settle(permitId,outcome):Promise<void>` serializes full rule updates. Each bucket maps permanently to one D1 shard; all tenant document protection mutations remain in that shard. `RuleReservation` holds document namespace, staging/content bucket IDs, reserved rule IDs, desired/current generation and pending state. Reserve two rules per document per relevant bucket (effective retention date and effective indefinite hold); coalesce multiple holds into the hold rule, never one rule per hold. Configured admission ceiling must be below the verified provider rule limit with maintenance headroom.

- [ ] Test `unrelated_rules_survive_update`, `two_tenants_share_bucket_safely`, `stale_rule_write_never_overwrites_newer_generation`, `rule_capacity_blocks_admission_or_hold`, `pending_hold_blocks_new_delete_permits`, `unknown_delete_prevents_active_hold`, `last_hold_release_keeps_retention`, and `artifact_publication_inherits_document_namespace`.
- [ ] Run `bun run test:cloudflare -- holds.worker-case.ts`; expect missing controller/permit failures.
- [ ] Implement D1 pending-hold transaction and durable bucket permit; update/inspect R2 rules through a private controller Worker with secret references. Never expire unknown config-update permits and let a later update race them. Reconcile complete desired bucket rules while preserving unrelated reservations; active document hold follows confirmed provider protection generation and settled prior destruction. Apply rules to all original/staging/derived namespaces under that document; publication cannot escape namespace or protection state. Use Date retention and Indefinite hold rules; ordinary workers cannot mutate controller configuration. Deployment pairing of database and bucket shard is validated before admission. [R2 lock rules and current capacity](https://developers.cloudflare.com/r2/buckets/bucket-locks/).
- [ ] Run local cases and authorized live R2 hold/delete/overwrite tests, rule update failure/ambiguity and exhaustion simulation. Prove worker-visible active state follows actual protection, not merely successful D1 write. Account-level administrators remain explicit trust boundary, not a claimed WORM guarantee.
- [ ] Commit: `feat: serialize Cloudflare evidence protection rules`.

### Task 3: D1/R2 cleanup providers and cross-module races

**Files:** Create `packages/documents-cloudflare/src/governance/{cleanup-registry,deletion-worker,reconciliation}.ts`, `apps/document-api/src/cloudflare-cleanup.ts`, `apps/document-api/worker-tests/deletion.worker-case.ts`, `test/cloudflare-documents/governance-races.integration.test.ts`, `docs/operations/cloudflare-governance.md`; register shared P3 governance/deletion routes, update manifests.

**Interfaces:** Implement P3 CleanupRegistry, DeletionService and providers with owner names `artifacts`, `metadata`, `uploads`, `processing`, `search`, `flowkit`. CF2 supplies the first three; CF3 supplies the last three. `reconcile` pages all R2 keys/parts/objects and D1 history/leases; `destroy` receives the current authorized permit. Unconfigured required provider prevents completion, never an empty inventory assumption. Recovery-copy obligations are completed only by CF4's expiry/destruction proof.

- [ ] Run shared cleanup-provider scenarios; add exact metadata-history erasure, incomplete uploads, quarantine, abandoned promotion, SQL/FTS rows, unknown R2 writes and lost delete response. Assert raw SQL cleanup cannot bypass pending/active hold or retention, and missing CF3/backup cleanup keeps operation pending.
- [ ] Run `bun run test:cloudflare -- deletion.worker-case.ts`; expect unimplemented provider failures.
- [ ] Implement lifecycle generation fencing and durable obligations before each remote artifact operation. Block new publication/discovery/redemptions on deletion; reconcile provider outcomes rather than trusting a negative read after an unknown earlier write. Sanitize sensitive D1 history and leave minimal tombstone/receipt/reference records. Destroy only under P3 permits, serializing R2 rule removal and SQL row destruction against holds. Status/errors are shared /v1 APIs; failed/unknown obligations remain visible/retryable.
- [ ] Run local cases and authorized live races for uploads, delayed callbacks, text-index rebuild/replay and holds; re-run the complete provider matrix once CF3/CF4 land. Show no resurrection and no premature completion, including live Time Travel/backup obligations at final assembly.
- [ ] Commit: `feat: reconcile Cloudflare document destruction safely`.

## Self-review and handoff

P3 owns common grant/lifecycle/cleanup policy; CF2 owns provider behavior. Pairing each bucket with one D1 shard makes full-config serialization possible without cross-shard document transactions. Current rule limits are deployment admission constraints, not a reason to relax holds. CF2 cannot close assembled acceptance while CF3/CF4 cleanup providers remain absent.

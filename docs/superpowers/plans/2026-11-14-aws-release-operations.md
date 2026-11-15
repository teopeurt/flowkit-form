# AWS Release and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, observe, recover and package the assembled AWS document-management release with its approved OCR engines and external supported FlowKit runtime.

**Architecture:** Retain the isolated document deployment and compose all required modules through configuration and public exports. Operational service identities run replay/reindex/reconciliation against the same lifecycle and authorization contracts. A release evidence matrix links every design goal to offline and real assembled checks.

**Tech Stack:** TypeScript/Bun, existing CI, CDK, AWS monitoring/logging/tracing, encrypted backups and approved isolated AWS/runtime integration environments. No UI or new runtime backend.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [master waves](2026-11-14-release-waves.md). AWS lane requires P1/P0/P2–P6. Shared release readiness also requires CF1–CF4; Cloudflare operations are in CF4.

## Parallel-provider ownership

This plan implements shared services first and the AWS provider portion second.
The [approved Cloudflare amendment](../specs/2026-11-14-cloudflare-alternative-design.md)
and [master waves](2026-11-14-release-waves.md) apply to every task. Commit and
verify portable outputs before AWS adapters so Cloudflare can consume them
without waiting for AWS implementation or deployment. The shared API/identity,
upload/artifact/reader/delivery and runner-neutral test boundaries belong to
[P0](2026-11-14-shared-provider-contracts.md). Do not recreate them in this plan.

## Global Constraints

- “Encrypt content and records, use least-privilege identities, avoid document content in operational logs”.
- “Provide replay/reindex tooling and documented backup/restore exercises.”
- “Exercise the assembled AWS deployment and its configured FlowKit runtime, rather than relying only on mocked adapters.”
- “Availability, quotas, and cost of chosen AWS services must be verified against official documentation during planning.”
- “No cross-service exactly-once claim.”
- No live deployment/restore/real-data transfer without existing or explicit target authorization; prepare concrete artifacts/diffs first.

## Review Focus

- Logs, traces, errors or audit payloads retain evidence/tokens after deletion (Task 1).
- Replay reuses new operation IDs or arbitrary endpoints and duplicates effects (Task 2).
- Partial provider outage appears healthy or loses evidence/intent (Task 3).
- Restore reintroduces deleted content or removes accepted holds/grant revocations (Task 4).
- Deployment rollback uses incompatible event/state schemas and silently fails processing (Task 5).

### Task 1: Final composition, least privilege and monitoring

**Files:** Create `deploy/aws/src/{observability,release-stack}.ts`, `packages/documents-aws/src/observability/{logging,metrics,tracing}.ts`, `test/documents-aws/operations.test.ts`, `docs/operations/aws-monitoring.md`; update document function composition and release configuration.

**Interfaces:** `emitMetric(name, value, dimensions): void` restricts dimension names to provider/deployment/service/operation/status, not document IDs/raw actor data. `safeLog(event: OperationalLog): void` accepts correlation/operation IDs, safe error code and duration, never arbitrary request/body. `readiness(): Promise<{ ready: boolean; dependencies: Readonly<Record<string,'ready'|'unavailable'|'unconfigured'>> }>` checks required config and dependency health without returning endpoints/secrets. FlowKit outage degrades integration readiness and raises alerts without making valid stored evidence inaccessible.

- [ ] Write tests that final composition includes document, governance, processing, search and FlowKit modules; missing required profile/identity/runtime prevents release readiness. Assert no token, signed URL, raw text, metadata values or binary content in error/log/trace fixtures. Assert API roles cannot delete originals, search roles cannot access quarantine and cleanup roles cannot bypass retention.
- [ ] Run `bun test test/documents-aws/operations.test.ts`; expect missing monitoring/final-composition failures.
- [ ] Implement structured redacted logs and correlation propagation; instrument queue age, oldest outbox age, processing failure/timeout, callback lag, failed deliveries, search lag, pending holds, unknown permits and cleanup backlog. CDK adds alarms with deployment-config thresholds, encrypted bounded log retention, DLQ alarms, least-privilege role policies, private object access and cost budgets. Upload verifier/profile providers must be configured; no accept-all production fallbacks.
- [ ] Run focused tests, synth and IAM policy checks; trigger alarms in authorized test deployment and verify actual metric/alarm state. Record notification destination configuration; do not send messages through external tools unless separately authorized.
- [ ] Commit: `feat: instrument and secure assembled document services`.

### Task 2: Replay, reindex and failed-work operations

**Files:** Create `scripts/documents/{replay,reconcile,status}.ts`, `packages/documents-aws/src/operations/commands.ts`, `test/documents-aws/operational-commands.test.ts`, `docs/operations/failed-work.md`; reuse P5 `scripts/documents/reindex.ts`, modify root scripts.

**Interfaces:** `replay({ target, failedDeliveryIds, dryRun }): Promise<ReplayReport>` uses configured target names only; `reconcile({ documentRef, dryRun }): Promise<ReconciliationReport>`; `status({ operationId }): Promise<OperationStatus>`. Every command requires trusted operations identity, provider/account/target match and explicit deployment output file. AWS target includes region; Cloudflare includes environment/bindings fingerprint. Dispatch is from trusted operator profile, never client API input. Default dry-run emits sanitized plan; apply mode requires explicit flag. Preserve event/operation/binding IDs from original intent, with a new audited replay invocation ID.

- [ ] Test dry run mutates nothing, target mismatch is rejected, denied operator cannot replay, schema mismatch remains failed, duplicate invocation produces no duplicate effect, deleted generation is rejected/cleaned, and changing the target endpoint through arguments is impossible.
- [ ] Run `bun test test/documents-aws/operational-commands.test.ts`; expect absent command failures.
- [ ] Implement bounded paginated replay/status and provider reconciliation using P2–P6 services, not direct unrestricted table editing. Repair uncertain delivery by querying target receipts; do not invent success or reissue with a different stable operation ID. Expose sanitized failure codes/attempt history and resumable checkpoints. Reindex delegates to P5 rebuild and obeys all lifecycle checks.
- [ ] Run focused tests and authorized live injection/replay against SQS failure records, processing jobs, search indexing and runtime outages. Confirm one logical effect and durable visible failures when recovery remains impossible.
- [ ] Commit: `feat: operate failed document work with safe replay tools`.

### Task 3: Full acceptance, security races and resource budgets

**Files:** Create `test/aws-documents/{assembled-acceptance,security-races,capacity}.integration.test.ts`, `docs/validation/{document-design-coverage,document-release-evidence}.md`, `.github/workflows/documents-aws.yml`; update `.github/workflows/ci.yml` synth/offline gates without weakening existing checks.

**Interfaces:** Explicit live profile names are `smoke`, `acceptance`, `races`, `capacity`; every live profile consumes approved deployment outputs and workload limits. Profile config includes corpus/profile IDs, tenant identities, runtime fixture, request rate, duration and max spend. Test runner must reject identity/target mismatch and stop on spend/timeout cap. Offline CI cannot claim live acceptance success.

- [ ] Write end-to-end assertions for customer/staff upload, classification/tags/issuer/expiry/associations, immutable replacement, exact historical metadata, OCR status/text/layout/error/reprocess history, authorized metadata/full-text search and version-specific FlowKit approval. Include negative cases for both tenants across upload/download/search/processing/audit/external grants. Add races for URL reuse, completion duplication, stale permissions, reordered events, deletion vs callbacks/index/rebuild, and holds vs destruction.
- [ ] Run offline scenario schema/fixture tests and live suite in disabled mode; expect explicit skip when unapproved and hard failure when approved but misconfigured. Root typecheck/test/build and all package contract checks must pass or baseline failures be explicitly resolved before release.
- [ ] Implement live profile orchestration in workflow_dispatch CI with restricted OIDC role and environment review; no cloud secrets in repository or ordinary PR jobs. Create a coverage row for every design goal/invariant with owning plan task, exact assertion and evidence artifact. Capture only IDs/checksums/correlations, not content. Keep raw corpus outside public artifacts.
- [ ] Execute authorized assembled acceptance/race/capacity profiles against actual AWS, chosen OCR adapters and supported runtime. Measure API p95 excluding bytes, processing latency, throughput, queue/search lag, DLQ recovery, resource use and cost against required P2 deployment budgets. Fail on exceeded limits or missing module; do not lower budgets silently.
- [ ] Commit: `test: gate release on assembled AWS document acceptance`.

### Task 4: Backup, deletion obligations and restore drill

**Files:** Create `packages/documents-aws/src/operations/{recovery-ledger,restore}.ts`, `scripts/documents/restore-check.ts`, `test/documents-aws/restore.test.ts`, `test/aws-documents/restore.integration.test.ts`, `docs/operations/backup-restore.md`; update CDK backup and lifecycle configuration, governance cleanup registry and evidence.

**Interfaces:** `RecoveryLedger` persists minimal deletion generations, active/pending holds and access-revocation epochs in an independently protected restore-control store. `recordControlChange(change): Promise<void>` has durable outbox intent in the authoritative mutation transaction; recovery refuses service until it reconciles all control changes after the restore point. `RestoreCoordinator.validate({ restoredResource, sourceWatermark, target }): Promise<RestoreReport>` / `activate(reportId): Promise<void>` gates recovery on reconciliation, IAM/config verification and index rebuild. Control records use references only, not sensitive values.

- [ ] Test restoring a snapshot from before deletion, before hold activation and before grant revocation; restored content remains unavailable until control ledger/state replay blocks deleted generations and restores holds/revocations. Test lagged/unavailable recovery ledger fails closed, provider cleanup remains pending and operational replay cannot erase tombstones.
- [ ] Run `bun test test/documents-aws/restore.test.ts`; expect absent restore controls.
- [ ] Implement encrypted PITR/backup policy and explicit inventory of recovery copies. Current source-of-truth control changes must survive restoration by reconciling the current source, independent ledger and pending outbox before activation. If current control state is unavailable and a provably complete watermark cannot be established, keep restored deployment closed. Search is rebuilt from authorized surviving records and P4 artifacts; do not assume provider index snapshots are the sole recovery source. Restore FlowKit host dependencies through its existing supported procedures and recheck evidence associations.
- [ ] Run authorized isolated restore drill into new tables/resources, never overwrite live tables. Measure loss and recovery duration against configured RPO/RTO; verify deleted documents cannot be retrieved/searched/processed or replayed and holds still block destruction. Document that backups/PITR cannot selectively purge a single document: retain a visible recovery-copy cleanup obligation until configured recovery copies expire or are destroyed. Deletion cannot report complete while sensitive recovery copies remain an unresolved obligation; report expected expiry. Do not shorten backups or disable recovery to force a successful test.
- [ ] Commit: `feat: prevent evidence resurrection during AWS recovery`.

### Task 5: Reproducible release package and rollout/rollback gate

**Files:** Create `packages/documents/src/operations/{contracts,release}.ts`, `scripts/documents/release-manifest.ts`, `docs/deployment/aws-release.md`, `test/documents-aws/release-contract.test.ts`; update root scripts, CI artifacts, README and active specification/roadmap status to reflect only verified delivered functionality.

**Interfaces:** `ReleaseManifest` includes source commit, locked dependencies and separate tagged provider entries. AWS entry has Lambda artifact/CDK template hashes; Cloudflare entry has Worker bundle/Wrangler binding/compatibility date/D1 migration hashes. Both entries include supported event schema versions, storage migration/rollback compatibility, engine/profile revisions and redacted credential/config references. Shared operational types (`OperationalLog`, ReplayReport, ReconciliationReport, OperationStatus, RecoveryLedger, RestoreCoordinator) live in `packages/documents/src/operations/contracts.ts`, implemented per provider. `validateRelease(manifest, evidence): Promise<{ ready: boolean; blockers: readonly string[] }>` requires passing evidence for both AWS and Cloudflare, refuses missing P1/P0/P2–P7/CF1–CF4 evidence, open engine/dependency/deployment gates or incompatible rollback target.

- [ ] Test changed artifact/template hash invalidates evidence, engine revision mismatch fails release, missing live runtime/restore evidence or failed/missing Cloudflare evidence blocks ready status even when AWS passes, unknown queued event schema blocks unsafe rollback and private config never enters manifest.
- [ ] Run `bun test test/documents-aws/release-contract.test.ts`; expect missing release validator.
- [ ] Implement reproducible bundles/synth, staged deployment checklist and backward-compatible expand/contract schema/event rules. Rollback uses prior compatible code/config while retaining durable objects, tombstones, grants, audit and queues; never rolls state back to remove accepted holds/deletions. Drain/quarantine incompatible queued work or migrate explicitly before rollback. Document external runtime and inference dependencies, service health prerequisites and cost/region verification evidence. Prepare target-specific CDK diff and manifest before any release approval request.
- [ ] Run all required offline gates, validate both provider evidence ledgers and package hashes, synth/diff final reviewed AWS configuration and confirm every wave exit. CF4 supplies Cloudflare artifacts/evidence independently; shared combined readiness is evaluated after both are collected, without a circular dependency on the other task's ready boolean. Report any remaining blocker honestly. Deployment is performed only when target authorization exists; after authorized rollout run smoke checks and observe metrics for configured rollout duration before marking released.
- [ ] Commit: `build: package verified AWS document management release`.

## Self-review and handoff

The full acceptance matrix, operational visibility, failed work/replay, budgets, least privilege, backup/restore and release controls have concrete tasks. Actual account/region/identity/runtime, representative corpus, engine hosting and deployment authorization are tracked gates rather than invented values. GCP/Azure and reviewer/submission UI require separate plans under later scope, not this AWS release.

# Cloudflare Release and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure, observe, recover and release the complete Cloudflare profile with provider-specific evidence and common AWS/Cloudflare readiness checks.

**Architecture:** Cloudflare operational Workers/commands use the same permission, lifecycle, replay and evidence contracts as P7. D1 authoritative state, R2 bytes, Queue work and external OCR/FlowKit dependencies have explicit health/recovery boundaries. A combined release gate requires independent passing evidence for both providers, without demanding simultaneous rollout.

**Tech Stack:** TypeScript/Bun, Wrangler, Workers logs/metrics, D1 Time Travel/export/import, private R2 recovery objects, Queues/DLQs, CI with separate reviewed Cloudflare credentials and local workerd checks.

**Spec:** [Approved amendment](../specs/2026-11-14-cloudflare-alternative-design.md), [master waves](2026-11-14-release-waves.md). CF4 requires CF1–CF3 and P7 portable operational contracts; monitor/config preparation may begin earlier.

## Global Constraints

- “Product first-release readiness requires both lanes' completed acceptance gates.”
- “One lane's pass does not waive the other's failed/missing capability.”
- “if its completeness cannot be established, keep restored service closed.”
- No Cloudflare service is silently replaced by an AWS dependency; external verifier/OCR/runtime are declared.
- D1 backup does not recover R2 object bytes; recovery copies retaining sensitive values remain visible deletion obligations.
- Target deployment/restore approvals are provider- and environment-specific; no test provisions/migrates remote resources itself.

## Review Focus

- Worker logs/errors leak tokens/text after a deletion: typed redaction and real output check (Task 1).
- Lost Queue work/replay changes operation identity: durable D1 failed intent and same IDs (Task 2).
- D1 restore rolls accepted holds/revocations/deletions backward: independent control ledger and fail-closed activation (Task 3).
- Export/Time Travel is mistaken for object backup or clone: separate R2 manifest and isolated restoration (Task 3).
- AWS alone passes and release says complete: combined manifest requires both provider evidence (Task 4).

### Task 1: Final Worker composition, privileges, quotas and monitoring

**Files:** Create `packages/documents-cloudflare/src/observability/{logging,metrics,readiness}.ts`, `deploy/cloudflare/src/monitoring.ts`, `apps/document-api/worker-tests/operations.worker-case.ts`, `docs/operations/cloudflare-monitoring.md`; complete runtime manifests and deployment configuration.

**Interfaces:** Implement P7 `safeLog(OperationalLog)`, `emitMetric(name,value,dimensions)` and `readiness()` contracts with deployment/provider IDs. Observed conditions include oldest pending outbox, queue/DLQ age/depth, job/callback timeouts, search lag, pending holds, unknown protection/destruction operations, cleanup backlog, database free headroom and lock-rule reservations. Health displays safe status codes, not secrets/endpoints/raw provider exceptions.

- [ ] Test no raw text/metadata values/capability/JWT/signed URLs in logs/traces/errors, missing provider configuration is not ready, external runtime outage degrades integration while evidence retrieval works, and only private protection-controller surface can alter lock rules. Validate no public content bucket and no production fake verifier/engine fallbacks.
- [ ] Run `bun run test:cloudflare -- operations.worker-case.ts`; expect missing final composition/telemetry.
- [ ] Implement typed safe logging and correlation across Fetch/Queue/callbacks, configured log retention/sampling/metrics and account spending/capacity alarms where supported. Explicitly document Worker binding privilege boundaries: broad R2/D1 bindings are trusted-code capabilities, not S3-style per-operation IAM. Isolate privileged controller/cleanup code behind private service methods; no generic client SQL/key/delete RPC. Validate actual native encryption/data-location/key-management capabilities and flag unmet requirements without claiming AWS KMS equivalence.
- [ ] Run Worker tests, typecheck/build and dry-run bundle. In authorized Cloudflare environment induce each failure/capacity alarm and inspect redacted real telemetry. Record pricing/plan/limit sources and measured budget values; do not assume free idle operation.
- [ ] Commit: `feat: monitor and secure Cloudflare document operations`.

### Task 2: Provider-safe replay, reindex and reconciliation commands

**Files:** Create `packages/documents-cloudflare/src/operations/{commands,status}.ts`, `apps/document-api/worker-tests/commands.worker-case.ts`, `docs/operations/cloudflare-failed-work.md`; extend shared `scripts/documents/{replay,reindex,reconcile,status}.ts` from P7 to dispatch by trusted deployment profile, not API body.

**Interfaces:** Implement P7 replay/reconcile/status service contracts and P5 rebuild through CF3 stores. Root commands consume a validated operator profile `{ provider, deploymentId, accountId, environment, outputsFile }`; default dry-run, explicit apply. Cloudflare and AWS output schemas are disjoint tagged types; each is matched to target before any write. Commands preserve original event/binding/operation IDs plus a new audited invocation ID.

- [ ] Test wrong provider/account/environment rejected before command, no writes in dry-run, unauthorized operator, unknown schema, same operation replay twice, deleted generation rejection/cleanup and original receipt recovery after gateway timeout. Simulate Queue retention loss with surviving D1 intent.
- [ ] Run `bun run test:cloudflare -- commands.worker-case.ts` and shared command tests; expect missing provider dispatch failures.
- [ ] Implement bounded paginated repair/replay of D1 failed deliveries/jobs/index work, not direct unrestricted table editing. Reconcile unknown effects at provider/gateway before retry. Reindex uses CF3 epoch/checkpoint/lifecycle logic and includes retiring epochs in cleanup. Persist checkpoints in D1 and keep unavailable external services visible/retryable.
- [ ] Run local tests and authorized real outage/DLQ/replay/reindex tests; prove no second logical effect and that no hidden required event was discarded. No arbitrary endpoint argument or new operation identity can bypass stable target receipts.
- [ ] Commit: `feat: operate Cloudflare failed work with shared recovery tools`.

### Task 3: D1 and R2 recovery with control-ledger reconciliation

**Files:** Create `packages/documents-cloudflare/src/operations/{recovery-ledger,backup-manifest,restore}.ts`, `apps/document-api/worker-tests/restore.worker-case.ts`, `test/cloudflare-documents/restore.integration.test.ts`, `docs/operations/cloudflare-backup-restore.md`; extend CF2 recovery-copy cleanup and operator commands.

**Interfaces:** Implement P7 RecoveryLedger/RestoreCoordinator contracts with Cloudflare output/profile tagging. `R2RecoveryManifest` identifies each copied ArtifactRef/checksum, namespace, createdAt, expiry, protection generation and cleanup obligation; it is protected operator data, not client search output. `restore-check` consumes source/control watermarks, restoredResource and intended destination, returns report/activation blockers. Control ledger is separately protected from the restored tenant database and stores non-sensitive deletion/hold/revocation control records; durable source mutation intent is in the tenant transaction.

- [ ] Test restoring before deletion/hold/grant-revocation, lagged/unknown control watermark fails closed, R2 source missing despite D1 restored, modified recovery checksum, incomplete object manifest, and sensitive Time Travel/export copies prevent deletion completion. Assert new DB activation never silently points clients to a stale tenant mapping.
- [ ] Run `bun run test:cloudflare -- restore.worker-case.ts`; expect missing recovery adapter failures.
- [ ] Implement D1 export/import into newly provisioned isolated destination, plus independently inventoried R2 backup/copy recovery and checksum validation. Time Travel may restore only the explicitly isolated original test DB; do not assume it can fork/clone a DB. Before activation reconcile authoritative latest control state, ledger and pending source outbox; if completeness cannot be proven, remain closed. Preserve accepted holds/revocations/tombstones, reapply R2 protection and rebuild FTS from surviving records. No automatic cross-provider failover/migration is introduced. [D1 Time Travel and current limits](https://developers.cloudflare.com/d1/reference/time-travel/).
- [ ] Run an authorized isolated D1 export/import + R2 recovery and separate Time Travel drill; measure configured RPO/RTO. Verify deleted content cannot be read/searched/reprocessed/replayed and holds still block destruction. Track provider recovery windows and exports as visible cleanup obligations until confirmed expiry/deletion; never force success by disabling required backups or claiming older bookmarks were erased.
- [ ] Commit: `feat: preserve evidence governance during Cloudflare recovery`.

### Task 4: Live parity, release artifacts and combined readiness

**Files:** Create `test/cloudflare-documents/{security-races,capacity,release}.integration.test.ts`, `.github/workflows/documents-cloudflare.yml`, `docs/deployment/cloudflare-release.md`; extend P7 shared release validator, `docs/validation/{document-design-coverage,document-release-evidence}.md` and root documentation.

**Interfaces:** Shared `ReleaseManifest` has per-provider entries containing artifact/config/schema/event versions, engine/profile revisions, external dependencies and evidence hashes. `validateRelease(manifest,evidence)` requires both `aws` and `cloudflare` provider readiness. CF4 contributes bundled Worker hashes, Wrangler compatibility/binding/config fingerprint, ordered D1 migration hashes, runtime/profile revisions and recovery/acceptance evidence. A provider-specific deployable artifact may be produced before combined readiness, but cannot be labeled a complete first product release alone.

- [ ] Test Cloudflare missing/failed evidence blocks combined readiness even if AWS passes; changed Worker/migration/engine/profile hashes invalidate prior evidence, missing real runtime/corpus cannot pass, and rollback rejects incompatible stored/queued schemas. Add the same tenant/permission/upload/hold/deletion/OCR/search/review race scenarios as AWS with Cloudflare-specific ambiguous write/rule exhaustion cases.
- [ ] Run shared release/offline suites and Cloudflare worker cases; before implementation expect absent provider manifest/validator failures. Unapproved live runs skip explicitly; approved-but-unconfigured runs fail.
- [ ] Implement reviewed CI environment for Cloudflare tests/deploy preparation with minimum credential scope, ordinary PR jobs local-only and existing AWS/demo gates retained. Reuse P7 smoke/acceptance/races/capacity profile names and workload/cost caps; actual numbers are provider-specific configuration. Package Worker bundles/manifests/migrations and prepare concrete target dry-run/diff/rollback instructions before any missing deployment approval request.
- [ ] Execute authorized live parity/capacity/race/restore suites against actual D1/R2/Queues, evaluated OCR and supported FlowKit runtime; record sanitized evidence for every amendment/base invariant. Run combined release validation only after both provider ledgers pass; rollout each authorized target independently with compatible schema/event expansion, monitored smoke window and no state rollback that removes accepted holds/deletions.
- [ ] Commit: `build: gate parallel AWS Cloudflare release on verified parity`.

## Self-review and handoff

Monitoring, least privilege, durable operational repair, both D1/R2 recovery and combined release readiness are covered. CF4 does not weaken P7 AWS checks or permit one provider's approval/evidence to authorize the other. Actual account/plan/location/budgets, engines, runtime and target authorization remain explicit gates; no cloud deployment or model execution occurs while writing plans.

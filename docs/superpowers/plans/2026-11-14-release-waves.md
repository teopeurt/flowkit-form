# FlowkitForm AWS and Cloudflare Release Waves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved document design and amendment through two independently deployable, verified first-release alternatives: AWS and Cloudflare.

**Architecture:** One portable document core, Fetch API, processing/search/FlowKit service layer and behavioral conformance suite feed two provider adapter sets. AWS uses DynamoDB/S3/SQS/Lambda/OpenSearch; Cloudflare uses authoritative D1/R2/Queues/Workers/FTS5. Each assembly connects to a configured external supported FlowKit runtime and evaluated verification/OCR services.

**Tech Stack:** TypeScript, Bun 1.3.14 matching existing CI, AWS SDK v3/CDK v2 and Node.js Lambda; Wrangler, workerd/Vitest Workers and scoped Workers types for Cloudflare. Pin compatible exact tool versions during execution; existing FlowKit packages remain 1.2.0 unless a separate compatibility decision changes them. No provider SDK/types in portable contracts.

**Spec:** [Approved base design](../specs/2026-11-14-flowkitform-design.md) and [approved Cloudflare amendment](../specs/2026-11-14-cloudflare-alternative-design.md).

## Global Constraints

- “AWS and Cloudflare are first-release targets, each independently runnable against the same portable document core and behavioral contracts.”
- “Each tenant belongs to one configured deployment/provider in this release.”
- “Neither provider may omit a required capability and still count as release-complete.”
- “Existing packages must retain their current responsibilities.”
- Required FlowKit integration remains separate; no replacement runtime, UI, GCP/Azure adapter, cross-provider replication/failover or migration tool in this release.
- State/audit/outbox intent commits atomically; asynchronous delivery is at least once, never cross-service exactly once.
- Engine/hosting/data-location/account/budget decisions are explicit deployment/evaluation gates, not guessed approvals. Prepare deployable artifacts and diffs before requesting only missing authorization for actual external actions.

## Review Focus

- Portable contracts accidentally depend on AWS implementation: P0 lands before either vertical slice and compiles both harnesses.
- D1 CAS loser commits side effects or R2 write ambiguity resurrects evidence: CF1 Tasks 2–3 and CF2 Task 3.
- Source permissions/holds are stale at search/download/cleanup: shared authorization plus primary persistence tests on both lanes.
- Cloudflare reuses S3 assumptions or AWS alone passes parity: CF-specific conformance and combined P7/CF4 release gate.
- Local mocks conceal missing actual engines/runtime/recovery: required real environments and per-provider evidence, never a skipped live suite reported as success.

## Complete plan set and dependency order

| ID | Plan | Prerequisite | Responsibility |
| --- | --- | --- | --- |
| P1 | [Portable foundation](2026-11-14-document-foundation.md) | None | Evidence identity/history, permissions, atomic persistence, lifecycle |
| P0 | [Shared provider contracts and API](2026-11-14-shared-provider-contracts.md) | P1 | Artifacts/readers/uploads/identity/cursors/delivery, one Fetch API and conformance harness |
| P2 | [AWS document slice](2026-11-14-aws-document-slice.md) | P1/P0 | DynamoDB/S3/SQS, Lambda envelope and CDK vertical slice |
| CF1 | [Cloudflare document slice](2026-11-14-cloudflare-document-slice.md) | P1/P0 | D1/R2/Queues, Workers envelope and Wrangler vertical slice |
| P3 | [Governance and external access](2026-11-14-governance-external-access.md) | P1/P0 | Shared services/routes; AWS protection/cleanup implementation after P2 |
| CF2 | [Cloudflare governance](2026-11-14-cloudflare-governance.md) | CF1; P3 shared services | D1 grants/permits, R2 lock reservations and complete cleanup |
| P4 | [Processing and OCR](2026-11-14-processing-ocr.md) | P1/P0; P3 lifecycle | Shared contracts/services/routes/engine evaluation; AWS adapters after P2 |
| P5 | [Authorized search](2026-11-14-authorized-search.md) | P1/P0; P3/P4 interfaces | Shared query/materializer/rebuild; AWS OpenSearch adapter after P2 |
| P6 | [FlowKit integration](2026-11-14-flowkit-integration.md) | P1/P0; P3 lifecycle | Shared exact-evidence bridge/gateway; AWS stores after P2 |
| CF3 | [Cloudflare processing/search/FlowKit](2026-11-14-cloudflare-processing-search-flowkit.md) | CF1/CF2; respective P4–P6 shared contracts | D1 jobs/FTS5/bindings, Worker transport and real engine/runtime acceptance |
| P7 | [AWS release and shared operations](2026-11-14-aws-release-operations.md) | P1/P0/P2–P6 | Shared operational/release contracts, AWS evidence and release artifacts |
| CF4 | [Cloudflare release and operations](2026-11-14-cloudflare-release-operations.md) | CF1–CF3; P7 shared contracts | Cloudflare monitoring/replay/recovery/evidence and release artifacts |

P0's number preserves existing P1–P7 references; execution order is P1 then P0.
The old `2026-09-02-governance-contracts.md` is historical framework/demo work,
not part of this release and not authority for cross-repository framework edits.

## Ownership and concurrency rules

| Owner | Sole authority for shared interface/behavior |
| --- | --- |
| P1 `packages/documents` | DocumentStore, Scope/CommandContext, immutable references, permission/history/lifecycle services |
| P0 `packages/documents` | ArtifactStore, UploadStore/Service/Backend, UploadVerifier, DocumentReader/Inventory, paging and delivery |
| P0 `apps/document-api` | createDocumentApplication(Request→Response), TokenVerifier/IdentityDirectory, errors/cursors, common base routes/OpenAPI |
| P2 / CF1 | Provider-specific stores, upload sealing/promotion, queue adapters, ingress envelope and deployment configuration |
| P3 / CF2 | P3 common grant/protection/cleanup policy and routes; AWS / Cloudflare provider stores/protections respectively |
| P4 / CF3 Task 1 | P4 common processing/engine contracts/services/routes; AWS / Cloudflare persistence/dispatch/runtime wrappers respectively |
| P5 / CF3 Task 2 | P5 common SearchService/materialization/query/rebuild contract; OpenSearch / D1 FTS5 adapters respectively |
| P6 / CF3 Task 3 | P6 common evidence binding/bridge/gateway/consumer fixture; AWS / D1 stores and authenticated delivery respectively |
| P7 / CF4 | P7 common operational/release types, validators/scenarios; AWS / Cloudflare telemetry/recovery/evidence respectively |

When a P3–P7 task contains both portable and AWS outputs, deliver and verify its
portable portion first as a separately reviewable commit, then implement its AWS
adapter portion. Cloudflare may consume that verified shared output without
waiting for AWS code, deployment or live-test completion. CF tasks implement
interfaces rather than fork the shared service. Each consumer compiles against
its owner's exports. P0 takes ownership of portable files formerly scheduled in
P2; historical P2 declarations do not override it. Every plan's task text has
been adjusted to this split.

Both providers may work independently after shared prerequisites land. Serialize
edits to common exports, route registrations, root manifests/lockfile, shared
scenario files and OpenAPI. Merge provider-specific files first, then integrate
shared composition once. Parallel waves describe dependency independence and do
not themselves select subagent execution.

**Persistence:** bounded head/delta commands, immutable paged rows, durable
receipts, atomic state/audit/outbox. D1 zero-row CAS must fail inside transaction;
DynamoDB transaction limits cannot be evaded by non-atomic splitting. Capacity
and workload bounds are explicit and measured separately.

**Artifacts/destruction:** opaque immutable generation, staged verification,
tracked promotion, no published-byte mutation. Unknown writes/destruction/rule
updates must be reconciled, not assumed cancelled after timeout. Pending holds
block new destructive permits; active acknowledgment waits for earlier permit
settlement and provider protection. Cleanup includes all artifact owners,
index epochs and recoverable sensitive copies.

## Wave and implementation checklist

### Wave 0: Baseline and deployment decisions

- [ ] Review the full plan set, record workspace/test baseline and public installed FlowKit exports, select execution method and use an isolated worktree when needed.
- [ ] Start read-only P4 engine/corpus evaluation planning and P6 runtime compatibility inventory; do not execute model code or deploy inference without existing/explicit authorization.
- [ ] Prepare separate AWS and Cloudflare account/region-or-location/identity/credential/capacity/cost/recovery configuration records (P2 Task 1, CF1 Task 1).
- [ ] Inventory production verifier, OCR hosting, trusted membership directory and supported external runtime prerequisites for each profile.

**Exit:** both providers' inputs/gates recorded, no fake deployment values treated as production-ready.

### Wave 1: Core and shared prerequisites

- [ ] Execute P1 Tasks 1–5; verify bounded persistence, exact content/metadata history, default-deny permissions and lifecycle fencing.
- [ ] Execute P0 Tasks 1–4; one upload service, standard Fetch API, identity/cursors, delivery and runner-neutral conformance suite.
- [ ] Compile synthetic AWS/Cloudflare implementations; run portable tests/typecheck/build and review public contracts before provider implementations consume them.

**Exit:** neither provider requires the other's SDK or implementation to meet shared contracts. Existing demo behavior remains intact.

### Wave 2: Parallel evidence vertical slices

- [ ] AWS: execute P2 Tasks 1–6 using P0, prepare CDK synth/diff and run real DynamoDB/S3/SQS evidence tests after target authorization.
- [ ] Cloudflare: execute CF1 Tasks 1–5 using P0, prepare Wrangler/migration configuration and run real D1/R2/Queues evidence tests after target authorization.
- [ ] Run identical upload/history/download/audit/auth scenarios plus provider-specific CAS/VersionId-or-create-only/queue ambiguity cases.
- [ ] Begin shared P3–P6 service/contract work once P0 is available; do not wait for either lane's live environment to create portable code.

**Exit:** authorized client can create, upload, complete, retrieve exact evidence/history and audit in both real deployments with atomic intent and durable replay.

### Wave 3: Governance and extraction

- [ ] Shared: complete P3 portable grants/holds/cleanup and P4 processing/engine/profile/service/route work.
- [ ] AWS: finish P3 S3 protection/cleanup and P4 AWS job/engine packaging adapters and real acceptance.
- [ ] Cloudflare: execute CF2 Tasks 1–3 and CF3 Task 1; prove lock capacity/ordering, D1 cleanup and bounded Worker/declared remote extraction.
- [ ] Run shared external submission, hold/deletion/late-result and native/scanned/mixed/image/multi-page corpus cases on both lanes.

**Exit:** required first-class extraction and lifecycle behavior works on both, with evaluated engine hosting and no fictitious scanner/model success. Later search/FlowKit cleanup remains an explicit assembly gate until Wave 4.

### Wave 4: Authorized search and exact-evidence workflow

- [ ] Complete P5/P6 shared materialization/rebuild/bridge/gateway/consumer-fixture code and route modules.
- [ ] AWS: finish P5 OpenSearch and P6 AWS stores/delivery; Cloudflare: finish CF3 Tasks 2–4 with D1 FTS5/bindings and shared runtime gateway.
- [ ] Regenerate/validate the one OpenAPI inventory and run both providers' live permission revocation/pagination and exact-version/metadata review scenarios.
- [ ] Re-run P3/CF2 full cleanup provider matrix against processing/search/FlowKit/replay/rebuild; holds and tombstones must dominate all writers.

**Exit:** two independent deployments support search, review and deletion without transferring approval or leaking revoked evidence.

### Wave 5: Operations, recovery and parallel-provider release

- [ ] Complete P7 shared operational contracts/coverage/evidence format and AWS monitoring/replay/restore/packaging.
- [ ] Complete CF4 Tasks 1–4: Worker monitoring, provider-safe commands, D1/R2 restore, real parity/capacity evidence and Cloudflare packaging.
- [ ] Record separate provider latency/throughput/resource/cost/RPO/RTO results and fix failed acceptance gates; no provider's evidence substitutes for the other.
- [ ] Build both release artifacts and run the common combined readiness validator after their evidence is collected. Package preparation does not depend on the other lane's final ready boolean, avoiding a circular release dependency.
- [ ] Prepare concrete target manifests/diffs and rollback instructions; roll out independently only when authorized, then observe each provider's smoke/monitoring window.

**Exit:** first product release ready only when both providers have complete passing evidence. Simultaneous deployment, shared production accounts and cross-provider data synchronization are not required.

## Live verification, evidence and unresolved gates

Offline Bun tests cover portable code and AWS mocks; `test:cloudflare` uses
Vitest/workerd on explicit `.worker-case.ts` includes (not Bun's auto-discovery).
Live suites are `test/aws-documents/` and `test/cloudflare-documents/` with their
own `FLOWKITFORM_AWS_TEST_APPROVED=true` or
`FLOWKITFORM_CLOUDFLARE_TEST_APPROVED=true`, explicit outputs/account/target and
identity fixtures. A missing flag means explicit skip/no live evidence. A
present flag with missing/mismatched configuration fails. Tests never provision
or migrate remote services; provisioning/migrations are separate reviewed
operator actions for the approved isolated environment.

Write `docs/validation/document-release-evidence.md` and
`docs/validation/document-design-coverage.md` during execution. Each row records
plan/task, provider, commit, command, environment/profile, result and sanitized
artifact hash/location. Include every base/amendment invariant. Do not collect
raw certificate text, tokens or actual deployment secrets in public artifacts.

| Gate | Owners | Local progress allowed | Blocks |
| --- | --- | --- | --- |
| Actual account/region/location, workload/cost/resource/recovery budgets | P2.1 / CF1.1 | Synthetic config, offline adapters/bundles | Provider deployment and budget acceptance |
| Identity issuer/audience/membership directory and credentials | P0.3, P2.4 / CF1.5 | Typed adapters, negative-auth tests | Real API acceptance |
| Configured upload verifier | P0.2, P2.3 / CF1.3 | Rejecting fixtures and streaming tests | Making real evidence available |
| Authorized representative corpus and selected engine/hosting | P4.1/P4.4 / CF3.1 | Portable service/profile/job work | Real OCR acceptance on both |
| Supported runtime/gateway/public-export compatibility | P6.1/P6.3 / CF3.3 | Binding/bridge tests | Actual workflow acceptance |
| Search service budget/availability or D1 FTS capacity | P5.3 / CF3.2 | Query/materializer tests | Live search/capacity acceptance |
| Retention/hold authority, R2 rule admission and recovery copy expiry | P3/P7 / CF2/CF4 | State-machine/recovery simulations | Destructive release behavior and restore readiness |
| Concrete target deployment/migration/restore authorization | Provider operators | Artifacts/diffs/runbooks ready for review | Actual target mutations |

Use focused tests per code task and full relevant portable/Worker/root checks at
wave exit. Preserve existing Compose/browser CI and framework boundaries. Fix
new failures; record and resolve baseline failures before claiming release.
Commits remain scoped, including a portable-first commit where tasks mix lanes.

## Self-review and handoff

P1/P0 own shared foundation/API; P2/CF1 vertical slices; P3/CF2 governance;
P4–P6/CF3 extraction/search/review; P7/CF4 operations and combined release.
All amendment conditions have task owners and provider-specific live proof.
Review the complete plan set and choose native or subagent-driven execution
before implementation; no execution method is inferred from design approval.

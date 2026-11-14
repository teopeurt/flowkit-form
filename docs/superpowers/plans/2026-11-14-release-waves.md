# FlowkitForm AWS Release Waves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved document-management design through a complete, verifiable AWS release.

**Architecture:** Portable domain and processing contracts feed separate AWS and FlowKit adapters. Small vertical slices converge into an assembled serverless document product connected to an external supported FlowKit runtime. This index coordinates the seven implementation plans; it does not replace their task checklists.

**Tech Stack:** TypeScript, Bun 1.3.14 (matching CI), Node.js Lambda bundles, AWS CDK v2 in TypeScript, S3, DynamoDB, SQS, API Gateway, OpenSearch Serverless, configured OIDC identity integration and an external FlowKit runtime. CDK and OpenSearch are planner selections, not claims of user-selected tools. Pin compatible exact package versions at implementation; keep the six existing FlowKit packages at 1.2.0 unless a separate compatibility decision changes them.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md).

## Global Constraints

- “Deploy to AWS serverless first, GCP serverless second, Azure serverless third.”
- “Existing packages must retain their current responsibilities.”
- “FlowKit integration is required in the assembled product but lives in a separate module.”
- “First-class OCR is required”; engine and hosting adoption remain subject to the design's evaluation gate.
- “The first release is API-first; any submission/reviewer UI requires separate scope agreement.”
- No new FlowKit runtime backend, electronic signing or automated signature validation.
- Each mutation has atomic state, audit and event intent; processing/event delivery is at least once.
- This plan set authorizes implementation preparation, not deployment, real-data transfer, model execution or production changes. Use existing session authorization where applicable; request only missing external-action approval when the result is ready for review.

## Review Focus

- Interfaces drifting between independently executed plans: use the shared ownership table and compile their consumers at each wave exit.
- Stale asynchronous work after deletion: run cross-subsystem races in Governance Task 4 and Release Task 3.
- Hidden PostgreSQL/Temporal dependencies: AWS Task 5 and FlowKit Task 1 inventory them and fail document-function import checks.
- Fake adapters masking an unusable deployment: Release Task 3 requires a real AWS environment and supported runtime.
- Missing engines, deployment values or corpus treated as success: track each gate below; no production-readiness claim while unresolved.

## Plan set and dependency order

| ID | Plan | Dependencies | Deliverable |
| --- | --- | --- | --- |
| P1 | [Portable foundation](2026-11-14-document-foundation.md) | None | Tested evidence, permissions, history, persistence and lifecycle contracts |
| P2 | [AWS document slice](2026-11-14-aws-document-slice.md) | P1 | Running /v1 upload, version, metadata and audit API with AWS adapters and IaC |
| P3 | [Governance and external access](2026-11-14-governance-external-access.md) | P1, P2 | Scoped external grants, retention/holds and reconciled deletion |
| P4 | [Processing and OCR](2026-11-14-processing-ocr.md) | P1; AWS wiring needs P2; deletion checks need P3 | First-class extraction jobs and selected approved engines |
| P5 | [Authorized search](2026-11-14-authorized-search.md) | P1, P2; text integration P4; cleanup P3 | Search, indexing and rebuild with current permissions |
| P6 | [FlowKit integration](2026-11-14-flowkit-integration.md) | P1, P2; assembled acceptance P3–P5 | Exact-evidence review via supported external runtime |
| P7 | [AWS release and operations](2026-11-14-aws-release-operations.md) | P1–P6 | Assembled acceptance, monitoring, replay, recovery and release evidence |

The older `2026-09-02-governance-contracts.md` is a framework/demo historical plan and is not part of this release; do not execute its cross-repository framework changes.

## Shared ownership and integration contracts

All portable APIs return promises and receive trusted tenant/actor context; JSON HTTP input never supplies trusted verification or service identity. IDs are opaque strings; timestamps ISO UTC; generations and revisions nonnegative safe integers. Each module exports from `src/index.ts`; compiled production artifacts use the existing root TypeScript build plus isolated Lambda bundling. Existing demo source exports remain unchanged.

| Owner | Contract used by other plans |
| --- | --- |
| P1 `packages/documents` | `DocumentStore`, `CommandContext`, `Scope`, `DocumentRef`, `ArtifactRef`, `VerifiedContent`, `CommitReceipt`, `authorize`, content/metadata/grant and lifecycle services |
| P2 `packages/documents` | `UploadStore`, `UploadService`, `ArtifactStore`, `DocumentReader`, `Page<T>`, event envelope and durable delivery interfaces |
| P2 `packages/documents-aws` | DynamoDB store, S3 artifact store, outbox relay, Lambda composition and CDK resources; no SDK types in P1 |
| P2 `apps/document-api` | `DocumentApiDependencies`, verified identity adapter, HTTP router, errors/cursors and OpenAPI; later plans register routes here |
| P3 `packages/documents` | `ExternalGrantService`, `CleanupRegistry`, `DeletionService`, provider destruction authorization |
| P4 `packages/document-processing` | Inspector, NativeExtractor, Renderer, OcrParser, ResultNormalizer, ProcessingStore, ProcessingService and artifact cleanup registration |
| P5 `packages/document-search` | SearchIndex, IndexCoordinator, SearchService; AWS OpenSearch implementation remains in `packages/documents-aws` |
| P6 `packages/documents-flowkit` | EvidenceBindingStore, FlowkitDocumentBridge, evidence references and consumer-selected event/action bindings |
| P7 | Operational commands/runbooks and assembled tests; does not own document business policy |

**Persistence rule:** P1's logical aggregate must not become an unbounded DynamoDB item or a transaction rewriting all history. P1 defines bounded head reads, immutable-row reads and append/delta mutations before P2 implementation. Root head changes always use aggregate revision CAS. Store immutable metadata/version rows separately and page every collection; state, appended rows, receipt, audit and outbox must commit together. Reject an oversized single command before writes. Never split a logically atomic mutation across independent transactions.

**Destruction rule:** A hold request may be pending while an irreversible provider deletion is in flight. Serialize per-document cleanup under durable destruction permits; do not acknowledge a hold as active until an earlier permit is resolved and provider protections are applied. Do not expire a timed-out permit and assume the destructive call stopped. A pending hold prevents new destructive permits. P3 supplies the state machine and race proof.

**Live test convention:** Unit/contract tests under `test/documents*/` use injected fakes and run normally. Real-cloud suites under `test/aws-documents/` skip unless `FLOWKITFORM_AWS_TEST_APPROVED=true` and an explicit deployment output file/account/region is provided. With that flag set, missing configuration is a failure, never a skip. No tests create environments or migrate databases. Test-owned fixture destruction is confined to the explicitly approved isolated test deployment.

## Accompanying wave and implementation checklist

### Wave 0: Baseline and deployment decisions

- [ ] Record clean/dirty workspace state, existing test baseline and installed package exports; use an isolated worktree at execution time where required.
- [ ] Review P1–P7 and select execution method. The authorization to write all plans does not select subagents.
- [ ] Start P4 Task 1 read-only evaluation matrix and P6 Task 1 compatibility inventory; neither requires executing models or deploying infrastructure.
- [ ] Prepare `docs/decisions/aws-release-config.md` from P2 Task 1: account/region/issuer/audience/membership endpoint, size/concurrency/cost limits, recovery objectives, external runtime and credential references. Missing real values block deployment, not local implementation.

**Exit:** all plans read; dependency ownership agreed; baseline recorded. No product functionality claimed.

### Wave 1: Portable foundation

- [ ] Execute P1 Tasks 1–5 in order, including the bounded persistence clarification above.
- [ ] Run portable contract suites, typecheck and build; preserve existing demo behavior.
- [ ] Review the public contract diff before provider implementations consume it.

**Exit:** immutable content/history, current permissions, atomic commits and publication/deletion fences have executable contract coverage.

### Wave 2: AWS evidence vertical slice

- [ ] Execute P2 Tasks 1–6 in order; prepare CDK synthesis and deployment diff before seeking any missing cloud approval.
- [ ] Deploy only into an explicitly authorized test environment, then run real-cloud atomicity, upload reuse/multipart and isolation tests.
- [ ] Start P4 Tasks 2–3, P5 Tasks 1–2 and P6 Tasks 2–3 after their P1/P2 interfaces land. These streams can be worked independently, but must not edit shared API composition concurrently.

**Exit:** authorized API client can create a document, upload/complete immutable bytes, query history and download an exact version with durable audit/event intent.

### Wave 3: Governance and processing

- [ ] Complete P3 Tasks 1–4 and P4 Tasks 1–5; production OCR integration waits for its engine/hosting gate.
- [ ] Prove pending/active hold semantics and deletion reconciliation before exposing destructive release APIs.
- [ ] Complete P5 indexing and text ingestion integration with real processing artifacts.

**Exit:** controlled external submission, version-specific OCR/results, retained histories and complete deletion work across original and derived data. Fake OCR alone cannot pass this wave.

### Wave 4: Search and workflow assembly

- [ ] Complete P5 Tasks 1–4 and P6 Tasks 1–5; use evidence IDs/revisions across the boundary.
- [ ] Register the final API routes and regenerate/validate OpenAPI once the route set is assembled.
- [ ] Run live search revocation/pagination tests and real-runtime evidence replacement and delivery-outage tests.

**Exit:** evidence can be found, reviewed and correlated to an exact historical snapshot; permissions and holds apply throughout.

### Wave 5: Release operations and acceptance

- [ ] Complete P7 Tasks 1–5, including repeated out-of-order delivery/deletion races, security negative tests and a restore drill.
- [ ] Record measured latency, throughput, cost and recovery results against deployment budgets; resolve failed gates.
- [ ] Prepare release artifact hashes, CDK diff, service dependency inventory and rollback instructions for final deployment review.

**Exit:** all approved-design acceptance cases have real assembled evidence. Release deployment requires existing or newly obtained authorization for its concrete target.

## Open deployment and engine gates

| Gate | Owner | Can continue while unresolved | Required before |
| --- | --- | --- | --- |
| Real AWS account/region, spending/capacity/recovery budgets | P2 Task 1 | Offline code, fakes, synth with explicit synthetic values | Live test deployment and release |
| OIDC issuer/audience, membership directory and service credentials | P2 Task 4 | Typed adapter and negative-auth tests | Authenticated real API acceptance |
| Upload-verifier implementation and hosting | P2 Task 3 | Verification contracts and rejecting fixture | Making real uploaded evidence available |
| Authorized representative corpus, engine execution/adoption/hosting | P4 Tasks 1 and 4 | Portable processing contracts, job orchestration and fixture adapters | Real OCR acceptance and release |
| Supported runtime contract verification and external dependencies | P6 Tasks 1 and 3 | Binding models and bridge tests | Runtime deployment/assembled workflow acceptance |
| Actual OpenSearch region/capacity pricing and network policy | P5 Task 3 | Search contracts, authorization and coordinator tests | Collection deployment and live search acceptance |
| Production retention mode, backup-copy expiry and hold authority | P3 Task 2, P7 Task 4 | Governance state machine, simulated recovery | Destructive release operations and governance sign-off |
| Concrete target approval for deployment/restore | P2 Task 6, P7 Tasks 4–5 | Bundles, CDK diff, runbooks and evidence preparation | Target mutation |

No elapsed wait, passing fake, or design approval resolves one of these gates.

## Evidence ledger and completion rules

Create `docs/validation/aws-release-evidence.md` during execution with one row per plan/task: commit, exact command, environment, result, artifact location and unresolved failures. Never mark an entire wave complete from unit tests alone when its exit requires live services. Collect no raw certificate content or credentials in this ledger.

Local verification per code task: its focused tests, `bun run typecheck`, and appropriate build checks. Full root tests/build run at each wave exit; broaden only for changed integration concerns. Preserve existing Compose/browser CI alongside new document gates. Commits are scoped to each task; never commit credentials or deployment outputs.

## Self-review and handoff

Every approved design goal maps to P1–P7; P7 owns the full coverage matrix. No UI, GCP/Azure adapters or runtime extension is scheduled. Native execution minimizes context churn for shared contracts; subagent-driven execution provides independent per-task review. Review the full plan set and choose the execution approach before starting implementation.

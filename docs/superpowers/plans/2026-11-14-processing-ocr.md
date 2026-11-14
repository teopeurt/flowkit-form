# First-Class Processing and OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver version-specific extraction jobs, native text/OCR routing, results/history APIs and evaluated adapter implementations without coupling OCR engine choice to AWS.

**Architecture:** Portable inspection/extraction/rendering/parser contracts feed an asynchronous application service. Bounded work units execute in document workers or registered approved remote services; durable job records handle polling/callbacks/retries. Artifacts remain in authorized storage, registered with governance before publication.

**Tech Stack:** TypeScript/Bun, separate `@flowkit-form/document-processing` package, DynamoDB/SQS/S3 AWS adapters, adapter-specific native/runtime dependencies only after evaluation. pdf-inspector and Unlimited-OCR remain candidates, not implicit installations.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [master waves](2026-11-14-release-waves.md). P1/P0 required for shared services/API; P2 for AWS deployed jobs; CF1/CF2/CF3 Task 1 for Cloudflare. P3 owns common cleanup interfaces.

## Parallel-provider ownership

This plan implements shared services first and the AWS provider portion second.
The [approved Cloudflare amendment](../specs/2026-11-14-cloudflare-alternative-design.md)
and [master waves](2026-11-14-release-waves.md) apply to every task. Commit and
verify portable outputs before AWS adapters so Cloudflare can consume them
without waiting for AWS implementation or deployment. The shared API/identity,
upload/artifact/reader/delivery and runner-neutral test boundaries belong to
[P0](2026-11-14-shared-provider-contracts.md). Do not recreate them in this plan.

## Global Constraints

- “OCR is a central product capability, not merely a generic extension hook.”
- “OCR adapters are independent of cloud infrastructure adapters”.
- “Pin profile and adapter/model revisions to each run.”
- “no silent provider switch that changes data handling or loses multi-page context.”
- “confidence only when supplied by the engine”; do not synthesize comparable confidence.
- Model execution/adoption/hosting requires the evaluation authorization described in the design. A fake engine does not satisfy release acceptance.

## Review Focus

- Encrypted/corrupt/oversized or decompression-bomb PDFs fail boundedly without exhausting a worker (Tasks 1–2).
- Mixed PDF text order and coordinate systems remain traceable by page/source (Tasks 2–3).
- Callback arrives twice or after newer attempts/deletion: preserve history without overwriting current results (Task 3).
- Whole-document engine silently receives split pages: capability/profile validation rejects it (Task 2).
- External endpoint leaks tenant data or returns hostile artifacts: allowlisted configuration, job-scoped access and validated results only (Tasks 3–4).

### Task 1: Evaluation corpus and engine/hosting decision

**Files:** Create `docs/decisions/ocr-evaluation.md`, `scripts/documents/evaluate-ocr.ts`, `test/fixtures/documents/manifest.json`, `test/document-processing/evaluation.test.ts`; add a root `documents:evaluate-ocr` script.

**Interfaces:** `EvaluationCase = { id: string; mediaType: string; fixtureRef: string; category: 'native' | 'scanned' | 'mixed' | 'image' | 'multipage' | 'invalid'; language: string; expectedTextRef?: string; expectedPageCount?: number }`; `evaluateEngine(adapter, corpus, limits): Promise<EvaluationReport>` reports page ordering, text/layout fidelity, failures, latency, peak memory, cost assumptions, revision/license and hosting constraints. No private customer documents in committed fixtures.

- [ ] Test manifest validation, missing language/document categories, report provenance, no fabricated metrics, and runner refusing model/remote execution without explicit evaluation enablement and configured adapter. Include generated benign native/scanned/mixed/image/multi-page fixtures plus encrypted/corrupt/limit cases; synthetic fixtures are smoke tests, not proof of real certificate fidelity.
- [ ] Run `bun test test/document-processing/evaluation.test.ts`; expect missing runner failures.
- [ ] Implement metadata-only runner by default. Inspect and cite [pdf-inspector documentation](https://github.com/firecrawl/pdf-inspector) and [Unlimited-OCR model card](https://huggingface.co/baidu/Unlimited-OCR); pin candidate commits/model revisions and dependency licenses. Prepare representative redacted/authorized corpus protocol and cost/latency/resource acceptance budgets from deployment config. Ask only for missing corpus/engine execution or hosting authorization when evaluation is ready to run; continue portable tasks meanwhile.
- [ ] Run manifest/report tests. When authorized, execute evaluated adapters against representative languages/certificates/signed documents and record measured results. Record an explicit decision selecting inspector/native extractor/renderer and OCR provider plus execution mode, data residency/credentials, cancellation and cleanup behavior. If none meets constraints, keep release gate open and propose a measured alternative; do not silently choose Textract or GPU hosting.
- [ ] Commit: `docs: define reproducible document extraction evaluation`.

### Task 2: Portable capability contracts and normalization

**Files:** Create `packages/document-processing/package.json`, `packages/document-processing/src/{contracts,profiles,normalize,index}.ts`, `test/document-processing/{capabilities,normalization}.test.ts`; update root manifest/lockfile.

**Interfaces:** `ProcessingSource = { ref: DocumentRef; versionId: string; artifact: ArtifactRef; lifecycleGeneration: number }`; `ProcessingContext` adds runId, attemptId, correlationId, operationId and deadline. `AdapterCapabilities` declares mediaTypes, languages, inputModes (`image | pages | document`), maxBytes/maxPages, optional output features and completion modes. `Inspector.inspect(source, context): Promise<Inspection>`; `NativeExtractor.extract(source, pageNumbers, context): Promise<ExtractionResult>`; `Renderer.render(source, pageNumbers, context): Promise<readonly RenderedPage[]>`; `OcrParser.parse(input: ParserInput, context): Promise<ParserOutcome>`; `ResultNormalizer.normalize(raw, context): Promise<ExtractionResult>`. `ParserInput` is discriminated by image/pages/document and holds artifact refs only. `ParserOutcome` is `{ kind:'complete'; result: ExtractionResult } | { kind:'pending'; providerJobId: string; pollAfter: string }`; parser declares optional `poll` and `cancel` capabilities.

`ExtractionResult` has source version, run/attempt/engine/model/profile revisions, ordered page outcomes (`succeeded | failed`), method (`native | ocr | parser`), text/artifact refs, optional engine confidence/layout/tables and provider artifact refs. Layout records coordinate units, dimensions, page number and source provenance. `ProcessingProfile` names exact adapters/revisions, limits and explicit fallback rules. Failed pages make overall run `failed` with partial results visible; no false full success.

- [ ] Test native-only routing skips OCR, mixed PDF routes selected pages and merges page order, image mode, full-document-only engines reject page splitting, unsupported language/format fails or uses explicit allowed fallback, partial failure remains visible, and absent confidence/layout stays absent. Test page/pixel/byte/deadline bounds and reject invalid coordinates/provider refs outside job namespace.
- [ ] Run `bun test test/document-processing/capabilities.test.ts test/document-processing/normalization.test.ts`; expect missing exports.
- [ ] Implement profile validation, route planning and result schema validation independent of SDK/native packages. Renderer output includes page dimensions/DPI and artifact provenance. Normalize known schema while retaining optional provider artifacts by authorized reference; never force unsupported fields or overwrite human-reviewed values.
- [ ] Run focused tests plus root typecheck/build; expect PASS and no AWS/native engine imports in the portable package.
- [ ] Commit: `feat: define portable extraction capabilities and results`.

### Task 3: Durable jobs, attempts, dispatch and completion

**Files:** Create `packages/document-processing/src/{jobs,service,hooks}.ts`, `packages/documents-aws/src/processing/{store,dispatcher,completion,cleanup}.ts`, `apps/document-api/src/workers/processing.ts`, `test/document-processing/jobs.test.ts`, `test/aws-documents/processing.integration.test.ts`; update exports/CDK.

**Interfaces:** `ProcessingService.start(context, { ref, versionId, profileId }): Promise<{ runId: string }>`; `get(scope, { ref, runId }): Promise<ProcessingRun>`; `reprocess(context, { ref, versionId, profileId }): Promise<{ runId: string }>`; `complete(serviceContext, { runId, attemptId, providerJobId, result }): Promise<void>`. `ProcessingRun` states `pending | running | succeeded | failed`, with immutable source/profile revisions and paged attempt/page-result references. `ProcessingStore.createRun/claimAttempt/recordOutcome` use bounded CAS records plus audit/outbox; run creation checks document lifecycle generation atomically. Registered trusted hooks receive the same context/artifact constraints and durable attempts, not user executable code.

- [ ] Test duplicate source-event starts one automatic run, manual reprocessing creates a separate run, retry records a new attempt, deadline/poll timeout fails boundedly, partial page results persist, duplicate/stale callbacks do not replace newer outcomes, revoked service grant blocks dispatch, and deletion before/after remote output leaves cleanup obligations. Test crash after remote submit uses stable provider operation ID or reconciliation before resubmitting.
- [ ] Run `bun test test/document-processing/jobs.test.ts`; expect missing lifecycle methods.
- [ ] Implement portable orchestration through P0 delivery and P4 ProcessingStore first, then the AWS SQS dispatcher, with bounded per-stage work, resumable page batches and deadline checks. Pending provider jobs persist handles and schedule polling; callback routes authenticate the configured service and bind tenant/run/attempt/job ID. Register source and possible output leases with P3 before external writes; artifacts inherit retention/holds. No source bytes or extracted text in queue payloads. Explicit fallback creates a recorded attempt with selected provider, never a hidden switch. Register cleanup provider owner `processing` to cancel/reconcile all remote jobs and artifacts.
- [ ] Run offline suite and authorized AWS fixture-provider tests; prove duplicate/out-of-order delivery, DLQ/manual replay and cleanup after delayed completion. These test transport/lifecycle, not OCR quality acceptance.
- [ ] Commit: `feat: orchestrate durable version-specific extraction jobs`.

### Task 4: Implement evaluated engine adapters and execution packaging

**Files:** Create `packages/document-processing/src/adapters/{remote-inspector,remote-renderer,remote-parser}.ts`, `packages/documents-aws/src/processing/adapters/{pdf-inspector,native-renderer}.ts`, `deploy/aws/src/processing-resources.ts`, `test/document-processing/adapters.test.ts`, `test/aws-documents/ocr-engine.integration.test.ts`; add engine-specific lock/manifests only for approved selections.

**Interfaces:** `createInspector(config): Inspector & NativeExtractor`, `createRenderer(config): Renderer`, `createRemoteParser(config): OcrParser`; config includes pinned engine/model revision, registered endpoint/credential refs, limits and capabilities. Every adapter implements Task 2 contracts. Shared HTTP transports live in document-processing; CF3 supplies Worker credential/artifact wrappers and reuses those transports instead of forking engine protocol logic. A remote bridge accommodates Unlimited-OCR without putting model code in the API; implement a specific engine transport only after Task 1 selects and authorizes it. If pdf-inspector is rejected, replace its adapter file with a name matching the evaluated selection and update manifest/plan evidence; preserve contracts.

- [ ] Test process/container timeout, native dependency load failure, missing models, overlarge renderer output, remote authentication error, remote result schema mismatch, redirect to unregistered host and cross-job artifact references. Test both synchronous result and asynchronous handle modes with adapter conformance suite.
- [ ] Run `bun test test/document-processing/adapters.test.ts`; expect absent adapters.
- [ ] Implement selected inspector/native extraction, bounded rendering and OCR transport. Package native binaries in a Lambda-compatible image/layer only if measured resource/runtime limits pass. Use separately hosted inference only with explicit approved hosting/resource declaration. Pin dependencies, disable arbitrary caller endpoints and remote executable loading in ordinary API/worker paths. Limit job credentials by source/output namespace and expiry; keep them out of logs.
- [ ] Run selected adapter suites and representative corpus under authorized target runtime; record page fidelity/latency/memory/cost, current licenses and engine revisions. Fail release if serverless constraints or extraction budgets are not satisfied; do not claim adapter stubs are adopted engines.
- [ ] Commit: `feat: integrate evaluated document extraction adapters`.

### Task 5: Processing APIs and assembled extraction acceptance

**Files:** Create `apps/document-api/src/routes/processing.ts`, `test/document-api/processing.test.ts`, `test/aws-documents/extraction-acceptance.integration.test.ts`, `docs/operations/document-processing.md`; update API dependencies/OpenAPI/CDK/evidence.

**Interfaces:** Routes POST `/v1/documents/{id}/versions/{versionId}/processing-runs`, GET same `/processing-runs` (paged), GET `/v1/documents/{id}/processing-runs/{runId}`, GET same `/{runId}/pages` and `/{runId}/results`, POST same `/{runId}/reprocess`. Add `processing.start` permission; metadata permission governs status and `content.read` governs extracted content/layout/artifact access. Callback route is service-authenticated and excluded from client submission operations. Add run/attempt/page pagination methods to ProcessingStore.

- [ ] Test authorization independently for status/start/results, grant revocation before artifact URL issuance, all history pages, error redaction and human-reviewed values kept distinct from machine output. Add real native/scanned/mixed/image/multi-page cases with expected page order/provenance and at least one partial failure/reprocess history.
- [ ] Run `bun test test/document-api/processing.test.ts`; expect unregistered route failures.
- [ ] Register routes and trusted processing hooks, document statuses/retry/reprocess and configured fallback behavior. Store result text separately and return bounded paginated data/artifact references; do not pass large full text through either provider's HTTP responses. Human review remains consumer/FlowKit policy.
- [ ] Create shared cases in `test/support/document-conformance/processing.ts`; run OpenAPI/offline suites and authorized real engine + AWS acceptance, with CF3 Task 4 executing the same cases on Cloudflare; verify P3 cleanup contract and search-ingestion events for P5. Record current engine adoption/hosting decision as a required release artifact.
- [ ] Commit: `feat: expose first-class extraction status and result history`.

## Self-review and handoff

The design's Inspector, Native extractor, Renderer, OCR/parser and normalizer all have contracts, tests and evaluated adapter work. Native-only, scanned, mixed, image, multi-page, partial, retry and deletion behavior are covered. Task 1 may start in Wave 0 read-only; implementation can continue with fixtures while engine execution/hosting is unresolved, but full OCR acceptance cannot be marked complete until Task 4's gate passes.

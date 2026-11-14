# FlowkitForm document management design

Status: approved by the user on 2026-11-14; implementation not started.

## Relationship to existing documentation

This approved design supersedes conflicting target requirements in
`docs/spec.md`, `docs/architecture.md`, and `docs/roadmap.md`. Those documents now
separate the active direction from their historical target content. The active
direction is portable persistence with DynamoDB in AWS, first-class OCR, an
API-first release with separately scoped UI, and a separate FlowKit integration
using an explicitly external supported runtime. Existing PostgreSQL, BetterAuth,
and Temporal dependencies remain part of the current application until an
explicit migration or external-service composition replaces them. Approval does
not authorize a runtime rewrite, UI work, engine adoption, or cloud deployment.
The reconciliation in `docs/spec.md` records carried-forward, deferred, and
retired legacy requirements; implementation plans use this design as authority.

## Intent and agreed scope

FlowkitForm is a document management system for structured and unstructured
content. Its first use case is a regulated company receiving certificates and
signed documents from staff or customers as evidence for applications. Evidence
is checked, audited, and approved through FlowKit workflows.

FormKiQ is a capability reference, not a selected backend or an API compatibility
requirement: https://raw.githubusercontent.com/formkiq/formkiq-core/refs/heads/master/docs/openapi/openapi-jwt.yaml

Deploy to AWS serverless first, GCP serverless second, Azure serverless third.
FlowKit integration is required in the assembled product but lives in a separate
module. Extending FlowKit to additional execution backends is separate work.

## Goals

- Upload, durably store, retrieve, and version documents, including direct large-file uploads.
- Classify documents through types, tags, custom metadata, issuer and expiry attributes.
- Associate evidence with applications and other consumer-owned business records.
- Search metadata and extracted text with authorization-aware filtering.
- Provide first-class OCR and document extraction, expose status and results, and support extensible processing hooks.
- Integrate document events and operations with FlowKit review and approval processes.
- Preserve document audit history and correlate decisions with exact evidence versions.
- Enforce tenant isolation, document permissions, and controlled external submission/access.
- Support retention, legal holds, controlled deletion, and deletion audit records.
- Provide documented APIs, pagination, consistent errors, idempotent mutations, and versioned events.
- Deliver AWS infrastructure as code, encryption, monitoring, recovery procedures, and failed-processing visibility.

## Non-goals and anti-goals

No visual workflow designer, electronic signing, automated signature verification,
or advanced AI classification in this release. Accepting a signed file does not
certify its signature. No application-specific approval or replacement rules in
the document core. No new FlowKit runtime backend. No GCP/Azure implementations
in the AWS release. No requirement to copy FormKiQ endpoints or implementation.

Avoid AWS-specific types in portable contracts, accidental cross-tenant search
disclosure, silently lost audit events, approvals pointing at mutable latest
content, and claiming all components are cloud-native serverless while hiding a
workflow runtime dependency.

## Approaches

1. AWS implementation followed by portability extraction: fastest start, but later clouds risk a rewrite.
2. Portable document core with cloud adapters: some initial contract work, but stable behavior across deployments. **Selected by the user**, implementing AWS adapters first.
3. Common infrastructure stack across clouds: uniform operations, but restricts native serverless choices.

## Ownership and modules

Proposed implementation choices below are design recommendations, not additional
requirements supplied by the user. Build on the repository's TypeScript, Bun,
compiled package exports, and consumer-owned dependency injection conventions.

- Document core: identifiers, metadata, immutable content versions, associations,
  processing records, audit contracts, retention constraints, and application services.
- API module: authentication boundary, validation, upload/download authorization,
  pagination, idempotency, and consistent errors.
- FlowKit integration module: required at product assembly; connects documents to
  workflow subjects, consumer actions, registered steps, and task references using
  public exports only. It does not own approval policy or task eligibility.
- Provider adapters: object storage, transactional metadata/audit persistence,
  asynchronous delivery, text extraction, search indexing, and key management.
- AWS deployment: infrastructure and composition of the above modules.

Physical package names and granularity are left to the implementation planner.
Existing packages must retain their current responsibilities.

### Document access and FlowKit authentication/authorization

These are distinct, complementary concerns, as clarified by the user. FlowKit
auth supplies identity and workflow authorization contracts. FlowkitForm owns
document access: permission to discover, view metadata, download content, upload
versions, modify metadata, share, or request deletion. Workflow role or task
eligibility alone does not confer document access; document access alone does
not authorize a workflow transition.

The document access module consumes authenticated principal and tenant context
and evaluates document-specific permissions independently. Its permission model
and policy storage are separate from workflow definitions and task eligibility.
Planner choices include the representation of grants and policy evaluation;
they must support explicit document grants and revocation for principals or
groups, operation-specific permissions, and tenant isolation. These are proposed
baseline mechanics, not a claim that the user selected a particular ACL/RBAC
implementation. Workflow integrations use authorized service identities or
explicit document grants; a workflow event never bypasses document permissions.
Search visibility, API operations, external grants, and processing access must
respect this same boundary.

FlowKit owns stages, transitions, routing, eligibility, maker-checker rules, SLAs,
approval decisions, and whether corrected evidence can continue an application.
FlowkitForm owns the evidence and document operations. Retention and legal holds
constrain those operations regardless of a workflow's requested action.

## Data and behavior

A tenant-scoped document has a stable ID, classification, metadata, associations,
and content versions. A version identifies immutable bytes, checksum, media type,
size, uploader, and creation time. Metadata changes have revisions and audit
records; reviews capture the content version and relevant metadata revision.
Each metadata revision preserves an immutable snapshot or a losslessly
reconstructable history of its values. Authorized APIs can retrieve the exact
revision referenced by a review, using current document permissions rather than
historical grants. Historical metadata inherits the document's retention, legal
hold, and deletion rules. Review references remain identifiable after permitted
deletion, but do not justify retaining deleted sensitive values.
An application remains a consumer business record referenced by type and ID;
FlowkitForm does not become an application management system.

Uploads begin with an authorized intent and restricted upload destination.
Completion verifies stored content before making a version available. Duplicate
completion delivery must not create duplicate versions or processing work.
Abandoned uploads expire. File limits and allowed types are deployment settings.
Upload destinations are staging locations. Completion binds verification and
publication to one immutable storage generation, or promotes verified bytes to
a protected immutable object before publication. Outstanding upload credentials
must not be able to alter published content. Verification, checksum, download,
and processing references all identify those same bytes; a mutable object key
alone is insufficient. Repeated or concurrent completion must select the same
generation or fail explicitly, never rebind an existing document version.
External upload grants are tenant- and purpose-scoped and do not grant broad
document listing or retrieval.

Processing is asynchronous and version-specific. Status includes pending,
running, succeeded, and failed; retries and manual reprocessing preserve attempt
history. Original content is retained separately from extracted text and results.
Processing hooks are registered trusted integrations, not arbitrary executable
code submitted through the document API. Specific malware scanning integration
is left to the planner; unverified uploads must not enter normal retrieval or processing.

### First-class OCR and extraction

OCR is a central product capability, not merely a generic extension hook. The
user supplied these references:

- https://github.com/firecrawl/pdf-inspector
- https://huggingface.co/baidu/Unlimited-OCR

The inspected pdf-inspector documentation describes PDF classification,
position-aware native text extraction, and per-page OCR routing. It also offers
selective local OCR with external runtime/model dependencies. Unlimited-OCR's
model card documents image and multi-page parsing, PDF page rendering, and
GPU-based inference. Neither reference alone establishes an AWS serverless
deployment architecture or acceptable performance on this product's documents.

Proposed pipeline: inspect PDFs, extract usable native text directly, render and
route scanned/image pages or pages with unusable text to an OCR provider, then
normalize results into version-specific extraction artifacts. Images go directly
to OCR. Preserve page order and provenance when combining native and OCR output;
retain an explicit full-document parsing route for engines that benefit from
multi-page context rather than assuming page splitting is always equivalent.

First-class APIs expose job status, page-level outcomes, extracted text and
structured layout where available, processing errors, and reprocessing. Record
engine/model revision, configuration, source version, extraction method, and
confidence only when supplied by the engine; do not invent a comparable score
across engines. Preserve previous extraction runs and distinguish machine
extraction from human-reviewed values. OCR output does not itself approve a
document or validate a signature.

The user requires an adapter-based architecture that can accommodate these
modules; the specific implementations are evaluation candidates. OCR adapters
are independent of cloud infrastructure adapters: deployment on AWS must not
imply use of an AWS OCR engine.

Define the following portable processing boundaries (names are provisional):

- Inspector: accepts a document-version reference and returns document/page
  characteristics, usable-text assessments, and suggested extraction routes.
- Native extractor: returns native text and available layout with page/source
  provenance. One implementation may provide both inspection and extraction.
- Renderer: produces bounded page images for engines requiring image inputs,
  preserving page numbers, dimensions, and rendering configuration.
- OCR/parser: accepts supported image, page-set, or whole-document inputs and
  returns text plus optional layout, tables, and engine-specific artifacts.
  Supports synchronous completion or asynchronous job handles with polling or
  completion delivery; the application API remains asynchronous in either case.
- Result normalizer: validates and persists a common result envelope while
  retaining provider-specific artifacts by reference, without forcing every
  engine to supply the same layout or confidence fields.

Adapters declare capabilities: input formats, languages, page/document modes,
input limits, output features, and execution/completion modes. A processing
profile selects adapters and explicit fallback rules according to those
capabilities. Pin profile and adapter/model revisions to each run. Unsupported
inputs fail explicitly or follow a configured fallback; no silent provider
switch that changes data handling or loses multi-page context.

Contracts carry tenant context, source-version and artifact references,
idempotency/correlation IDs, deadlines, and normalized retryable/permanent errors.
Large binaries and results remain in authorized artifact storage. External
inference receives access scoped to the job; artifacts inherit document access
and retention controls. Registered adapter configuration determines execution
location and credentials, not caller-supplied arbitrary endpoints.

The processing application service owns inspection, dispatch, result persistence,
and job lifecycle. FlowKit owns business decisions triggered by those outcomes;
processing mechanics do not become approval policy. Local native modules,
container workers, and remote inference services may implement the same contracts,
but each deployed implementation must satisfy the agreed deployment constraints.

Contract tests cover capability negotiation, native-only PDFs, scanned and mixed
PDFs, image uploads, multi-page context, duplicate completion, partial page
failure, timeout/retry, result normalization, access control, and provenance.
Engine evaluation uses representative documents behind these same contracts so
adoption or replacement does not require redesigning the document API.

Keep inspection/extraction and OCR inference behind separate portable adapters.
Evaluate pdf-inspector as the initial PDF inspection/native extraction candidate
and Unlimited-OCR as an inference candidate. Specific engine adoption and hosting
remain unapproved pending an evaluation of representative certificates and signed
documents, languages, layout fidelity, latency, memory, cost, deployment support,
and dependency licensing. First-class OCR is required; these links are candidates,
not an instruction to execute model code or deploy inference infrastructure.

OCR inference may require a separately hosted service. Its deployment must be
resolved explicitly against the serverless requirement; do not silently assume
GPU inference runs inside the document API's functions. Cloud-managed OCR remains
an adapter alternative, rather than an AWS dependency in the document core.

Metadata and full-text search may be eventually consistent. Metadata persistence
remains authoritative. Search queries must apply tenant and permission filters;
retrieval rechecks authorization, including after permission changes. Indexes
must be rebuildable from stored documents and extraction results.
An indexed permission is only a candidate filter: every search response must
enforce current authoritative document permissions before exposing identifiers,
metadata, snippets, extracted text, or other document-derived information.
Permission revocation must take effect for subsequent search requests without
waiting for reindexing; if current authorization cannot be established, fail
closed. Counts, facets, and aggregations must use the same authorized set or be
omitted; totals from an unfiltered candidate set must never be returned.
Pagination uses opaque tenant/query-bound cursors, reauthorizes each page, and
advances through candidates without disclosing denied candidates or their count.
An adapter unable to meet these guarantees must disable the affected search
features rather than rely on download-time checks.

Mutations commit state and durable audit/event intent together. Delivery uses
at-least-once semantics, stable event IDs, deduplication, bounded retries, and a
failed-delivery queue with replay controls. No cross-service exactly-once claim.
Audit captures actor/service identity, tenant, operation, target version/revision,
timestamp, correlation and operation IDs, and relevant changes. Access grants
and content delivery events should be distinguishable; issuing a download URL
does not prove a person read the file.

Retention and legal holds apply to originals, versions, derived content, and
indexes. Deletion is a tracked operation with retries and completion status;
legal holds block destruction. Preserve permitted audit/tombstone information
without retaining deleted sensitive content in logs or event payloads. Retention
durations and hold authority are consumer configuration, not universal defaults.
Deletion first records a durable tombstone and advances a document lifecycle
generation in authoritative storage. Upload publication, processing dispatch,
artifact publication, indexing, retries, replay, and rebuild paths must check
that generation and reject work for a deleted or superseded lifecycle. Artifact
creation must coordinate with deletion so that an in-flight writer cannot leave
untracked content: use fenced publication plus cleanup of unpublished objects,
or an equivalent adapter guarantee. Late provider callbacks cannot restore a
document or publish results; any returned artifacts enter deletion cleanup.
Deletion completion requires reconciliation of originals, staged uploads,
metadata history, extraction artifacts, and indexes, including outstanding work
and provider cleanup obligations. Pending or failed cleanup remains visible and
retryable. Retain the minimal non-sensitive tombstone needed to reject delayed
deliveries. Hold creation and destruction authorization must be serialized so
that an accepted hold prevents subsequent destructive steps; completion cannot
be reported while a hold or cleanup obligation remains unresolved.

## FlowKit integration contract

Use the current `FlowRuntime` and `FlowkitConsumer` contracts; supply adapters
through consumer dependencies. A document ID, version ID, and metadata revision
are passed by reference, not binary content. Persist associations between
documents, business records, flow IDs, and review references.

Document events do not blindly become approval actions. Consumer-supplied
bindings map events to permitted workflow operations and registered processing
steps. FlowKit remains authoritative for transition decisions. Integration must
deduplicate deliveries and expose failures without rolling back a valid stored
document. An approval of version A must never implicitly approve replacement B.

The initial deployment connects to an existing supported FlowKit runtime.
Temporal or any other FlowKit execution service is an explicit external
dependency. FlowkitForm's own AWS components are serverless; a fully AWS-native
workflow runtime is not a prerequisite delivered by this project. Runtime
availability and configuration are deployment prerequisites.

## AWS deployment proposal

Use native AWS serverless services behind adapters: S3 for content, Lambda and
API Gateway for APIs/workers, DynamoDB for authoritative records and transactional
outbox/audit intent, and SQS for work and failed delivery. OCR provider and hosting
are subject to the first-class OCR evaluation; Textract is an AWS-managed
alternative, not a selected default. Use an authorization-aware search adapter with an AWS serverless search
service; exact engine and cost profile are planner choices. Infrastructure tool,
identity provider integration, region, capacity limits, recovery objectives, and
index mappings are also left to the planner or deployment configuration.

Encrypt content and records, use least-privilege identities, avoid document
content in operational logs, and instrument queue age, processing failures,
delivery failures, and search lag. Provide replay/reindex tooling and documented
backup/restore exercises. Availability, quotas, and cost of chosen AWS services
must be verified against official documentation during planning.

GCP and Azure adapters must satisfy the same behavioral contracts. Do not choose
their service mappings before their implementation phases. Shared contract tests
should exercise each provider's persistence, delivery, search, and processing
semantics as it is introduced.

## Acceptance and validation

An authorized customer or staff member can upload evidence, attach it to a
business record, find it by permitted metadata/text queries, and retrieve a
specific version. OCR status and results are visible. A configured FlowKit flow
can review that version and correlate its decision with document history.
Replacement produces a new version without altering the reviewed evidence;
continuation behavior is selected in the flow definition.

Verify tenant isolation across upload, download, search, processing, and audit;
duplicate/reordered event handling; upload completion races; processing retries;
stale search permissions; retention/hold versus deletion races; and recovery
from delivery or indexing failures. Exercise the assembled AWS deployment and
its configured FlowKit runtime, rather than relying only on mocked adapters.
Specifically verify that revoked documents disappear from search hits, snippets,
counts, facets, and later cursor pages before index permission updates; that
reusing upload credentials after completion cannot change published bytes; and
that concurrent completion cannot bind verification to different content.
Retrieve the exact metadata values from an earlier review after later edits.
Race deletion against upload completion, OCR callbacks, artifact writes,
indexing, replay, and rebuild, and verify that no content is resurrected and
completion waits for all cleanup obligations. Race hold creation against each
destructive step and verify the authoritative ordering is respected.

## Scope and next step

This is a multi-module project. After design approval, write an implementation
plan with incremental AWS milestones and required integration checks. This
document authorizes no runtime extension or product UI design. The first release
is API-first; any submission/reviewer UI requires separate scope agreement.

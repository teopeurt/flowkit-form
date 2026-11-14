# Cloudflare deployment alternative design amendment

Status: approved by the user on 2026-11-14; implementation not started.
The user confirmed Cloudflare alongside AWS in the first release and selected
D1 as Cloudflare's authoritative store on 2026-11-14. Those scope/approach
choices and the detailed mechanisms below are approved design decisions.
Implementation has not started.

## Intent, scope and authority

Extend the [approved document design](2026-11-14-flowkitform-design.md) with a
complete Cloudflare deployment alternative. AWS and Cloudflare are first-release
targets, each independently runnable against the same portable document core and
behavioral contracts. A Cloudflare document deployment does not require S3,
DynamoDB, SQS, Lambda or OpenSearch. Each product assembly still requires a
supported external FlowKit runtime and configured identity/verification/OCR
services, as the base design already states. The external services and their
hosting must be declared; Cloudflare does not become a new FlowKit runtime.

This amendment changes deployment sequence and adds provider implementations.
It preserves exact evidence versions, independent document permissions,
authorization-aware search, first-class extraction, retention/holds, deletion
fences, atomic audit/event intent and recovery requirements. Behavioral parity
means the same supported operations and invariants, not identical service
quotas, prices, search relevance, latency or regulatory certifications. Neither
provider may omit a required capability and still count as release-complete.

Each tenant belongs to one configured deployment/provider in this release.
Live cross-provider replication, automatic failover, active-active writes,
AWS-to-Cloudflare migration tooling, UI, GCP/Azure implementation, signing,
signature validation and new workflow runtimes remain out of scope. GCP then
Azure follow the first AWS/Cloudflare release in later phases.

## Approaches considered and selected

1. **D1 authoritative metadata/lifecycle with R2 and Queues — selected by the
   user.** State, operation receipts, audit and outbox live in one transactional
   D1 shard. D1 FTS5 supplies a rebuildable search index. This minimizes separate
   authority/projection systems, while imposing database-size and SQL/Worker
   execution bounds that the adapter must enforce.
2. Durable Objects authoritative per-document state with D1 search projection.
   Strong local coordination, but adds authority-to-projection recovery and
   coordination for tenant/actor-wide receipts and cross-document references.
   Not selected. Durable Objects may be introduced later only for a demonstrated
   infrastructure coordination need; they are not a required second source of
   document truth in this release.

D1 batch statements execute transactionally and roll back on a statement error.
This supports the selected approach, but an update affecting zero rows is not
itself a transaction error. [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Provider composition and boundaries

| Responsibility | AWS lane | Cloudflare lane |
| --- | --- | --- |
| HTTP/API execution | API Gateway and Lambda | Workers Fetch entrypoint |
| State, grants, histories, audit/outbox, job/binding records | DynamoDB adapters | D1 adapters |
| Original and derived bytes | S3 immutable version references | R2 unique, application-immutable object references |
| At-least-once dispatch and failure queues | SQS and relay | Queues and durable D1 relay |
| Scheduled repair/reconciliation | AWS scheduled workers | Cron-triggered Workers plus durable checkpoints |
| Search candidates | OpenSearch Serverless | D1 FTS5 and indexed metadata SQL |
| Infrastructure and runtime configuration | CDK | Wrangler manifests, D1 migrations and scripted resource configuration |
| Heavy inspection/rendering/OCR | Evaluated adapters with declared hosting | Same contracts; bounded Worker-compatible or declared external execution |
| Business review and approval | Supported external FlowKit runtime | Same supported external FlowKit runtime boundary |

The planner should introduce `packages/documents-cloudflare` for provider
adapters and `deploy/cloudflare` for manifests/configuration. HTTP routing,
validation, errors, OpenAPI, identity resolution and permission checks remain
shared. Separate Lambda and Workers entrypoints translate their envelopes into
standard Request/Response or an equivalent provider-neutral handler contract.
Neither the shared API nor the portable services import AWS SDK clients or
Cloudflare bindings. Existing demo packages keep their responsibilities.

P2 currently owns some portable contracts alongside AWS files. Before either
provider is implemented, planning must move those contract deliverables to a
shared prerequisite task: upload/artifact interfaces, readers, paging/cursors,
identity, delivery envelopes/receipts and API dependencies. Cloudflare must not
wait for AWS SDK/CDK implementation to discover its required interfaces.

## D1 authority, transactions and tenant routing

Keep a tenant's document heads, immutable version/metadata rows, current grants,
retention/holds, upload/job/review records, mutation receipts, audit and outbox in
one authoritative D1 database. The configured tenant-to-database registry is
trusted deployment state; request parameters cannot choose a database. All
primary/foreign/unique keys include tenant scope where shared tables require it.
The current tenant/actor/operation receipt uniqueness is preserved across all
that tenant's documents. No required atomic operation spans D1 databases or R2.

Use a normalized bounded layout and the portable append/delta command contract.
A mutation transaction includes a checked expected aggregate revision, immutable
row appends, operation receipt, audit and outbox intent. Conditional failure must
abort the entire SQL batch: use an explicitly failing assertion/constraint or a
transaction-safe equivalent proven on actual D1. Do not run a CAS update, notice
zero changes after commit and leave audit/outbox side effects committed. Replay
of an identical operation returns its stored result; changed fingerprints
conflict. Provider/client retries do not replace durable application receipts.

Authorization, revocation, holds and deletion state read from the primary path,
not a replica that may miss another user's recent write. Initially leave read
replication unused for authoritative decisions. If it is later enabled, every
such read must explicitly route to primary; session ordering/bookmarks alone
are not a global latest-permission guarantee. [D1 sessions and replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

D1 currently limits each paid database to 10 GB and each query to 100 bound
parameters. Tenant admission reserves headroom for histories, outbox, FTS data,
leases and cleanup. Use an explicit tenant/database mapping and reject or pause
new nonessential writes before capacity exhaustion; never silently split a
mutation or redirect half a tenant to a new database. A larger tenant requires
an explicit future capacity/migration design, not automatic resharding in this
release. Provider-level deployment capacities can differ, but minimum supported
file sizes, corpus and workload acceptance must be recorded for both. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## R2 content identity and immutable uploads

R2 S3 compatibility does not include S3 bucket versioning. Portable
`ArtifactRef.generation` therefore represents an opaque immutable identity,
not a mandatory S3 VersionId. On R2, use a server-generated write-once object
ID/generation pair and namespace; never use an ETag as a version history or
whole-file SHA-256. Final object IDs are never reused, including after deletion.
[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

Staging and published content are separate private buckets or equivalent
isolated bindings. Uploaders receive only restricted staging PUT/part URLs;
they cannot complete arbitrary uploads, delete staged content or write final
objects. API/download/processing identities cannot retrieve quarantined bytes.
Single PUT credentials must cryptographically bind `If-None-Match: *`; acceptance
tests must prove removing/changing that condition invalidates the signature.
If that guarantee is unavailable for the deployed client path, use
server-completed multipart upload rather than issue reusable overwriting PUTs.
For multipart upload, the trusted service applies the create-only condition on
completion, not only initiation. All object keys are unguessable and unique.
[R2 conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/),
[reusable presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Completion reserves one source/intent and version ID durably before verification.
Definitively complete/reconcile the staging write, then verify the completed
immutable source. Stream SHA-256 with a bounded incremental implementation or
approved external verifier; do not buffer large files into Workers memory or
substitute a multipart/composite ETag. Type/size and configured safety checks
must pass before publication. Promote verified bytes to a unique final key
using create-only writes, verify destination identity, then publish its reference
in the D1 mutation transaction. A publication lease registers possible output
before writes/copies so a failed commit leaves a cleanup obligation.

R2 and D1 are not one transaction. Only D1-published, verified references are
available through ordinary retrieval/processing. Clients can read an exact
version even if its staging URL is reused; reuse cannot mutate that version.
Do not delete/recreate final keys. Unknown upload/copy/completion outcomes remain
tracked until definitively settled; one 404 is not proof a disconnected request
cannot later commit. Expiry/abort/cleanup cannot remove a source still in use by
verification. Published data is never subject to staging expiry. [R2 consistency
and unknown writes](https://developers.cloudflare.com/r2/reference/consistency/).

Private bucket bindings/S3 endpoints bypass public CDN content caching. Keep
public access and unauthenticated custom-domain caching disabled for evidence.
Current authorization is checked before downloads/results, with the same bounded
signed-URL expiry/revocation semantics on both providers. No claim that revoking
a grant retracts already downloaded bytes or already issued URLs instantaneously.

## Outbox, jobs and asynchronous work

D1 mutations commit delivery intent in the same batch as document state and
audit. Queues send is a subsequent operation, never presumed transactional with
D1. Relay claims and checkpoints are durable in D1. Send-then-crash may resend;
receipts are per consumer, stable event/operation IDs survive replay, and
out-of-order consumers check aggregate revision and lifecycle generation.

Queues provides at-least-once delivery and does not guarantee publication
ordering. Use retry/dead-letter configuration plus durable failed-delivery
records. A scheduled scan finds pending/expired relay claims and stalled work;
queue retention is not the durable replay source. Unknown remote side effects
cannot be cleared simply because a lease timed out. [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Processing contracts, page provenance, profiles/model revisions, native/OCR
routing and historical results are unchanged. Durable handles and callbacks
support work outside Worker limits. No native Rust/Python PDF binary or GPU
engine is assumed to execute inside Workers. Evaluate bounded WASM/Worker
implementations or registered remote inspectors/renderers/OCR services and
record hosting/data handling explicitly. Every external service uses job-scoped
access and participates in deletion/hold reconciliation. Cloudflare Workflows
is not a substitute FlowKit runtime; it is not required for this design.
[Worker resource limits](https://developers.cloudflare.com/workers/platform/limits/).

## Search and current permissions

D1 indexed SQL supplies metadata filtering; FTS5 supplies full-text candidates
from normalized extraction artifacts. Store enough source/generation/revision
provenance to reject stale candidates. Search text remains derived and
rebuildable; D1 document/grant rows remain authoritative. Chunk long extracted
text into bounded provenance-preserving rows below D1 row/statement/parameter
limits; a large result must not become one unbounded SQL row or Worker buffer. [D1 FTS5 support](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

Share query validation, allowed filters/sorts, response/error schema, cursor
binding and permission materialization with AWS. Every result rechecks current
primary document permissions; text matches/snippets also require content access.
No unauthorized IDs, titles, snippets, scores, counts or facets reach clients.
Omit totals/facets on both lanes unless computed over the fully authorized set.
Cursor contents are authenticated/encrypted and bound to tenant, actor, query,
index epoch and expiry; D1 uses a stable keyset instead of exposing SQL offsets.
Reauthorize every page, including when grant rows changed after cursor creation.

FTS refresh uses durable event receipts and lifecycle fencing. Candidate indexes
can lag; old events cannot publish deleted data. Rebuild uses a new epoch,
checkpoints and mutation catch-up, with atomic D1 catalog activation. Deletion
covers active/building/retiring FTS epochs and normalized-text artifacts. D1 SQL
operations do not make untracked external artifact writes transactional.

## Retention, holds and controlled deletion

The portable legal-hold/retention/deletion state machine is unchanged. D1 owns
pending/active holds, destructive permits, publication leases, lifecycle
generations and cleanup status. Accepted holds serialize against irreversible
operations: pending hold requests prevent new destruction, while a prior
in-flight/unknown destruction must settle before active acknowledgment.

Use R2 bucket lock rules to protect the exact per-document content/artifact
namespace for its configured retention or indefinite hold. Both originals and
derived artifacts must be inventoried/protected, including newly published
objects. R2 rules apply by prefix and are not S3 per-version Object Lock nor an
assertion of equivalent regulatory WORM certification. Current R2 configuration
allows at most 1,000 lock rules per bucket; deployments must reserve capacity,
provision a bounded bucket shard layout and account for retention and hold
rules before accepting documents or protection changes. Capacity exhaustion
cannot downgrade protection: leave the requested operation pending/failed with
a visible error and block destruction. [R2 bucket lock behavior and limits](https://developers.cloudflare.com/r2/buckets/bucket-locks/).

Bucket-rule changes affect a shared resource. Serialize all configuration writes
per bucket with a durable D1 operation/permit; preserve unrelated rules and
reconcile ambiguous updates before allowing another update. A request to shorten
or remove a lock is authorized only after the last applicable retention/hold
constraint is released. Do not acknowledge active protection until provider
confirmation is consistent with the D1 protection generation; a timed-out rule
update is pending/unknown. Runtime upload/index/processing roles cannot change
lock configuration. Privileged rule administrators are an explicit trust
boundary, not a promise of protection against the account owner.

D1 metadata/history/FTS and retained operation records are protected through
restricted application bindings and the same hold/destruction permit rules;
R2 locks do not protect SQL rows. Delete all current and staging objects, parts,
quarantine, extraction/remote artifacts, metadata histories and search epochs
through tracked providers. Late callbacks add cleanup obligations rather than
restore content. Completion waits for all unknown writes, protection changes,
remote jobs and recoverable sensitive copies to settle or expire. Tombstones
retain minimal non-sensitive IDs/generation and replay rejection records.

## Recovery, security and deployment operations

Cloudflare is a separate deployable profile with Wrangler bindings, explicit
compatibility date, environment separation, reviewed D1 migrations, bucket/queue
configuration scripts and secret references. Configuration includes tenant
routing, database/bucket capacities, identity issuer/audience/membership source,
verification/processing providers, URL expiry, workload/cost limits, data
location requirements and recovery objectives. Do not silently imply AWS KMS
customer-key features exist on every Cloudflare service: document native
protection and any unmet key-management requirement explicitly.

Apply the same least-privilege identity, log redaction, correlation, queue/job
failure visibility, reindex/replay and operational readiness contracts. No
metadata/content/credential leakage in queues, errors, logs or validation
artifacts. Verify actual account-plan pricing, service limits and data-location
features before target deployment; no cost advantage is presumed.

D1 Time Travel provides provider backups; it is not an R2 content backup and
currently cannot clone/fork a database into a new copy. Prove D1 export/import
and R2 object recovery in an authorized isolated environment, and test Time
Travel only on the isolated database. Maintain a separate restore-control ledger
for accepted holds/deletion generations/revocations and pending control intent;
if its completeness cannot be established, keep restored service closed.
Rebuild search from surviving authorized documents/extractions. Recovery copies
retaining sensitive values remain visible deletion obligations until expiry or
confirmed destruction; restoring a database does not erase its old bookmarks.
[D1 recovery capabilities and limits](https://developers.cloudflare.com/d1/reference/time-travel/).

## Parallel release waves and implementation plans

This section sets design-level sequencing; the [master implementation plan](../plans/2026-11-14-release-waves.md)
links all shared and provider task checklists.

| Wave | Shared work | AWS lane | Cloudflare lane | Exit |
| --- | --- | --- | --- | --- |
| 0 | Baseline; public contracts; identity/runtime/OCR inventory; deployment budget profiles | Verify AWS services/limits | Verify Workers/D1/R2/Queues limits, lock capacity and tools | Both profiles' unknowns recorded |
| 1 | Portable core, bounded persistence, API/identity/upload/artifact/reader/event contracts, shared conformance harness | Adapter skeleton | Adapter skeleton | Same contracts compile against both without SDK leakage |
| 2 | Core /v1 evidence/API vertical slice | DynamoDB/S3/SQS + CDK | D1/R2/Queues + Wrangler | Real upload/replay/download/history/tenant tests on both |
| 3 | Governance and processing services, evaluated engine profiles | AWS protection and worker adapters | R2 locks, D1 permits, Worker/remote processing | Holds/deletion/OCR behavior proven independently on both |
| 4 | Search/query authorization and exact-evidence FlowKit bridge | OpenSearch and AWS delivery | D1 FTS5 and Queues delivery | Live search/revocation/review/cleanup acceptance on both |
| 5 | Common acceptance matrix and release evidence format | Monitoring, backup/restore, rollout | Monitoring, D1/R2 recovery, rollout | Two complete independently deployable provider profiles |

Do not require simultaneous deployments or a common production account; each
lane can execute its tasks independently once shared prerequisites land.
Product first-release readiness requires both lanes' completed acceptance gates.
One lane's pass does not waive the other's failed/missing capability. Parallel
work here describes dependencies, not authorization to spawn implementers.

Preserve existing P1–P7 IDs and AWS file mappings where useful. Add Cloudflare
provider task plans spanning persistence/upload/delivery/API, governance,
processing/search/FlowKit adapters and operations. Revise the master wave plan,
shared prerequisite ownership and coverage ledger to link both lanes; replace
AWS-only gate language in common plans. The expanded plan set keeps existing AWS tasks and adds shared prerequisites
and Cloudflare provider plans under one combined release contract.

## Acceptance, review focus and evaluation gates

Run shared portable/domain tests and identical behavioral API scenarios against
both providers, plus provider-specific live tests for:

- CAS conflict and rollback, zero-row update failure, receipt replay and atomic
  state/audit/outbox under duplicate concurrent mutations.
- Primary permission revocation, cross-tenant DB/bucket routing and opaque cursor
  isolation, including snippets/history/results and later pages.
- Reused/modified upload credentials, multipart completion races, immutable final
  identity, streaming verification, deadlines and ambiguous writes/promotion.
- Out-of-order/duplicate events, queue retention/outage, durable failed work,
  manual replay and provider receipt reconciliation.
- Pending/active holds racing deletion, lost bucket-rule responses, concurrent
  changes to unrelated rules, rule exhaustion and new artifacts during a hold.
- Deletion vs remote OCR callback/FTS rebuild/replay, all index epochs, lingering
  multipart uploads and backup-copy expiry; no content resurrection.
- Native, scanned, mixed, image and multi-page extraction with partial failure,
  retry history, provenance, model/profile pinning and evaluated execution limits.
- Supported FlowKit review pinned to content version and metadata revision,
  replacement, maker-checker, revoked grants and runtime outage recovery.
- Real deployment security, resource/cost budgets, monitoring, restore drill and
  separate manifest/rollback compatibility evidence for each provider.

Required external values remain configuration/evaluation gates: Cloudflare
account/plan/data location, tenant workload/capacity and protection-rule budgets,
trusted identity/membership, verifier and OCR hosting/adoption, supported runtime,
recovery objectives and target-specific deployment/restore authorization. These
are not new user product choices; the planner chooses sensible implementation
mechanics and records deployment values before executing dependent live work.
No models or cloud resources are executed/deployed by writing this amendment.

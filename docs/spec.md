# FlowKitForm — Specification

**Status:** Draft v0.2
**Based on:** FlowKit workflow framework (`@teopeurt/flowkit-*`, [teopeurt/flowkit](https://github.com/teopeurt/flowkit))
**License:** Apache-2.0
**See also:** [architecture](architecture.md) for how this specification is realised, and the [roadmap](roadmap.md) for what exists today.

---

## 1. Purpose & Scope

FlowKitForm is an open-source **Document Management Platform** for storing, processing, and governing documents through durable, auditable workflows. It is designed to run as:

- **Headless software** — consumed entirely via its Document API and workflow APIs, and
- **A web-based client** — a basic reference UI for humans to upload, review, approve, and search documents.

It targets **document workflows, records management, and general document storage/processing** on managed cloud services: stateless request handling, with Temporal as the durable workflow runtime.

**In scope:** document lifecycle, workflow orchestration (human + automated), auditability, extensibility via API.
**Out of scope (for v0.1):** full-blown CMS/editing suite, OCR/ML pipelines as first-party features (exposed as extension points instead), multi-tenant SaaS billing.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Document** | An immutable blob plus mutable metadata, versioned over time. |
| **Workflow** | A durable, defined process composed of steps (human and/or automated). |
| **Stage** | A state of a workflow. A stage waits for a human action, a signal, or the result of its automated entry steps. |
| **Step** | A unit of work in a workflow: task, approval, review, system call, AI-assisted decision, timer/escalation. Each is expressed as a stage, an action, or an entry step of the FlowKit definition model (§5.2). |
| **Projection** | A derived, queryable read-model built from workflow/document events (e.g., "documents awaiting my approval"). |
| **Record** | A document under a retention/records policy (immutable, disposition-controlled). |
| **Extension** | A module that receives document or workflow events (webhook or document processor) and reports results back through the API. |

---

## 3. Goals & Non-Goals

### Goals
1. **Headless-first**: every capability in the web client is reachable through the API.
2. **Durable workflows**: workflow state survives failures, restarts, and scale events.
3. **Human + automated parity**: approvals, reviews, maker-checker controls, SLA escalation, and system/AI-assisted decisions are first-class step types wired into one auditable process.
4. **Cloud-portable, stateless where possible**: the API, document processors, and webhook delivery hold no state and can run as functions or scale-to-zero containers. The workflow worker is a long-lived process on Temporal.
5. **Extensible**: custom document processors and webhooks via a stable contract; new workflows as data, without a deploy.
6. **Auditable**: every state change is attributable, ordered, and replayable.

### Non-Goals (v0.1)
- Rich document authoring/editing.
- Real-time collaborative editing.
- Being a general-purpose BPMN engine (FlowKit is the workflow substrate; FlowKitForm exposes a document-centric subset).
- Full event sourcing. State is stored directly; the audit log records every change but is not the read path.
- Uploading executable logic through the API. Workflow definitions are data and reference logic that is registered in code.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Clients:  Web Client (reference UI)   │   Headless API     │
└───────────────────┬────────────────────┴──────────┬─────────┘
                    │  REST/JSON (+ webhooks)        │
┌───────────────────▼────────────────────────────────▼────────┐
│                     FlowKitForm API Gateway                  │
│  Document API │ Workflow API │ Search API │ AuthN/AuthZ      │
└───────┬───────────────┬───────────────┬──────────────┬───────┘
        │               │               │              │
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────┐ ┌─────▼───────┐
│ Document     │ │ FlowKit      │ │ Projection │ │ Extension   │
│ Service      │ │ Runtime      │ │ Engine     │ │ Host        │
│ (storage,    │ │ (Temporal    │ │ (read      │ │ (processors,│
│  versions,   │ │  worker,     │ │  models)   │ │  webhooks)  │
│  records)    │ │  long-lived) │ │            │ │             │
└───────┬──────┘ └──────┬───────┘ └─────┬──────┘ └─────┬───────┘
        │               │               │              │
┌───────▼───────────────▼───────────────▼──────────────▼───────┐
│  Substrate: object storage · PostgreSQL (state, audit log,   │
│  outbox) · Temporal (durable execution, timers) · secrets    │
└──────────────────────────────────────────────────────────────┘
```

**Design principles**
- **Audited state**: every mutation changes state rows, appends one audit event, and enqueues its side effects in a single database transaction. Projections can be rebuilt from the audit log; state is not derived from it at read time.
- **Stateless request handling**: the API, document processors, and webhook delivery keep no state between requests. Durable continuation state lives in Temporal and PostgreSQL.
- **Ports & adapters**: object storage, identity, notification channels, and webhook delivery sit behind adapters. PostgreSQL and Temporal are fixed dependencies.
- **Definitions are data**: a workflow definition is declarative, validated, and pinned by content hash; it references logic by name and never contains it.

---

## 5. Core Domain Model

### 5.1 Document
| Field | Type | Notes |
|---|---|---|
| `id` | string (ULID) | Immutable |
| `tenantId` | string | Multi-tenant key: the organization ID from server-validated membership, never from the request body |
| `title` | string | |
| `metadata` | object | Extensible, schema-optional |
| `version` | int | Monotonic; the current version |
| `contentRef` | string | Pointer to object storage blob (per version) |
| `hash` | string | Content hash (integrity), computed by the server from the stored bytes (per version) |
| `recordClass` | string \| null | Records-management classification |
| `status` | enum | `draft`, `in_review`, `approved`, `rejected`, `archived`, `disposed` |
| `createdAt`/`updatedAt` | timestamp | |
| `createdBy` | principal | |

**Invariants**
- Document content versions are **immutable**; updates create a new version.
- A document under an active workflow cannot be hard-deleted; it is archived.
- Every version stores a content hash for tamper detection.
- `status` changes only through a workflow transition; it cannot be set through `PATCH`.
- A workflow instance is pinned to one document version. Uploading a new version does not change what is under review; the definition decides how the workflow reacts.
- A document has at most one running instance of a given workflow definition.

### 5.2 Workflow Definition (FlowKit-backed)
A declarative FlowKit definition: stages, the actions available in each stage (`human`, `system`, or `signal`), and the entry steps a stage runs automatically (`system`, `ai`, `rule`, `orchestrate`). The document is the workflow subject, and each stage maps to a document `status`.

The step types this specification requires are expressed as follows (v0.2):

| Step type | Expressed as |
|---|---|
| `task` | A stage with a pending role and `human` actions, each protected by an authorization policy. |
| `approval` | As `task`, with approve/reject actions. Quorum (several approvers on one stage) is not yet supported; see §11. |
| `review` | As `task`; comments and checklist results are carried as action facts and checked by guards. |
| `makerCheckers` | A guard on the approving action: submitter ≠ approver. Guards run inside the transition, so no client can bypass them. |
| `system` | A `system` entry step, resolved by name from the registered system steps. |
| `aiAssist` | An `ai` entry step. `gate: human` records a recommendation for a person; `gate: auto` lets a named rule release the stage and falls back to a person if the rule declines or the step fails. |
| `timer` | The stage SLA (`sla.after`), a durable Temporal timer. |
| `escalation` | The stage SLA's `escalate`: notify a role and/or take an action. |
| `notify` | `notify` on an action or `entryNotify` on a stage, delivered through a channel adapter. |

A definition may reference only policies, guards, rules, steps, templates, and channels that are already registered in code. Adding a new one is a code change and a worker deploy.

**Workflow instance state** is durable: paused steps, in-flight timers, and human assignments survive runtime restarts. Each instance runs the immutable definition snapshot (identified by content hash) it started with; registering a new version affects only new instances.

### 5.3 Audit Event
Immutable record per state change: `{ id, tenantId, documentId, workflowInstanceId, actor, action, before, after, timestamp, correlationId, previousHash, hash }`. Append-only; queryable; exportable. `hash` covers the event and `previousHash`, forming one chain per tenant. The event is written in the same transaction as the state change it describes.

---

## 6. Document API (extendable)

REST/JSON, versioned (`/v1`), OpenAPI-described. All endpoints scoped by tenant and authorization.

### 6.1 Documents
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/documents` | Create document (metadata + optional content upload via signed URL; the server verifies the stored hash before creating the version) |
| `GET` | `/v1/documents/{id}` | Retrieve metadata |
| `GET` | `/v1/documents/{id}/versions` | List versions |
| `POST` | `/v1/documents/{id}/versions` | Add new version |
| `GET` | `/v1/documents/{id}/content` | Signed URL to content |
| `PATCH` | `/v1/documents/{id}` | Update mutable metadata (not `status`) |
| `DELETE` | `/v1/documents/{id}` | Soft-delete/archive |
| `POST` | `/v1/documents/{id}/records` | Classify as record / set retention |

### 6.2 Workflows
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/workflows` | Register a workflow definition: validated, published as an immutable snapshot with a content hash, stored per tenant |
| `POST` | `/v1/documents/{id}/workflows` | Start workflow instance on document |
| `GET` | `/v1/workflow-instances/{id}` | Instance state |
| `POST` | `/v1/workflow-instances/{id}/steps/{stepId}/complete` | Submit human decision/task result |
| `POST` | `/v1/workflow-instances/{id}/signals` | External signal (e.g., system callback) |
| `GET` | `/v1/workflow-instances/{id}/history` | Full audit trail (from the audit log) |

### 6.3 Search & Projections
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/search` | Query documents/workflows (filter, sort, paginate) |
| `GET` | `/v1/projections/{name}` | Read a named projection (e.g., `myPendingApprovals`) |

### 6.4 Extensibility contract
- **Webhooks**: subscribe to `document.*` and `workflow.*` events. Delivered at least once from the outbox, with a signed payload.
- **Extension registration**: `POST /v1/extensions` registers a document processor with a manifest.
- **Document processors**: invoked on upload/version events; may enrich metadata, transform, or index. They run outside the API and worker processes (for example as isolated functions) and report results back through the API as a workflow signal.
- **Custom steps**: a new system or AI step is registered by name in code and then referenced from definitions. There is no step-type plugin interface loaded at runtime, and no `compensate` operation in v0.2; see §11.

---

## 7. Web Client (Reference UI)

A minimal SPA (framework-agnostic spec) covering:

1. **Inbox** — assigned tasks/approvals (from projections).
2. **Document view** — metadata, versions, content preview, audit timeline.
3. **Upload / new version**.
4. **Workflow monitor** — instance state, pending steps, SLA status.
5. **Search** — filter by metadata, status, record class.
6. **Admin** — workflow definitions, extensions, retention policies, roles.

The web client is **not privileged**: it uses the same public API. Any capability not expressible via the API is considered a spec bug.

---

## 8. Deployment Model

- **Compute**: the API, document processors, and webhook delivery are stateless and may run as functions or scale-to-zero containers. The workflow worker and the notification worker are long-lived containers that scale horizontally.
- **Workflow runtime**: Temporal (Temporal Cloud or a self-hosted cluster). Durable timers are Temporal timers; there is no separate scheduler.
- **Storage**: object storage for content; PostgreSQL for state, the audit log, and the outbox.
- **Identity**: pluggable OIDC adapter.
- **Config**: declarative deployment manifests per cloud (AWS/GCP/Azure) for the adapter-backed services.
- **Statelessness**: no in-process durable state; all continuation state is persisted by the FlowKit runtime in Temporal and PostgreSQL.

**Reference deployment** ships as Docker Compose and Kubernetes manifests, with IaC templates per supported cloud to follow.

"Any cloud" means any cloud that offers managed PostgreSQL, object storage, and a reachable Temporal cluster.

---

## 9. Security & Compliance

- **AuthN**: OIDC/OAuth2; service tokens for headless clients.
- **AuthZ**: role- and attribute-based (RBAC/ABAC) enforced at API layer; workflow step assignees additionally constrained.
- **Tenant isolation**: every record keyed by `tenantId`; object-storage keys prefixed by tenant; every repository query carries a tenant predicate; cross-tenant reads return a non-disclosing not-found.
- **Audit**: append-only audit log, insert-only at the database-grant level; tamper-evident via per-tenant hash chaining; exportable.
- **Records management**: retention policies, legal hold, disposition with approval, immutable record versions.
- **Data protection**: encryption at rest/in transit; signed URLs scoped and expiring; secrets via managed secrets store.
- **Maker-checker**: enforced by the workflow engine (submitter ≠ approver), not merely UI.

---

## 10. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Durability | Workflow instances survive runtime failure; at-least-once step execution with idempotency keys. |
| Auditability | 100% of state transitions recorded; replayable projections. |
| Latency | API p95 < 300ms (excl. upload/download); workflow step dispatch p95 < 500ms. |
| Scale | Horizontal; stateless services auto-scale, workers scale on task-queue depth; tested to N concurrent workflow instances (target TBD). |
| Extensibility | New workflow definitions, webhooks, and document processors deployable without core changes. New system or AI steps require a code change and worker deploy. |
| Portability | Runs on any cloud with managed PostgreSQL, object storage, and Temporal; other services via adapters. |
| Observability | Structured logs, traces (OpenTelemetry), metrics per workflow/SLA. |

---

## 11. Open Questions

- **Approval quorum**: several approvers on one stage has no direct FlowKit construct.
- **Compensation**: whether system steps need a `compensate` operation, and how it would be expressed.
- **Uploads**: whether signed-URL upload is required from the first API release or a size-limited direct upload is acceptable first.
- **Records management**: retention, legal hold, and disposition modelled as a workflow definition on the document, or as separate state alongside it.
- **Scale target** for §10.

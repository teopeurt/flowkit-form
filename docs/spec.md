# FlowKitForm — Specification

**Status:** Draft v0.1
**Based on:** FlowKit workflow framework
**License:** Open Source (TBD — recommend Apache-2.0)

---

## 1. Purpose & Scope

FlowKitForm is an open-source **Document Management Platform** for storing, processing, and governing documents through durable, auditable workflows. It is designed to run as:

- **Headless software** — consumed entirely via its Document API and workflow APIs, and
- **A web-based client** — a basic reference UI for humans to upload, review, approve, and search documents.

It targets **document workflows, records management, and general document storage/processing** in serverless cloud environments.

**In scope:** document lifecycle, workflow orchestration (human + automated), auditability, extensibility via API.
**Out of scope (for v0.1):** full-blown CMS/editing suite, OCR/ML pipelines as first-party features (exposed as extension points instead), multi-tenant SaaS billing.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Document** | An immutable blob plus mutable metadata, versioned over time. |
| **Workflow** | A durable, defined process composed of steps (human and/or automated). |
| **Step** | A unit of work in a workflow: task, approval, review, system call, AI-assisted decision, timer/escalation. |
| **Projection** | A derived, queryable read-model built from workflow/document events (e.g., "documents awaiting my approval"). |
| **Record** | A document under a retention/records policy (immutable, disposition-controlled). |
| **Extension** | A pluggable module implementing Document API hooks or workflow step types. |

---

## 3. Goals & Non-Goals

### Goals
1. **Headless-first**: every capability in the web client is reachable through the API.
2. **Durable workflows**: workflow state survives failures, restarts, and scale events.
3. **Human + automated parity**: approvals, reviews, maker-checker controls, SLA escalation, and system/AI-assisted decisions are first-class step types wired into one auditable process.
4. **Serverless-native**: deployable on any serverless cloud (functions + managed storage/queues/DB).
5. **Extensible**: custom document processors and step types via a stable contract.
6. **Auditable**: every state change is attributable, ordered, and replayable.

### Non-Goals (v0.1)
- Rich document authoring/editing.
- Real-time collaborative editing.
- Being a general-purpose BPMN engine (FlowKit is the workflow substrate; FlowKitForm exposes a document-centric subset).

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
│ (storage,    │ │ (define/run/ │ │ (read      │ │ (processors,│
│  versions,   │ │  project/    │ │  models)   │ │  step types)│
│  records)    │ │  integrate)  │ │            │ │             │
└───────┬──────┘ └──────┬───────┘ └─────┬──────┘ └─────┬───────┘
        │               │               │              │
┌───────▼───────────────▼───────────────▼──────────────▼───────┐
│  Serverless substrate: object storage · DB/event log · queue │
│  · scheduler · secrets · function runtime                    │
└──────────────────────────────────────────────────────────────┘
```

**Design principles**
- **Event-sourced core**: all mutations emit events; projections and audit are derived from the event log.
- **Stateless compute**: services are serverless functions; state lives in storage/DB.
- **Ports & adapters**: storage, DB, queue, and identity are abstracted behind adapters to allow any serverless provider.

---

## 5. Core Domain Model

### 5.1 Document
| Field | Type | Notes |
|---|---|---|
| `id` | string (ULID) | Immutable |
| `tenantId` | string | Multi-tenant key |
| `title` | string | |
| `metadata` | object | Extensible, schema-optional |
| `version` | int | Monotonic |
| `contentRef` | string | Pointer to object storage blob |
| `hash` | string | Content hash (integrity) |
| `recordClass` | string \| null | Records-management classification |
| `status` | enum | `draft`, `in_review`, `approved`, `rejected`, `archived`, `disposed` |
| `createdAt`/`updatedAt` | timestamp | |
| `createdBy` | principal | |

**Invariants**
- Document content versions are **immutable**; updates create a new version.
- A document under an active workflow cannot be hard-deleted; it is archived.
- Every version stores a content hash for tamper detection.

### 5.2 Workflow Definition (FlowKit-backed)
A declarative definition composed of steps. Supported step types (v0.1):

| Step type | Description |
|---|---|
| `task` | Human task with assignee/role resolution and form schema. |
| `approval` | Yes/no/abstain decision with quorum rules. |
| `review` | Review with comments and required checklist. |
| `makerCheckers` | Maker-checker control: submitter ≠ approver enforcement. |
| `system` | Automated call to an extension or external API. |
| `aiAssist` | AI-assisted decision/recommendation, always with a human-confirmable path. |
| `timer` | Durable timer for SLA deadlines. |
| `escalation` | Triggered on SLA breach; reassign/notify/auto-advance. |
| `notify` | Emit notification via channel adapter. |

**Workflow instance state** is durable: paused steps, in-flight timers, and human assignments survive runtime restarts.

### 5.3 Audit Event
Immutable record per state change: `{ id, documentId, workflowInstanceId, actor, action, before, after, timestamp, correlationId }`. Append-only; queryable; exportable.

---

## 6. Document API (extendable)

REST/JSON, versioned (`/v1`), OpenAPI-described. All endpoints scoped by tenant and authorization.

### 6.1 Documents
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/documents` | Create document (metadata + optional content upload via signed URL) |
| `GET` | `/v1/documents/{id}` | Retrieve metadata |
| `GET` | `/v1/documents/{id}/versions` | List versions |
| `POST` | `/v1/documents/{id}/versions` | Add new version |
| `GET` | `/v1/documents/{id}/content` | Signed URL to content |
| `PATCH` | `/v1/documents/{id}` | Update mutable metadata |
| `DELETE` | `/v1/documents/{id}` | Soft-delete/archive |
| `POST` | `/v1/documents/{id}/records` | Classify as record / set retention |

### 6.2 Workflows
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/workflows` | Register a workflow definition |
| `POST` | `/v1/documents/{id}/workflows` | Start workflow instance on document |
| `GET` | `/v1/workflow-instances/{id}` | Instance state |
| `POST` | `/v1/workflow-instances/{id}/steps/{stepId}/complete` | Submit human decision/task result |
| `POST` | `/v1/workflow-instances/{id}/signals` | External signal (e.g., system callback) |
| `GET` | `/v1/workflow-instances/{id}/history` | Full audit trail |

### 6.3 Search & Projections
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/search` | Query documents/workflows (filter, sort, paginate) |
| `GET` | `/v1/projections/{name}` | Read a named projection (e.g., `myPendingApprovals`) |

### 6.4 Extensibility contract
- **Webhooks**: subscribe to `document.*` and `workflow.*` events.
- **Extension registration**: `POST /v1/extensions` registers a processor/step-type provider with a manifest.
- **Document processors**: invoked on upload/version events; may enrich metadata, transform, or index. Executed as isolated serverless functions.
- **Custom step types**: implement the FlowKit step contract (`validate`, `execute`, `compensate`).

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

## 8. Deployment Model (Serverless)

- **Compute**: functions for API, workflow execution, projections, extensions.
- **Storage**: object storage (content), document/event DB, queue/event bus, durable timers (scheduler).
- **Identity**: pluggable OIDC adapter.
- **Config**: declarative deployment manifests per cloud (AWS/GCP/Azure) + a provider-neutral "ports" spec.
- **Statelessness**: no in-process durable state; all continuation state persisted via FlowKit runtime.

**Reference deployment** ships as IaC templates per supported cloud.

---

## 9. Security & Compliance

- **AuthN**: OIDC/OAuth2; service tokens for headless clients.
- **AuthZ**: role- and attribute-based (RBAC/ABAC) enforced at API layer; workflow step assignees additionally constrained.
- **Tenant isolation**: every record keyed by `tenantId`; storage prefixes and DB partitions isolated.
- **Audit**: append-only event log; tamper-evident via hash chaining; exportable.
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
| Scale | Horizontal; serverless auto-scale; tested to N concurrent workflow instances (target TBD). |
| Extensibility | New document processors/step types deployable without core changes. |
| Portability | Runs on any serverless cloud via adapters. |
| Observability | Structured logs, traces (OpenTelemetry), metrics per workflow/SLA. |

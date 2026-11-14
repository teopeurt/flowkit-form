# Architecture

The [approved design](superpowers/specs/2026-11-14-flowkitform-design.md) is the
current target architecture. The document core owns evidence, permissions,
metadata history, processing lifecycle and retention. Separate modules provide
HTTP transport, FlowKit integration and provider adapters. AWS uses S3, Lambda,
API Gateway, DynamoDB and SQS; search and OCR engines require explicit evaluation.
State, audit and outbox intent commit atomically. Search rechecks authoritative
permissions, uploads publish immutable references, and deletion fences all writers.

Current code still uses BetterAuth/PostgreSQL, Temporal workers, the demo API and
web client. Their dependencies are real and must be included in assembly until
explicitly replaced. The serverless document deployment must not import the demo
composition root and thereby silently require PostgreSQL. FlowKit is consumed
through public package exports and remains an external supported runtime.

The previous architecture below describes the earlier target and useful current
code boundaries. Its fixed PostgreSQL document substrate, workflow-owned document
status, UI scope and definition-registration targets are superseded by the
[reconciliation](spec.md); they are not requirements for the new implementation.

## Historical architecture and existing application context

This document describes the target architecture of FlowKitForm, the document platform specified in
[spec.md](spec.md), and how it sits on the code that exists today. Sections marked **Target** are
not implemented yet; the [roadmap](roadmap.md) says which phase delivers each one.

## 1. Decisions

Four decisions shape everything below. Each one narrows a statement in the specification.

| Topic | Decision | Effect on the specification |
| --- | --- | --- |
| Compute | Temporal stays the durable workflow runtime. The API, document processors, and extensions are stateless and may run as functions; the workflow worker is a long-lived process. | §4 and §8 "serverless" applies to everything except the worker. |
| Source of truth | State tables in PostgreSQL, plus an append-only, hash-chained audit log written in the same transaction as the state change. | §4 "event-sourced core" becomes "audited state": projections can be rebuilt from the audit log, but state is not derived from it at read time. |
| Workflow definitions | Definitions are data, registered at runtime and pinned by content hash. They may reference only policies, guards, rules, and steps that are registered in code. | §6.2 `POST /v1/workflows` accepts a declarative definition, never executable logic. |
| Document binding | The document is the workflow subject. A workflow instance is pinned to one document version, and the workflow is the only writer of document `status`. | Fills a gap: the specification does not define the binding. |

## 2. Ownership boundaries

The repository owns application behavior, but not framework implementation.

```text
apps/web              reference web client; uses the public API only
apps/api              HTTP transport, BetterAuth, organization resolution, and commands
apps/worker           Temporal workflow registration and activities
apps/notify-worker    durable outbox delivery to inbox and SMTP
packages/domain       document types and invariants, definitions, roles, registries, templates
packages/database     schema, migrations, tenant-scoped repositories, and transactions
packages/ui           neutral tokens and reusable accessible components
@teopeurt/flowkit-*   installed framework contracts only
```

Use the framework only through package exports. Do not edit `node_modules`, import package source,
or add a framework copy under `packages`. `test/package-contracts.preflight.test.ts` records the
exports the application consumes; `test/package-boundary.test.ts` rejects sibling-source imports.

What FlowKit provides, and FlowKitForm therefore does not rebuild:

| Concern | Package |
| --- | --- |
| Definition model, lint, and the single pure `transition` | `@teopeurt/flowkit-core` |
| YAML authoring format and JSON Schema for definitions | `@teopeurt/flowkit-definitions` (not yet a dependency) |
| Publishing an immutable definition snapshot and running it in Temporal | `@teopeurt/flowkit-temporal` |
| Task projection, claims, and inbox | `@teopeurt/flowkit-tasks` |
| Notification planning, outbox, and delivery | `@teopeurt/flowkit-notify` |
| Principals, roles, and permission checks | `@teopeurt/flowkit-auth` |

## 3. Tenant invariant

Every document, version, workflow subject, task, transition, audit event, notification, and stored
object belongs to an organization. The specification's `tenantId` is the BetterAuth organization
ID. Active organization and application role come from server-validated session membership.
Request-body organization IDs are never authoritative. Repositories use tenant predicates, and
cross-organization reads return a non-disclosing not-found response. Object-storage keys start with
the organization ID. Keep this invariant when introducing every new table, route, projection,
storage key, notification recipient, or worker activity.

## 4. Document model (Target, phase 1)

A document is mutable metadata plus an ordered list of immutable versions.

```ts
type DocumentStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived' | 'disposed';

type DocumentRecord = {
  id: string;
  organizationId: string;
  title: string;
  metadata: Record<string, unknown>;
  currentVersion: number;
  status: DocumentStatus;
  recordClass: string | null;
};

type DocumentVersion = {
  documentId: string;
  organizationId: string;
  version: number;
  contentRef: string;
  contentHash: string;
  createdBy: string;
};

export function nextVersion(document: DocumentRecord, upload: { contentRef: string; contentHash: string; actorId: string }): DocumentVersion {
  return {
    documentId: document.id,
    organizationId: document.organizationId,
    version: document.currentVersion + 1,
    contentRef: upload.contentRef,
    contentHash: upload.contentHash,
    createdBy: upload.actorId,
  };
}
```

Invariants, enforced in `packages/domain` and again by database constraints:

- A version row is never updated or deleted. New content means a new version.
- `contentHash` is computed by the server from the stored bytes, not taken from the client.
- A document with a running workflow, a record class, or a legal hold cannot be deleted; `DELETE`
  archives it.
- `status` changes only through a workflow transition (section 6). `PATCH` cannot set it.

## 5. Write path and audit log (Target, phase 1)

Every state change follows one shape:

```text
command → authorize (tenant, role) → one database transaction:
            1. change state rows (document, version, flow state, tasks)
            2. append one audit event
            3. enqueue outbox rows (notifications, webhooks)
```

The audit event is `{ id, organizationId, documentId, workflowInstanceId, actor, action, before,
after, correlationId, createdAt, previousHash, hash }`. `hash` covers the canonical JSON of the
event and `previousHash`, and the chain is per organization. Rows are insert-only; the database
role used by the application has no update or delete grant on the table. Export and chain
verification read the same table.

Today the `audit_events` table exists but has no chain and no document columns, and workflow
transitions are written by the `recordTransition` activity in `apps/worker/src/activities.ts`.
That activity is the place the audit append is added, so a transition and its audit event commit
together. Because Temporal activities run at least once, the audit insert is keyed by the
transition's operation ID and a repeat is a no-op.

Outbox rows written in the same transaction are the only way side effects leave the system. This
is how notifications already work (`apps/notify-worker/src/delivery.worker.ts`); webhooks reuse it.

## 6. Document–workflow binding (Target, phase 2)

- Starting a workflow on a document creates a FlowKit subject `{ id, organizationId, metadata }`
  where `metadata` carries `documentId`, the pinned `version`, and its `contentHash`.
- The Temporal workflow ID is tenant-scoped and derived from the document, so one document has at
  most one running instance of a given definition.
- Each definition stage maps to a document `status`. The `recordTransition` activity writes the
  flow state and the document status in the same transaction as the audit event.
- Uploading a new version while a workflow is running does not change what is under review. The
  definition decides what happens next, normally a signal action that returns the flow to the
  review stage with the new version pinned.

The specification's step types map onto the FlowKit definition model as follows. FlowKit has
stages, actions (`human`, `system`, `signal`), and entry steps (`system`, `ai`, `rule`,
`orchestrate`); it has no per-step-type plugin interface.

| Specification step | FlowKit construct |
| --- | --- |
| `task`, `approval`, `review` | A stage with `pendingRole` and `human` actions guarded by a policy; the task appears through `@teopeurt/flowkit-tasks`. |
| `makerCheckers` | A guard on the approving action comparing the actor with the submitter. Guards run inside `transition`, so the UI cannot bypass them. |
| `system` | A `system` entry step resolved from the `systemSteps` registry. |
| `aiAssist` | An `ai` entry step. `gate: human` records a recommendation for a person; `gate: auto` lets a named rule release the stage and falls back to a person if the rule declines or the step fails. |
| `timer`, `escalation` | The stage `sla` with `escalate.notify` or `escalate.action`. |
| `notify` | `notify` on an action, or `entryNotify` on a stage. |

Two parts of the specification have no FlowKit equivalent and need a decision before phase 2:
approval **quorum** (several approvers on one stage) and the custom step contract's
**`compensate`** operation.

### Definition registration

`POST /v1/workflows` accepts a definition, validates it (schema, lint, then registry references),
publishes an immutable snapshot with its hash, and stores it per organization. A running instance
keeps the snapshot it started with; registering a new version affects only new instances.
Definitions cannot introduce logic: every policy, guard, rule, step, template, and channel name
must already be registered in `packages/domain`. A new system step or AI step is a code change and
a worker deploy.

Today definitions are TypeScript constants (`packages/domain/src/leave/leave.definition.ts`) with
registries in `packages/domain/src/leave/leave.registries.ts`, bound into the workflow bundle in
`apps/worker/src/workflows.ts`. The leave, ride, and enrolment examples stay until the
document-approval definition replaces them in phase 2.

## 7. API surface (Target, phase 2 and 3)

The `/v1` API in `apps/api` is the only entry point. The web client holds no privilege the API does
not grant. Controllers translate HTTP into commands; they contain no workflow rules.

- **Documents:** create, read, list versions, add version, update metadata, archive, classify.
  Content never passes through the API process: clients upload and download with short-lived signed
  URLs, and the API verifies the stored object's hash before creating the version row.
- **Workflows:** register definition, start on a document, read instance state, complete a step
  (a Temporal update), send a signal, read history (from the audit log).
- **Search and projections:** PostgreSQL queries over tenant-scoped tables first. A separate search
  index is added only if measured need appears.
- **Webhooks and extensions:** delivered from the outbox with at-least-once semantics and a signed
  payload. Document processors run outside the API and worker processes and report results back
  through the API as a signal.

Today the API exposes leave-specific controllers such as `apps/api/src/flow.controller.ts`, and the
browser form is `apps/web/src/features/requests/RequestForm.tsx`.

## 8. Ports and adapters

Domain code depends on a port; the adapter is chosen at process start.

| Port | First adapter | Status |
| --- | --- | --- |
| Object storage (put, get, signed URL, hash) | Local filesystem or S3-compatible store for development | Target, phase 2 |
| Database | PostgreSQL through Drizzle (`packages/database/src/schema.ts`, SQL in `packages/database/migrations`) | Exists |
| Workflow runtime | Temporal through `@teopeurt/flowkit-temporal` | Exists |
| Identity | BetterAuth organizations; OIDC through the same port | Exists, OIDC is target |
| Notification channels | Inbox and SMTP (`packages/domain/src/notifications/templates.ts`) | Exists |
| Webhook delivery | Outbox consumer | Target, phase 3 |

PostgreSQL and Temporal are fixed dependencies, not swappable ports. "Runs on any cloud" means any
cloud that offers managed PostgreSQL, object storage, and either Temporal Cloud or a self-hosted
Temporal cluster.

## 9. Deployment

**Today:** four long-lived processes (API, workflow worker, notification worker, static web) with
PostgreSQL, Temporal, and Mailpit, on Docker Compose or k3s. See [deployment.md](deployment.md).

**Target, phase 5:** the API, document processors, and webhook delivery run as functions or
scale-to-zero containers because they hold no state between requests. The workflow worker and the
notification worker remain long-lived containers that scale horizontally on task-queue depth.
Durable timers are Temporal timers; no separate scheduler is introduced.

## 10. Open questions

- Approval quorum and `compensate` (section 6).
- Whether signed-URL uploads are required in phase 2 or a size-limited direct upload is acceptable
  first.
- Retention, legal hold, and disposition: modelled as a workflow definition on the document, or as
  separate state alongside it.
- The scale target in specification §10.

The order for replacing the example application with the document domain is in
[customizing.md](customizing.md).

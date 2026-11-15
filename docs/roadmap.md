# FlowKitForm roadmap and gap analysis

The [approved base design](superpowers/specs/2026-11-14-flowkitform-design.md) and
[approved Cloudflare amendment](superpowers/specs/2026-11-14-cloudflare-alternative-design.md)
define the target. AWS and Cloudflare ship alongside each other; each tenant is
assigned to one deployment/provider. Current code remains the demo application;
approved plans do not imply document features have been implemented.

1. Portable foundation (P1): evidence/history, permissions, atomic persistence and lifecycle fencing.
2. Shared provider prerequisites (P0): readers/artifacts/uploads/delivery, identity, Fetch API/OpenAPI and runner-neutral conformance.
3. Parallel evidence slices (P2/CF1): DynamoDB/S3/SQS/Lambda/CDK and D1/R2/Queues/Workers/Wrangler, verified independently.
4. Governance and extraction (P3/P4, CF2/CF3): scoped external access, holds/deletion, version-specific OCR/jobs/results and provider cleanup.
5. Search and FlowKit (P5/P6, CF3): OpenSearch or FTS5, current permissions, exact evidence review on a supported external runtime.
6. Operations and release (P7/CF4): monitoring/replay, separate backup/restore drills, budgets and two-provider release evidence.

## Execution plans

The [master wave and implementation plan](superpowers/plans/2026-11-14-release-waves.md)
links all twelve shared/provider plans and defines six execution waves, task
ownership, entry/exit checks, parallel work and live-test gates. Both providers
must pass their own acceptance to declare the first release ready; simultaneous
deployment is not required. Engine/hosting adoption, actual deployment profiles
and target authorization remain explicit gates. GCP/Azure and UI remain later scope.

## Historical roadmap and existing demo gap analysis

This tracks how the repository gets from its starting point to the [FlowKitForm specification](spec.md). The [architecture](architecture.md) describes the target design each phase builds toward.

## Starting point

The repository began as a copy of the FlowKit Demo reference application. It already provides the platform pieces the spec reuses, built on six public `@teopeurt/flowkit-*` packages at version `1.2.0` (consumed only through their public exports):

| Spec need | Already in the repository |
| --- | --- |
| Durable workflows (§5.2, §10) | Temporal worker, `apps/worker`, interpreter from `@teopeurt/flowkit-temporal` |
| Human tasks, maker-checker (§5.2, §9) | `@teopeurt/flowkit-tasks` claims and maker-checker; guards in `packages/domain` |
| System, AI, timer, escalation, and notify steps (§5.2) | FlowKit entry steps (`system`, `ai` with `gate: human` or `gate: auto`, `rule`), stage SLA with escalation, and `notify` bindings |
| Definition snapshots pinned by hash (§5.2) | `publishDefinition` in `@teopeurt/flowkit-temporal` |
| Notifications (`notify` step) | `apps/notify-worker`, outbox and inbox adapters |
| AuthN/AuthZ, roles (§9) | BetterAuth, organization membership, roles in `packages/domain` |
| Tenant isolation (§9) | Tenant-scoped repositories in `packages/database`, isolation tests |
| Inbox, request UI (§7.1) | `apps/web` task inbox and notification inbox |
| Deployment (§8) | Docker Compose, Tilt, k3s Kustomize; the long-lived worker processes the spec keeps |

## Gaps

| Spec section | Gap | Phase |
| --- | --- | --- |
| §5.1 Document model | No document, version, or content-hash types or tables | 1 |
| §5.3 Audit event | Transitions are projected and an `audit_events` table exists, but it has no hash chain, no document columns, and is not insert-only | 1 |
| §6.1 Document API | No `/v1/documents` routes or object-storage port; signed URLs absent | 2 |
| §6.2 Workflow API | Leave-specific controllers only; no runtime definition registration, signals, or history endpoints. `@teopeurt/flowkit-definitions` (YAML and JSON Schema) is not yet a dependency | 2 |
| §5.1, §5.2 Document binding | No document-approval definition; nothing pins a workflow to a document version or maps stages to document status | 2 |
| §5.2 Step types | No AI step is implemented (`executeAiStep` is a stub); approval quorum has no FlowKit construct (spec §11) | 2 |
| §6.3 Search and projections | No `/v1/search` or named projections | 3 |
| §6.4 Extensibility | No webhooks, extension registry, or document-processor host | 3 |
| §9 Records management | No retention, legal hold, or disposition | 3 |
| §7 Web client | Leave and ride screens only; no document view, upload, monitor, search, or admin | 4 |
| §8 Deployment | Kubernetes and Compose manifests only; the API is not yet packaged to run as a function or scale-to-zero container, and there is no per-cloud IaC | 5 |
| §10 Observability | No OpenTelemetry traces or per-workflow SLA metrics | 5 |
| §9 API versioning | No OpenAPI description, no `/v1` prefix | 2 |

## Phases

1. **Document domain.** `packages/domain/src/documents` types and invariants (immutable versions, server-computed hash, archive instead of delete, status changed only by a workflow); migrations and tenant-scoped repository in `packages/database`; insert-only audit table with per-tenant hash chaining, appended in the same transaction as each state change.
2. **Document and workflow API.** `/v1` routes and OpenAPI; storage port with a local adapter; a document-approval definition replacing the leave example (including a maker-checker guard), with the document as workflow subject and one pinned version per instance; runtime definition registration through `@teopeurt/flowkit-definitions`; signals and history endpoints.
3. **Projections, search, extensions, records.** Named projections such as `myPendingApprovals`; search on PostgreSQL first; webhooks from the outbox; extension manifest and document-processor host; retention and legal hold.
4. **Reference web client.** Document view and audit timeline, upload and new version, workflow monitor, search, admin; every capability reached through the public API only.
5. **Deployment and observability.** API, document processors, and webhook delivery packaged as functions or scale-to-zero containers; workers stay long-lived; per-cloud IaC templates; OpenTelemetry.

## Open decisions

- Whether the `@flowkit-demo/*` workspace package scope and `FLOWKITFORM_*` environment variables are renamed to FlowKitForm names. This is deliberately not done yet: the names appear across code, deployment manifests, and tests, and renaming them is a mechanical change best done on its own.
- Target concurrency for the scale requirement (§10 "N concurrent workflow instances").
- Approval quorum and step compensation, which have no FlowKit construct (spec §11).
- Signed-URL upload from the first API release, or a size-limited direct upload first.
- Records management as a workflow definition or as separate state.

## Known issues

- Two tests in `test/enrolment-conformance.test.ts` (policy-protected signals, separation of duties) time out after the move to `@teopeurt/flowkit-*` `1.2.0`. The cause is not yet known; the same tests fail more widely on `1.1.1`.

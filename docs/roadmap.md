# FlowKitForm roadmap and gap analysis

This tracks how the repository gets from its starting point to the [FlowKitForm specification](spec.md).

## Starting point

The repository began as a copy of the FlowKit Demo reference application. It already provides the platform pieces the spec reuses, built on the six `@naakwu/flowkit-*` packages (consumed only through their public exports):

| Spec need | Already in the repository |
| --- | --- |
| Durable workflows (§5.2, §10) | Temporal worker, `apps/worker`, interpreter from `@naakwu/flowkit-temporal` |
| Human tasks, maker-checker (§5.2, §9) | `@naakwu/flowkit-tasks` claims and maker-checker; guards in `packages/domain` |
| Notifications (`notify` step) | `apps/notify-worker`, outbox and inbox adapters |
| AuthN/AuthZ, roles (§9) | BetterAuth, organization membership, roles in `packages/domain` |
| Tenant isolation (§9) | Tenant-scoped repositories in `packages/database`, isolation tests |
| Inbox, request UI (§7.1) | `apps/web` task inbox and notification inbox |
| Deployment (§8) | Docker Compose, Tilt, k3s Kustomize (Kubernetes, not serverless) |

## Gaps

| Spec section | Gap | Phase |
| --- | --- | --- |
| §5.1 Document model | No document, version, or content-hash types or tables | 1 |
| §5.3 Audit event | Transitions are projected, but there is no append-only, hash-chained audit log | 1 |
| §6.1 Document API | No `/v1/documents` routes or object-storage port; signed URLs absent | 2 |
| §6.2 Workflow API | Leave-specific controllers only; no definition registration, signals, or history endpoints | 2 |
| §5.2 Step types | Only human, system, and rule steps; `approval` quorum, `review` checklist, `aiAssist`, `timer`/`escalation` as authored step types are missing | 2 |
| §6.3 Search and projections | No `/v1/search` or named projections | 3 |
| §6.4 Extensibility | No webhooks, extension registry, or processor host | 3 |
| §9 Records management | No retention, legal hold, or disposition | 3 |
| §7 Web client | Leave and ride screens only; no document view, upload, monitor, search, or admin | 4 |
| §8 Serverless | Kubernetes and Compose manifests only; no function-runtime adapters or per-cloud IaC | 5 |
| §10 Observability | No OpenTelemetry traces or per-workflow SLA metrics | 5 |
| §9 API versioning | No OpenAPI description, no `/v1` prefix | 2 |

## Phases

1. **Document domain.** `packages/domain/src/documents` types and invariants (immutable versions, hash, archive instead of delete); migrations and tenant-scoped repository in `packages/database`; append-only audit table with hash chaining.
2. **Document and workflow API.** `/v1` routes and OpenAPI; storage port with a local adapter; a document-approval definition replacing the leave example (including a maker-checker step); signals and history endpoints.
3. **Projections, search, extensions, records.** Named projections such as `myPendingApprovals`; search; webhooks; extension manifest and processor host; retention and legal hold.
4. **Reference web client.** Document view and audit timeline, upload and new version, workflow monitor, search, admin; every capability reached through the public API only.
5. **Serverless and observability.** Provider-neutral ports spec, adapters, per-cloud IaC templates, OpenTelemetry.

## Open decisions

- License (the spec recommends Apache-2.0; none chosen yet beyond the repository's existing `LICENSE`).
- Whether the `@flowkit-demo/*` workspace package scope and `FLOWKIT_DEMO_*` environment variables are renamed to FlowKitForm names. This is deliberately not done yet: the names appear across code, deployment manifests, and tests, and renaming them is a mechanical change best done on its own.
- Target concurrency for the scale requirement (§10 "N concurrent workflow instances").

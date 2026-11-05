# Serverless deployment (AWS, Pulumi)

This document describes how FlowKitForm runs on AWS serverless services and how the first Pulumi
scaffold in [`infra/`](../infra) implements it. It implements spec §8 for one cloud only; the
provider-neutral ports remain a Phase 5 item in the [roadmap](roadmap.md).

The FormKiQ Core IAM OpenAPI description
(`docs/openapi/openapi-iam.yaml`, API version 1.19.1) is used as a **reference for shape, not a
target to copy**. FlowKitForm's API is the smaller `/v1` surface in spec §6.

## Topology

```text
Client ──SigV4 / OIDC JWT──▶ API Gateway (HTTP API)
                                   │  Lambda proxy
                                   ▼
                          API Lambda (container image, AWS Lambda Web Adapter,
                          unchanged NestJS server)
                           │          │            │
                           ▼          ▼            ▼
                    Aurora Serverless v2   S3 content bucket   SQS notify queue (+ DLQ)
                    (PostgreSQL)           (versioned, KMS)            │
                           ▲                                          ▼
              ECS Fargate: workflow worker ──▶ Temporal Cloud   Fargate: notify worker
```

| Spec concern | AWS resource | Notes |
| --- | --- | --- |
| API gateway (§4) | API Gateway HTTP API + Lambda | Default route is `AWS_IAM`; `GET /health/{proxy+}` is open. |
| AuthN (§9) | IAM (SigV4) by default; JWT authorizer when `oidcIssuer` and `oidcAudience` are set | Matches the reference's `awsSigv4` scheme; OIDC covers the spec's OIDC requirement. |
| Content store (§5.1) | S3, versioning on, SSE-KMS, public access blocked | Immutable versions come from S3 object versions plus the content hash stored in the database. |
| Document and event DB (§4) | Aurora Serverless v2 PostgreSQL | Keeps the existing `packages/database` repositories and migrations. `dbMinAcu: 0` enables scale to zero. |
| Queue (§4) | SQS standard queue with a dead-letter queue | Used by the existing notification outbox delivery. |
| Durable workflows (§5.2) | Temporal Cloud, reached from Fargate workers | See "Why workers are not Lambda". |
| Secrets (§9) | Secrets Manager | Aurora manages its own master password; the Temporal API key secret is created empty and populated out of band. |
| Observability (§10) | CloudWatch log groups (JSON logs, 30-day retention), Fargate Container Insights | OpenTelemetry tracing is not wired yet. |

### Why workers are not Lambda

FlowKit executes workflows on Temporal, whose workers long-poll for tasks. Running those pollers
on Lambda would mean paying for idle polling and fighting execution time limits. The API is stateless
and runs on Lambda; the two pollers (`apps/worker`, `apps/notify-worker`) run as Fargate services
that connect to Temporal Cloud. This is "serverless containers", and it is the main place this
deployment departs from "functions only".

## Mapping the reference API to FlowKitForm `/v1`

The reference defines about 150 paths for a general document platform. FlowKitForm keeps the parts
that serve document workflows and leaves the rest to extensions or the underlying platform.

| Reference tag / path family | FlowKitForm treatment |
| --- | --- |
| `/documents`, `/documents/{id}`, `/versions`, `/content`, `/url`, `/upload` | Adopted as spec §6.1 (documents, versions, signed content URLs). |
| `/documents/{id}/tags`, `/attributes` | Folded into the `metadata` object (spec §5.1); no separate tag API in v0.1. |
| `/documents/{id}/legalHold`, `/purge`, `/restore` | Mapped to records management: legal hold, disposition, restore (spec §9). Roadmap phase 3. |
| `/documents/{id}/workflows`, `/workflow/{id}/decisions` | Mapped to spec §6.2 (start instance, complete step). |
| `/documents/{id}/reviews`, `/reviews/{id}/decisions` | Mapped to the `review` and `approval` constructs built on FlowKit stages and actions. |
| `/documents/{id}/actions`, `/userActivities`, `/activities` | Mapped to the audit trail and workflow history (spec §5.3, §6.2). |
| `/documents/{id}/notifications`, webhooks | Mapped to spec §6.4 webhooks and the `notify` binding. |
| Search (`/search`, fulltext, advanced search) | Spec §6.3 `/v1/search`; implementation deferred to roadmap phase 3. |
| `/esignature/docusign/*`, `/ocr`, `/antivirus`, `/malwareScan`, `/entities`, `/folders`, `/syncs`, `/ai/prompts` | Out of scope for v0.1. OCR, scanning and AI are extension points (spec §1, §6.4). |

Status: **none of the `/v1` routes exist yet.** The scaffold deploys the existing application
(leave and ride-hail demo) unchanged, so it proves the infrastructure shape, not the document API.

## The Pulumi scaffold

`infra/` is a standalone TypeScript Pulumi project (not part of the Bun workspaces). It is organized
by concern: `storage.ts`, `database.ts`, `queues.ts`, `api.ts`, `workers.ts`, wired together in
`index.ts`.

Configuration lives in `Pulumi.dev.yaml`. Every `REPLACE_ME` value must be set first:
`vpcId`, `privateSubnetIds` (private subnets with outbound access to AWS APIs and Temporal Cloud,
for example through NAT or VPC endpoints), the two image URIs, and the Temporal address and
namespace. Optional keys: `oidcIssuer`, `oidcAudience`, `dbMinAcu`, `dbMaxAcu`, `retainData`
(default `true`, which protects the bucket and database from deletion).

Checks that run without cloud credentials:

```sh
cd infra
bun install
bun run typecheck
bun test ./test      # Pulumi mock tests: private bucket, IAM auth, encrypted DB, DLQ, Fargate, no wildcard IAM
```

Deploying requires the Pulumi CLI, a configured backend, and AWS credentials; none of that has been
exercised yet. Before the first `pulumi up`:

1. Build and push the API image (with the AWS Lambda Web Adapter extension) and the worker image.
   The repository's `Dockerfile` builds the application but does not yet include the adapter, and
   it needs a read token for the private `@naakwu/flowkit-*` packages.
2. Set the Temporal API key secret value in Secrets Manager.
3. Run database migrations against Aurora from a trusted network location. The application's
   migration guard intentionally refuses remote databases for automatic migration.
4. Review `pulumi preview`; the Lambda reaches the database and AWS APIs from private subnets.

## Known gaps

- The API Lambda reads configuration names (`CONTENT_BUCKET`, `NOTIFY_QUEUE_URL`, `TEMPORAL_*`) that
  the current application code does not consume yet; it still expects `FLOWKIT_DEMO_*` variables
  and a local Temporal. The environment mapping needs a small application change.
- No custom domain, WAF, VPC endpoints, alarms, or per-environment stacks beyond `dev`.
- No object-storage port in application code, so S3 is provisioned but not used.
- Not yet verified against a real AWS account.

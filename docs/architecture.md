# Architecture

## Ownership boundaries

The repository owns application behavior, but not framework implementation.

```text
apps/web              authenticated React and Vite experience
apps/api              HTTP transport, BetterAuth, organization resolution, and commands
apps/worker           Temporal workflow registration and activities
apps/notify-worker    durable outbox delivery to inbox and SMTP
packages/domain       replaceable definitions, roles, registries, types, and templates
packages/database     schema, migrations, tenant-scoped repositories, and transactions
packages/ui           neutral tokens and reusable accessible components
@naakwu/flowkit-*     installed framework contracts only
```

Use the framework only through package exports. Do not edit `node_modules`, import package source,
or add a framework copy under `packages`. `test/package-contracts.preflight.test.ts` records the
exports the application consumes; `test/package-boundary.test.ts` rejects sibling-source imports.

## Tenant invariant

Every workflow subject, task, transition, notification, and persistence operation belongs to an
organization. Active organization and application role come from server-validated session
membership. Request-body organization IDs are never authoritative. Repositories use tenant
predicates, and cross-organization reads return a non-disclosing not-found response. Keep this
invariant when introducing every new table, route, projection, notification recipient, or worker
activity.

The following small example is intentionally framework-independent; it demonstrates the shape an
application adapter should pass into its own domain boundary.

```ts
type TenantActor = {
  id: string;
  organizationId: string;
  roles: string[];
};

export const actorFromVerifiedMembership: TenantActor = {
  id: 'member-123',
  organizationId: 'org-123',
  roles: ['employee'],
};
```

## Replaceable seams

- `packages/domain/src/leave/leave.definition.ts` is the example state machine.
- `packages/domain/src/leave/leave.registries.ts` owns example guards, policies, rules, system
  step references, templates, and channels.
- `packages/domain/src/notifications/templates.ts` and
  `packages/domain/src/notifications/recipients.ts` own notification wording and recipients.
- `packages/database/src/schema.ts` declares the tenant-owned data model; SQL history lives in
  `packages/database/migrations`.
- `apps/api/src/flow.controller.ts` owns the example HTTP route; `apps/web/src/features/requests/RequestForm.tsx`
  owns its workflow form.
- `apps/worker/src/workflows.ts` and `apps/notify-worker/src/delivery.worker.ts` are adapters from
  the application into the installed FlowKit contracts.

The full replacement order is in [customizing.md](customizing.md).

# Customizing the starter

Keep the example runnable as you customize it. Make the following replacements in this exact
order; each step changes starter-owned files and retains the installed FlowKit package contracts.

1. Rename product metadata and neutral theme tokens.
2. Replace seeded organizations, roles, and memberships.
3. Replace the leave definition and domain types.
4. Replace activity, guard, rule, and notification registries.
5. Add domain persistence and migrations.
6. Replace API routes and workflow forms.
7. Replace browser scenarios while retaining framework contract tests.

## 1. Metadata and theme

Update `package.json`, `apps/api/src/auth/auth.config.ts`, and user-facing text under
`apps/web/src`. Keep reusable styling neutral in `packages/ui/src/tokens.css`; product terms belong
in feature modules, not reusable UI primitives. Check `packages/ui/src/components/components.test.tsx`
after a token or component change.

## 2. Organizations, roles, and memberships

Replace the example records in `packages/database/scripts/seed.ts`, role declarations in
`packages/domain/src/roles.ts`, and lookup behavior in
`packages/domain/src/auth/role-registry.ts`. Update `test/seeded-actor.test.ts` with both tenant
directions represented. An active organization must still be derived from server-validated session
membership; request-body organization IDs are never authoritative.

## 3. Definition and types

Replace `packages/domain/src/leave/leave.definition.ts`,
`packages/domain/src/leave/leave.types.ts`, and `packages/domain/src/leave/workflow-type.ts` with
the new domain vocabulary. Keep the definition and its version explicit. Verify it with
`test/definition.test.ts` and `test/workflow-type.test.ts`.

## 4. Registries and notifications

Replace the example behavior in `packages/domain/src/leave/leave.registries.ts`, recipient logic in
`packages/domain/src/notifications/recipients.ts`, and message content in
`packages/domain/src/notifications/templates.ts`. Activities, guards, policies, rules, and
notifications must use names registered through the application boundary; do not reach into an
installed package implementation.

## 5. Persistence and migrations

Add tenant-owned tables to `packages/database/src/schema.ts`, repositories under
`packages/database/src`, and forward-only SQL under `packages/database/migrations`. Every
repository operation needs tenant predicates. Preserve the non-disclosing not-found behavior for a
cross-organization read. Test SQL scoping in `packages/database/test/tenant-sql-scope.test.ts` and
isolation in `packages/database/test/tenant-isolation.integration.test.ts`.

Never point the starter migration runner at a shared or remote database. The automatic guard accepts
only the marked disposable `flowkit_demo` database. Obtain explicit approval before running a
migration or seed command.

## 6. API routes and browser forms

Replace the example controller in `apps/api/src/flow.controller.ts`, related transport wiring in
`apps/api/src/app.module.ts`, browser route composition in `apps/web/src/router.tsx`, and the form
in `apps/web/src/features/requests/RequestForm.tsx`. Continue deriving the organization from the
server session and continue sending mutation idempotency keys. Do not trust organization fields
supplied by a form.

## 7. Scenarios and contract tests

Replace the example browser journey in `test/browser-flow.playwright.ts` and the application tests
that express the old domain. Keep `test/package-contracts.preflight.test.ts`,
`test/package-boundary.test.ts`, and tenant isolation coverage: they protect the installed-framework
boundary and the tenant invariant while product behavior changes. The browser test requires an
already-running, explicitly approved disposable stack; it does not create one.

## Rules that do not change

Do not edit `node_modules`, copy `@naakwu/flowkit-` implementation, or import framework source.
Use released package artifacts when they are available, and follow
[local-package-overrides.md](local-package-overrides.md) only for temporary pre-publication testing.
Every new data access path must carry tenant predicates, and every identity decision must come from
server-validated session membership.

# FlowkitForm Rename and Demo Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the `flowkit-demo` identity across package names, environment variables, PostgreSQL identity and deployment resources in favour of `flowkitform`, and quarantine the demo application behind honest `demo-` names so it stays runnable and green while the document product grows beside it.

**Architecture:** One npm scope `@flowkitform/*` holds both product and demo workspaces, distinguished by package name rather than directory: product packages keep bare names (`@flowkitform/document`), demo workspaces take a `demo-` prefix (`@flowkitform/demo-api`). Directory paths are deliberately unchanged. The demo leaves the default `test` and `build` targets and runs under explicit `test:examples` / `build:examples` scripts; a boundary test enforces that product packages never import a demo package. No behaviour changes, no deletions.

**Tech Stack:** TypeScript/Bun workspaces, PostgreSQL 16 via `postgres`, Docker Compose, k3s/kustomize, Tilt, GitHub Actions.

**Spec:** [Approved design](../specs/2026-11-14-flowkitform-design.md); [wave plan](2026-11-14-release-waves.md). This plan is naming and packaging only — it predates and unblocks P0/P1 and must not alter runtime behaviour, schema content or test semantics.

## Global Constraints

- No behaviour change. Every task is a rename or a packaging move; a reviewer must be able to read each diff as pure substitution.
- The demo is quarantined, never deleted. It remains runnable, and its suites stay in CI under an explicit target.
- Migration **filenames and file contents are frozen**. They are tracked by name plus SHA-256 checksum; editing either re-runs applied migrations.
- Every database-name guard moves in the same commit as the database rename. A half-applied rename must fail closed, never open.
- Existing `@teopeurt/flowkit-*` dependencies stay pinned at 1.2.0 and are never renamed — they are the vendor's packages, not ours.
- The environment-variable prefix is `FLOWKITFORM_` with no `DEMO` infix, matching `FLOWKITFORM_AWS_TEST_APPROVED` already specified in the AWS slice plan. Runtime identity (env vars, database, infrastructure) carries the product name; only package names mark the demo.

## Review Focus

- **Migration re-run:** renaming `0001_flowkit_demo.sql` or touching any migration body changes its checksum and makes the runner treat it as pending (Task 5).
- **Guard fail-open:** the disposable-database name is asserted in four places (`scripts/lib/local-database-guard.ts`, `packages/domain/src/config.ts`, `packages/database/scripts/migrate.ts`, `scripts/reset-stack.ts`). A rename that lands in three of four either bricks local tooling or loosens the guard that keeps destructive commands off non-disposable databases (Task 5).
- **Stale cluster marker:** `DISPOSABLE_DATABASE_MARKER` is read from PostgreSQL `cluster_name`, set by compose. Rename the marker without recreating the volume and the guard validates against a stale database (Task 5).
- **Silent env-var misses:** `FLOWKIT_DEMO_MIGRATION_APPROVED`, `_ALLOW_SEED` and `_CI_APPROVED` are string-compared, not schema-validated. A missed rename reads as "not approved" (fails closed, loud) but a *duplicated* old-and-new read fails open (Task 4).
- **CI self-match trick:** `.github/workflows/ci.yml:47` splits literals (`'packages/flowkit-''demo'`) so the guard does not match its own source. Preserve that construction when editing (Task 6).
- **Default-suite silence:** moving demo tests out of `bun test` must not silently reduce CI coverage; `test:examples` has to be wired into the workflow in the same commit (Task 7).

## Facts verified for planning

Measured in this repository at `f6d3173`:

- `@flowkit-demo/` — 129 references across 9 manifests; fully compiler-verified by `tsc --noEmit`.
- `FLOWKIT_DEMO_` — 88 references, 20 distinct variables; not compiler-verified.
- `flowkit_demo` — 115 references: PostgreSQL database/user/password, compose project, volume `flowkit_demo_postgres`, Temporal helm values, migration tracking table `flowkit_demo_migrations`.
- `flowkit-demo` — k8s resource names, image tags, ingress hosts, CI artefact paths.
- Migrations run through `packages/database/scripts/migrate.ts`: ordered by filename, tracked in `flowkit_demo_migrations` by `(name, sha256(sql))`, serialized by `pg_advisory_lock(hashtext('flowkit_demo_migrations'))`. No migration body contains `flowkit_demo`.
- Test databases follow `flowkit_demo_test(_[a-z0-9_]+)?` (`packages/domain/src/config.ts:11`).
- Gate tests asserting current names: `test/documentation.test.ts`, `test/repository-boundaries.test.ts`, `test/deployment-contract.test.ts`, `scripts/stack-ci.test.ts`, `scripts/lib/local-database-guard.test.ts`.

## Naming map

| Current | Target |
| --- | --- |
| `@flowkit-demo/workspace` | `@flowkitform/workspace` |
| `@flowkit-demo/document` | `@flowkitform/document` |
| `@flowkit-demo/domain` | `@flowkitform/demo-domain` |
| `@flowkit-demo/database` | `@flowkitform/demo-database` |
| `@flowkit-demo/ui` | `@flowkitform/demo-ui` |
| `@flowkit-demo/api` | `@flowkitform/demo-api` |
| `@flowkit-demo/worker` | `@flowkitform/demo-worker` |
| `@flowkit-demo/notify-worker` | `@flowkitform/demo-notify-worker` |
| `@flowkit-demo/web` | `@flowkitform/demo-web` |
| `FLOWKIT_DEMO_*` | `FLOWKITFORM_*` |
| PostgreSQL db/user/password `flowkit_demo` | `flowkitform` |
| Test databases `flowkit_demo_test*` | `flowkitform_test*` |
| Tracking table `flowkit_demo_migrations` | `flowkitform_migrations` |
| Cluster marker `flowkit_starter_identity` | `flowkitform_identity` |
| Compose project / volume `flowkit_demo*` | `flowkitform*` |
| k8s resources / images `flowkit-demo-*` | `flowkitform-*` |
| k8s namespace `flowkit-demo-dev` | `flowkitform-dev` |
| Temporal namespace / task queue `flowkit-demo*` | `flowkitform*` |
| Migration filenames `0001_flowkit_demo.sql` … | **unchanged (frozen)** |

Scope rename and `demo-` prefixing are applied in a single pass (Task 2) rather than as two commits, because splitting them rewrites the same 129 import sites twice for no added safety — the compiler verifies either form equally.

### Task 1: Pin the current state with a rename-completeness gate

**Files:** Create `test/naming-contract.test.ts`.

**Interfaces:** A test that scans tracked sources and asserts the retired identifiers are absent, parameterised so it fails until the rename completes. Export nothing; this is a gate, not a library.

- [x] Write a test asserting that no tracked file outside `docs/superpowers/`, `packages/database/migrations/` and this plan contains `@flowkit-demo/`, `FLOWKIT_DEMO_`, `flowkit_demo` or `flowkit-demo`. Build the forbidden literals from split strings so the test never matches its own source. Allow-list migration filenames explicitly, with a comment stating they are checksum-tracked history.
- [x] Run `bun test test/naming-contract.test.ts`; expect FAIL listing roughly 148 files. Record the count as the starting baseline.
- [x] Commit: `test: gate retired flowkit-demo identifiers`.

### Task 2: Rename the npm scope and prefix demo workspaces

**Files:** Modify all 9 `package.json` manifests, `bun.lock`, and every importing source under `apps/`, `packages/`, `scripts/`, `test/`.

**Interfaces:** Apply the naming map above. Package *directories* do not move. `packages/document` keeps its bare product name and its existing public surface (`DocumentService`, the repository contracts, the error types) unchanged.

- [x] Rewrite the nine manifest `name` fields and every `workspace:*` dependency entry to the mapped names.
- [x] Rewrite all import specifiers. Verify no `@flowkit-demo/` remains outside docs and this plan.
- [x] Run `bun install` to relink workspaces, then `bunx tsc --noEmit`; expect PASS with zero unresolved specifiers. The typecheck is the completeness proof for this task.
- [x] Run `bun test ./test/` and `bun test packages/database/test`; expect PASS unchanged from baseline (demo suites still run from the default target at this point).
- [x] Commit: `refactor: rename packages to @flowkitform scope`.

### Task 3: Separate product and demo build targets

**Files:** Modify root `package.json`, `tsconfig.build.json`; create `tsconfig.examples.json`.

**Interfaces:** `build` compiles product workspaces only; `build:examples` compiles the demo. `typecheck` continues to cover the entire repository — the demo must keep typechecking, it is only excluded from the shipped build.

- [x] Add `tsconfig.examples.json` covering the demo workspaces; narrow `tsconfig.build.json` to `packages/document` plus future product packages.
- [x] Add `build:examples` and keep `build:web` reachable from it. Leave `dev*`, `stack:*`, `db:*` and `scenario` scripts pointed at the demo; they are demo entrypoints by definition.
- [x] Run `bun run typecheck`, `bun run build` and `bun run build:examples`; expect all PASS and the product `dist` to contain no demo output.
- [x] Commit: `build: split product and example build targets`.

### Task 4: Rename the environment-variable prefix

**Files:** Modify `packages/domain/src/config.ts`, `.env.example`, `scripts/*.ts`, `scripts/lib/*.ts`, `apps/**/src/**`, `test/**`, `deploy/k8s/base/configmap.yaml`, `deploy/compose/docker-compose.yml`, `docker-compose.yml`, `Tiltfile`, `deploy/tilt/k3s.Tiltfile`, `.github/workflows/ci.yml`, `README.md`, `docs/deployment.md`.

**Interfaces:** All 20 variables move from `FLOWKIT_DEMO_` to `FLOWKITFORM_`. No variable gains a fallback to its old name — a dual read would let a stale deployment satisfy an approval gate silently.

- [x] Extend `test/naming-contract.test.ts` to assert no source reads a `FLOWKIT_DEMO_` variable and that no approval gate accepts two spellings.
- [x] Rewrite the prefix across code, compose, kustomize, Tilt, CI and docs. Update the Zod schema keys in `config.ts` together with their consumers.
- [x] Run `bun test test/ scripts/ packages/database/test` and `bun run typecheck`; expect PASS. Confirm `FLOWKITFORM_MIGRATION_APPROVED` unset still blocks `db:migrate` with the guarded error.
- [x] Update any CI repository secrets/variables carrying the old names before merging; a rename landed without them turns approval gates off, not on.
- [x] Commit: `refactor: rename environment prefix to FLOWKITFORM`.

### Task 5: Rename the PostgreSQL identity and its guards

**Files:** Modify `scripts/lib/local-database-guard.ts`, `scripts/lib/local-database-guard.test.ts`, `scripts/reset-stack.ts`, `scripts/dev.ts`, `scripts/stack-ci.ts`, `packages/database/scripts/migrate.ts`, `packages/database/scripts/seed.ts`, `packages/domain/src/config.ts`, `test/durable-test-database.ts`, `docker-compose.yml`, `deploy/compose/docker-compose.yml`, `deploy/k8s/base/postgres.yaml`, `deploy/k8s/base/flowkit-migration.yaml`, `deploy/k8s/base/flowkit-seed.yaml`, `deploy/k8s/temporal/values-k3s-dev.yaml`. **Do not modify** `packages/database/migrations/*.sql`.

**Interfaces:** `DISPOSABLE_DATABASE_NAME = 'flowkitform'`, `DISPOSABLE_DATABASE_MARKER = 'flowkitform_identity'`. The four database-name regexes (`local-database-guard.ts`, `config.ts:11,12,29`, `migrate.ts:11`, `reset-stack.ts:3`) change in this one commit. The migration tracking table and its advisory-lock key become `flowkitform_migrations`.

- [x] Add guard tests asserting that the old database name is now *rejected*, that a database matching the new name but carrying a stale `cluster_name` marker is rejected, and that a partially renamed URL never passes.
- [x] Run the guard tests; expect FAIL before implementation.
- [x] Apply the rename to database, user, password, compose project, volume `flowkitform_postgres`, the `cluster_name` marker, Temporal helm values and the test-database pattern `flowkitform_test*`. Leave migration filenames and bodies untouched so every checksum stays valid.
- [x] Tear down and rebuild local state: `docker compose -p flowkit_demo down -v` for the old project, then `bun run stack:up` for the new one. The old named volume is intentionally orphaned, not migrated.
- [x] For any persistent deployment that must survive in place, apply `ALTER DATABASE flowkit_demo RENAME TO flowkitform;`, `ALTER ROLE flowkit_demo RENAME TO flowkitform;` and `ALTER TABLE flowkit_demo_migrations RENAME TO flowkitform_migrations;` before deploying; a fresh tracking table would re-run all six applied migrations. Record whether any such deployment exists; if none, state that explicitly.
- [x] Run `FLOWKITFORM_MIGRATION_APPROVED=true bun run db:migrate`, then `bun run db:seed`, then the integration suites; expect six migrations applied to a fresh database and PASS throughout.
- [x] Commit: `refactor: rename database identity to flowkitform`.

### Task 6: Rename deployment resources and CI identifiers

**Files:** Modify `deploy/k8s/base/*.yaml`, `deploy/k8s/overlays/**`, `deploy/k8s/examples/**`, `deploy/scripts/*.sh`, `deploy/README.md`, `Dockerfile`, `Tiltfile`, `deploy/tilt/k3s.Tiltfile`, `.github/workflows/ci.yml`, `test/deployment-contract.test.ts`.

**Interfaces:** k8s resource names, labels, image tags and ingress hosts move from `flowkit-demo-*` to `flowkitform-*`. `deploy/k8s/examples/secrets.env.example` and `.env.example` survive as templates — they are scaffolding, not demo content.

- [x] Update `test/deployment-contract.test.ts` expectations to the new resource names first; expect FAIL.
- [x] Rename resources, labels, selectors, image references and the CI artefact path. When editing `.github/workflows/ci.yml:47`, keep the split-literal construction so the legacy guard still cannot match its own source, and extend it to catch the retired names.
- [x] Run `kubectl kustomize deploy/k8s/overlays/k3s-dev` and confirm it renders with consistent selectors and no dangling old names; run `bun test test/deployment-contract.test.ts` and `bun test scripts/stack-ci.test.ts`; expect PASS.
- [x] Note in `deploy/README.md` that applying this overlay to an existing cluster creates new objects and leaves the previous `flowkit-demo-*` objects and the `flowkit-demo-dev` namespace to be deleted deliberately.
- [x] Commit: `refactor: rename deployment resources to flowkitform`.

### Task 7: Quarantine demo suites and enforce the product boundary

**Files:** Move the demo suites under `test/demo/`; create `test/product-boundary.test.ts`; modify root `package.json`, `test/repository-boundaries.test.ts`, `.github/workflows/ci.yml`, `playwright.config.ts`.

**Interfaces:** `bun test` runs product suites only — the document suites plus the repository-wide gates (`package-boundary`, `repository-boundaries`, `documentation`, `deployment-contract`, `naming-contract`, `product-boundary`). `bun run test:examples` runs everything under `test/demo/`. Both run in CI.

- [x] Write `test/product-boundary.test.ts` asserting that no file under `packages/document/` imports any `@flowkitform/demo-*` package, and that the root `test` script does not reference `test/demo/`. Expect FAIL before the move.
- [x] Move the demo suites (leave, ride, enrolment, postgres stores, auth/api/browser e2e, notifications, scenario, schema, tenant and workflow suites, plus helpers `durable-test-database.ts` and the Playwright specs) into `test/demo/`, fixing relative imports. Keep `test/document-*.test.ts`, `test/in-memory-document-store.ts` and the repository-wide gates at `test/`.
- [x] Update `test/repository-boundaries.test.ts` `requiredDirectories` to the post-rename reality and add `packages/document/src`.
- [x] Add `test:examples` to root scripts, point `playwright.config.ts` at the moved specs, and add an explicit `test:examples` CI step so demo coverage stays gated rather than dropped.
- [x] Run `bun test`, `bun run test:examples`, `bun run typecheck` and `bun run build`; expect PASS with the product suite requiring no Docker stack.
- [x] Commit: `test: quarantine demo suites behind an explicit target`.

### Task 8: Reconcile documentation and close the naming gate

**Files:** Modify `README.md`, `docs/architecture.md`, `docs/customizing.md`, `docs/deployment.md`, `docs/spec.md`, `docs/roadmap.md`, `docs/local-package-overrides.md`, `deploy/README.md`, `test/documentation.test.ts`.

**Interfaces:** Documentation describes one repository holding a document product and a quarantined FlowKit demo, with the commands to run each. `docs/customizing.md` is retargeted from "replace the example" to "the example is quarantined; here is how to run, extend or remove it".

- [x] Update `test/documentation.test.ts` assertions — the README references `FLOWKIT_DEMO_MIGRATION_APPROVED`, `Acme Demo` and `Globex Demo` — to the renamed variables, and add assertions that the README documents both `bun test` and `bun run test:examples`.
- [x] Rewrite the affected documentation, including the new package names, environment prefix, database identity and the product/demo split. Leave `docs/superpowers/plans/` and `specs/` historical content intact; add a one-line note to `2026-11-14-release-waves.md` recording that the demo is now quarantined under `demo-` names so the wave plans' "does not import the demo app" constraints are mechanically checkable.
- [x] Run `bun test test/documentation.test.ts test/naming-contract.test.ts`; expect the naming gate from Task 1 to PASS for the first time, with only frozen migration filenames allow-listed.
- [x] Run the full set: `bun test`, `bun run test:examples`, `bun run typecheck`, `bun run build`, `bun run build:examples`; expect PASS.
- [x] Commit: `docs: describe the flowkitform product and quarantined demo`.

## Execution record (2026-11-15)

Executed in commits `9cfd177` … `HEAD` on this branch. Deviations from the plan as written:

- Environment variables became `FLOWKITFORM_*` rather than `FLOWKITFORM_DEMO_*`, and the database and infrastructure identity became plain `flowkitform`, per the amendment at execution time. Only package names mark the demo.
- Task 2 and Task 3 of the original draft merged: the scope rename and `demo-` prefixing landed in one commit because splitting them rewrites the same import sites twice.
- `test/package-boundary.test.ts` needed its relative-depth clause scoped to shipped source. Demo suites moved one directory deeper and now import the application they exercise as `../../apps/...`; the old rule passed only because of path depth, not by design.
- `packages/database/test` runs under `test:examples`, not the product target: it belongs to `@flowkitform/demo-database`.
- Two files intentionally retain the retired names and are allow-listed in the naming gate: `deploy/README.md` (documents the `ALTER DATABASE` upgrade path) and `scripts/lib/local-database-guard.test.ts` (asserts the old identity is rejected).

Verified: `bun run typecheck`, `bun run build`, `bun run build:examples`, `bun run test` (83 pass, 0 fail, no Docker required), `bun run test:examples` (91 pass, 22 skip, 3 fail).

The three `test:examples` failures are pre-existing Temporal time-skipping timeouts, confirmed by running the same suite at the pre-rename commit `ad93a16` in a scratch worktree, where they fail identically.

**Not verified here — Docker and kubectl are unavailable in this environment:** the live stack rebuild (`stack:up`), `db:migrate` and `db:seed` against a freshly named `flowkitform` database, the integration and browser suites that need that stack, and `kubectl kustomize` rendering of the renamed manifests. Manifest consistency was checked structurally instead, and the CI legacy-pattern guard was simulated locally. Run those gates on a machine with the stack before merging.

## Self-review and handoff

Every retired identifier family has an owning task and a mechanical gate: the compiler proves Task 2, `test/naming-contract.test.ts` proves Tasks 4–6, and `test/product-boundary.test.ts` proves Task 7. Tasks are independently revertable; the only one requiring destructive local action is Task 5, which recreates the disposable database by design.

Known residue accepted by this plan: migration filenames keep `flowkit_demo` permanently, because they are checksum-tracked history rather than branding. The naming gate allow-lists them explicitly.

Out of scope: deleting the demo (Option D). This plan deliberately leaves it runnable because it is currently the only executable evidence that FlowKit 1.2.0 integrates end-to-end. Revisit deletion once the P0/P1 document API carries its own e2e coverage; at that point the demo is a directory removal plus a script and CI cleanup, with no coverage cliff.

# FlowKitForm

FlowKitForm is an open-source document management platform for storing, processing, and governing
documents through durable, auditable workflows, built on the FlowKit workflow framework. It is
designed to run headless through its Document and workflow APIs and with a reference web client.
Read the [specification](docs/spec.md) for scope and goals, and the [roadmap](docs/roadmap.md) for
what exists today and what is planned.

**Status:** specification draft v0.2. The code in this repository is still the FlowKit Demo
starting point, a tenant-safe approval-workflow application. It is an application monorepo, not a
copy of the FlowKit framework: the six framework packages are consumed through their public
`@teopeurt/flowkit-*` exports, while this repository owns its domain, database, API, workers, and
browser experience. The document-management features in the specification are not implemented yet;
the sections below describe running and customizing the current application.

## Package availability

The FlowKit packages are published on [npmjs.org](https://www.npmjs.com/org/teopeurt) as
`@teopeurt/flowkit-*` (version `1.2.0`; versions through `1.0.0` used the `@naakwu` scope). They are
public, so installing them needs no token and no `.npmrc`:

```sh
bun install --frozen-lockfile
```

Source and releases live in [teopeurt/flowkit](https://github.com/teopeurt/flowkit). See
[local package overrides](docs/local-package-overrides.md) for testing an unreleased FlowKit change
against this repository.

## Default local development

After dependencies are installed, the single development entry point is:

```sh
bun run dev
```

It validates Docker, starts the disposable dependency
stack, validates the database identity, runs the approved local migration and seed, then starts the
API, workflow worker, notification worker, and Vite application. It prints these local addresses:

- Web: <http://localhost:5173/>
- API readiness: <http://localhost:3011/health/ready>
- Mailpit: <http://localhost:8025/>
- Temporal endpoint: `localhost:7233`

The seed supplies two isolated organizations: **Acme Demo** (`acme-demo`) and **Globex Demo**
(`globex-demo`). Each has employee, manager, HR, and read-only auditor memberships. In development
only, the seed command prints the demo credentials after it completes; test runs never print them.

### Migration safety

The checked-in SQL is only for the recognized disposable database. The guard permits only
`flowkit_demo` on `localhost`, loopback, or the Compose `postgres` service; it requires the
`flowkit_starter_identity` marker and rejects TLS. Remote databases never qualify for automatic
migration or seed operations. Do not run a migration manually unless you have explicit approval:

```sh
FLOWKIT_DEMO_MIGRATION_APPROVED=true bun run db:migrate
```

`bun run dev` can set that approval only after all local-identity checks pass. `bun run stack:reset`
prints a guarded reset instruction rather than deleting data itself.

## Validation and customization

Run the static gates after a source change:

```sh
bun run typecheck
bun run test
bun run build
```

The durable and browser suites require an explicitly approved disposable stack; they never create
or migrate one by themselves. Start with the ordered guide in
[customizing](docs/customizing.md), then consult the [architecture](docs/architecture.md),
[deployment](docs/deployment.md), and [local package overrides](docs/local-package-overrides.md).

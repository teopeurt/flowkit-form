# FlowKit Demo

FlowKit Demo is a clone-and-customize reference application for a tenant-safe approval workflow.
It is an application monorepo, not a copy of the FlowKit framework: the six framework packages are
consumed through their public `@naakwu/flowkit-*` exports, while this repository owns its domain,
database, API, workers, and browser experience.

## Current package availability

The FlowKit packages are private GitHub Packages during this phase. They require a GitHub token
with `read:packages` and access to the package-owning repository. Version `0.2.0` is not published
to GitHub Packages yet. Therefore a clean archive cannot currently complete
`bun install --frozen-lockfile`, even after package authentication is configured. That clean-clone
gate is deferred until the private `0.2.0` artifacts exist; do not describe local registry
artifacts as released packages.

When the private artifacts are available, configure the repository-root `.npmrc` without putting a
token in the file:

```sh
cp .npmrc.example .npmrc
export NODE_AUTH_TOKEN=your-github-packages-read-token
bun install --frozen-lockfile
```

`.npmrc.example` deliberately uses the exact private scope configuration:

```text
@naakwu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
always-auth=true
```

Keep `.npmrc` and `NODE_AUTH_TOKEN` private. Never commit a token or pass it as a Docker build
argument. See [local package overrides](docs/local-package-overrides.md) for temporary local-artifact
testing before publication.

## Default local development

After dependencies are installed, the single development entry point is:

```sh
bun run dev
```

It validates Docker and the package credential configuration, starts the disposable dependency
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

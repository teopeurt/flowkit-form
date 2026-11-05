# Deployment workflows

Docker Compose is the default local dependency stack. k3s with Tilt is an opt-in,
production-shaped development path. Neither path changes the package boundary: both install
private packages through an ephemeral npmrc secret rather than embedding a token in an image.

## Compose

`docker-compose.yml` provides PostgreSQL, Temporal, the Temporal namespace helper, and Mailpit for
the one-command development workflow. `deploy/compose/docker-compose.yml` is the full containerized
application stack. Its npmrc secret defaults to the repository-root `.npmrc` through
`FLOWKIT_NPMRC_PATH:-../../.npmrc`; set `FLOWKIT_NPMRC_PATH` to use another credential file.

After private package artifacts are available and `.npmrc` is configured, validate configuration
without starting services:

```sh
docker compose -f deploy/compose/docker-compose.yml config --quiet
```

Migration and seed services are deliberately ordered and guarded. Do not start them against any
database other than the disposable target, and do not set `FLOWKIT_DEMO_MIGRATION_APPROVED=true`
without explicit approval.

## k3s and Tilt

The default `Tiltfile` uses local Compose. Select k3s explicitly with:

```sh
export TILT_MODE=flowkit-k3s
export FLOWKIT_K3S_NAMESPACE=flowkit-demo-dev
export FLOWKIT_K3S_REGISTRY=registry.example.invalid/flowkit-demo-dev
tilt up
```

The implementation is `deploy/tilt/k3s.Tiltfile`; Kubernetes manifests are in `deploy/k8s`. Read
the operational prerequisites and secret bootstrap procedure in `deploy/README.md` and
`deploy/k8s/examples/README.md` before starting Tilt. Tilt uses `$HOME/.npmrc` by default for its
BuildKit secret; override it with `FLOWKIT_NPMRC_PATH`. The migration and seed resources have manual
initialization, so trigger the migration only after explicit approval, then seed, then application
workloads.

The repository does not prescribe a cloud environment. Before changing manifests, run the static
deployment contract test:

```sh
bun test test/deployment-contract.test.ts
```

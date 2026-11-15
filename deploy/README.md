# k3s + Tilt deployment

The original local Docker Compose workflow remains the default:

```sh
tilt up
```

The k3s path requires Tilt, Docker/BuildKit, `kubectl`, Helm 3, and access to
the authenticated registry. The local Compose path does not require Helm.

The hosted registry and k3s are used only when explicitly selecting the opt-in
mode `TILT_MODE=flowkit-k3s` documented below. The legacy `TILT_MODE=k3s`
mode is retired and no longer selects a working workflow.

Application and web image dependency installs use the public `@teopeurt/flowkit-*`
packages from npmjs.org. No registry credential, build secret, or build argument
is needed.

## FlowKit demo mode

`TILT_MODE=flowkit-k3s` runs the FlowKit demo against k3s instead of the
legacy AVSEC stack:

```sh
export KUBECONFIG=/Users/teopeurt/workspace/k3s/k3s.yaml
export TILT_MODE=flowkit-k3s
export FLOWKIT_K3S_NAMESPACE=flowkitform-dev
export FLOWKIT_K3S_REGISTRY=docker.pigstycoders.com/flowkitform-dev
tilt up
```

It builds only the `flowkitform` image (from the repository-root
`Dockerfile`), applies the Kustomize stack, and installs
Temporal from the upstream Helm chart in the `flowkitform-dev` namespace. The
target hostname family is:

- `https://flowkit.k3s.naakwu.app` — FlowKit demo
- `https://mail.flowkit.k3s.naakwu.app` — Mailpit UI (basic auth)
- `https://temporal.flowkit.k3s.naakwu.app` — Temporal UI (basic auth)

## One-time cluster bootstrap

Create the namespace/secrets before starting Tilt. The namespace is
intentionally outside the ordinary Tilt resource graph so `tilt down` does not
remove PVCs.

### Upgrading from the flowkit-demo naming

Resources were renamed from `flowkit-demo*` to `flowkitform*`, and the
namespace from `flowkit-demo-dev` to `flowkitform-dev`. Applying this overlay to
a cluster that ran the old names creates a parallel set of objects; it does not
rename the old ones. Delete the previous `flowkit-demo-*` objects and the
`flowkit-demo-dev` namespace deliberately, after confirming nothing you need
still runs there.

The PostgreSQL database, user and volume moved from `flowkit_demo` to
`flowkitform` in the same change. A fresh deployment needs no action. To keep
an existing database in place, rename it before deploying:

```sql
ALTER DATABASE flowkit_demo RENAME TO flowkitform;
ALTER ROLE flowkit_demo RENAME TO flowkitform;
ALTER TABLE flowkit_demo_migrations RENAME TO flowkitform_migrations;
```

The tracking-table rename matters: the migration runner keys applied migrations
on `(filename, sha256(body))`, so a fresh `flowkitform_migrations` table would
re-run all six applied migrations. Migration filenames deliberately keep the old
spelling — they are checksum-tracked history, not branding.

cert-manager is optional for the core FlowKit deploy. Install it only when you
want Tilt to request the real Let's Encrypt certificate:

```sh
export ACME_EMAIL=ops@example.com
./deploy/scripts/bootstrap-flowkit-cert-manager.sh
```

The script installs cert-manager from the official Jetstack OCI chart, enables
its CRDs, waits for the controllers, renders `letsencrypt-prod` from
`deploy/k8s/bootstrap/cluster-issuer.yaml`, and applies it. Override the chart
version with `CERT_MANAGER_VERSION=v1.20.3` if needed. After it succeeds, start
Tilt with `FLOWKIT_K3S_CERT_MANAGER_ENABLED=true` to apply
`deploy/k8s/base/certificates.yaml`. Leave it unset/false when the cluster does
not have cert-manager installed.

Then create/update the FlowKit namespace and required secrets:

```sh
cp deploy/k8s/examples/secrets.env.example deploy/k8s/examples/secrets.env
# edit deploy/k8s/examples/secrets.env with real values; do not commit it
./deploy/scripts/bootstrap-flowkit-k3s.sh
```

The bootstrap script loads `deploy/k8s/examples/secrets.env` automatically when
it exists. Override the path with `FLOWKIT_K3S_ENV_FILE=/path/to/file`, or export
variables directly in your shell. The committed example intentionally contains
no values. Set `FLOWKITFORM_MIGRATION_APPROVED=true` only for the explicit
migration run, then return it to `false`.

If Tilt reports `namespaces "flowkitform-dev" not found`, stop Tilt, run the
bootstrap script above, then start `TILT_MODE=flowkit-k3s tilt up` again.

The script is idempotent and uses `kubectl apply`; rerunning it updates the
secrets. It does not install charts, apply application manifests, run
migrations, deploy workloads, or install cert-manager. Run
`./deploy/scripts/bootstrap-flowkit-cert-manager.sh` before enabling
`FLOWKIT_K3S_CERT_MANAGER_ENABLED=true`. Do not commit rendered secret files.

Point DNS records for the FlowKit hosts (listed under "FlowKit demo mode") at
the Traefik LoadBalancer address before expecting HTTP-01 certificates to
become ready.

## Safe validation

`deploy/scripts/validate-k3s-target.sh` is read-only and runs automatically as a
Tilt preflight. It verifies the selected context, a Ready node, and all required
secrets. It does not install charts, apply manifests, run migrations, or delete
resources. FlowKit database migrations are managed by the `flowkit-migration`
k8s resource once the user starts the flowkit-k3s Tilt workflow.

In Tilt, trigger `flowkit-migration` manually, then trigger `flowkit-seed`, then
let `flowkit-api`, `flowkit-worker`, and `flowkit-notify` start. This preserves
the repository rule that migrations run only after explicit approval. Both
manual jobs include a `wait-for-postgres` init container, so a manual trigger
will wait for `postgres:5432` instead of consuming the Job backoff limit while
the StatefulSet is still starting.

## Verification

```sh
kubectl -n flowkitform-dev get pods
kubectl -n flowkitform-dev get jobs
kubectl -n flowkitform-dev get ingress
curl -fsS https://flowkit.k3s.naakwu.app/health/live
curl -fsS https://flowkit.k3s.naakwu.app/health/ready
```

## Temporal schema hook failures

If Temporal fails on a pod named like `temporal-schema-*` and a container such
as `create-default-store`, inspect the schema hook logs before retrying:

```sh
kubectl -n flowkitform-dev logs pod/<temporal-schema-pod> -c create-default-store --previous
kubectl -n flowkitform-dev describe pod <temporal-schema-pod>
```

The FlowKit NetworkPolicies include an explicit allow rule for Temporal Helm
hook/schema pods to reach DNS and `postgres:5432`. Tilt applies them through
the ordered `flowkit-network-policies` local resource before the Temporal Helm
resource runs. They intentionally stay outside the kustomize overlay because
the overlay adds selector labels for Tilt-managed workloads, while Temporal's
Helm hook pods are chart-managed and must still match the policy.

If an earlier failed Helm operation is stuck, clear the failed release before
retriggering Temporal:

```sh
helm -n flowkitform-dev uninstall temporal --wait=false
```

If the schema hook still exits immediately after the policy is applied, check
whether an old Postgres PVC was initialized with a different user/password or a
role that cannot create databases:

```sh
kubectl -n flowkitform-dev exec statefulset/postgres -- sh -lc 'PGPASSWORD=flowkitform psql -h 127.0.0.1 -U flowkitform -d flowkitform -c "select current_user, rolsuper, rolcreatedb from pg_roles where rolname=current_user;"'
```

# k3s secrets

Prefer the idempotent bootstrap helper:

```sh
cp deploy/k8s/examples/secrets.env.example deploy/k8s/examples/secrets.env
# edit deploy/k8s/examples/secrets.env with real values
./deploy/scripts/bootstrap-flowkit-k3s.sh
```

It loads `deploy/k8s/examples/secrets.env` automatically when present and
creates the namespace plus these secrets in `flowkit-demo-dev` before starting
`TILT_MODE=flowkit-k3s tilt up`. The manual commands below are kept for
debugging and recovery.

When running through Tilt, `deploy/tilt/k3s.Tiltfile` applies
`deploy/k8s/base/network-policies.yaml` as the ordered
`flowkit-network-policies` resource before Temporal Helm starts. This avoids
Temporal schema hook pods being blocked by default-deny networking during the
initial install.

cert-manager certificates are intentionally opt-in. Leave
`FLOWKIT_K3S_CERT_MANAGER_ENABLED` unset/false unless the cluster has the
cert-manager CRDs and `letsencrypt-prod` ClusterIssuer installed.
To install both:

```sh
export ACME_EMAIL=ops@example.com
./deploy/scripts/bootstrap-flowkit-cert-manager.sh
```

```sh
kubectl -n flowkit-demo-dev create secret docker-registry flowkit-demo-registry \
  --docker-server=docker.pigstycoders.com \
  --docker-username="$REGISTRY_USERNAME" --docker-password="$REGISTRY_PASSWORD"

kubectl -n flowkit-demo-dev create secret generic flowkit-demo-runtime \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  --from-literal=FLOWKIT_DEMO_MIGRATION_APPROVED="$FLOWKIT_DEMO_MIGRATION_APPROVED"

htpasswd -nbB "$OPS_USER" "$OPS_PASSWORD" | kubectl -n flowkit-demo-dev create secret generic flowkit-demo-basic-auth \
  --from-file=users=/dev/stdin
```

The namespace and optional cert-manager `ClusterIssuer` are bootstrap resources
and are applied separately. Use
`deploy/scripts/bootstrap-flowkit-cert-manager.sh` for the cert-manager path.

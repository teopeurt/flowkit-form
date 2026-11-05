#!/usr/bin/env bash
set -euo pipefail

env_file="${FLOWKIT_K3S_ENV_FILE:-deploy/k8s/examples/secrets.env}"
if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

: "${KUBECONFIG:?Set KUBECONFIG to the k3s kubeconfig before bootstrapping FlowKit}"
: "${REGISTRY_USERNAME:?Set REGISTRY_USERNAME for docker.pigstycoders.com}"
: "${REGISTRY_PASSWORD:?Set REGISTRY_PASSWORD for docker.pigstycoders.com}"
: "${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET to a 32+ character secret}"
: "${OPS_USER:?Set OPS_USER for Mailpit/Temporal basic auth}"
: "${OPS_PASSWORD:?Set OPS_PASSWORD for Mailpit/Temporal basic auth}"

namespace="${FLOWKIT_K3S_NAMESPACE:-flowkit-demo-dev}"
database_url="${DATABASE_URL:-postgresql://flowkit_demo:flowkit_demo@postgres:5432/flowkit_demo}"
migration_approved="${FLOWKIT_DEMO_MIGRATION_APPROVED:-false}"

if [[ "${#BETTER_AUTH_SECRET}" -lt 32 ]]; then
  echo "BETTER_AUTH_SECRET must be at least 32 characters." >&2
  exit 1
fi

if ! command -v htpasswd >/dev/null 2>&1; then
  echo "htpasswd is required to create the basic-auth secret." >&2
  echo "Install apache2-utils/httpd-tools, or create flowkit-demo-basic-auth manually." >&2
  exit 1
fi

kubectl apply --validate=false -f deploy/k8s/bootstrap/namespace.yaml

kubectl -n "${namespace}" create secret docker-registry flowkit-demo-registry \
  --docker-server=docker.pigstycoders.com \
  --docker-username="${REGISTRY_USERNAME}" \
  --docker-password="${REGISTRY_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply --validate=false -f -

kubectl -n "${namespace}" create secret generic flowkit-demo-runtime \
  --from-literal=DATABASE_URL="${database_url}" \
  --from-literal=BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET}" \
  --from-literal=FLOWKIT_DEMO_MIGRATION_APPROVED="${migration_approved}" \
  --dry-run=client -o yaml | kubectl apply --validate=false -f -

htpasswd -nbB "${OPS_USER}" "${OPS_PASSWORD}" \
  | kubectl -n "${namespace}" create secret generic flowkit-demo-basic-auth \
      --from-file=users=/dev/stdin \
      --dry-run=client -o yaml \
  | kubectl apply --validate=false -f -

echo "FlowKit k3s bootstrap complete for namespace ${namespace}."
echo "Created/updated: flowkit-demo-registry, flowkit-demo-runtime, flowkit-demo-basic-auth."

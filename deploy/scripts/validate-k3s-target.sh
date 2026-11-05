#!/usr/bin/env bash
set -euo pipefail

: "${KUBECONFIG:?Set KUBECONFIG to the k3s kubeconfig before running Tilt}"

context="$(kubectl config current-context)"
namespace="${FLOWKIT_K3S_NAMESPACE:-flowkit-demo-dev}"
node_count="$(kubectl get nodes --no-headers 2>/dev/null | awk '$2 == "Ready" {count++} END {print count + 0}')"

if [[ "${node_count}" -lt 1 ]]; then
  echo "No Ready k3s node found in context ${context}" >&2
  exit 1
fi

if ! kubectl get namespace "${namespace}" >/dev/null 2>&1; then
  echo "Namespace ${namespace} is missing." >&2
  echo "Run: ./deploy/scripts/bootstrap-flowkit-k3s.sh" >&2
  exit 1
fi
kubectl get secret flowkit-demo-registry -n "${namespace}" >/dev/null
kubectl get secret flowkit-demo-runtime -n "${namespace}" >/dev/null
kubectl get secret flowkit-demo-basic-auth -n "${namespace}" >/dev/null

for key in DATABASE_URL BETTER_AUTH_SECRET FLOWKIT_DEMO_MIGRATION_APPROVED; do
  if ! kubectl get secret flowkit-demo-runtime -n "${namespace}" -o "jsonpath={.data.${key}}" | grep -q .; then
    echo "Secret flowkit-demo-runtime in ${namespace} is missing key ${key}" >&2
    exit 1
  fi
done

echo "k3s target ${context}/${namespace} is ready for FlowKit Tilt"

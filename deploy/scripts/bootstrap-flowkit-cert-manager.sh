#!/usr/bin/env bash
set -euo pipefail

: "${KUBECONFIG:?Set KUBECONFIG to the k3s kubeconfig before bootstrapping cert-manager}"
: "${ACME_EMAIL:?Set ACME_EMAIL for the Lets Encrypt ClusterIssuer}"

cert_manager_version="${CERT_MANAGER_VERSION:-v1.20.3}"
issuer_template="deploy/k8s/bootstrap/cluster-issuer.yaml"
issuer_rendered="$(mktemp)"

cleanup() {
  rm -f "${issuer_rendered}"
}
trap cleanup EXIT

for binary in helm kubectl; do
  if ! command -v "${binary}" >/dev/null 2>&1; then
    echo "${binary} is required to bootstrap cert-manager." >&2
    exit 1
  fi
done

helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version "${cert_manager_version}" \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true

kubectl -n cert-manager rollout status deployment/cert-manager --timeout=180s
kubectl -n cert-manager rollout status deployment/cert-manager-cainjector --timeout=180s
kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=180s

sed "s|\${ACME_EMAIL}|${ACME_EMAIL}|g" "${issuer_template}" > "${issuer_rendered}"
kubectl apply --validate=false -f "${issuer_rendered}"

kubectl get crd certificates.cert-manager.io >/dev/null
kubectl get clusterissuer letsencrypt-prod >/dev/null

echo "cert-manager ${cert_manager_version} is installed and ClusterIssuer letsencrypt-prod is ready."
echo "Start Tilt with FLOWKIT_K3S_CERT_MANAGER_ENABLED=true to apply deploy/k8s/base/certificates.yaml."

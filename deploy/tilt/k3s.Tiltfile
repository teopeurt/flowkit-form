# Opt-in FlowKit demo mode for k3s (TILT_MODE=flowkit-k3s).
# The root Tiltfile loads this only when TILT_MODE=flowkit-k3s.

load('ext://helm_resource', 'helm_resource', 'helm_repo')

# Builds only the FlowKit demo image and wires the flowkit-* resources.
def configure_flowkit_k3s():
    registry = os.getenv('FLOWKIT_K3S_REGISTRY', 'docker.pigstycoders.com/flowkit-demo-dev')
    namespace = os.getenv('FLOWKIT_K3S_NAMESPACE', 'flowkit-demo-dev')
    temporal_chart_version = os.getenv('TEMPORAL_HELM_CHART_VERSION', '1.2.0')
    target_platform = os.getenv('K3S_PLATFORM', 'linux/amd64')
    upsert_timeout_secs = int(os.getenv('FLOWKIT_K3S_UPSERT_TIMEOUT_SECS', '300'))
    cert_manager_enabled = os.getenv('FLOWKIT_K3S_CERT_MANAGER_ENABLED', 'false') == 'true'
    npmrc_path = os.getenv('FLOWKIT_NPMRC_PATH', os.getenv('HOME', '') + '/.npmrc')

    allow_k8s_contexts(os.getenv('K3S_TILT_CONTEXT', 'default'))
    update_settings(
        max_parallel_updates=2,
        k8s_upsert_timeout_secs=upsert_timeout_secs,
    )

    # The namespace is intentionally not part of the Kustomize graph, because
    # `tilt down` should not remove it or any PVCs living in it. Apply it once
    # up front so the first Tilt deploy cannot race namespaced resources.
    if os.getenv('FLOWKIT_K3S_AUTO_BOOTSTRAP_NAMESPACE', 'true') == 'true':
        local('kubectl apply --validate=false -f deploy/k8s/bootstrap/namespace.yaml')

    docker_build(
        registry + '/flowkit-demo',
        '.',
        dockerfile='Dockerfile',
        platform=target_platform,
        secret=['id=npmrc,src=%s' % npmrc_path],
    )

    local_resource(
        'k3s-preflight',
        cmd='./deploy/scripts/validate-k3s-target.sh',
        deps=[
            'deploy/scripts/validate-k3s-target.sh',
            'deploy/k8s/bootstrap/namespace.yaml',
            'deploy/k8s/examples/README.md',
            'deploy/k8s/overlays/k3s-dev',
        ],
        auto_init=True,
        allow_parallel=False,
    )

    local_resource(
        'flowkit-network-policies',
        cmd='kubectl -n %s apply --validate=false -f deploy/k8s/base/network-policies.yaml' % namespace,
        deps=[
            'deploy/k8s/base/network-policies.yaml',
            'deploy/k8s/bootstrap/namespace.yaml',
        ],
        resource_deps=['k3s-preflight', 'postgres'],
        auto_init=True,
        allow_parallel=False,
    )

    if cert_manager_enabled:
        local_resource(
            'flowkit-certificates',
            cmd='kubectl -n %s apply --validate=false -f deploy/k8s/base/certificates.yaml' % namespace,
            deps=[
                'deploy/k8s/base/certificates.yaml',
                'deploy/k8s/bootstrap/cluster-issuer.yaml',
            ],
            resource_deps=['k3s-preflight'],
            auto_init=True,
            allow_parallel=False,
        )

    k8s_yaml(kustomize('deploy/k8s/overlays/k3s-dev'))

    # Temporal is installed through its upstream chart because it ships
    # lifecycle hooks that should be handled by Helm, not plain YAML.
    # The helm_repo extension creates a local resource named after the repo
    # (resource_name), distinct from the 'temporal' helm_resource below.
    helm_repo('temporal', 'https://go.temporal.io/helm-charts', resource_name='temporal-repo')
    helm_resource(
        'temporal',
        'temporal/temporal',
        namespace=namespace,
        flags=[
            '--version=%s' % temporal_chart_version,
            '--values=deploy/k8s/temporal/values-k3s-dev.yaml',
        ],
        resource_deps=['k3s-preflight', 'postgres', 'flowkit-network-policies'],
    )

    k8s_resource('postgres', resource_deps=['k3s-preflight'])
    k8s_resource('mailpit', resource_deps=['k3s-preflight'])
    k8s_resource('flowkit-migration', resource_deps=['k3s-preflight', 'postgres', 'flowkit-network-policies'], auto_init=False)
    k8s_resource('flowkit-seed', resource_deps=['flowkit-migration'], auto_init=False)
    k8s_resource('flowkit-api', resource_deps=['flowkit-seed', 'temporal', 'flowkit-temporal-namespace'])
    k8s_resource('flowkit-worker', resource_deps=['flowkit-seed', 'temporal', 'flowkit-temporal-namespace'])
    k8s_resource('flowkit-notify', resource_deps=['flowkit-seed', 'mailpit', 'flowkit-network-policies'])
    k8s_resource('flowkit-temporal-namespace', resource_deps=['k3s-preflight', 'temporal'])

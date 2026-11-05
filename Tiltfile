tilt_mode = os.getenv('TILT_MODE', 'local')

if tilt_mode == 'flowkit-k3s':
    k3s_symbols = load_dynamic('deploy/tilt/k3s.Tiltfile')
    k3s_symbols['configure_flowkit_k3s']()
elif tilt_mode == 'k3s':
    fail('TILT_MODE=k3s is retired; use TILT_MODE=flowkit-k3s')
else:
    docker_compose('docker-compose.yml')

    local_resource(
        'flowkit-migration',
        cmd='FLOWKIT_DEMO_MIGRATION_APPROVED=true bun run db:migrate',
        resource_deps=['postgres'],
        auto_init=False,
        allow_parallel=False,
    )
    local_resource(
        'flowkit-seed',
        cmd='FLOWKIT_DEMO_ALLOW_SEED=true bun run db:seed',
        resource_deps=['flowkit-migration'],
        auto_init=False,
        allow_parallel=False,
    )
    local_resource(
        'flowkit-api',
        serve_cmd='bun run dev:api',
        deps=['apps/api/src', 'packages/database/src', 'packages/domain/src'],
        resource_deps=['flowkit-seed', 'temporal-namespace'],
    )
    local_resource(
        'flowkit-worker',
        serve_cmd='bun run dev:worker',
        deps=['apps/worker/src', 'packages/database/src', 'packages/domain/src'],
        resource_deps=['flowkit-seed', 'temporal-namespace'],
    )
    local_resource(
        'flowkit-notify',
        serve_cmd='bun run dev:notify',
        deps=['apps/notify-worker/src', 'packages/database/src', 'packages/domain/src'],
        resource_deps=['flowkit-seed', 'mailpit'],
    )
    local_resource(
        'flowkit-web',
        serve_cmd='bun run dev:web',
        deps=['apps/web/src', 'packages/ui/src'],
        resource_deps=['flowkit-api'],
    )

import { describe, expect, it } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

async function filesBelow(path: string): Promise<string[]> {
  const directory = resolve(root, path);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

function yaml<T>(source: string): T {
  return Bun.YAML.parse(source) as T;
}

type ComposeService = {
  build?: {
    context?: string;
    dockerfile?: string;
    secrets?: string[];
  };
  command?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
};

type ComposeFile = {
  name?: string;
  services: Record<string, ComposeService>;
  secrets?: Record<string, { file?: string }>;
};

const workloadCommands = {
  api: ['bun', 'run', 'apps/api/src/main.ts'],
  worker: ['bun', 'run', 'apps/worker/src/main.ts'],
  notify: ['bun', 'run', 'apps/notify-worker/src/delivery.worker.ts'],
  migration: ['bun', 'run', 'db:migrate'],
  seed: ['bun', 'run', 'db:seed'],
} as const;

async function resolveLocalImport(
  importer: string,
  specifier: string,
  workspaceExports: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  let unresolved: string;
  if (specifier.startsWith('.')) {
    unresolved = resolve(dirname(importer), specifier);
  } else {
    const workspaceExport = workspaceExports.get(specifier);
    if (workspaceExport === undefined) {
      if (specifier.startsWith('@flowkit-demo/')) {
        throw new Error(`Unresolved workspace package import ${specifier} from ${relative(root, importer)}`);
      }
      return undefined;
    }
    unresolved = resolve(root, workspaceExport);
  }

  for (const candidate of [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, resolve(unresolved, 'index.ts')]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Unable to resolve local import ${specifier} from ${relative(root, importer)}`);
}

async function runtimeDependencyClosure(entries: readonly string[]): Promise<Set<string>> {
  const workspaceExports = new Map<string, string>();
  for (const packageJsonPath of (await filesBelow('packages')).filter((path) => path.endsWith('/package.json'))) {
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { name: string; exports?: string };
    if (typeof manifest.exports === 'string') {
      workspaceExports.set(manifest.name, relative(root, resolve(dirname(packageJsonPath), manifest.exports)));
    }
  }

  const pending = entries.map((entry) => resolve(root, entry));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const localPath = relative(root, current);
    if (visited.has(localPath)) continue;
    visited.add(localPath);

    const source = await readFile(current, 'utf8');
    const imports = source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const match of imports) {
      const dependency = await resolveLocalImport(current, match[1], workspaceExports);
      if (dependency !== undefined) pending.push(dependency);
    }
  }
  return visited;
}

describe('deployment contract', () => {
  it('installs private packages only through an ephemeral BuildKit npmrc secret', async () => {
    const dockerfile = await text('Dockerfile');
    const lockfile = await text('bun.lock');
    const installs = dockerfile.split('\n').filter((line) => /^RUN .*bun install/.test(line));

    expect(dockerfile).toStartWith('# syntax=docker/dockerfile:1.7');
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) {
      expect(install).toContain('--mount=type=secret,id=npmrc,target=/root/.npmrc,required=true');
    }
    expect(dockerfile).not.toMatch(/^(?:ARG|ENV)\s+.*(?:TOKEN|NPMRC|PASSWORD)/im);
    expect(dockerfile).not.toMatch(/^COPY\s+.*\.npmrc/im);

    const dockerignore = await text('.dockerignore');
    expect(dockerignore.split(/\r?\n/)).toContain('.npmrc');
    expect(dockerignore.split(/\r?\n/)).toContain('.env');
    expect(lockfile).not.toContain('http://127.0.0.1:4873');
    if (process.env.FLOWKIT_DEMO_CANDIDATE_TARBALLS === 'true') {
      expect(lockfile).toContain('"overrides"');
    } else {
      for (const packageName of ['auth', 'consumer', 'core', 'notify', 'tasks', 'temporal']) {
        expect(lockfile).toContain(`"@naakwu/flowkit-${packageName}": ["@naakwu/flowkit-${packageName}@0.2.0", ""`);
      }
    }
  });

  it('ships the current monorepo runtime paths in one production image', async () => {
    const dockerfile = await text('Dockerfile');
    const packageJson = JSON.parse(await text('package.json')) as { scripts: Record<string, string> };
    expect(dockerfile).toContain('FROM oven/bun:1.3.14 AS production');
    expect(dockerfile).toMatch(/^COPY --from=build .*\/app\/apps .*\/app\/apps$/m);
    expect(dockerfile).toMatch(/^COPY --from=build .*\/app\/packages .*\/app\/packages$/m);
    expect(dockerfile).toContain('CMD ["bun", "run", "apps/api/src/main.ts"]');

    const entrypoints = Object.values(workloadCommands).map((command) => {
      const target = command.at(-1)!;
      const script = packageJson.scripts[target];
      return script === undefined ? target : script.split(/\s+/).at(-1)!;
    });
    const closure = await runtimeDependencyClosure(entrypoints);
    const productionStage = dockerfile.slice(dockerfile.indexOf('FROM oven/bun:1.3.14 AS production'));
    const copiedRoots = new Set(Array.from(
      productionStage.matchAll(/^COPY --from=\S+ \/app\/(\S+) \/app\/\1$/gm),
      (match) => match[1],
    ));
    const missingFromImage = Array.from(closure).filter((path) => !copiedRoots.has(path.split('/')[0]));

    expect(entrypoints).toEqual([
      'apps/api/src/main.ts',
      'apps/worker/src/main.ts',
      'apps/notify-worker/src/delivery.worker.ts',
      'packages/database/scripts/migrate.ts',
      'packages/database/scripts/seed.ts',
    ]);
    expect(closure).toContain('packages/database/src/index.ts');
    expect(closure).toContain('packages/domain/src/index.ts');
    expect(closure).toContain('scripts/lib/local-database-guard.ts');
    expect(missingFromImage).toEqual([]);
  });

  it('uses the production image and guarded job ordering in the full Compose stack', async () => {
    const localCompose = yaml<ComposeFile>(await text('docker-compose.yml'));
    const compose = yaml<ComposeFile>(await text('deploy/compose/docker-compose.yml'));
    const deployReadme = await text('deploy/README.md');
    expect(localCompose.name).toBe('flowkit-demo');
    expect(Object.keys(localCompose.services)).toEqual(['postgres', 'temporal', 'temporal-namespace', 'mailpit']);
    expect(compose.secrets?.npmrc?.file).toBe('${FLOWKIT_NPMRC_PATH:-../../.npmrc}');
    expect(deployReadme.replace(/\s+/g, ' ')).toContain(
      'Compose defaults to the repository-root `.npmrc`; Tilt defaults to `$HOME/.npmrc`.',
    );

    for (const [serviceName, command] of Object.entries(workloadCommands)) {
      const service = compose.services[serviceName];
      expect(service?.build).toEqual({ context: '../..', dockerfile: 'Dockerfile', secrets: ['npmrc'] });
      expect(service?.command).toEqual(Array.from(command));
    }
    expect(compose.services.migration.environment?.FLOWKIT_DEMO_MIGRATION_APPROVED).toBe('true');
    expect(compose.services.seed.depends_on?.migration?.condition).toBe('service_completed_successfully');
    expect(compose.services.api.depends_on?.seed?.condition).toBe('service_completed_successfully');
    expect(compose.services.worker.depends_on?.['temporal-namespace']?.condition).toBe('service_completed_successfully');
  });

  it('probes Temporal through its container address', async () => {
    const compose = await text('docker-compose.yml');
    expect(compose).toContain('"--address", "temporal:7233"');
    expect(compose).not.toContain('"--address", "127.0.0.1:7233"');
  });

  it('keeps the local Tilt path safe and the k3s path explicitly ordered', async () => {
    const rootTilt = await text('Tiltfile');
    const k3sTilt = await text('deploy/tilt/k3s.Tiltfile');

    expect(rootTilt).toContain("docker_compose('docker-compose.yml')");
    expect(rootTilt).toContain("load_dynamic('deploy/tilt/k3s.Tiltfile')");
    expect(rootTilt).toContain("auto_init=False");
    expect(k3sTilt).toContain("dockerfile='Dockerfile'");
    expect(k3sTilt).toContain("'flowkit-migration', resource_deps=['k3s-preflight', 'postgres', 'flowkit-network-policies'], auto_init=False");
    expect(k3sTilt).toContain("'flowkit-seed', resource_deps=['flowkit-migration'], auto_init=False");
    expect(k3sTilt).toContain("resource_deps=['k3s-preflight', 'postgres', 'flowkit-network-policies']");
    expect(k3sTilt).toContain('if cert_manager_enabled:');
  });

  it('renders tenant-neutral FlowKit workload identities with probes and ingress intact', async () => {
    const manifests = await filesBelow('deploy/k8s');
    const rendered = (await Promise.all(manifests.map((path) => readFile(path, 'utf8')))).join('\n---\n');
    expect(rendered).not.toMatch(/FAAN|AVSEC|faan-avsec|packages\/flowkit-demo/i);

    const api = (await text('deploy/k8s/base/flowkit-api.yaml'))
      .split(/^---$/m)
      .map((document) => yaml<Record<string, unknown>>(document));
    const deployment = api.find((document) => document.kind === 'Deployment') as any;
    const container = deployment.spec.template.spec.containers[0];
    expect(deployment.metadata.name).toBe('flowkit-api');
    expect(container.command).toEqual(workloadCommands.api);
    expect(container.readinessProbe.httpGet.path).toBe('/health/ready');
    expect(container.livenessProbe.httpGet.path).toBe('/health/live');

    for (const [name, command] of Object.entries(workloadCommands).filter(([name]) => name !== 'api')) {
      const manifest = yaml<any>(await text(`deploy/k8s/base/flowkit-${name}.yaml`));
      expect(manifest.metadata.name).toBe(`flowkit-${name}`);
      expect(manifest.spec.template.spec.containers.at(-1).command).toEqual(Array.from(command));
    }

    const ingress = await text('deploy/k8s/base/ingress.yaml');
    expect(ingress).toContain('name: flowkit-api');
    expect(ingress).toContain('name: temporal-web');
    expect(ingress).toContain('name: mailpit');
  });

  it('keeps committed secret examples value-free', async () => {
    const example = await text('deploy/k8s/examples/secrets.env.example');
    const assignments = example.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) expect(assignment).toMatch(/^[A-Z][A-Z0-9_]*=$/);
  });

  it('runs all static and disposable-stack gates in CI with package authentication', async () => {
    const ci = await text('.github/workflows/ci.yml');
    expect(ci).toContain('packages: read');
    expect(ci).toContain('NODE_AUTH_TOKEN: ${{ secrets.FLOWKIT_PACKAGES_TOKEN || github.token }}');
    expect(ci).toContain('bun install --frozen-lockfile');
    expect(ci).toContain('bun run typecheck');
    expect(ci).toContain('bun test');
    expect(ci).toContain('bun run build');
    expect(ci).toContain('docker build --secret id=npmrc,src="$HOME/.npmrc" -f Dockerfile .');
    expect(ci).toContain('docker compose config --quiet');
    expect(ci).toContain('kubectl kustomize deploy/k8s/overlays/k3s-dev');
    expect(ci).toContain('CI=true NODE_ENV=test bun run stack:ci');
    expect(ci).not.toMatch(/--build-arg|NODE_AUTH_TOKEN=.*docker build/);

    const codeql = await text('.github/workflows/codeql.yml');
    expect(codeql).toContain('github/codeql-action/init@v4');
    expect(codeql).toContain('github/codeql-action/analyze@v4');

    const dependabot = yaml<{ updates: Array<{ 'package-ecosystem': string }> }>(await text('.github/dependabot.yml'));
    expect(dependabot.updates.map((update) => update['package-ecosystem'])).toEqual(['bun', 'github-actions', 'docker']);
  });

  it('contains no extracted-repository references to the former monorepo path', async () => {
    const deployManifests = (await filesBelow('deploy')).filter((path) =>
      /(?:\.ya?ml|Dockerfile|Tiltfile)$/.test(path),
    );
    const deploymentFiles = [
      'Dockerfile',
      'docker-compose.yml',
      'Tiltfile',
      ...deployManifests,
      ...(await filesBelow('.github')),
    ];
    const source = (await Promise.all(deploymentFiles.map((path) =>
      typeof path === 'string' && path.startsWith(root) ? readFile(path, 'utf8') : text(path),
    ))).join('\n');
    expect(source).not.toMatch(/packages\/flowkit-demo|packages\/faan|faan-avsec-backend|public-web|internal-web|ministack/i);
  });
});

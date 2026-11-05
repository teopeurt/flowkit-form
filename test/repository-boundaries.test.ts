import { describe, expect, it } from 'bun:test';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');

async function repositoryFiles(pattern = '**/*'): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob(pattern);

  for await (const path of glob.scan({ cwd: repositoryRoot, absolute: true, dot: true, onlyFiles: true })) {
    const repositoryPath = relative(repositoryRoot, path);
    if (repositoryPath === 'bun.lock' || repositoryPath.startsWith('.git/') || repositoryPath.startsWith('node_modules/')) {
      continue;
    }
    files.push(path);
  }

  return files.sort();
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(join(repositoryRoot, path))).isDirectory();
  } catch {
    return false;
  }
}

describe('repository boundaries', () => {
  it('keeps application and owned-package source in the declared monorepo boundaries', async () => {
    const requiredDirectories = [
      'apps/api/src',
      'apps/web/src',
      'apps/worker/src',
      'apps/notify-worker/src',
      'packages/domain/src',
      'packages/database/src',
      'packages/ui/src',
    ];

    const missing = [];
    for (const directory of requiredDirectories) {
      if (!(await existingDirectory(directory))) missing.push(directory);
    }

    expect({ missing, legacyRootSource: await existingDirectory('src') }).toEqual({
      missing: [],
      legacyRootSource: false,
    });
  });

  it('imports FlowKit only through released @naakwu package exports', async () => {
    const violations: string[] = [];
    const sourceFiles = (await repositoryFiles('**/*.{ts,tsx,js,mjs,cjs}'));
    const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;

    for (const path of sourceFiles) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (
          specifier.includes('packages/faan-') ||
          specifier.startsWith('@flowkit/') ||
          /^@[^/]+\/[^/]+\/src(?:\/|$)/.test(specifier)
        ) {
          violations.push(`${relative(repositoryRoot, path)}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('pins all six FlowKit packages at the exact released version without local links', async () => {
    const manifests = await repositoryFiles('**/package.json');
    const expectedPackages = [
      '@naakwu/flowkit-auth',
      '@naakwu/flowkit-consumer',
      '@naakwu/flowkit-core',
      '@naakwu/flowkit-notify',
      '@naakwu/flowkit-tasks',
      '@naakwu/flowkit-temporal',
    ];
    const resolved = new Map<string, string>();
    const localLinks: string[] = [];

    for (const path of manifests) {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      for (const groupName of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides']) {
        const group = manifest[groupName] as Record<string, string> | undefined;
        for (const [name, version] of Object.entries(group ?? {})) {
          if (version.includes('file:../flowkit')) localLinks.push(`${relative(repositoryRoot, path)}: ${name}=${version}`);
          if (expectedPackages.includes(name)) resolved.set(name, version);
        }
      }
    }

    expect(localLinks).toEqual([]);
    const resolvedEntries = Object.entries(Object.fromEntries([...resolved].sort()));
    if (process.env.FLOWKIT_DEMO_CANDIDATE_TARBALLS === 'true') {
      expect(resolvedEntries.map(([name]) => name)).toEqual([...expectedPackages].sort());
      expect(resolvedEntries.every(([name, version]) => expectedPackages.includes(name) && version.startsWith('file:'))).toBe(true);
    } else {
      expect(Object.fromEntries(resolvedEntries)).toEqual(
        Object.fromEntries(expectedPackages.map((name) => [name, '0.2.0'])),
      );
    }
  });

  it('declares dependencies used outside their owning workspace', async () => {
    const rootManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const uiManifest = JSON.parse(await readFile(join(repositoryRoot, 'packages/ui/package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };

    expect(rootManifest.dependencies?.express).toBeDefined();
    expect(rootManifest.dependencies?.['@temporalio/workflow']).toBeDefined();
    expect(rootManifest.devDependencies?.['@types/express']).toBeDefined();
    expect(rootManifest.devDependencies?.['better-call']).toBeDefined();
    expect(uiManifest.devDependencies?.['@testing-library/user-event']).toBeDefined();
  });

  it('does not commit a local package registry into the lockfile', async () => {
    const lockfile = await readFile(join(repositoryRoot, 'bun.lock'), 'utf8');
    expect(lockfile).not.toContain('127.0.0.1:4873');
  });

  it('contains no copied FlowKit framework implementation', async () => {
    const violations: string[] = [];
    for (const path of await repositoryFiles('packages/**/package.json')) {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { name?: string };
      if (manifest.name?.startsWith('@naakwu/flowkit-') || manifest.name?.startsWith('@flowkit/')) {
        violations.push(relative(repositoryRoot, path));
      }
    }
    for (const path of await repositoryFiles('packages/flowkit-*/**')) {
      violations.push(relative(repositoryRoot, path));
    }

    expect([...new Set(violations)].sort()).toEqual([]);
  });

  it('uses only the standalone repository as the deployment build context', async () => {
    const violations: string[] = [];
    for (const path of await repositoryFiles('deploy/**/*.{yaml,yml,Dockerfile,md,ts,js}')) {
      const source = await readFile(path, 'utf8');
      if (/(?:faan-avsec|packages\/flowkit-|packages\/flowkit-demo|dockerfile:\s*packages\/)/i.test(source)) {
        violations.push(relative(repositoryRoot, path));
      }
    }

    expect(violations).toEqual([]);
  });
});

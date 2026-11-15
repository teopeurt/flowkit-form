import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const repositoryRoot = new URL('..', import.meta.url).pathname;

/** Workspaces that ship as the product. Everything else is quarantined demo. */
const productPackages = ['packages/document', 'packages/documents'];

const demoScopePrefix = '@flowkitform/demo-';

async function sourcesUnder(directory: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: join(repositoryRoot, directory) })) {
    paths.push(join(directory, path));
  }
  return paths.sort();
}

describe('product boundary', () => {
  it('keeps product packages free of demo imports', async () => {
    const violations: string[] = [];

    for (const productPackage of productPackages) {
      for (const path of await sourcesUnder(productPackage)) {
        const source = await readFile(join(repositoryRoot, path), 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
          const specifier = match[1];
          if (specifier.startsWith(demoScopePrefix) || specifier.includes('../../apps/')) {
            violations.push(`${path}: ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runs the demo suites from an explicit target rather than the default one', async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};

    expect(scripts.test).toBeDefined();
    expect(scripts.test).not.toContain('test/demo');
    expect(scripts['test:examples']).toContain('test/demo');
  });

  it('keeps the product suite runnable without the demo stack', async () => {
    // Product-suite files must not reach for the demo's durable database helper,
    // which requires PostgreSQL, Temporal and Mailpit to be up.
    const glob = new Bun.Glob('*.{ts,tsx}');
    const violations: string[] = [];

    for await (const file of glob.scan({ cwd: join(repositoryRoot, 'test') })) {
      if (join('test', file) === relative(repositoryRoot, import.meta.path)) continue;
      const source = await readFile(join(repositoryRoot, 'test', file), 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (specifier.includes('durable-test-database') || specifier.includes('./demo/')) {
          violations.push(`${relative(repositoryRoot, join('test', file))}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

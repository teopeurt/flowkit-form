import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

const repositoryRoot = new URL('..', import.meta.url).pathname;

/**
 * Retired identifiers, assembled from fragments so this gate never matches its
 * own source. The repository moved from the `flowkit-demo` identity to
 * `flowkitform`; see docs/superpowers/plans/2026-11-15-flowkitform-rename-and-demo-quarantine.md.
 */
const retired = [
  { label: 'npm scope', pattern: '@flowkit-' + 'demo/' },
  { label: 'environment prefix', pattern: 'FLOWKIT_' + 'DEMO_' },
  { label: 'database identity', pattern: 'flowkit_' + 'demo' },
  { label: 'infrastructure identity', pattern: 'flowkit-' + 'demo' },
] as const;

/**
 * Migration filenames are checksum-tracked history: the runner keys applied
 * migrations on (filename, sha256(body)), so renaming one re-runs it against
 * databases that already have it. They keep the retired spelling permanently.
 */
const frozenMigrations = /^packages\/database\/migrations\/\d+_.*\.sql$/;

/** Historical planning records are preserved verbatim, including old names. */
function isHistoricalRecord(path: string): boolean {
  return path.startsWith('docs/superpowers/') || path === 'bun.lock';
}

function isExempt(path: string): boolean {
  return (
    path === relative(repositoryRoot, import.meta.path) ||
    frozenMigrations.test(path) ||
    isHistoricalRecord(path)
  );
}

async function trackedSources(): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx,js,mjs,cjs,json,jsonc,yml,yaml,sql,sh,md,css,html,env,example,Tiltfile}');
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: repositoryRoot, dot: true })) {
    if (path.startsWith('node_modules/') || path.startsWith('.git/') || path.startsWith('dist/')) continue;
    paths.push(path);
  }
  for (const extra of ['Tiltfile', 'Dockerfile', '.env.example', '.dockerignore']) {
    if (!paths.includes(extra)) paths.push(extra);
  }
  return paths.sort();
}

describe('naming contract', () => {
  it('has retired every flowkit-demo identifier outside frozen history', async () => {
    const offenders: string[] = [];

    for (const path of await trackedSources()) {
      if (isExempt(path)) continue;
      let text: string;
      try {
        text = await readFile(new URL(path, new URL('..', import.meta.url)), 'utf8');
      } catch {
        continue;
      }
      for (const { label, pattern } of retired) {
        if (text.includes(pattern)) offenders.push(`${path}: ${label} (${pattern})`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reads each safety gate under exactly one name so a stale value fails closed', async () => {
    const gates = ['MIGRATION_APPROVED', 'ALLOW_SEED', 'CI_APPROVED'];
    const violations: string[] = [];

    for (const path of await trackedSources()) {
      if (isExempt(path)) continue;
      let text: string;
      try {
        text = await readFile(new URL(path, new URL('..', import.meta.url)), 'utf8');
      } catch {
        continue;
      }
      for (const gate of gates) {
        if (text.includes('FLOWKIT_' + 'DEMO_' + gate)) {
          violations.push(`${path}: retired spelling of ${gate}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

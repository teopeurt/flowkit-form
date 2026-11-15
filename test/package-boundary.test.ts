import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

/**
 * Forbidden everywhere: retired vendor paths, the unreleased `@flowkit/` scope,
 * and reaching into a published package's internals via `@scope/name/src`.
 */
const forbiddenEverywhere = /(?:from|import\()[^\n]*(?:faan-avsec|@flowkit\/|@[^/'"]+\/[^/'"]+\/src)/;

/**
 * Additionally forbidden in shipped source: climbing out of one workspace into
 * another workspace's `src` by relative path instead of its public export.
 * Test files are exempt from this clause only — a suite under `test/demo/`
 * legitimately imports the application it exercises, which it did as `../apps/...`
 * before those suites moved one directory deeper.
 */
const forbiddenInSource = /(?:from|import\()[^\n]*\.\.\/\.\.\/[^'" ]+\/src/;

describe('consumer boundary', () => {
  it('has no FAAN or sibling source imports', async () => {
    const glob = new Bun.Glob('{apps,packages,scripts,test}/**/*.{ts,tsx}');
    for await (const file of glob.scan({ cwd: new URL('..', import.meta.url).pathname })) {
      if (file.endsWith('package-boundary.test.ts')) continue;
      const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');

      expect(text).not.toMatch(forbiddenEverywhere);
      if (!file.startsWith('test/')) {
        expect(text).not.toMatch(forbiddenInSource);
      }
    }
  });
});

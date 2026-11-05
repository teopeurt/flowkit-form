import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

describe('consumer boundary', () => {
  it('has no FAAN or sibling source imports', async () => {
    const glob = new Bun.Glob('{apps,packages,scripts,test}/**/*.{ts,tsx}');
    for await (const file of glob.scan({ cwd: new URL('..', import.meta.url).pathname })) {
      if (file.endsWith('package-boundary.test.ts')) continue;
      const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text).not.toMatch(
        /(?:from|import\()[^\n]*(?:faan-avsec|@flowkit\/|@[^/'"]+\/[^/'"]+\/src|\.\.\/\.\.\/[^'" ]+\/src)/,
      );
    }
  });
});

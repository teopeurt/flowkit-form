import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

describe('customization-guide boundaries', () => {
  it('uses the design-approved seven-step replacement order', async () => {
    const guide = await readFile(resolve(root, 'docs/customizing.md'), 'utf8');
    const expectedSteps = [
      '1. Rename product metadata and neutral theme tokens.',
      '2. Replace seeded organizations, roles, and memberships.',
      '3. Replace the leave definition and domain types.',
      '4. Replace activity, guard, rule, and notification registries.',
      '5. Add domain persistence and migrations.',
      '6. Replace API routes and workflow forms.',
      '7. Replace browser scenarios while retaining framework contract tests.',
    ];
    let previous = -1;
    for (const step of expectedSteps) {
      const position = guide.indexOf(step);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
  });

  it('preserves framework and tenant-safety boundaries while customizing', async () => {
    const guide = await readFile(resolve(root, 'docs/customizing.md'), 'utf8');

    expect(guide).toContain('node_modules');
    expect(guide).toContain('@naakwu/flowkit-');
    expect(guide).toContain('request-body organization IDs are never authoritative');
    expect(guide).toContain('non-disclosing not-found');
    expect(guide).toContain('tenant predicates');
    expect(guide).toContain('server-validated session membership');
    expect(guide).toContain('test/package-contracts.preflight.test.ts');
    expect(guide).toContain('test/package-boundary.test.ts');
  });
});

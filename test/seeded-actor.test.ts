import { describe, expect, it } from 'bun:test';

import { resolveDemoActor } from '@flowkit-demo/domain';

describe('seeded organization actors', () => {
  it.each([
    ['acme-demo-employee', 'acme-demo', 'employee'],
    ['acme-demo-manager', 'acme-demo', 'manager'],
    ['acme-demo-hr', 'acme-demo', 'hr'],
    ['acme-demo-readonly_auditor', 'acme-demo', 'readonly_auditor'],
    ['globex-demo-employee', 'globex-demo', 'employee'],
    ['globex-demo-manager', 'globex-demo', 'manager'],
    ['globex-demo-hr', 'globex-demo', 'hr'],
    ['globex-demo-readonly_auditor', 'globex-demo', 'readonly_auditor'],
  ] as const)('resolves %s into its persisted tenant and role', async (id, organizationId, role) => {
    expect(await resolveDemoActor(id)).toEqual({ id, organizationId, roles: [role] });
  });
});

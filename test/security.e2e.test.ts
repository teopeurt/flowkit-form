import { describe, expect, it } from 'bun:test';
import { AuthError } from '@naakwu/flowkit-auth';

import {
  resolveOrganizationContext,
  type BetterAuthSession,
  type OrganizationMembership,
} from '../apps/api/src/auth/organization-context';

const session: BetterAuthSession = {
  user: { id: 'auditor-1', email: 'auditor@example.test', emailVerified: true },
  session: {
    id: 'session-auditor-1',
    userId: 'auditor-1',
    token: 'validated-by-better-auth',
    activeOrganizationId: 'acme',
    createdAt: new Date('2026-08-13T00:00:00.000Z'),
    updatedAt: new Date('2026-08-13T00:00:00.000Z'),
    expiresAt: new Date('2026-08-14T00:00:00.000Z'),
  },
};

function store(rows: readonly OrganizationMembership[]) {
  return { listForUser: async () => rows };
}

describe('organization authorization boundary', () => {
  it('uses persisted application-role metadata instead of BetterAuth or request roles', async () => {
    const context = await resolveOrganizationContext(session, 'acme', store([{
      id: 'member-auditor-1',
      organizationId: 'acme',
      userId: 'auditor-1',
      role: 'owner',
      applicationRole: 'readonly_auditor',
      enabled: true,
    }]));

    expect(context.principal.role).toBe('readonly_auditor');
    expect(context.principal.readOnly).toBe(true);
    expect(context.principal.role).not.toBe('owner');
  });

  it('rejects a client-selected organization outside the persisted membership set', async () => {
    const resolution = resolveOrganizationContext(session, 'globex', store([{
      id: 'member-auditor-1',
      organizationId: 'acme',
      userId: 'auditor-1',
      role: 'member',
      applicationRole: 'readonly_auditor',
      enabled: true,
    }]));

    await expect(resolution).rejects.toMatchObject({
      name: 'AuthError',
      code: 'permission_denied',
    } satisfies Partial<AuthError>);
  });

  it('rejects application roles outside the canonical domain registry', async () => {
    const resolution = resolveOrganizationContext(session, 'acme', store([{
      id: 'member-auditor-1',
      organizationId: 'acme',
      userId: 'auditor-1',
      role: 'owner',
      applicationRole: 'superuser-from-request',
      enabled: true,
    }]));

    await expect(resolution).rejects.toMatchObject({
      name: 'AuthError',
      code: 'role_unknown',
    } satisfies Partial<AuthError>);
  });
});

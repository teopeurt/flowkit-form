import { describe, expect, it } from 'bun:test';
import { AuthError } from '@naakwu/flowkit-auth';

import {
  resolveOrganizationContext,
  type BetterAuthSession,
  type OrganizationMembership,
} from './organization-context';

const now = new Date('2026-08-13T12:00:00.000Z');

function session(activeOrganizationId?: string): BetterAuthSession {
  return {
    user: {
      id: 'user-1',
      email: 'employee@example.test',
      emailVerified: true,
    },
    session: {
      id: 'session-1',
      userId: 'user-1',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date('2026-08-14T12:00:00.000Z'),
      token: 'server-validated-token',
      activeOrganizationId,
    },
  };
}

function membership(
  organizationId: string,
  applicationRole: 'employee' | 'manager' = 'employee',
  enabled = true,
): OrganizationMembership {
  return {
    id: `membership-${organizationId}`,
    organizationId,
    userId: 'user-1',
    role: 'member',
    applicationRole,
    enabled,
  };
}

function membershipStore(rows: readonly OrganizationMembership[]) {
  return {
    listForUser: async (userId: string) => rows.filter((row) => row.userId === userId),
  };
}

async function expectAuthError(promise: Promise<unknown>, code: AuthError['code']) {
  try {
    await promise;
    throw new Error(`Expected ${code} AuthError`);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
  }
}

describe('resolveOrganizationContext', () => {
  it('resolves the session active organization from an enabled membership', async () => {
    const context = await resolveOrganizationContext(
      session('acme'),
      undefined,
      membershipStore([membership('acme')]),
    );

    expect(context.organizationId).toBe('acme');
    expect(context.userId).toBe('user-1');
    expect(context.principal).toMatchObject({
      authUserId: 'user-1',
      subjectId: 'user-1',
      role: 'employee',
      activeScope: { type: 'organization', id: 'acme', membershipId: 'membership-acme' },
    });
    expect(Object.isFrozen(context.principal)).toBe(true);
  });

  it('rejects an authenticated user with no organization membership', async () => {
    await expectAuthError(
      resolveOrganizationContext(session('acme'), undefined, membershipStore([])),
      'scope_required',
    );
  });

  it('rejects a requested organization when the user is not a member', async () => {
    await expectAuthError(
      resolveOrganizationContext(session('acme'), 'globex', membershipStore([membership('acme')])),
      'permission_denied',
    );
  });

  it('rejects a disabled organization membership', async () => {
    await expectAuthError(
      resolveOrganizationContext(session('acme'), undefined, membershipStore([membership('acme', 'employee', false)])),
      'permission_denied',
    );
  });

  it('uses an explicit active selection for a user with two organizations', async () => {
    const context = await resolveOrganizationContext(
      session('acme'),
      'globex',
      membershipStore([membership('acme', 'employee'), membership('globex', 'manager')]),
    );

    expect(context.organizationId).toBe('globex');
    expect(context.principal.role).toBe('manager');
    expect(context.principal.permissions).toContain('leave.review');
  });

  it('never turns a request-body organization value into a membership', async () => {
    const persistedMemberships = [membership('acme')];
    const requestedFromBody = 'body-controlled-organization';

    await expectAuthError(
      resolveOrganizationContext(
        session('acme'),
        requestedFromBody,
        membershipStore(persistedMemberships),
      ),
      'permission_denied',
    );
    expect(persistedMemberships.map((row) => row.organizationId)).toEqual(['acme']);
  });
});

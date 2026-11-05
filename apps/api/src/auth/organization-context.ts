import {
  AuthError,
  freezePrincipal,
  type AuthenticatedPrincipal,
  type IdentityProof,
} from '@naakwu/flowkit-auth';

import { createDemoDatabaseClient } from '@flowkit-demo/database';
import { roleRegistry, type DemoRole } from '@flowkit-demo/domain';

export type BetterAuthSession = {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly emailVerified: boolean;
  };
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly expiresAt: Date;
    readonly token: string;
    readonly activeOrganizationId?: string | null;
  };
};

export type OrganizationMembership = {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly applicationRole: string;
  readonly enabled: boolean;
};

export type OrganizationMembershipStore = {
  listForUser(userId: string): Promise<readonly OrganizationMembership[]>;
};

export type OrganizationContext = Readonly<{
  organizationId: string;
  userId: string;
  principal: AuthenticatedPrincipal<DemoRole>;
}>;

const postgresMembershipStore: OrganizationMembershipStore = {
  async listForUser(userId) {
    const sql = createDemoDatabaseClient();
    try {
      return await sql<OrganizationMembership[]>`
        SELECT
          id,
          organization_id AS "organizationId",
          user_id AS "userId",
          role,
          application_role AS "applicationRole",
          enabled
        FROM better_auth.member
        WHERE user_id = ${userId}
        ORDER BY organization_id, id
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
};

function verifiedIdentityProofs(session: BetterAuthSession): readonly IdentityProof[] {
  if (!session.user.emailVerified) return [];
  return [{
    kind: 'email',
    normalizedValue: session.user.email.trim().toLowerCase(),
    verified: true,
  }];
}

function canonicalRole(role: string): DemoRole {
  const normalized = roleRegistry.normalizeRole(role);
  if (!normalized || !(normalized in roleRegistry.definitions)) {
    throw new AuthError('role_unknown', 'Organization membership has an unrecognized application role.');
  }
  return normalized as DemoRole;
}

/**
 * Builds tenant context only from a BetterAuth session and persisted membership.
 * A requested organization is a selection hint, never membership or role input.
 */
export async function resolveOrganizationContext(
  session: BetterAuthSession,
  requestedOrganizationId?: string,
  memberships: OrganizationMembershipStore = postgresMembershipStore,
): Promise<OrganizationContext> {
  if (!session.user.id || session.session.userId !== session.user.id) {
    throw new AuthError('unauthenticated', 'BetterAuth session user does not match the authenticated user.');
  }

  const rows = await memberships.listForUser(session.user.id);
  const enabled = rows.filter((membership) => membership.enabled);
  if (rows.length === 0) {
    throw new AuthError('scope_required', 'An enabled organization membership is required.');
  }
  const selectedOrganizationId = requestedOrganizationId?.trim()
    || session.session.activeOrganizationId?.trim()
    || (enabled.length === 1 ? enabled[0]?.organizationId : undefined);

  if (!selectedOrganizationId) {
    throw new AuthError(
      enabled.length > 1 ? 'scope_ambiguous' : 'scope_required',
      enabled.length > 1
        ? 'Select one of the organizations in the authenticated membership set.'
        : 'An enabled organization membership is required.',
    );
  }

  const selected = rows.find((membership) => membership.organizationId === selectedOrganizationId);
  if (!selected || selected.userId !== session.user.id || !selected.enabled) {
    throw new AuthError('permission_denied', 'The authenticated user is not an enabled member of the requested organization.');
  }

  const role = canonicalRole(selected.applicationRole);
  const principal = freezePrincipal<DemoRole>({
    authUserId: session.user.id,
    subjectId: session.user.id,
    role,
    permissions: roleRegistry.definitions[role].permissions,
    readOnly: roleRegistry.isReadOnly(role),
    identityProofs: verifiedIdentityProofs(session),
    activeScope: {
      type: 'organization',
      id: selected.organizationId,
      membershipId: selected.id,
    },
    session: {
      id: session.session.id,
      issuedAt: session.session.createdAt.toISOString(),
      expiresAt: session.session.expiresAt.toISOString(),
    },
  });

  return Object.freeze({
    organizationId: selected.organizationId,
    userId: session.user.id,
    principal,
  });
}

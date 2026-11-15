import { describe, expect, it } from 'bun:test';

import {
  DocumentError,
  addGrant,
  createDocument,
  evaluatePermissions,
  getDocument,
  parseGrant,
  pruneExpiredGrants,
  removeGrant,
  requirePermission,
  updateMetadata,
  type DocumentState,
  type Grant,
} from '@flowkitform/documents';

import { harness, scope, tenantB } from './fixtures';

const now = '2026-11-15T12:00:00Z';

function grant(overrides: Partial<{ id: string; actorId: string; groupId: string; permissions: string[]; expiresAt: string }> = {}): Grant {
  const principal = overrides.groupId
    ? { kind: 'group' as const, id: overrides.groupId }
    : { kind: 'actor' as const, id: overrides.actorId ?? 'actor-1' };
  return parseGrant(
    {
      id: overrides.id ?? 'grant-1',
      principal,
      permissions: overrides.permissions ?? ['read'],
      ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
    },
    '2026-11-15T00:00:00Z',
    'actor-admin',
  );
}

function state(overrides: Partial<DocumentState> = {}): DocumentState {
  return {
    ref: { tenantId: 'tenant-a', documentId: 'doc-1' },
    aggregateRevision: 1,
    lifecycleGeneration: 1,
    status: 'active',
    currentVersionId: null,
    currentMetadataRevision: 1,
    grants: [],
    holds: [],
    retention: null,
    outstandingPublications: 0,
    outstandingCleanups: 0,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

describe('evaluatePermissions', () => {
  it('grants nothing without an explicit grant', () => {
    expect([...evaluatePermissions(state(), scope(), now)]).toEqual([]);
  });

  it('resolves actor and group grants', () => {
    const current = state({
      grants: [grant({ id: 'g1', permissions: ['read'] }), grant({ id: 'g2', groupId: 'team', permissions: ['write'] })],
    });

    expect([...evaluatePermissions(current, scope(), now)]).toEqual(['read']);
    expect([...evaluatePermissions(current, scope({ groupIds: ['team'] }), now)].sort()).toEqual(['read', 'write']);
  });

  it('ignores expired grants', () => {
    const current = state({ grants: [grant({ expiresAt: '2026-11-15T06:00:00Z' })] });

    expect([...evaluatePermissions(current, scope(), '2026-11-15T05:59:59Z')]).toEqual(['read']);
    expect([...evaluatePermissions(current, scope(), now)]).toEqual([]);
  });

  it('grants nothing across tenants or on a non-active document', () => {
    const current = state({ grants: [grant({ permissions: ['read', 'write'] })] });

    expect([...evaluatePermissions(current, scope({ tenantId: tenantB }), now)]).toEqual([]);
    expect([...evaluatePermissions({ ...current, status: 'deleting' }, scope(), now)]).toEqual([]);
    expect([...evaluatePermissions({ ...current, status: 'deleted' }, scope(), now)]).toEqual([]);
  });
});

describe('requirePermission', () => {
  it('passes when the permission is held', () => {
    const current = state({ grants: [grant({ permissions: ['read', 'write'] })] });
    expect(() => requirePermission(current, scope(), 'write', now)).not.toThrow();
  });

  it('reports absence rather than denial to a caller with no access', () => {
    try {
      requirePermission(state(), scope(), 'read', now);
      throw new Error('expected rejection');
    } catch (error) {
      // A prober must not learn that the document exists.
      expect(DocumentError.is(error, 'not_found')).toBe(true);
    }
  });

  it('reports denial only to a caller who already holds some access', () => {
    const current = state({ grants: [grant({ permissions: ['read'] })] });
    try {
      requirePermission(current, scope(), 'delete', now);
      throw new Error('expected rejection');
    } catch (error) {
      expect(DocumentError.is(error, 'forbidden')).toBe(true);
    }
  });
});

describe('grant set mutation', () => {
  it('rejects duplicates and enforces the bounded grant limit', () => {
    const current = state({ grants: [grant({ id: 'g1' })] });
    expect(() => addGrant(current, grant({ id: 'g1' }))).toThrow(/grant_already_present/);

    const full = state({ grants: Array.from({ length: 16 }, (_, index) => grant({ id: `g${index}` })) });
    expect(() => addGrant(full, grant({ id: 'extra' }))).toThrow(/grant_limit_exceeded/);
  });

  it('refuses to remove the last share grant', () => {
    const current = state({
      grants: [grant({ id: 'owner', permissions: ['read', 'share'] }), grant({ id: 'reader', permissions: ['read'] })],
    });

    expect(removeGrant(current, 'reader')).toHaveLength(1);
    expect(() => removeGrant(current, 'owner')).toThrow(/grant_last_share_removal/);
    expect(() => removeGrant(current, 'missing')).toThrow(/grant_not_found/);
  });

  it('prunes expired grants from the bounded head', () => {
    const current = state({
      grants: [grant({ id: 'live' }), grant({ id: 'dead', expiresAt: '2026-11-15T06:00:00Z' })],
    });

    expect(pruneExpiredGrants(current, now).map((entry) => entry.id)).toEqual(['live']);
  });

  it('rejects unknown permissions and malformed principals', () => {
    expect(() => parseGrant({ id: 'g', principal: { kind: 'actor', id: 'a' }, permissions: ['admin'] }, now, 'a')).toThrow(
      /grant_permission_unknown/,
    );
    expect(() => parseGrant({ id: 'g', principal: { kind: 'robot', id: 'a' }, permissions: ['read'] }, now, 'a')).toThrow(
      /principal_kind_invalid/,
    );
    expect(() => parseGrant({ id: 'g', principal: { kind: 'actor', id: 'a' }, permissions: [] }, now, 'a')).toThrow(
      /grant_permissions_required/,
    );
  });
});

describe('tenant isolation through the services', () => {
  it('hides another tenant’s document entirely', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Secret' } });

    const intruder = scope({ tenantId: tenantB, actorId: 'actor-1' });
    await expect(getDocument(deps, intruder, created.ref.documentId, now)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('gives the creator an explicit grant rather than implicit ownership', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Owned' } });

    expect(created.grants).toHaveLength(1);
    expect(created.grants[0]?.principal).toEqual({ kind: 'actor', id: 'actor-1' });
    expect([...created.grants[0]!.permissions].sort()).toEqual(['delete', 'read', 'share', 'write']);
  });

  it('refuses a write from an actor with no grant', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Owned' } });

    await expect(
      updateMetadata(deps, context({ actorId: 'actor-2' }), {
        documentId: created.ref.documentId,
        expectedRevision: 1,
        metadata: { title: 'Hijacked' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

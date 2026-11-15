import { describe, expect, it } from 'bun:test';

import {
  abandonPublicationLease,
  acquirePublicationLease,
  appendVersion,
  beginDeletion,
  completeDeletion,
  completePublicationLease,
  createDocument,
  getDocument,
  placeLegalHold,
  releaseLegalHold,
  resolveCleanupObligation,
  setRetention,
  updateMetadata,
} from '@flowkitform/documents';

import { harness, scope, verifiedContent } from './fixtures';

const now = '2026-11-15T12:00:00Z';
const artifact = { store: 'memory', objectId: 'object-1', generation: 'gen-1' } as const;

async function seeded() {
  const context = harness();
  const created = await createDocument(context.deps, context.context(), { metadata: { title: 'Evidence' } });
  return { ...context, documentId: created.ref.documentId, state: created };
}

describe('holds', () => {
  it('blocks deletion while a hold is present and allows it after release', async () => {
    const { deps, context, documentId } = await seeded();

    const held = await placeLegalHold(deps, context(), {
      documentId,
      expectedRevision: 1,
      holdId: 'hold-1',
      reason: 'litigation',
    });
    expect(held.holds).toHaveLength(1);

    await expect(beginDeletion(deps, context(), { documentId, expectedRevision: 2 })).rejects.toMatchObject({
      code: 'held',
    });

    const released = await releaseLegalHold(deps, context(), { documentId, expectedRevision: 2, holdId: 'hold-1' });
    expect(released.holds).toHaveLength(0);

    const deleting = await beginDeletion(deps, context(), { documentId, expectedRevision: 3 });
    expect(deleting.status).toBe('deleting');
  });

  it('rejects duplicate holds and unknown releases', async () => {
    const { deps, context, documentId } = await seeded();
    await placeLegalHold(deps, context(), { documentId, expectedRevision: 1, holdId: 'hold-1', reason: 'r' });

    await expect(
      placeLegalHold(deps, context(), { documentId, expectedRevision: 2, holdId: 'hold-1', reason: 'r' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      releaseLegalHold(deps, context(), { documentId, expectedRevision: 2, holdId: 'missing' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('enforces the bounded hold limit', async () => {
    const { deps, context, documentId } = await seeded();
    let revision = 1;
    for (let index = 0; index < 16; index += 1) {
      await placeLegalHold(deps, context(), {
        documentId,
        expectedRevision: revision,
        holdId: `hold-${index}`,
        reason: 'bulk',
      });
      revision += 1;
    }

    await expect(
      placeLegalHold(deps, context(), { documentId, expectedRevision: revision, holdId: 'overflow', reason: 'r' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('retention', () => {
  it('blocks deletion until the retention window passes', async () => {
    const { deps, context, documentId } = await seeded();
    await setRetention(deps, context(), {
      documentId,
      expectedRevision: 1,
      policyId: 'policy-7y',
      retainUntil: '2027-01-01T00:00:00Z',
    });

    await expect(
      beginDeletion(deps, context({ now: '2026-12-31T23:59:59Z' }), { documentId, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'retained' });

    const deleting = await beginDeletion(deps, context({ now: '2027-01-01T00:00:01Z' }), {
      documentId,
      expectedRevision: 2,
    });
    expect(deleting.status).toBe('deleting');
  });

  it('allows extending retention but never shortening it', async () => {
    const { deps, context, documentId } = await seeded();
    await setRetention(deps, context(), {
      documentId,
      expectedRevision: 1,
      policyId: 'p',
      retainUntil: '2027-01-01T00:00:00Z',
    });

    const extended = await setRetention(deps, context(), {
      documentId,
      expectedRevision: 2,
      policyId: 'p',
      retainUntil: '2028-01-01T00:00:00Z',
    });
    expect(extended.retention?.retainUntil).toBe('2028-01-01T00:00:00Z');

    await expect(
      setRetention(deps, context(), { documentId, expectedRevision: 3, policyId: 'p', retainUntil: '2027-06-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'retained' });
  });

  it('reports a hold before retention when both block deletion', async () => {
    const { deps, context, documentId } = await seeded();
    await setRetention(deps, context(), {
      documentId,
      expectedRevision: 1,
      policyId: 'p',
      retainUntil: '2027-01-01T00:00:00Z',
    });
    await placeLegalHold(deps, context(), { documentId, expectedRevision: 2, holdId: 'h', reason: 'r' });

    await expect(beginDeletion(deps, context(), { documentId, expectedRevision: 3 })).rejects.toMatchObject({
      code: 'held',
    });
  });
});

describe('deletion generations', () => {
  it('advances the lifecycle generation and makes in-flight work stale', async () => {
    const { deps, context, documentId } = await seeded();
    const deleting = await beginDeletion(deps, context(), { documentId, expectedRevision: 1 });

    expect(deleting).toMatchObject({ status: 'deleting', lifecycleGeneration: 2 });

    // A version planned against generation 1 must not land after the deletion.
    await expect(
      appendVersion(deps, context(), {
        documentId,
        expectedRevision: 2,
        lifecycleGeneration: 1,
        content: verifiedContent(),
      }),
    ).rejects.toMatchObject({ code: 'stale_lifecycle' });
  });

  it('refuses writes and reads once deleting', async () => {
    const { deps, context, documentId } = await seeded();
    await beginDeletion(deps, context(), { documentId, expectedRevision: 1 });

    await expect(
      updateMetadata(deps, context(), { documentId, expectedRevision: 2, metadata: { title: 'nope' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(getDocument(deps, scope(), documentId, now)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('records a cleanup obligation per artifact and blocks completion until resolved', async () => {
    const { store, deps, context, documentId } = await seeded();
    const deleting = await beginDeletion(deps, context(), {
      documentId,
      expectedRevision: 1,
      artifacts: [artifact],
    });

    expect(deleting.outstandingCleanups).toBe(1);
    const obligations = await store.cleanupObligations(scope(), deleting.ref);
    expect(obligations.items).toHaveLength(1);
    expect(obligations.items[0]).toMatchObject({ reason: 'deletion', lifecycleGeneration: 2, resolvedAt: null });

    await expect(completeDeletion(deps, context(), { documentId, expectedRevision: 2 })).rejects.toMatchObject({
      code: 'conflict',
    });

    const resolved = await resolveCleanupObligation(deps, context(), {
      documentId,
      expectedRevision: 2,
      obligationId: obligations.items[0]!.id,
    });
    expect(resolved.outstandingCleanups).toBe(0);

    const deleted = await completeDeletion(deps, context(), { documentId, expectedRevision: 3 });
    expect(deleted).toMatchObject({ status: 'deleted', currentVersionId: null, grants: [] });
  });

  it('requires deletion to have started before it can complete', async () => {
    const { deps, context, documentId } = await seeded();
    await expect(completeDeletion(deps, context(), { documentId, expectedRevision: 1 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('publication leases', () => {
  it('counts an outstanding publication and clears it on completion', async () => {
    const { store, deps, context, documentId } = await seeded();
    const { state, lease } = await acquirePublicationLease(deps, context(), {
      documentId,
      expectedRevision: 1,
      versionId: 'version-1',
      expiresAt: '2026-11-15T01:00:00Z',
    });

    expect(state.outstandingPublications).toBe(1);
    expect(lease.lifecycleGeneration).toBe(1);
    expect((await store.leases(scope(), state.ref)).items).toHaveLength(1);

    const completed = await completePublicationLease(deps, context({ now: '2026-11-15T00:30:00Z' }), {
      documentId,
      expectedRevision: 2,
      lease,
    });
    expect(completed.outstandingPublications).toBe(0);
    expect((await store.leases(scope(), state.ref)).items).toHaveLength(0);
  });

  it('blocks deletion completion while a publication is outstanding', async () => {
    const { deps, context, documentId } = await seeded();
    await acquirePublicationLease(deps, context(), {
      documentId,
      expectedRevision: 1,
      versionId: 'version-1',
      expiresAt: '2026-11-15T01:00:00Z',
    });
    await beginDeletion(deps, context(), { documentId, expectedRevision: 2 });

    await expect(completeDeletion(deps, context(), { documentId, expectedRevision: 3 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('rejects a lease completion from a superseded generation', async () => {
    const { deps, context, documentId } = await seeded();
    const { lease } = await acquirePublicationLease(deps, context(), {
      documentId,
      expectedRevision: 1,
      versionId: 'version-1',
      expiresAt: '2026-11-15T01:00:00Z',
    });
    await beginDeletion(deps, context(), { documentId, expectedRevision: 2 });

    await expect(
      completePublicationLease(deps, context({ now: '2026-11-15T00:30:00Z' }), {
        documentId,
        expectedRevision: 3,
        lease,
      }),
    ).rejects.toMatchObject({ code: 'stale_lifecycle' });
  });

  it('rejects an expired lease', async () => {
    const { deps, context, documentId } = await seeded();
    const { lease } = await acquirePublicationLease(deps, context(), {
      documentId,
      expectedRevision: 1,
      versionId: 'version-1',
      expiresAt: '2026-11-15T00:00:05Z',
    });

    await expect(
      completePublicationLease(deps, context({ now: '2026-11-15T00:10:00Z' }), {
        documentId,
        expectedRevision: 2,
        lease,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('converts an abandoned lease into a tracked cleanup obligation', async () => {
    const { store, deps, context, documentId } = await seeded();
    const { state, lease } = await acquirePublicationLease(deps, context(), {
      documentId,
      expectedRevision: 1,
      versionId: 'version-1',
      expiresAt: '2026-11-15T00:00:05Z',
    });

    const abandoned = await abandonPublicationLease(deps, context(), {
      documentId,
      expectedRevision: 2,
      lease,
      artifact,
    });

    expect(abandoned).toMatchObject({ outstandingPublications: 0, outstandingCleanups: 1 });
    const obligations = await store.cleanupObligations(scope(), state.ref);
    expect(obligations.items[0]).toMatchObject({ reason: 'abandoned_publication', resolvedAt: null });
    // The bytes are tracked, not orphaned.
    expect((await store.leases(scope(), state.ref)).items).toHaveLength(0);
  });

  it('refuses to resolve the same obligation twice', async () => {
    const { store, deps, context, documentId } = await seeded();
    const deleting = await beginDeletion(deps, context(), { documentId, expectedRevision: 1, artifacts: [artifact] });
    const obligations = await store.cleanupObligations(scope(), deleting.ref);

    await resolveCleanupObligation(deps, context(), {
      documentId,
      expectedRevision: 2,
      obligationId: obligations.items[0]!.id,
    });
    await expect(
      resolveCleanupObligation(deps, context(), {
        documentId,
        expectedRevision: 3,
        obligationId: obligations.items[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

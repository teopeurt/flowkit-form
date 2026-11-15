import { describe, expect, it } from 'bun:test';

import {
  DocumentError,
  appendVersion,
  createDocument,
  getCurrentMetadata,
  getDocument,
  listAudit,
  listMetadataRevisions,
  listVersions,
  updateMetadata,
} from '@flowkitform/documents';

import { harness, scope, verifiedContent } from './fixtures';

const now = '2026-11-15T12:00:00Z';

describe('createDocument', () => {
  it('creates an active document at revision 1 with metadata revision 1', async () => {
    const { deps, context } = harness();
    const state = await createDocument(deps, context(), { documentId: 'doc-1', metadata: { title: 'Certificate' } });

    expect(state).toMatchObject({
      aggregateRevision: 1,
      lifecycleGeneration: 1,
      status: 'active',
      currentVersionId: null,
      currentMetadataRevision: 1,
      outstandingPublications: 0,
      outstandingCleanups: 0,
    });
    expect(state.ref).toEqual({ tenantId: 'tenant-a', documentId: 'doc-1' });
  });

  it('mints an identifier when none is supplied', async () => {
    const { deps, context } = harness();
    const state = await createDocument(deps, context(), { metadata: { title: 'Auto' } });
    expect(state.ref.documentId).toMatch(/^id-\d{3}$/);
  });

  it('rejects a duplicate document', async () => {
    const { deps, context } = harness();
    await createDocument(deps, context(), { documentId: 'doc-1', metadata: { title: 'A' } });

    await expect(
      createDocument(deps, context(), { documentId: 'doc-1', metadata: { title: 'B' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects invalid metadata before touching the store', async () => {
    const { store, deps, context } = harness();
    await expect(createDocument(deps, context(), { documentId: 'doc-1', metadata: {} })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await store.head(scope(), { tenantId: 'tenant-a', documentId: 'doc-1' })).toBeUndefined();
  });

  it('rejects a malformed command context', async () => {
    const { deps, context } = harness();
    await expect(
      createDocument(deps, context({ now: 'not-a-timestamp' }), { metadata: { title: 'x' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('updateMetadata', () => {
  it('appends an immutable revision and advances the head', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'v1' } });
    const updated = await updateMetadata(deps, context(), {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      metadata: { title: 'v2', tags: ['x'] },
    });

    expect(updated).toMatchObject({ aggregateRevision: 2, currentMetadataRevision: 2 });

    const revisions = await listMetadataRevisions(deps, scope(), created.ref.documentId, now);
    expect(revisions.items.map((entry) => entry.values.title)).toEqual(['v1', 'v2']);
    expect(await getCurrentMetadata(deps, scope(), created.ref.documentId, now)).toMatchObject({ title: 'v2' });
  });

  it('rejects a stale expected revision', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'v1' } });
    await updateMetadata(deps, context(), { documentId: created.ref.documentId, expectedRevision: 1, metadata: { title: 'v2' } });

    await expect(
      updateMetadata(deps, context(), { documentId: created.ref.documentId, expectedRevision: 1, metadata: { title: 'v3' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reports absence for an unknown document', async () => {
    const { deps, context } = harness();
    await expect(
      updateMetadata(deps, context(), { documentId: 'missing', expectedRevision: 1, metadata: { title: 'x' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('appendVersion', () => {
  it('appends an immutable version and makes it current', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Doc' } });

    const { state, version } = await appendVersion(deps, context(), {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      lifecycleGeneration: 1,
      content: verifiedContent(),
    });

    expect(state).toMatchObject({ aggregateRevision: 2, currentVersionId: version.id });
    expect(version.content.checksum).toEqual({ algorithm: 'sha256', value: 'b'.repeat(64) });

    const versions = await listVersions(deps, scope(), created.ref.documentId, now);
    expect(versions.items).toHaveLength(1);
  });

  it('keeps every prior version readable after a new one lands', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Doc' } });

    const first = await appendVersion(deps, context(), {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      lifecycleGeneration: 1,
      content: verifiedContent({ verificationId: 'verification-1' }),
    });
    const second = await appendVersion(deps, context(), {
      documentId: created.ref.documentId,
      expectedRevision: 2,
      lifecycleGeneration: 1,
      content: verifiedContent({
        artifact: { store: 'memory', objectId: 'object-2', generation: 'gen-2' },
        checksum: { algorithm: 'sha256', value: 'c'.repeat(64) },
        verificationId: 'verification-2',
      }),
    });

    const versions = await listVersions(deps, scope(), created.ref.documentId, now);
    expect(versions.items).toHaveLength(2);
    // The first version's bytes are untouched by the second append.
    const original = versions.items.find((entry) => entry.id === first.version.id);
    expect(original?.content.checksum.value).toBe('b'.repeat(64));
    expect(second.state.currentVersionId).toBe(second.version.id);
  });

  it('rejects a version carrying a stale lifecycle generation', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Doc' } });

    await expect(
      appendVersion(deps, context(), {
        documentId: created.ref.documentId,
        expectedRevision: 1,
        lifecycleGeneration: 0,
        content: verifiedContent(),
      }),
    ).rejects.toMatchObject({ code: 'stale_lifecycle' });
  });

  it('replays a retried append without creating a second version', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Doc' } });
    const retried = context({ operationId: 'op-append' });

    const first = await appendVersion(deps, retried, {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      lifecycleGeneration: 1,
      content: verifiedContent(),
    });
    const second = await appendVersion(deps, retried, {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      lifecycleGeneration: 1,
      content: verifiedContent(),
    });

    expect(second.version.id).toBe(first.version.id);
    expect(second.state.aggregateRevision).toBe(first.state.aggregateRevision);
    const versions = await listVersions(deps, scope(), created.ref.documentId, now);
    expect(versions.items).toHaveLength(1);
  });
});

describe('queries', () => {
  it('records an audit trail of every mutation', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Doc' } });
    await updateMetadata(deps, context(), { documentId: created.ref.documentId, expectedRevision: 1, metadata: { title: 'Doc2' } });

    const audit = await listAudit(deps, scope(), created.ref.documentId, now);
    expect(audit.items.map((entry) => entry.operation).sort()).toEqual(['document.create', 'metadata.update']);
    for (const record of audit.items) {
      expect(record.correlationId).toBe('corr-1');
      // Audit carries operation names and references only, never metadata values.
      expect(JSON.stringify(record.references)).not.toContain('Doc');
    }
  });

  it('refuses reads for a caller without the read permission', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'Doc' } });

    await expect(
      getDocument(deps, scope({ actorId: 'stranger' }), created.ref.documentId, now),
    ).rejects.toBeInstanceOf(DocumentError);
  });
});

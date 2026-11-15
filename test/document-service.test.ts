import { describe, expect, it } from 'bun:test';

import {
  DocumentNotFoundError,
  DocumentRevisionConflictError,
  DocumentService,
  DocumentStateError,
} from '@flowkitform/document';

import { InMemoryDocumentStore } from './in-memory-document-store';

const scope = { organizationId: 'org-a' } as const;

function makeService() {
  let tick = 0;
  let sequence = 0;
  const store = new InMemoryDocumentStore();
  const service = new DocumentService({
    unitOfWork: store,
    now: () => new Date(Date.UTC(2026, 10, 15, 0, 0, tick++)),
    newId: () => `doc-${++sequence}`,
  });
  return { store, service };
}

describe('document application service', () => {
  it('creates a draft document at revision 1', async () => {
    const { service } = makeService();
    const created = await service.createDocument(scope, {
      title: 'Incident runbook',
      content: '# Steps',
      createdBy: 'user-1',
    });
    expect(created).toMatchObject({
      id: 'doc-1',
      organizationId: 'org-a',
      status: 'draft',
      revision: 1,
      contentType: 'text/markdown',
    });
    expect(await service.getDocument(scope, 'doc-1')).toEqual(created);
  });

  it('rejects blank titles and unknown documents', async () => {
    const { service } = makeService();
    await expect(
      service.createDocument(scope, { title: '  ', content: '', createdBy: 'user-1' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(service.getDocument(scope, 'missing')).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it('updates content with optimistic concurrency and bumps the revision', async () => {
    const { service } = makeService();
    const created = await service.createDocument(scope, { title: 'T', content: 'v1', createdBy: 'user-1' });

    const updated = await service.updateContent(scope, { id: created.id, expectedRevision: 1, content: 'v2' });
    expect(updated).toMatchObject({ content: 'v2', revision: 2 });

    await expect(
      service.updateContent(scope, { id: created.id, expectedRevision: 1, content: 'stale' }),
    ).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    expect((await service.getDocument(scope, created.id)).content).toBe('v2');
  });

  it('lets exactly one of two concurrent same-revision edits win', async () => {
    const { service } = makeService();
    const created = await service.createDocument(scope, { title: 'T', content: 'v1', createdBy: 'user-1' });

    const results = await Promise.allSettled([
      service.updateContent(scope, { id: created.id, expectedRevision: 1, content: 'left' }),
      service.updateContent(scope, { id: created.id, expectedRevision: 1, content: 'right' }),
    ]);
    const outcomes = results.map((result) => result.status).sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(DocumentRevisionConflictError);
    expect((await service.getDocument(scope, created.id)).revision).toBe(2);
  });

  it('enforces the status lifecycle', async () => {
    const { service } = makeService();
    const created = await service.createDocument(scope, { title: 'T', content: 'v1', createdBy: 'user-1' });

    const published = await service.changeStatus(scope, created.id, 1, 'published');
    expect(published).toMatchObject({ status: 'published', revision: 2 });

    await expect(service.changeStatus(scope, created.id, 2, 'draft')).rejects.toBeInstanceOf(DocumentStateError);
    await expect(
      service.updateContent(scope, { id: created.id, expectedRevision: 2, content: 'edit published' }),
    ).resolves.toMatchObject({ revision: 3 });

    const archived = await service.changeStatus(scope, created.id, 3, 'archived');
    expect(archived.status).toBe('archived');
    await expect(
      service.updateContent(scope, { id: created.id, expectedRevision: 4, content: 'nope' }),
    ).rejects.toBeInstanceOf(DocumentStateError);
  });

  it('refuses to delete published documents but deletes drafts and archived ones', async () => {
    const { store, service } = makeService();
    const draft = await service.createDocument(scope, { title: 'Draft', content: '', createdBy: 'user-1' });
    const published = await service.createDocument(scope, { title: 'Live', content: '', createdBy: 'user-1' });
    await service.changeStatus(scope, published.id, 1, 'published');

    await expect(service.deleteDocument(scope, published.id, 2)).rejects.toBeInstanceOf(DocumentStateError);
    await service.deleteDocument(scope, draft.id, 1);
    expect(store.snapshot(scope).map((d) => d.id)).toEqual([published.id]);
  });

  it('keeps a failed state change from committing partial work', async () => {
    const { store, service } = makeService();
    const created = await service.createDocument(scope, { title: 'T', content: 'v1', createdBy: 'user-1' });
    await expect(service.changeStatus(scope, created.id, 99, 'published')).rejects.toBeInstanceOf(
      DocumentRevisionConflictError,
    );
    expect(store.snapshot(scope)[0]).toMatchObject({ status: 'draft', revision: 1 });
  });

  it('scopes reads and lists to the caller tenant', async () => {
    const { service } = makeService();
    await service.createDocument(scope, { title: 'A', content: '', createdBy: 'user-1' });
    await service.createDocument({ organizationId: 'org-b' }, { title: 'B', content: '', createdBy: 'user-2' });

    expect((await service.listDocuments(scope)).map((d) => d.title)).toEqual(['A']);
    await expect(service.getDocument(scope, 'doc-2')).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(service.listDocuments({ organizationId: '' })).rejects.toBeInstanceOf(TypeError);
  });
});

import { describe, expect, it } from 'bun:test';

import {
  DocumentRevisionConflictError,
  DuplicateDocumentError,
  type Document,
} from '@flowkitform/document';

import { InMemoryDocumentStore } from './in-memory-document-store';

const scope = { organizationId: 'org-a' } as const;
const otherScope = { organizationId: 'org-b' } as const;

function document(overrides: Partial<Document> = {}): Document {
  const at = new Date('2026-11-15T00:00:00Z');
  return {
    organizationId: scope.organizationId,
    id: 'doc-1',
    title: 'Runbook',
    content: '# Runbook',
    contentType: 'text/markdown',
    status: 'draft',
    revision: 1,
    createdBy: 'user-1',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('in-memory document store transaction semantics', () => {
  it('commits all mutations of a unit of work together', async () => {
    const store = new InMemoryDocumentStore();
    await store.run(async (repository) => {
      await repository.insert(document({ id: 'doc-1' }));
      await repository.insert(document({ id: 'doc-2' }));
    });
    expect((await store.run((repository) => repository.list(scope))).map((d) => d.id)).toEqual(['doc-1', 'doc-2']);
  });

  it('rolls back every mutation when the unit of work rejects', async () => {
    const store = new InMemoryDocumentStore();
    await store.run((repository) => repository.insert(document({ id: 'doc-1' })));

    await expect(
      store.run(async (repository) => {
        await repository.insert(document({ id: 'doc-2' }));
        await repository.insert(document({ id: 'doc-1' })); // duplicate aborts the transaction
      }),
    ).rejects.toBeInstanceOf(DuplicateDocumentError);

    expect(store.snapshot(scope).map((d) => d.id)).toEqual(['doc-1']);
  });

  it('serializes concurrent transactions so neither sees uncommitted writes', async () => {
    const store = new InMemoryDocumentStore();
    await store.run((repository) => repository.insert(document()));

    const observed: number[] = [];
    await Promise.all([
      store.run(async (repository) => {
        const current = (await repository.findById(scope, 'doc-1'))!;
        observed.push(current.revision);
        await repository.update({ ...current, content: 'first' }, current.revision);
      }),
      store.run(async (repository) => {
        const current = (await repository.findById(scope, 'doc-1'))!;
        observed.push(current.revision);
        await repository.update({ ...current, content: 'second' }, current.revision);
      }),
    ]);

    // Each transaction read the revision the previous one committed.
    expect(observed).toEqual([1, 2]);
    const final = store.snapshot(scope)[0]!;
    expect(final).toMatchObject({ content: 'second', revision: 3 });
  });

  it('remains usable after a failed transaction', async () => {
    const store = new InMemoryDocumentStore();
    await expect(store.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await store.run((repository) => repository.insert(document()));
    expect(store.snapshot(scope)).toHaveLength(1);
  });

  it('rejects stale-revision updates and deletes', async () => {
    const store = new InMemoryDocumentStore();
    await store.run((repository) => repository.insert(document()));
    await store.run(async (repository) => {
      const current = (await repository.findById(scope, 'doc-1'))!;
      await repository.update({ ...current, content: 'v2' }, 1);
    });

    await expect(
      store.run(async (repository) => {
        const current = (await repository.findById(scope, 'doc-1'))!;
        await repository.update({ ...current, content: 'stale' }, 1);
      }),
    ).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    await expect(store.run((repository) => repository.delete(scope, 'doc-1', 1))).rejects.toBeInstanceOf(
      DocumentRevisionConflictError,
    );
    expect(store.snapshot(scope)[0]).toMatchObject({ content: 'v2', revision: 2 });
  });

  it('isolates tenants from each other', async () => {
    const store = new InMemoryDocumentStore();
    await store.run((repository) => repository.insert(document()));
    await store.run((repository) =>
      repository.insert(document({ organizationId: otherScope.organizationId, id: 'doc-1', title: 'Other' })),
    );

    expect(store.snapshot(scope).map((d) => d.title)).toEqual(['Runbook']);
    expect(store.snapshot(otherScope).map((d) => d.title)).toEqual(['Other']);
    const crossTenantRead = await store.run((repository) => repository.findById(otherScope, 'doc-1'));
    expect(crossTenantRead?.title).toBe('Other');
  });
});

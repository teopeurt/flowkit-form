import { describe, expect, it } from 'bun:test';

import {
  DocumentError,
  createDocument,
  limits,
  preflightCommand,
  updateMetadata,
  type CommandAction,
  type DocumentCommand,
  type DocumentState,
} from '@flowkitform/documents';

import { harness, scope, tenantA } from './fixtures';

function headAction(state: DocumentState): CommandAction {
  return { kind: 'put-head', state };
}

function command(overrides: Partial<DocumentCommand> = {}): DocumentCommand {
  const state = {
    ref: { tenantId: tenantA, documentId: 'doc-1' },
    aggregateRevision: 1,
    lifecycleGeneration: 1,
    status: 'active' as const,
    currentVersionId: null,
    currentMetadataRevision: 1,
    grants: [],
    holds: [],
    retention: null,
    outstandingPublications: 0,
    outstandingCleanups: 0,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
  };
  return {
    ref: { tenantId: tenantA, documentId: 'doc-1' },
    operationId: 'op-1',
    correlationId: 'corr-1',
    expectedAggregateRevision: null,
    actions: [headAction(state)],
    ...overrides,
  };
}

describe('preflightCommand', () => {
  it('accepts a minimal command', () => {
    expect(() => preflightCommand(command())).not.toThrow();
  });

  it('requires exactly one head write to carry the compare-and-swap', () => {
    const state = (command().actions[0] as { state: DocumentState }).state;
    expect(() => preflightCommand(command({ actions: [] }))).toThrow(DocumentError);
    expect(() => preflightCommand(command({ actions: [headAction(state), headAction(state)] }))).toThrow(
      /single_head_write/,
    );
  });

  it('rejects more than the action limit', () => {
    const state = (command().actions[0] as { state: DocumentState }).state;
    const actions: CommandAction[] = [headAction(state)];
    for (let index = 0; index < limits.commandActions; index += 1) {
      actions.push({ kind: 'delete-lease', leaseId: `lease-${index}` });
    }
    expect(() => preflightCommand(command({ actions }))).toThrow(/command_action_limit_exceeded/);
  });

  it('rejects a command beyond the encoded byte limit', () => {
    const state = (command().actions[0] as { state: DocumentState }).state;
    const actions: CommandAction[] = [headAction(state)];
    // Few actions, each large: the byte bound must catch what the count bound misses.
    for (let index = 0; index < 4; index += 1) {
      actions.push({ kind: 'delete-lease', leaseId: 'x'.repeat(600_000) });
    }
    expect(() => preflightCommand(command({ actions }))).toThrow(/command_size_limit_exceeded/);
  });

  it('rejects a non-integer expected revision', () => {
    expect(() => preflightCommand(command({ expectedAggregateRevision: 1.5 }))).toThrow(
      /command_expected_revision_invalid/,
    );
  });
});

describe('memory store command semantics', () => {
  it('commits head, history, audit and event intent together', async () => {
    const { store, deps, context } = harness();
    const state = await createDocument(deps, context(), { metadata: { title: 'Certificate' } });

    const audit = await store.audit(scope(), state.ref);
    const metadata = await store.metadataRevisions(scope(), state.ref);
    const events = store.eventsFor(scope(), state.ref);

    expect(state.aggregateRevision).toBe(1);
    expect(audit.items).toHaveLength(1);
    expect(metadata.items).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ schemaVersion: 1, kind: 'document.created', aggregateRevision: 1 });
  });

  it('writes nothing when a command is rejected', async () => {
    const { store, deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'T' } });

    await expect(
      updateMetadata(deps, context(), { documentId: created.ref.documentId, expectedRevision: 99, metadata: { title: 'X' } }),
    ).rejects.toThrow(DocumentError);

    const head = await store.head(scope(), created.ref);
    const metadata = await store.metadataRevisions(scope(), created.ref);
    expect(head?.aggregateRevision).toBe(1);
    expect(metadata.items).toHaveLength(1);
  });

  it('enforces compare-and-swap on concurrent writers', async () => {
    const { deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'T' } });

    const results = await Promise.allSettled([
      updateMetadata(deps, context(), { documentId: created.ref.documentId, expectedRevision: 1, metadata: { title: 'left' } }),
      updateMetadata(deps, context(), { documentId: created.ref.documentId, expectedRevision: 1, metadata: { title: 'right' } }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(DocumentError.is(rejected.reason, 'conflict')).toBe(true);
  });

  it('replays a repeated operationId without applying it twice', async () => {
    const { store, deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'T' } });

    const retried = context({ operationId: 'op-retry' });
    const first = await updateMetadata(deps, retried, {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      metadata: { title: 'second' },
    });
    const second = await updateMetadata(deps, retried, {
      documentId: created.ref.documentId,
      expectedRevision: 1,
      metadata: { title: 'second' },
    });

    expect(first.aggregateRevision).toBe(2);
    expect(second.aggregateRevision).toBe(2);
    const revisions = await store.metadataRevisions(scope(), created.ref);
    expect(revisions.items).toHaveLength(2);
  });

  it('refuses to overwrite an immutable row', async () => {
    const { store, deps, context } = harness();
    const created = await createDocument(deps, context(), { metadata: { title: 'T' } });
    const state = (await store.head(scope(), created.ref))!;

    await expect(
      store.commit({
        ref: created.ref,
        operationId: 'op-dup',
        correlationId: 'corr-1',
        expectedAggregateRevision: 1,
        actions: [
          { kind: 'put-head', state: { ...state, aggregateRevision: 2 } },
          {
            kind: 'put-metadata-revision',
            revision: { revision: 1, values: { title: 'clobber', tags: [], custom: {}, associations: [] }, createdAt: '2026-11-15T00:00:00Z', createdBy: 'actor-1' },
          },
        ],
      }),
    ).rejects.toThrow(/immutable_row_exists/);

    const head = await store.head(scope(), created.ref);
    expect(head?.aggregateRevision).toBe(1);
  });

  it('pages deterministically and rejects a cursor from another document', async () => {
    const { store, deps, context } = harness({ pageSize: 2 });
    const first = await createDocument(deps, context(), { documentId: 'doc-a', metadata: { title: 'A' } });
    const second = await createDocument(deps, context(), { documentId: 'doc-b', metadata: { title: 'B' } });

    let revision = 1;
    for (const title of ['v2', 'v3', 'v4']) {
      await updateMetadata(deps, context(), { documentId: 'doc-a', expectedRevision: revision, metadata: { title } });
      revision += 1;
    }

    const page1 = await store.metadataRevisions(scope(), first.ref);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.metadataRevisions(scope(), first.ref, page1.nextCursor!);
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    await expect(store.metadataRevisions(scope(), second.ref, page1.nextCursor!)).rejects.toThrow(
      /cursor_document_mismatch/,
    );
  });
});

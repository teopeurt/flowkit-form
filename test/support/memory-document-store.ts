import {
  DocumentError,
  type AuditRecord,
  type CleanupObligation,
  type CommitReceipt,
  type CommitResult,
  type Cursor,
  type DocumentCommand,
  type DocumentRef,
  type DocumentState,
  type DocumentStore,
  type EventEnvelope,
  type MetadataRevision,
  type Page,
  type PublicationLease,
  type Scope,
  type Version,
} from '@flowkitform/documents';

/**
 * Deterministic in-memory reference implementation of DocumentStore.
 *
 * Test infrastructure, not production persistence. It models the semantics a
 * real adapter must provide:
 *
 * - Atomicity: a command mutates a working copy that is published only on
 *   success, so a rejected command leaves no partial writes.
 * - Compare-and-swap: the single head write in each command is conditional on
 *   the expected aggregate revision.
 * - Idempotency: a repeated operationId returns the first outcome and applies
 *   nothing, mirroring durable operation receipts rather than a provider's
 *   time-limited request token.
 * - Immutability: version, metadata-revision and audit rows never overwrite.
 * - Tenant isolation: every read is filtered by the scope's tenant.
 * - Deterministic ordering and stable cursors, so paging assertions are exact.
 */
export class MemoryDocumentStore implements DocumentStore {
  private committed = new Table();
  private queue: Promise<unknown> = Promise.resolve();
  readonly pageSize: number;

  constructor(options: { pageSize?: number } = {}) {
    this.pageSize = options.pageSize ?? 25;
  }

  async head(scope: Scope, ref: DocumentRef): Promise<DocumentState | undefined> {
    if (scope.tenantId !== ref.tenantId) return undefined;
    return this.committed.heads.get(key(ref));
  }

  async receipt(scope: Scope, operationId: string): Promise<CommitReceipt | undefined> {
    return this.committed.receipts.get(`${scope.tenantId}\u0000${operationId}`);
  }

  commit(command: DocumentCommand): Promise<CommitResult> {
    // Commands serialize: no command observes another's uncommitted writes.
    const execution = this.queue.then(
      () => this.apply(command),
      () => this.apply(command),
    );
    this.queue = execution.catch(() => undefined);
    return execution;
  }

  private async apply(command: DocumentCommand): Promise<CommitResult> {
    const receiptKey = `${command.ref.tenantId}\u0000${command.operationId}`;
    const existing = this.committed.receipts.get(receiptKey);
    if (existing) {
      const state = this.committed.heads.get(key(command.ref));
      if (!state) throw DocumentError.notFound('document_not_found');
      return Object.freeze({ state, receipt: existing, replayed: true });
    }

    const working = this.committed.clone();
    const current = working.heads.get(key(command.ref));
    const expected = command.expectedAggregateRevision;

    if (expected === null) {
      if (current) throw DocumentError.conflict('document_already_exists');
    } else {
      if (!current) throw DocumentError.notFound('document_not_found');
      if (current.aggregateRevision !== expected) {
        throw DocumentError.conflict('aggregate_revision_stale', {
          expected,
          actual: current.aggregateRevision,
        });
      }
    }

    let nextState: DocumentState | undefined;

    for (const action of command.actions) {
      switch (action.kind) {
        case 'put-head':
          nextState = action.state;
          working.heads.set(key(command.ref), action.state);
          break;
        case 'put-version':
          working.appendImmutable(working.versions, command.ref, action.version.id, action.version);
          break;
        case 'put-metadata-revision':
          working.appendImmutable(
            working.metadata,
            command.ref,
            String(action.revision.revision),
            action.revision,
          );
          break;
        case 'put-audit':
          working.appendImmutable(working.audit, command.ref, action.record.id, action.record);
          break;
        case 'put-event':
          working.appendImmutable(working.events, command.ref, action.envelope.eventId, action.envelope);
          break;
        case 'put-lease':
          working.rows(working.leases, command.ref).set(action.lease.id, action.lease);
          break;
        case 'delete-lease': {
          const leases = working.rows(working.leases, command.ref);
          if (!leases.delete(action.leaseId)) throw DocumentError.notFound('lease_not_found');
          break;
        }
        case 'put-cleanup':
          working.rows(working.cleanup, command.ref).set(action.obligation.id, action.obligation);
          break;
        case 'resolve-cleanup': {
          const obligations = working.rows(working.cleanup, command.ref);
          const obligation = obligations.get(action.obligationId);
          if (!obligation) throw DocumentError.notFound('cleanup_not_found');
          if (obligation.resolvedAt !== null) throw DocumentError.conflict('cleanup_already_resolved');
          obligations.set(action.obligationId, Object.freeze({ ...obligation, resolvedAt: action.resolvedAt }));
          break;
        }
      }
    }

    if (!nextState) throw DocumentError.invalidInput('command_requires_single_head_write');

    const receipt: CommitReceipt = Object.freeze({
      operationId: command.operationId,
      aggregateRevision: nextState.aggregateRevision,
      lifecycleGeneration: nextState.lifecycleGeneration,
      committedAt: nextState.updatedAt,
    });
    working.receipts.set(receiptKey, receipt);

    this.committed = working;
    return Object.freeze({ state: nextState, receipt, replayed: false });
  }

  async versions(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<Version>> {
    return this.page(this.committed.versions, scope, ref, cursor);
  }

  async metadataRevisions(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<MetadataRevision>> {
    return this.page(this.committed.metadata, scope, ref, cursor);
  }

  async audit(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<AuditRecord>> {
    return this.page(this.committed.audit, scope, ref, cursor);
  }

  async leases(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<PublicationLease>> {
    return this.page(this.committed.leases, scope, ref, cursor);
  }

  async cleanupObligations(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<CleanupObligation>> {
    return this.page(this.committed.cleanup, scope, ref, cursor);
  }

  /** Events are not part of the port; exposed for delivery-intent assertions. */
  eventsFor(scope: Scope, ref: DocumentRef): readonly EventEnvelope[] {
    if (scope.tenantId !== ref.tenantId) return [];
    return [...(this.committed.events.get(key(ref))?.values() ?? [])];
  }

  private page<T>(
    table: Map<string, Map<string, T>>,
    scope: Scope,
    ref: DocumentRef,
    cursor?: Cursor,
  ): Page<T> {
    if (scope.tenantId !== ref.tenantId) throw DocumentError.notFound('document_not_found');

    const rows = [...(table.get(key(ref))?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right));
    let offset = 0;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      // A cursor issued for one document must never be replayed against another.
      if (decoded.document !== key(ref)) throw DocumentError.invalidInput('cursor_document_mismatch');
      offset = decoded.offset;
    }

    const slice = rows.slice(offset, offset + this.pageSize);
    const nextOffset = offset + slice.length;
    return Object.freeze({
      items: Object.freeze(slice.map(([, value]) => value)),
      nextCursor: nextOffset < rows.length ? encodeCursor(key(ref), nextOffset) : null,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

function key(ref: DocumentRef): string {
  return `${ref.tenantId}\u0000${ref.documentId}`;
}

function encodeCursor(document: string, offset: number): Cursor {
  return Buffer.from(JSON.stringify({ document, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: Cursor): { document: string; offset: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw DocumentError.invalidInput('cursor_invalid');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { document?: unknown }).document !== 'string' ||
    !Number.isInteger((parsed as { offset?: unknown }).offset)
  ) {
    throw DocumentError.invalidInput('cursor_invalid');
  }
  return parsed as { document: string; offset: number };
}

class Table {
  heads = new Map<string, DocumentState>();
  receipts = new Map<string, CommitReceipt>();
  versions = new Map<string, Map<string, Version>>();
  metadata = new Map<string, Map<string, MetadataRevision>>();
  audit = new Map<string, Map<string, AuditRecord>>();
  events = new Map<string, Map<string, EventEnvelope>>();
  leases = new Map<string, Map<string, PublicationLease>>();
  cleanup = new Map<string, Map<string, CleanupObligation>>();

  rows<T>(table: Map<string, Map<string, T>>, ref: DocumentRef): Map<string, T> {
    const existing = table.get(key(ref));
    if (existing) return existing;
    const created = new Map<string, T>();
    table.set(key(ref), created);
    return created;
  }

  /** Immutable rows are written once; a duplicate key is a defect, not an update. */
  appendImmutable<T>(table: Map<string, Map<string, T>>, ref: DocumentRef, rowKey: string, value: T): void {
    const rows = this.rows(table, ref);
    if (rows.has(rowKey)) throw DocumentError.conflict('immutable_row_exists');
    rows.set(rowKey, value);
  }

  clone(): Table {
    const copy = new Table();
    copy.heads = new Map(this.heads);
    copy.receipts = new Map(this.receipts);
    copy.versions = cloneNested(this.versions);
    copy.metadata = cloneNested(this.metadata);
    copy.audit = cloneNested(this.audit);
    copy.events = cloneNested(this.events);
    copy.leases = cloneNested(this.leases);
    copy.cleanup = cloneNested(this.cleanup);
    return copy;
  }
}

function cloneNested<T>(table: Map<string, Map<string, T>>): Map<string, Map<string, T>> {
  return new Map([...table.entries()].map(([id, rows]) => [id, new Map(rows)]));
}

import {
  DocumentNotFoundError,
  DocumentRevisionConflictError,
  DuplicateDocumentError,
  requireTenantScope,
  type Document,
  type DocumentRepository,
  type DocumentUnitOfWork,
  type TenantScope,
} from '@flowkit-demo/document';

function storageKey(organizationId: string, documentId: string): string {
  return `${organizationId}\u0000${documentId}`;
}

/**
 * In-memory reference adapter for the document persistence contracts. Test
 * infrastructure only — it exists to exercise transaction and concurrency
 * semantics in service tests, not to back a deployment.
 *
 * Semantics it models:
 * - Atomicity: each `run` works on a snapshot and commits all-or-nothing.
 * - Serialization: concurrent `run` calls queue behind a single lock, so no
 *   transaction observes another's uncommitted writes.
 * - Optimistic concurrency: update/delete compare the stored revision.
 */
export class InMemoryDocumentStore implements DocumentUnitOfWork {
  private committed = new Map<string, Document>();
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: (repository: DocumentRepository) => Promise<T>): Promise<T> {
    const execution = this.tail.then(
      () => this.runSerialized(work),
      () => this.runSerialized(work),
    );
    this.tail = execution.catch(() => undefined);
    return execution;
  }

  /** Committed rows for one organization, for assertions in tests. */
  snapshot(scope: TenantScope): Document[] {
    const { organizationId } = requireTenantScope(scope);
    return [...this.committed.values()].filter((document) => document.organizationId === organizationId);
  }

  private async runSerialized<T>(work: (repository: DocumentRepository) => Promise<T>): Promise<T> {
    const working = new Map(this.committed);
    const result = await work(new InMemoryDocumentRepository(working));
    this.committed = working;
    return result;
  }
}

class InMemoryDocumentRepository implements DocumentRepository {
  constructor(private readonly rows: Map<string, Document>) {}

  async findById(scope: TenantScope, documentId: string): Promise<Document | undefined> {
    const { organizationId } = requireTenantScope(scope);
    return this.rows.get(storageKey(organizationId, documentId));
  }

  async list(scope: TenantScope): Promise<Document[]> {
    const { organizationId } = requireTenantScope(scope);
    return [...this.rows.values()]
      .filter((document) => document.organizationId === organizationId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async insert(document: Document): Promise<void> {
    requireTenantScope(document);
    const key = storageKey(document.organizationId, document.id);
    if (this.rows.has(key)) throw new DuplicateDocumentError(document.id);
    this.rows.set(key, document);
  }

  async update(document: Document, expectedRevision: number): Promise<void> {
    requireTenantScope(document);
    const key = storageKey(document.organizationId, document.id);
    const current = this.rows.get(key);
    if (!current) throw new DocumentNotFoundError(document.id);
    if (current.revision !== expectedRevision) {
      throw new DocumentRevisionConflictError(document.id, expectedRevision, current.revision);
    }
    this.rows.set(key, { ...document, revision: expectedRevision + 1 });
  }

  async delete(scope: TenantScope, documentId: string, expectedRevision: number): Promise<void> {
    const { organizationId } = requireTenantScope(scope);
    const key = storageKey(organizationId, documentId);
    const current = this.rows.get(key);
    if (!current) throw new DocumentNotFoundError(documentId);
    if (current.revision !== expectedRevision) {
      throw new DocumentRevisionConflictError(documentId, expectedRevision, current.revision);
    }
    this.rows.delete(key);
  }
}

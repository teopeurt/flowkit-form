import type { Document, TenantScope } from './model';

/**
 * Provider-neutral persistence contract for documents. Implementations must be
 * tenant-isolated: every operation is scoped to one organization, and no call
 * may observe or mutate another organization's rows.
 */
export interface DocumentRepository {
  findById(scope: TenantScope, documentId: string): Promise<Document | undefined>;
  list(scope: TenantScope): Promise<Document[]>;
  /** Persists a new document; rejects with DuplicateDocumentError when the id is taken. */
  insert(document: Document): Promise<void>;
  /**
   * Replaces the stored document only when its current revision equals
   * `expectedRevision`; rejects with DocumentRevisionConflictError otherwise.
   * The replacement carries `expectedRevision + 1`.
   */
  update(document: Document, expectedRevision: number): Promise<void>;
  /** Removes the document under the same optimistic-concurrency rule as update. */
  delete(scope: TenantScope, documentId: string, expectedRevision: number): Promise<void>;
}

/**
 * Transaction boundary. `run` executes `work` atomically: either every
 * repository mutation performed inside `work` is visible after it resolves, or
 * none is when it rejects. Concurrent `run` calls must be isolated from each
 * other's uncommitted writes.
 */
export interface DocumentUnitOfWork {
  run<T>(work: (repository: DocumentRepository) => Promise<T>): Promise<T>;
}

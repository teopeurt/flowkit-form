import { DocumentNotFoundError, DocumentStateError } from './errors';
import {
  canTransition,
  requireTenantScope,
  type CreateDocumentInput,
  type Document,
  type DocumentStatus,
  type TenantScope,
  type UpdateDocumentContentInput,
} from './model';
import type { DocumentRepository, DocumentUnitOfWork } from './repository';

export type DocumentServiceOptions = Readonly<{
  unitOfWork: DocumentUnitOfWork;
  now?: () => Date;
  newId?: () => string;
}>;

/**
 * Application services over the provider-neutral persistence contracts. Every
 * command runs inside one unit of work; invariants (status transitions,
 * optimistic concurrency) are enforced here, not by any particular store.
 */
export class DocumentService {
  private readonly unitOfWork: DocumentUnitOfWork;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: DocumentServiceOptions) {
    this.unitOfWork = options.unitOfWork;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async createDocument(scope: TenantScope, input: CreateDocumentInput): Promise<Document> {
    const { organizationId } = requireTenantScope(scope);
    if (input.title.trim().length === 0) throw new TypeError('A document title is required.');
    const at = this.now();
    const document: Document = {
      organizationId,
      id: input.id ?? this.newId(),
      title: input.title,
      content: input.content,
      contentType: input.contentType ?? 'text/markdown',
      status: 'draft',
      revision: 1,
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    };
    await this.unitOfWork.run((repository) => repository.insert(document));
    return document;
  }

  async getDocument(scope: TenantScope, documentId: string): Promise<Document> {
    requireTenantScope(scope);
    return this.unitOfWork.run(async (repository) => {
      const document = await repository.findById(scope, documentId);
      if (!document) throw new DocumentNotFoundError(documentId);
      return document;
    });
  }

  async listDocuments(scope: TenantScope): Promise<Document[]> {
    requireTenantScope(scope);
    return this.unitOfWork.run((repository) => repository.list(scope));
  }

  async updateContent(scope: TenantScope, input: UpdateDocumentContentInput): Promise<Document> {
    requireTenantScope(scope);
    return this.mutate(scope, input.id, input.expectedRevision, (document) => {
      if (document.status === 'archived') {
        throw new DocumentStateError(document.id, document.status, document.status);
      }
      return {
        ...document,
        title: input.title ?? document.title,
        content: input.content ?? document.content,
      };
    });
  }

  async changeStatus(scope: TenantScope, documentId: string, expectedRevision: number, to: DocumentStatus): Promise<Document> {
    requireTenantScope(scope);
    return this.mutate(scope, documentId, expectedRevision, (document) => {
      if (!canTransition(document.status, to)) {
        throw new DocumentStateError(document.id, document.status, to);
      }
      return { ...document, status: to };
    });
  }

  async deleteDocument(scope: TenantScope, documentId: string, expectedRevision: number): Promise<void> {
    requireTenantScope(scope);
    await this.unitOfWork.run(async (repository) => {
      const document = await repository.findById(scope, documentId);
      if (!document) throw new DocumentNotFoundError(documentId);
      if (document.status === 'published') {
        throw new DocumentStateError(documentId, 'published', 'deleted');
      }
      await repository.delete(scope, documentId, expectedRevision);
    });
  }

  private mutate(
    scope: TenantScope,
    documentId: string,
    expectedRevision: number,
    apply: (document: Document) => Document,
  ): Promise<Document> {
    return this.unitOfWork.run(async (repository: DocumentRepository) => {
      const document = await repository.findById(scope, documentId);
      if (!document) throw new DocumentNotFoundError(documentId);
      const next: Document = { ...apply(document), revision: expectedRevision + 1, updatedAt: this.now() };
      await repository.update(next, expectedRevision);
      return next;
    });
  }
}

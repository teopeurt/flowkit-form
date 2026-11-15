export {
  canTransition,
  documentStatuses,
  requireTenantScope,
  type CreateDocumentInput,
  type Document,
  type DocumentStatus,
  type TenantScope,
  type UpdateDocumentContentInput,
} from './model';
export {
  DocumentNotFoundError,
  DocumentRevisionConflictError,
  DocumentStateError,
  DuplicateDocumentError,
} from './errors';
export type { DocumentRepository, DocumentUnitOfWork } from './repository';
export { DocumentService, type DocumentServiceOptions } from './service';

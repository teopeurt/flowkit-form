export type TenantScope = Readonly<{ organizationId: string }>;

/** Accepts only the trusted organization context selected by the authentication boundary. */
export function requireTenantScope(scope: TenantScope): TenantScope {
  if (!scope || typeof scope.organizationId !== 'string' || scope.organizationId.trim().length === 0) {
    throw new TypeError('A non-empty organization scope is required.');
  }
  return scope;
}

export const documentStatuses = ['draft', 'published', 'archived'] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

export type Document = Readonly<{
  organizationId: string;
  id: string;
  title: string;
  content: string;
  contentType: string;
  status: DocumentStatus;
  /** Monotonic per-document revision; every committed mutation increments it by exactly one. */
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CreateDocumentInput = Readonly<{
  id?: string;
  title: string;
  content: string;
  contentType?: string;
  createdBy: string;
}>;

export type UpdateDocumentContentInput = Readonly<{
  id: string;
  expectedRevision: number;
  title?: string;
  content?: string;
}>;

/** Status transitions the application layer permits. */
const allowedTransitions: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  draft: ['published', 'archived'],
  published: ['archived'],
  archived: [],
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return allowedTransitions[from]?.includes(to) ?? false;
}

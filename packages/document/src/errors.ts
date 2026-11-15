export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} does not exist in this organization.`);
    this.name = 'DocumentNotFoundError';
  }
}

export class DuplicateDocumentError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} already exists in this organization.`);
    this.name = 'DuplicateDocumentError';
  }
}

/** Optimistic-concurrency failure: the stored revision no longer matches the caller's snapshot. */
export class DocumentRevisionConflictError extends Error {
  constructor(
    documentId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Document ${documentId} is at revision ${actualRevision}, not expected revision ${expectedRevision}.`);
    this.name = 'DocumentRevisionConflictError';
  }
}

export class DocumentStateError extends Error {
  constructor(documentId: string, from: string, to: string) {
    super(`Document ${documentId} cannot move from ${from} to ${to}.`);
    this.name = 'DocumentStateError';
  }
}

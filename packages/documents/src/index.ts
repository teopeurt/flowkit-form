/**
 * Portable document core. Public exports only — no provider SDK types, no
 * streams and no binary payloads cross this boundary.
 */

/* Value types and validation */
export {
  canonicalJson,
  encodedBytes,
  isIsoTimestamp,
  limits,
  parseJsonObject,
  parseMetadata,
  parseVerifiedContent,
  requireCommandContext,
  requireIdentifier,
  requireIsoTimestamp,
  requireSameTenant,
  requireScope,
  type ArtifactRef,
  type Association,
  type Checksum,
  type CommandContext,
  type DocumentRef,
  type DocumentState,
  type DocumentStatus,
  type Grant,
  type Hold,
  type JsonArray,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Metadata,
  type MetadataRevision,
  type Permission,
  type Principal,
  type Retention,
  type Scope,
  type VerifiedContent,
  type Version,
} from './model';

/* Errors */
export { DocumentError, type DocumentErrorCode, type SafeContext } from './errors';

/* Persistence contracts */
export {
  assertExpectedRevision,
  buildAudit,
  buildEvent,
  preflightCommand,
  requireHead,
  submitCommand,
  type AuditRecord,
  type CommandAction,
  type CommitReceipt,
  type CommitResult,
  type Cursor,
  type DocumentCommand,
  type DocumentStore,
  type EventEnvelope,
  type Page,
} from './persistence';

/* Access control */
export {
  addGrant,
  evaluatePermissions,
  isPermission,
  parseGrant,
  parsePrincipal,
  permissions,
  pruneExpiredGrants,
  removeGrant,
  requirePermission,
} from './access';

/* Metadata and version services */
export {
  appendVersion,
  createDocument,
  getCurrentMetadata,
  getDocument,
  listAudit,
  listMetadataRevisions,
  listVersions,
  updateMetadata,
  type AppendVersionInput,
  type CreateDocumentInput,
  type DocumentServiceDependencies,
  type UpdateMetadataInput,
} from './documents';

/* Lifecycle services */
export {
  abandonPublicationLease,
  acquirePublicationLease,
  applyRetention,
  assertDeletable,
  assertDeletionCompletable,
  assertLeaseAcquirable,
  assertLeaseCompletable,
  beginDeletion,
  completeDeletion,
  completePublicationLease,
  leaseExpired,
  parseHold,
  placeHold,
  placeLegalHold,
  releaseHold,
  releaseLegalHold,
  requireActive,
  requireCurrentGeneration,
  resolveCleanupObligation,
  retentionBlocks,
  setRetention,
  type CleanupObligation,
  type CleanupReason,
  type HoldInput,
  type LifecycleDependencies,
  type PublicationLease,
} from './lifecycle';

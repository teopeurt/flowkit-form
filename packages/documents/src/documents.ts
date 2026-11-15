import { addGrant, parseGrant, requirePermission } from './access';
import { DocumentError } from './errors';
import { requireActive, requireCurrentGeneration } from './lifecycle';
import {
  parseMetadata,
  requireCommandContext,
  requireIdentifier,
  requireScope,
  type CommandContext,
  type DocumentRef,
  type DocumentState,
  type Metadata,
  type MetadataRevision,
  type Scope,
  type VerifiedContent,
  type Version,
} from './model';
import {
  assertExpectedRevision,
  buildAudit,
  buildEvent,
  replayedState,
  requireHead,
  submitCommand,
  type AuditRecord,
  type Cursor,
  type DocumentStore,
  type Page,
} from './persistence';

export type DocumentServiceDependencies = Readonly<{
  store: DocumentStore;
  /** Deterministic in tests; defaults to a random identifier in production. */
  newId?: () => string;
}>;

function identifiers(deps: DocumentServiceDependencies): () => string {
  return deps.newId ?? (() => crypto.randomUUID());
}

function ref(context: CommandContext, documentId: string): DocumentRef {
  return Object.freeze({
    tenantId: context.tenantId,
    documentId: requireIdentifier(documentId, 'document_id_invalid'),
  });
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

export type CreateDocumentInput = Readonly<{
  documentId?: string;
  metadata: unknown;
}>;

/**
 * Creates a document at aggregate revision 1 with metadata revision 1 and an
 * explicit full-permission grant for the creating actor. No content yet: bytes
 * arrive through appendVersion once a verifier has accepted them.
 */
export async function createDocument(
  deps: DocumentServiceDependencies,
  context: CommandContext,
  input: CreateDocumentInput,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const metadata = parseMetadata(input.metadata);
  const target = ref(context, input.documentId ?? nextId());

  const seed: DocumentState = Object.freeze({
    ref: target,
    aggregateRevision: 1,
    lifecycleGeneration: 1,
    status: 'active' as const,
    currentVersionId: null,
    currentMetadataRevision: 1,
    grants: Object.freeze([]),
    holds: Object.freeze([]),
    retention: null,
    outstandingPublications: 0,
    outstandingCleanups: 0,
    createdAt: context.now,
    updatedAt: context.now,
  });

  const creatorGrant = parseGrant(
    {
      id: nextId(),
      principal: { kind: 'actor', id: context.actorId },
      permissions: ['read', 'write', 'share', 'delete'],
    },
    context.now,
    context.actorId,
  );

  const state: DocumentState = Object.freeze({ ...seed, grants: addGrant(seed, creatorGrant) });
  const revision: MetadataRevision = Object.freeze({
    revision: 1,
    values: metadata,
    createdAt: context.now,
    createdBy: context.actorId,
  });

  return submitCommand(deps.store, context, target, null, [
    { kind: 'put-head', state },
    { kind: 'put-metadata-revision', revision },
    { kind: 'put-audit', record: buildAudit(context, state, 'document.create', nextId()) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'document.created', nextId()) },
  ]);
}

export type UpdateMetadataInput = Readonly<{
  documentId: string;
  expectedRevision: number;
  metadata: unknown;
}>;

/** Replaces current metadata, appending an immutable revision row. */
export async function updateMetadata(
  deps: DocumentServiceDependencies,
  context: CommandContext,
  input: UpdateMetadataInput,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const metadata = parseMetadata(input.metadata);
  const target = ref(context, input.documentId);

  const replayed = await replayedState(deps.store, context, target, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, target);
  requireActive(current);
  requirePermission(current, context, 'write', context.now);
  assertExpectedRevision(current, input.expectedRevision);

  const nextRevisionNumber = current.currentMetadataRevision + 1;
  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    currentMetadataRevision: nextRevisionNumber,
    updatedAt: context.now,
  });
  const revision: MetadataRevision = Object.freeze({
    revision: nextRevisionNumber,
    values: metadata,
    createdAt: context.now,
    createdBy: context.actorId,
  });

  return submitCommand(deps.store, context, target, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-metadata-revision', revision },
    {
      kind: 'put-audit',
      record: buildAudit(context, state, 'metadata.update', nextId(), { revision: String(nextRevisionNumber) }),
    },
    {
      kind: 'put-event',
      envelope: buildEvent(context, state, 'metadata.updated', nextId(), { revision: String(nextRevisionNumber) }),
    },
  ]);
}

export type AppendVersionInput = Readonly<{
  documentId: string;
  expectedRevision: number;
  /** Trusted verifier output. See the security note below. */
  content: VerifiedContent;
  lifecycleGeneration: number;
}>;

/**
 * Appends an immutable version and makes it current.
 *
 * SECURITY: `content` asserts that a verifier already read and hashed the exact
 * stored bytes. Never wire this parameter to a request body — only a verifier
 * adapter inside the trust boundary may supply it. A public upload API must go
 * through an upload intent that ends in verification, and the verifier calls
 * this.
 *
 * The caller's lifecycle generation is checked so a version produced before a
 * deletion cannot land after it.
 */
export async function appendVersion(
  deps: DocumentServiceDependencies,
  context: CommandContext,
  input: AppendVersionInput,
): Promise<Readonly<{ state: DocumentState; version: Version }>> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const target = ref(context, input.documentId);

  const replayed = await replayedState(deps.store, context, target, context.operationId);
  if (replayed) return Object.freeze({ state: replayed, version: await currentVersion(deps, context, replayed) });

  const current = await requireHead(deps.store, context, target);
  // Generation first: a caller holding obsolete work needs `stale_lifecycle` —
  // the signal that tells it to abandon and hand its bytes to cleanup — rather
  // than the blunter status or permission error a deleting document also
  // produces.
  requireCurrentGeneration(current, input.lifecycleGeneration);
  requireActive(current);
  requirePermission(current, context, 'write', context.now);
  assertExpectedRevision(current, input.expectedRevision);

  const version: Version = Object.freeze({
    id: nextId(),
    content: input.content,
    createdAt: context.now,
    createdBy: context.actorId,
  });
  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    currentVersionId: version.id,
    updatedAt: context.now,
  });

  const committed = await submitCommand(deps.store, context, target, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-version', version },
    { kind: 'put-audit', record: buildAudit(context, state, 'version.append', nextId(), { versionId: version.id }) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'version.appended', nextId(), { versionId: version.id }) },
  ]);
  return Object.freeze({ state: committed, version });
}

/** Resolves the head's current version from the paged version rows. */
async function currentVersion(
  deps: DocumentServiceDependencies,
  scope: Scope,
  state: DocumentState,
): Promise<Version> {
  if (state.currentVersionId === null) throw DocumentError.notFound('version_not_found');
  let page = await deps.store.versions(scope, state.ref);
  for (;;) {
    const found = page.items.find((version) => version.id === state.currentVersionId);
    if (found) return found;
    if (page.nextCursor === null) throw DocumentError.notFound('version_not_found');
    page = await deps.store.versions(scope, state.ref, page.nextCursor);
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export async function getDocument(
  deps: DocumentServiceDependencies,
  scope: Scope,
  documentId: string,
  now: string,
): Promise<DocumentState> {
  requireScope(scope);
  const target = Object.freeze({
    tenantId: scope.tenantId,
    documentId: requireIdentifier(documentId, 'document_id_invalid'),
  });
  const state = await requireHead(deps.store, scope, target);
  requirePermission(state, scope, 'read', now);
  return state;
}

export async function listVersions(
  deps: DocumentServiceDependencies,
  scope: Scope,
  documentId: string,
  now: string,
  cursor?: Cursor,
): Promise<Page<Version>> {
  const state = await getDocument(deps, scope, documentId, now);
  return deps.store.versions(scope, state.ref, cursor);
}

export async function listMetadataRevisions(
  deps: DocumentServiceDependencies,
  scope: Scope,
  documentId: string,
  now: string,
  cursor?: Cursor,
): Promise<Page<MetadataRevision>> {
  const state = await getDocument(deps, scope, documentId, now);
  return deps.store.metadataRevisions(scope, state.ref, cursor);
}

export async function listAudit(
  deps: DocumentServiceDependencies,
  scope: Scope,
  documentId: string,
  now: string,
  cursor?: Cursor,
): Promise<Page<AuditRecord>> {
  const state = await getDocument(deps, scope, documentId, now);
  return deps.store.audit(scope, state.ref, cursor);
}

/** Current metadata values, resolved from the paged revision rows. */
export async function getCurrentMetadata(
  deps: DocumentServiceDependencies,
  scope: Scope,
  documentId: string,
  now: string,
): Promise<Metadata> {
  const state = await getDocument(deps, scope, documentId, now);
  let page = await deps.store.metadataRevisions(scope, state.ref);
  let found: MetadataRevision | undefined;
  for (;;) {
    found = page.items.find((revision) => revision.revision === state.currentMetadataRevision) ?? found;
    if (found || page.nextCursor === null) break;
    page = await deps.store.metadataRevisions(scope, state.ref, page.nextCursor);
  }
  if (!found) throw DocumentError.notFound('metadata_revision_not_found');
  return found.values;
}

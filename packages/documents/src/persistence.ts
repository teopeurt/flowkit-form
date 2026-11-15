import { DocumentError } from './errors';
// Type-only: lifecycle.ts imports this module's values at runtime, so importing
// its types here must stay erasable to avoid a module cycle.
import type { CleanupObligation, PublicationLease } from './lifecycle';
import {
  canonicalJson,
  limits,
  requireSameTenant,
  type CommandContext,
  type DocumentRef,
  type DocumentState,
  type JsonObject,
  type MetadataRevision,
  type Scope,
  type Version,
} from './model';

/* ------------------------------------------------------------------ *
 * Paged reads
 * ------------------------------------------------------------------ */

/**
 * A cursor is opaque to callers and sealed at the API boundary. It never
 * crosses a document or tenant: an adapter must reject a cursor presented
 * against a different document than the one that issued it.
 */
export type Cursor = string;

export type Page<T> = Readonly<{ items: readonly T[]; nextCursor: Cursor | null }>;

/* ------------------------------------------------------------------ *
 * Audit and events
 * ------------------------------------------------------------------ */

export type AuditRecord = Readonly<{
  id: string;
  operation: string;
  actorId: string;
  occurredAt: string;
  correlationId: string;
  operationId: string;
  aggregateRevision: number;
  lifecycleGeneration: number;
  /** Operation names and references only; never metadata values or content. */
  references: JsonObject;
}>;

export type EventEnvelope = Readonly<{
  schemaVersion: 1;
  eventId: string;
  tenantId: string;
  documentId: string;
  lifecycleGeneration: number;
  aggregateRevision: number;
  kind: string;
  occurredAt: string;
  correlationId: string;
  operationId: string;
  refs: Readonly<Record<string, string>>;
}>;

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * The complete set of row mutations a command may request. Immutable rows
 * (`put-version`, `put-metadata-revision`, `put-audit`) must never overwrite an
 * existing row; an adapter rejects a duplicate key rather than replacing it.
 */
export type CommandAction =
  | Readonly<{ kind: 'put-head'; state: DocumentState }>
  | Readonly<{ kind: 'put-version'; version: Version }>
  | Readonly<{ kind: 'put-metadata-revision'; revision: MetadataRevision }>
  | Readonly<{ kind: 'put-lease'; lease: PublicationLease }>
  | Readonly<{ kind: 'delete-lease'; leaseId: string }>
  | Readonly<{ kind: 'put-cleanup'; obligation: CleanupObligation }>
  | Readonly<{ kind: 'resolve-cleanup'; obligationId: string; resolvedAt: string }>
  | Readonly<{ kind: 'put-audit'; record: AuditRecord }>
  | Readonly<{ kind: 'put-event'; envelope: EventEnvelope }>;

/**
 * One atomic unit of work.
 *
 * `expectedAggregateRevision` is the compare-and-swap condition: the revision
 * the command was planned against, or `null` to assert the document does not
 * exist yet. The store applies every action or none.
 */
export type DocumentCommand = Readonly<{
  ref: DocumentRef;
  operationId: string;
  correlationId: string;
  expectedAggregateRevision: number | null;
  actions: readonly CommandAction[];
}>;

/** Recorded per operationId so a retry returns the first outcome rather than reapplying. */
export type CommitReceipt = Readonly<{
  operationId: string;
  aggregateRevision: number;
  lifecycleGeneration: number;
  committedAt: string;
}>;

export type CommitResult = Readonly<{ state: DocumentState; receipt: CommitReceipt; replayed: boolean }>;

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

/**
 * Enforces the per-command bounds before anything is sent to a provider.
 *
 * Every adapter must call this, and a provider-backed adapter must additionally
 * preflight its own encoded transaction: this measures the portable command,
 * not the provider's wire format, which carries extra per-item overhead.
 */
export function preflightCommand(command: DocumentCommand): void {
  if (!Array.isArray(command.actions) || command.actions.length === 0) {
    throw DocumentError.invalidInput('command_actions_required');
  }
  if (command.actions.length > limits.commandActions) {
    throw DocumentError.invalidInput('command_action_limit_exceeded', {
      limit: limits.commandActions,
      actual: command.actions.length,
    });
  }

  const headWrites = command.actions.filter((action) => action.kind === 'put-head').length;
  if (headWrites !== 1) {
    // Exactly one head write carries the compare-and-swap for the whole command.
    throw DocumentError.invalidInput('command_requires_single_head_write', { actual: headWrites });
  }

  const size = new TextEncoder().encode(canonicalJson(command as unknown as JsonObject)).length;
  if (size > limits.commandBytes) {
    throw DocumentError.invalidInput('command_size_limit_exceeded', { limit: limits.commandBytes, actual: size });
  }

  if (command.expectedAggregateRevision !== null && !Number.isInteger(command.expectedAggregateRevision)) {
    throw DocumentError.invalidInput('command_expected_revision_invalid');
  }
}

/* ------------------------------------------------------------------ *
 * Store port
 * ------------------------------------------------------------------ */

/**
 * Provider-neutral persistence boundary.
 *
 * No SDK types, streams or binary payloads cross this interface: content is
 * referenced by ArtifactRef and described by VerifiedContent. Implementations
 * must be tenant-isolated — every call is scoped, and no call may observe
 * another tenant's rows.
 */
export interface DocumentStore {
  /** Strongly consistent head read; authorization decisions depend on it. */
  head(scope: Scope, ref: DocumentRef): Promise<DocumentState | undefined>;

  /**
   * Applies the command atomically under its compare-and-swap condition.
   * Rejects with `conflict` when the condition fails, and returns the original
   * outcome with `replayed: true` when the operationId was already committed.
   */
  commit(command: DocumentCommand): Promise<CommitResult>;

  receipt(scope: Scope, operationId: string): Promise<CommitReceipt | undefined>;

  versions(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<Version>>;
  metadataRevisions(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<MetadataRevision>>;
  audit(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<AuditRecord>>;
  leases(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<PublicationLease>>;
  cleanupObligations(scope: Scope, ref: DocumentRef, cursor?: Cursor): Promise<Page<CleanupObligation>>;
}

/* ------------------------------------------------------------------ *
 * Command construction helpers
 *
 * Shared by the metadata/version services and the lifecycle services so both
 * build commands, audit records and events the same way.
 * ------------------------------------------------------------------ */

export function buildAudit(
  context: CommandContext,
  state: DocumentState,
  operation: string,
  id: string,
  references: Readonly<Record<string, string>> = {},
): AuditRecord {
  return Object.freeze({
    id,
    operation,
    actorId: context.actorId,
    occurredAt: context.now,
    correlationId: context.correlationId,
    operationId: context.operationId,
    aggregateRevision: state.aggregateRevision,
    lifecycleGeneration: state.lifecycleGeneration,
    references: Object.freeze({ ...references }) as JsonObject,
  });
}

export function buildEvent(
  context: CommandContext,
  state: DocumentState,
  kind: string,
  eventId: string,
  refs: Readonly<Record<string, string>> = {},
): EventEnvelope {
  return Object.freeze({
    schemaVersion: 1 as const,
    eventId,
    tenantId: state.ref.tenantId,
    documentId: state.ref.documentId,
    lifecycleGeneration: state.lifecycleGeneration,
    aggregateRevision: state.aggregateRevision,
    kind,
    occurredAt: context.now,
    correlationId: context.correlationId,
    operationId: context.operationId,
    refs: Object.freeze({ ...refs }),
  });
}

/** Builds, preflights and commits one atomic command. */
export async function submitCommand(
  store: DocumentStore,
  context: CommandContext,
  ref: DocumentRef,
  expectedAggregateRevision: number | null,
  actions: readonly CommandAction[],
): Promise<DocumentState> {
  const command: DocumentCommand = Object.freeze({
    ref,
    operationId: context.operationId,
    correlationId: context.correlationId,
    expectedAggregateRevision,
    actions: Object.freeze([...actions]),
  });
  preflightCommand(command);
  const result = await store.commit(command);
  return result.state;
}

/** Reads the head, reporting a missing or cross-tenant document as absence. */
export async function requireHead(
  store: DocumentStore,
  scope: Scope,
  ref: DocumentRef,
): Promise<DocumentState> {
  requireSameTenant(scope, ref);
  const state = await store.head(scope, ref);
  if (!state) throw DocumentError.notFound('document_not_found');
  return state;
}

export function assertExpectedRevision(state: DocumentState, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision)) throw DocumentError.invalidInput('expected_revision_invalid');
  if (state.aggregateRevision !== expectedRevision) {
    throw DocumentError.conflict('aggregate_revision_stale', {
      expected: expectedRevision,
      actual: state.aggregateRevision,
    });
  }
}

/**
 * Returns the current head when this operationId was already committed.
 *
 * Mutating services must consult this before their optimistic-concurrency
 * check: a retry carries the revision the caller originally read, which the
 * first attempt has since advanced. Without this the retry would report a
 * spurious conflict instead of the original outcome. Receipts are durable, so
 * this stays correct after any provider-side idempotency window expires.
 */
export async function replayedState(
  store: DocumentStore,
  scope: Scope,
  ref: DocumentRef,
  operationId: string,
): Promise<DocumentState | undefined> {
  const receipt = await store.receipt(scope, operationId);
  if (!receipt) return undefined;
  const state = await store.head(scope, ref);
  if (!state) throw DocumentError.notFound('document_not_found');
  return state;
}

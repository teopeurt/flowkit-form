import { requirePermission } from './access';
import { DocumentError } from './errors';
import {
  limits,
  requireCommandContext,
  requireIdentifier,
  requireIsoTimestamp,
  type ArtifactRef,
  type CommandContext,
  type DocumentRef,
  type DocumentState,
  type Hold,
  type Retention,
} from './model';
import {
  assertExpectedRevision,
  buildAudit,
  buildEvent,
  replayedState,
  requireHead,
  submitCommand,
  type DocumentStore,
} from './persistence';

/* ------------------------------------------------------------------ *
 * Row types owned by the lifecycle
 * ------------------------------------------------------------------ */

/**
 * A claim that a publication is in flight for an exact lifecycle generation.
 * Leases are individual paged rows, never an array on the head; the head
 * carries only the outstanding count.
 */
export type PublicationLease = Readonly<{
  id: string;
  versionId: string;
  lifecycleGeneration: number;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}>;

export type CleanupReason = 'deletion' | 'abandoned_publication' | 'superseded_generation';

/**
 * A durable obligation to remove bytes that the document no longer references.
 * Recorded before the bytes are orphaned so a failed commit leaves tracked
 * work rather than an untracked orphan.
 */
export type CleanupObligation = Readonly<{
  id: string;
  artifact: ArtifactRef;
  reason: CleanupReason;
  lifecycleGeneration: number;
  recordedAt: string;
  resolvedAt: string | null;
}>;

/* ------------------------------------------------------------------ *
 * Generation checks
 * ------------------------------------------------------------------ */

/**
 * Work that started before a deletion must not land after it. Any operation
 * carrying a generation other than the head's current one is stale.
 */
export function requireCurrentGeneration(state: DocumentState, lifecycleGeneration: number): void {
  if (!Number.isInteger(lifecycleGeneration)) {
    throw DocumentError.invalidInput('lifecycle_generation_invalid');
  }
  if (lifecycleGeneration !== state.lifecycleGeneration) {
    throw DocumentError.staleLifecycle('lifecycle_generation_stale', {
      expected: state.lifecycleGeneration,
      actual: lifecycleGeneration,
    });
  }
}

export function requireActive(state: DocumentState): void {
  if (state.status === 'deleted') throw DocumentError.notFound('document_deleted');
  if (state.status !== 'active') throw DocumentError.conflict('document_not_active');
}

/* ------------------------------------------------------------------ *
 * Holds
 * ------------------------------------------------------------------ */

export function parseHold(input: { id: unknown; reason: unknown }, at: string, by: string): Hold {
  return Object.freeze({
    id: requireIdentifier(input.id, 'hold_id_invalid'),
    reason: requireIdentifier(input.reason, 'hold_reason_invalid'),
    placedAt: requireIsoTimestamp(at, 'hold_placed_at_invalid'),
    placedBy: requireIdentifier(by, 'hold_placed_by_invalid'),
  });
}

export function placeHold(state: DocumentState, hold: Hold): readonly Hold[] {
  if (state.holds.some((existing) => existing.id === hold.id)) {
    throw DocumentError.conflict('hold_already_present');
  }
  if (state.holds.length >= limits.currentHolds) {
    throw DocumentError.invalidInput('hold_limit_exceeded', { limit: limits.currentHolds });
  }
  return Object.freeze([...state.holds, hold]);
}

export function releaseHold(state: DocumentState, holdId: string): readonly Hold[] {
  const next = state.holds.filter((hold) => hold.id !== holdId);
  if (next.length === state.holds.length) throw DocumentError.notFound('hold_not_found');
  return Object.freeze(next);
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * Retention may be extended but never shortened: a shorter window would let a
 * caller erase evidence that an earlier policy required be kept.
 */
export function applyRetention(state: DocumentState, retention: Retention): Retention {
  requireIsoTimestamp(retention.retainUntil, 'retention_until_invalid');
  const current = state.retention;
  if (current && Date.parse(retention.retainUntil) < Date.parse(current.retainUntil)) {
    throw DocumentError.retained('retention_cannot_shorten');
  }
  return Object.freeze(retention);
}

export function retentionBlocks(state: DocumentState, now: string): boolean {
  if (!state.retention) return false;
  return Date.parse(now) < Date.parse(state.retention.retainUntil);
}

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

/**
 * Deletion is blocked by holds first, then by retention. Order matters for the
 * reported code: a held document reports `held` even when also retained, since
 * releasing the hold is the actionable step.
 */
export function assertDeletable(state: DocumentState, now: string): void {
  if (state.status === 'deleted') throw DocumentError.notFound('document_deleted');
  if (state.holds.length > 0) {
    throw DocumentError.held('deletion_blocked_by_hold', { holds: state.holds.length });
  }
  if (retentionBlocks(state, now)) throw DocumentError.retained('deletion_blocked_by_retention');
}

/**
 * Completion requires that no publication can still be writing to this
 * document's content, and that every obligation recorded at deletion time has
 * been resolved.
 */
export function assertDeletionCompletable(state: DocumentState): void {
  if (state.status !== 'deleting') throw DocumentError.conflict('deletion_not_started');
  if (state.outstandingPublications > 0) {
    throw DocumentError.conflict('deletion_blocked_by_publication', {
      outstanding: state.outstandingPublications,
    });
  }
  if (state.outstandingCleanups > 0) {
    throw DocumentError.conflict('deletion_blocked_by_cleanup', { outstanding: state.outstandingCleanups });
  }
}

/* ------------------------------------------------------------------ *
 * Publication leases
 * ------------------------------------------------------------------ */

export function assertLeaseAcquirable(state: DocumentState): void {
  requireActive(state);
}

export function leaseExpired(lease: PublicationLease, now: string): boolean {
  return Date.parse(now) >= Date.parse(lease.expiresAt);
}

/**
 * A lease completes only against the generation it was acquired in. A lease
 * acquired before a deletion is stale afterwards, and its bytes become a
 * cleanup obligation rather than a published version.
 */
export function assertLeaseCompletable(state: DocumentState, lease: PublicationLease, now: string): void {
  requireCurrentGeneration(state, lease.lifecycleGeneration);
  if (leaseExpired(lease, now)) throw DocumentError.conflict('lease_expired');
}

/* ------------------------------------------------------------------ *
 * Lifecycle application services
 * ------------------------------------------------------------------ */

export type LifecycleDependencies = Readonly<{
  store: DocumentStore;
  newId?: () => string;
}>;

function identifiers(deps: LifecycleDependencies): () => string {
  return deps.newId ?? (() => crypto.randomUUID());
}

function target(context: CommandContext, documentId: string): DocumentRef {
  return Object.freeze({
    tenantId: context.tenantId,
    documentId: requireIdentifier(documentId, 'document_id_invalid'),
  });
}

export type HoldInput = Readonly<{
  documentId: string;
  expectedRevision: number;
  holdId: string;
  reason: string;
}>;

/** Places a hold. Holds block deletion until released; they do not block writes. */
export async function placeLegalHold(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: HoldInput,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  requireActive(current);
  requirePermission(current, context, 'delete', context.now);
  assertExpectedRevision(current, input.expectedRevision);

  const hold = parseHold({ id: input.holdId, reason: input.reason }, context.now, context.actorId);
  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    holds: placeHold(current, hold),
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-audit', record: buildAudit(context, state, 'hold.place', nextId(), { holdId: hold.id }) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'hold.placed', nextId(), { holdId: hold.id }) },
  ]);
}

export async function releaseLegalHold(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; holdId: string }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  requirePermission(current, context, 'delete', context.now);
  assertExpectedRevision(current, input.expectedRevision);

  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    holds: releaseHold(current, requireIdentifier(input.holdId, 'hold_id_invalid')),
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-audit', record: buildAudit(context, state, 'hold.release', nextId(), { holdId: input.holdId }) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'hold.released', nextId(), { holdId: input.holdId }) },
  ]);
}

export async function setRetention(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; policyId: string; retainUntil: string }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  requireActive(current);
  requirePermission(current, context, 'delete', context.now);
  assertExpectedRevision(current, input.expectedRevision);

  const retention = applyRetention(current, {
    policyId: requireIdentifier(input.policyId, 'retention_policy_invalid'),
    retainUntil: requireIsoTimestamp(input.retainUntil, 'retention_until_invalid'),
    setAt: context.now,
    setBy: context.actorId,
  });
  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    retention,
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-audit', record: buildAudit(context, state, 'retention.set', nextId()) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'retention.set', nextId()) },
  ]);
}

/**
 * Starts deletion: advances the lifecycle generation so in-flight work becomes
 * stale, and records a cleanup obligation for the current content before those
 * bytes stop being referenced.
 */
export async function beginDeletion(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; artifacts?: readonly ArtifactRef[] }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  requirePermission(current, context, 'delete', context.now);
  assertExpectedRevision(current, input.expectedRevision);
  assertDeletable(current, context.now);

  const artifacts = input.artifacts ?? [];
  const nextGeneration = current.lifecycleGeneration + 1;
  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    lifecycleGeneration: nextGeneration,
    status: 'deleting' as const,
    outstandingCleanups: current.outstandingCleanups + artifacts.length,
    updatedAt: context.now,
  });

  const obligations = artifacts.map((artifact) => ({
    kind: 'put-cleanup' as const,
    obligation: Object.freeze({
      id: nextId(),
      artifact,
      reason: 'deletion' as const,
      lifecycleGeneration: nextGeneration,
      recordedAt: context.now,
      resolvedAt: null,
    }),
  }));

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    ...obligations,
    { kind: 'put-audit', record: buildAudit(context, state, 'deletion.begin', nextId()) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'deletion.began', nextId()) },
  ]);
}

export async function completeDeletion(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  assertExpectedRevision(current, input.expectedRevision);
  assertDeletionCompletable(current);

  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    status: 'deleted' as const,
    currentVersionId: null,
    grants: Object.freeze([]),
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-audit', record: buildAudit(context, state, 'deletion.complete', nextId()) },
    { kind: 'put-event', envelope: buildEvent(context, state, 'deletion.completed', nextId()) },
  ]);
}

export async function acquirePublicationLease(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; versionId: string; expiresAt: string }>,
): Promise<Readonly<{ state: DocumentState; lease: PublicationLease }>> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  // No replay short-circuit here: this command returns a newly minted lease,
  // which a receipt alone cannot reconstruct. Retry it with a fresh
  // operationId; the lease it would have created expires on its own.
  const current = await requireHead(deps.store, context, ref);
  requirePermission(current, context, 'write', context.now);
  assertExpectedRevision(current, input.expectedRevision);
  assertLeaseAcquirable(current);

  const lease: PublicationLease = Object.freeze({
    id: nextId(),
    versionId: requireIdentifier(input.versionId, 'lease_version_invalid'),
    lifecycleGeneration: current.lifecycleGeneration,
    holder: context.actorId,
    acquiredAt: context.now,
    expiresAt: requireIsoTimestamp(input.expiresAt, 'lease_expires_at_invalid'),
  });
  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    outstandingPublications: current.outstandingPublications + 1,
    updatedAt: context.now,
  });

  const committed = await submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'put-lease', lease },
    { kind: 'put-audit', record: buildAudit(context, state, 'lease.acquire', nextId(), { leaseId: lease.id }) },
  ]);
  return Object.freeze({ state: committed, lease });
}

/**
 * Completes a lease. A lease from a superseded generation is rejected as stale
 * and its bytes become a cleanup obligation rather than published content.
 */
export async function completePublicationLease(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; lease: PublicationLease }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  assertExpectedRevision(current, input.expectedRevision);
  assertLeaseCompletable(current, input.lease, context.now);

  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    outstandingPublications: Math.max(0, current.outstandingPublications - 1),
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'delete-lease', leaseId: input.lease.id },
    { kind: 'put-audit', record: buildAudit(context, state, 'lease.complete', nextId(), { leaseId: input.lease.id }) },
  ]);
}

/** Abandons a lease whose generation is gone, converting it to tracked cleanup. */
export async function abandonPublicationLease(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; lease: PublicationLease; artifact: ArtifactRef }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  assertExpectedRevision(current, input.expectedRevision);

  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    outstandingPublications: Math.max(0, current.outstandingPublications - 1),
    outstandingCleanups: current.outstandingCleanups + 1,
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    { kind: 'delete-lease', leaseId: input.lease.id },
    {
      kind: 'put-cleanup',
      obligation: Object.freeze({
        id: nextId(),
        artifact: input.artifact,
        reason: 'abandoned_publication' as const,
        lifecycleGeneration: input.lease.lifecycleGeneration,
        recordedAt: context.now,
        resolvedAt: null,
      }),
    },
    { kind: 'put-audit', record: buildAudit(context, state, 'lease.abandon', nextId(), { leaseId: input.lease.id }) },
  ]);
}

export async function resolveCleanupObligation(
  deps: LifecycleDependencies,
  context: CommandContext,
  input: Readonly<{ documentId: string; expectedRevision: number; obligationId: string }>,
): Promise<DocumentState> {
  requireCommandContext(context);
  const nextId = identifiers(deps);
  const ref = target(context, input.documentId);
  const replayed = await replayedState(deps.store, context, ref, context.operationId);
  if (replayed) return replayed;

  const current = await requireHead(deps.store, context, ref);
  assertExpectedRevision(current, input.expectedRevision);
  if (current.outstandingCleanups <= 0) throw DocumentError.conflict('cleanup_none_outstanding');

  const state: DocumentState = Object.freeze({
    ...current,
    aggregateRevision: current.aggregateRevision + 1,
    outstandingCleanups: current.outstandingCleanups - 1,
    updatedAt: context.now,
  });

  return submitCommand(deps.store, context, ref, current.aggregateRevision, [
    { kind: 'put-head', state },
    {
      kind: 'resolve-cleanup',
      obligationId: requireIdentifier(input.obligationId, 'cleanup_id_invalid'),
      resolvedAt: context.now,
    },
    { kind: 'put-audit', record: buildAudit(context, state, 'cleanup.resolve', nextId()) },
  ]);
}

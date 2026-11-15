import { DocumentError } from './errors';
import {
  limits,
  requireIdentifier,
  requireIsoTimestamp,
  type DocumentState,
  type Grant,
  type Permission,
  type Principal,
  type Scope,
} from './model';

export const permissions = ['read', 'write', 'share', 'delete'] as const;

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (permissions as readonly string[]).includes(value);
}

export function parsePrincipal(input: { kind: unknown; id: unknown }): Principal {
  if (input.kind !== 'actor' && input.kind !== 'group') {
    throw DocumentError.invalidInput('principal_kind_invalid');
  }
  return Object.freeze({ kind: input.kind, id: requireIdentifier(input.id, 'principal_id_invalid') });
}

export function parseGrant(
  input: { id: unknown; principal: { kind: unknown; id: unknown }; permissions: unknown; expiresAt?: unknown },
  at: string,
  by: string,
): Grant {
  if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
    throw DocumentError.invalidInput('grant_permissions_required');
  }
  const granted: Permission[] = [];
  for (const permission of input.permissions) {
    if (!isPermission(permission)) throw DocumentError.invalidInput('grant_permission_unknown');
    if (!granted.includes(permission)) granted.push(permission);
  }

  const grant: Record<string, unknown> = {
    id: requireIdentifier(input.id, 'grant_id_invalid'),
    principal: parsePrincipal(input.principal),
    permissions: Object.freeze(granted.sort()),
    grantedAt: requireIsoTimestamp(at, 'grant_granted_at_invalid'),
    grantedBy: requireIdentifier(by, 'grant_granted_by_invalid'),
  };
  if (input.expiresAt !== undefined) {
    grant.expiresAt = requireIsoTimestamp(input.expiresAt, 'grant_expires_at_invalid');
  }
  return Object.freeze(grant) as Grant;
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

function grantApplies(grant: Grant, scope: Scope, now: string): boolean {
  if (grant.expiresAt !== undefined && Date.parse(now) >= Date.parse(grant.expiresAt)) return false;
  if (grant.principal.kind === 'actor') return grant.principal.id === scope.actorId;
  return scope.groupIds.includes(grant.principal.id);
}

/**
 * Current permissions for this scope, from explicit grants only.
 *
 * There is no implicit ownership: a document's creator holds permissions
 * because creation writes an explicit grant, not because of who they are. A
 * document in any non-active status grants nothing — deletion is terminal for
 * access, and `deleting` is not a window for further writes.
 */
export function evaluatePermissions(state: DocumentState, scope: Scope, now: string): ReadonlySet<Permission> {
  if (state.ref.tenantId !== scope.tenantId) return new Set();
  if (state.status !== 'active') return new Set();

  const held = new Set<Permission>();
  for (const grant of state.grants) {
    if (!grantApplies(grant, scope, now)) continue;
    for (const permission of grant.permissions) held.add(permission);
  }
  return held;
}

/**
 * Authorizes an operation, or throws.
 *
 * A caller with no permission at all on an existing document cannot
 * distinguish it from a missing one: both report `not_found`. `forbidden` is
 * reserved for a caller who demonstrably holds some access but not this one,
 * so the weaker signal never confirms existence to a prober.
 */
export function requirePermission(
  state: DocumentState,
  scope: Scope,
  permission: Permission,
  now: string,
): void {
  const held = evaluatePermissions(state, scope, now);
  if (held.has(permission)) return;
  if (held.size === 0) throw DocumentError.notFound('document_not_found');
  throw DocumentError.forbidden('permission_denied');
}

/* ------------------------------------------------------------------ *
 * Mutation of the bounded grant set
 * ------------------------------------------------------------------ */

export function addGrant(state: DocumentState, grant: Grant): readonly Grant[] {
  if (state.grants.some((existing) => existing.id === grant.id)) {
    throw DocumentError.conflict('grant_already_present');
  }
  if (state.grants.length >= limits.currentGrants) {
    throw DocumentError.invalidInput('grant_limit_exceeded', { limit: limits.currentGrants });
  }
  return Object.freeze([...state.grants, grant]);
}

export function removeGrant(state: DocumentState, grantId: string): readonly Grant[] {
  const next = state.grants.filter((grant) => grant.id !== grantId);
  if (next.length === state.grants.length) throw DocumentError.notFound('grant_not_found');
  if (!next.some((grant) => grant.permissions.includes('share'))) {
    // Removing the last share grant would leave the document unmanageable.
    throw DocumentError.conflict('grant_last_share_removal');
  }
  return Object.freeze(next);
}

/** Drops expired grants so the bounded head does not fill with dead entries. */
export function pruneExpiredGrants(state: DocumentState, now: string): readonly Grant[] {
  return Object.freeze(
    state.grants.filter((grant) => grant.expiresAt === undefined || Date.parse(now) < Date.parse(grant.expiresAt)),
  );
}

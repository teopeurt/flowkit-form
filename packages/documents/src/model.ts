import { DocumentError } from './errors';

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonArray = readonly JsonValue[];

/* ------------------------------------------------------------------ *
 * Implementation limits
 *
 * These are bounds this implementation enforces so a single command stays
 * inside provider transaction limits. They are not claims about user scale.
 * Collections (versions, metadata revisions, audit, leases, cleanup
 * obligations) are unbounded across paginated rows; only what one command
 * touches, and what the bounded head carries, is limited here.
 * ------------------------------------------------------------------ */

export const limits = {
  /** UTF-8 bytes of canonical metadata JSON. */
  metadataBytes: 64 * 1024,
  /** Grants carried on the bounded head. */
  currentGrants: 16,
  /** Holds carried on the bounded head. */
  currentHolds: 16,
  /** Persistence actions in one atomic command. */
  commandActions: 64,
  /** Encoded bytes of one atomic command. */
  commandBytes: 2 * 1024 * 1024,
  /** Defensive bound on any single identifier. */
  identifierLength: 256,
} as const;

/* ------------------------------------------------------------------ *
 * Scope and command context
 * ------------------------------------------------------------------ */

/**
 * Trusted caller identity, produced by an authentication adapter at the
 * service boundary. Never populate this from an HTTP body, query string or
 * client-supplied header: every authorization decision in this package
 * assumes tenantId, actorId and groupIds were established by the adapter.
 */
export type Scope = Readonly<{
  tenantId: string;
  actorId: string;
  groupIds: readonly string[];
}>;

/** A Scope plus the per-command identifiers and the caller's clock reading. */
export type CommandContext = Scope &
  Readonly<{
    operationId: string;
    correlationId: string;
    now: string;
  }>;

/* ------------------------------------------------------------------ *
 * References
 * ------------------------------------------------------------------ */

export type DocumentRef = Readonly<{ tenantId: string; documentId: string }>;

/** Identifies an exact, immutable sequence of stored bytes. */
export type ArtifactRef = Readonly<{ store: string; objectId: string; generation: string }>;

export type Checksum = Readonly<{ algorithm: 'sha256'; value: string }>;

/**
 * Output of a trusted verifier: the bytes at `artifact` were read in full and
 * hashed to `checksum`.
 *
 * SECURITY: this type is an assertion that verification already happened. No
 * public API may accept it from a caller as proof that content is verified —
 * only a verifier adapter inside the trust boundary may construct it.
 */
export type VerifiedContent = Readonly<{
  artifact: ArtifactRef;
  checksum: Checksum;
  mediaType: string;
  size: number;
  verificationId: string;
}>;

export type Version = Readonly<{
  id: string;
  content: VerifiedContent;
  createdAt: string;
  createdBy: string;
}>;

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

export type Association = Readonly<{ type: string; id: string }>;

export type Metadata = Readonly<{
  title: string;
  type?: string;
  tags: readonly string[];
  custom: JsonObject;
  issuer?: string;
  expiresAt?: string;
  associations: readonly Association[];
}>;

export type MetadataRevision = Readonly<{
  revision: number;
  values: Metadata;
  createdAt: string;
  createdBy: string;
}>;

/* ------------------------------------------------------------------ *
 * Head state
 * ------------------------------------------------------------------ */

export type DocumentStatus = 'active' | 'deleting' | 'deleted';

export type Permission = 'read' | 'write' | 'share' | 'delete';

export type Principal = Readonly<{ kind: 'actor' | 'group'; id: string }>;

export type Grant = Readonly<{
  id: string;
  principal: Principal;
  permissions: readonly Permission[];
  grantedAt: string;
  grantedBy: string;
  expiresAt?: string;
}>;

export type Hold = Readonly<{
  id: string;
  reason: string;
  placedAt: string;
  placedBy: string;
}>;

export type Retention = Readonly<{
  policyId: string;
  retainUntil: string;
  setAt: string;
  setBy: string;
}>;

/**
 * The bounded head. Immutable history (versions, metadata revisions, audit),
 * individual leases and cleanup obligations are separate paged rows and never
 * appear here as complete arrays.
 */
export type DocumentState = Readonly<{
  ref: DocumentRef;
  aggregateRevision: number;
  lifecycleGeneration: number;
  status: DocumentStatus;
  currentVersionId: string | null;
  currentMetadataRevision: number;
  grants: readonly Grant[];
  holds: readonly Hold[];
  retention: Retention | null;
  /** Publication leases issued and not yet completed or expired. */
  outstandingPublications: number;
  /** Cleanup obligations recorded and not yet resolved. */
  outstandingCleanups: number;
  createdAt: string;
  updatedAt: string;
}>;

/* ------------------------------------------------------------------ *
 * Primitive validation
 * ------------------------------------------------------------------ */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

function fail(reason: string): never {
  throw DocumentError.invalidInput(reason);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function requireIsoTimestamp(value: unknown, reason: string): string {
  if (!isIsoTimestamp(value)) fail(reason);
  return value;
}

export function requireIdentifier(value: unknown, reason: string): string {
  if (typeof value !== 'string') fail(reason);
  if (value.length === 0 || value.length > limits.identifierLength) fail(reason);
  // Control characters would corrupt composite storage keys.
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(reason);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], reason: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(reason);
  }
}

/* ------------------------------------------------------------------ *
 * JSON validation
 * ------------------------------------------------------------------ */

/**
 * Recursively validates string-keyed JSON. Rejects undefined, non-finite
 * numbers, functions, symbols, and any non-plain object (Date, Map, class
 * instances) — none of which survive a persistence round trip intact.
 */
export function parseJsonObject(input: unknown, reason = 'json_object_expected'): JsonObject {
  if (!isPlainObject(input)) fail(reason);
  return freezeJsonObject(input, reason, 0);
}

const MAX_JSON_DEPTH = 32;

function freezeJsonObject(input: Record<string, unknown>, reason: string, depth: number): JsonObject {
  if (depth > MAX_JSON_DEPTH) fail('json_too_deep');
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(input).sort()) {
    // Assigning these keys through a plain object literal would mutate the
    // prototype chain rather than store data.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('json_unsafe_key');
    output[key] = freezeJsonValue(input[key], reason, depth + 1);
  }
  return Object.freeze(output) as JsonObject;
}

function freezeJsonValue(value: unknown, reason: string, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) fail('json_too_deep');
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) fail('json_nonfinite_number');
      return value;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint
      fail(reason);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJsonValue(entry, reason, depth + 1))) as JsonArray;
  }
  if (isPlainObject(value)) return freezeJsonObject(value, reason, depth);
  fail(reason);
}

/** Deterministic encoding: object keys sorted, so byte sizes and receipts are stable. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as JsonObject)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key])}`);
  return `{${entries.join(',')}}`;
}

export function encodedBytes(value: JsonValue): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

const METADATA_KEYS = ['title', 'type', 'tags', 'custom', 'issuer', 'expiresAt', 'associations'] as const;

/**
 * Validates untrusted metadata input into a frozen, canonical Metadata value.
 * Unknown keys are rejected rather than dropped so a caller never believes a
 * field was stored when it was not.
 */
export function parseMetadata(input: unknown): Metadata {
  if (!isPlainObject(input)) fail('metadata_object_expected');
  rejectUnknownKeys(input, METADATA_KEYS, 'metadata_unknown_key');

  const title = input.title;
  if (typeof title !== 'string' || title.trim().length === 0) fail('metadata_title_required');
  if (title.length > limits.identifierLength * 4) fail('metadata_title_too_long');

  const tagsInput = input.tags ?? [];
  if (!Array.isArray(tagsInput)) fail('metadata_tags_invalid');
  const tags = tagsInput.map((tag) => {
    if (typeof tag !== 'string' || tag.length === 0) fail('metadata_tag_invalid');
    return tag;
  });

  const associationsInput = input.associations ?? [];
  if (!Array.isArray(associationsInput)) fail('metadata_associations_invalid');
  const associations = associationsInput.map((association) => {
    if (!isPlainObject(association)) fail('metadata_association_invalid');
    rejectUnknownKeys(association, ['type', 'id'], 'metadata_association_unknown_key');
    return Object.freeze({
      type: requireIdentifier(association.type, 'metadata_association_type_invalid'),
      id: requireIdentifier(association.id, 'metadata_association_id_invalid'),
    });
  });

  const custom = input.custom === undefined ? Object.freeze({}) : parseJsonObject(input.custom, 'metadata_custom_invalid');

  const metadata: Record<string, unknown> = {
    title,
    tags: Object.freeze(tags),
    custom,
    associations: Object.freeze(associations),
  };
  if (input.type !== undefined) metadata.type = requireIdentifier(input.type, 'metadata_type_invalid');
  if (input.issuer !== undefined) metadata.issuer = requireIdentifier(input.issuer, 'metadata_issuer_invalid');
  if (input.expiresAt !== undefined) {
    metadata.expiresAt = requireIsoTimestamp(input.expiresAt, 'metadata_expires_at_invalid');
  }

  const result = Object.freeze(metadata) as Metadata;
  if (encodedBytes(result as unknown as JsonObject) > limits.metadataBytes) fail('metadata_too_large');
  return result;
}

const VERIFIED_CONTENT_KEYS = ['artifact', 'checksum', 'mediaType', 'size', 'verificationId'] as const;

/**
 * Validates verifier output.
 *
 * SECURITY: successful parsing proves the value is well formed, never that
 * content was verified. Call this only on data produced inside the trust
 * boundary by a verifier adapter — never on a request body.
 */
export function parseVerifiedContent(input: unknown): VerifiedContent {
  if (!isPlainObject(input)) fail('content_object_expected');
  rejectUnknownKeys(input, VERIFIED_CONTENT_KEYS, 'content_unknown_key');

  const artifactInput = input.artifact;
  if (!isPlainObject(artifactInput)) fail('content_artifact_invalid');
  rejectUnknownKeys(artifactInput, ['store', 'objectId', 'generation'], 'content_artifact_unknown_key');
  const artifact: ArtifactRef = Object.freeze({
    store: requireIdentifier(artifactInput.store, 'content_artifact_store_invalid'),
    objectId: requireIdentifier(artifactInput.objectId, 'content_artifact_object_invalid'),
    generation: requireIdentifier(artifactInput.generation, 'content_artifact_generation_invalid'),
  });

  const checksumInput = input.checksum;
  if (!isPlainObject(checksumInput)) fail('content_checksum_invalid');
  rejectUnknownKeys(checksumInput, ['algorithm', 'value'], 'content_checksum_unknown_key');
  if (checksumInput.algorithm !== 'sha256') fail('content_checksum_algorithm_unsupported');
  if (typeof checksumInput.value !== 'string' || !SHA256_HEX.test(checksumInput.value)) {
    fail('content_checksum_value_invalid');
  }
  const checksum: Checksum = Object.freeze({ algorithm: 'sha256', value: checksumInput.value });

  if (typeof input.mediaType !== 'string' || !MEDIA_TYPE.test(input.mediaType)) fail('content_media_type_invalid');

  const size = input.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > Number.MAX_SAFE_INTEGER) {
    fail('content_size_invalid');
  }

  return Object.freeze({
    artifact,
    checksum,
    mediaType: input.mediaType,
    size,
    verificationId: requireIdentifier(input.verificationId, 'content_verification_id_invalid'),
  });
}

/* ------------------------------------------------------------------ *
 * Scope and context validation
 * ------------------------------------------------------------------ */

export function requireScope(scope: Scope): Scope {
  if (!isPlainObject(scope as unknown)) fail('scope_required');
  requireIdentifier(scope.tenantId, 'scope_tenant_required');
  requireIdentifier(scope.actorId, 'scope_actor_required');
  if (!Array.isArray(scope.groupIds)) fail('scope_groups_required');
  for (const groupId of scope.groupIds) requireIdentifier(groupId, 'scope_group_invalid');
  return scope;
}

export function requireCommandContext(context: CommandContext): CommandContext {
  requireScope(context);
  requireIdentifier(context.operationId, 'context_operation_required');
  requireIdentifier(context.correlationId, 'context_correlation_required');
  requireIsoTimestamp(context.now, 'context_now_invalid');
  return context;
}

/** Cross-tenant access is reported as absence, never as a permission failure. */
export function requireSameTenant(scope: Scope, ref: DocumentRef): DocumentRef {
  if (scope.tenantId !== ref.tenantId) throw DocumentError.notFound('document_not_found');
  return ref;
}

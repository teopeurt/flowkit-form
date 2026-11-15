import {
  parseVerifiedContent,
  type CommandContext,
  type Scope,
  type VerifiedContent,
} from '@flowkitform/documents';

import { MemoryDocumentStore } from '../support/memory-document-store';

export const tenantA = 'tenant-a';
export const tenantB = 'tenant-b';

export function scope(overrides: Partial<Scope> = {}): Scope {
  return { tenantId: tenantA, actorId: 'actor-1', groupIds: [], ...overrides };
}

/** Deterministic identifiers and clock so assertions are exact. */
export function harness(options: { pageSize?: number } = {}) {
  const store = new MemoryDocumentStore(options);
  let ids = 0;
  let operations = 0;
  let seconds = 0;

  const newId = () => `id-${String(++ids).padStart(3, '0')}`;
  const at = (offsetSeconds?: number) =>
    new Date(Date.UTC(2026, 10, 15, 0, 0, offsetSeconds ?? seconds++)).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const context = (overrides: Partial<CommandContext> = {}): CommandContext => ({
    ...scope(),
    operationId: `op-${String(++operations).padStart(3, '0')}`,
    correlationId: 'corr-1',
    now: at(),
    ...overrides,
  });

  return { store, deps: { store, newId }, context, at, newId };
}

export function verifiedContent(overrides: Partial<VerifiedContent> = {}): VerifiedContent {
  return parseVerifiedContent({
    artifact: { store: 'memory', objectId: 'object-1', generation: 'gen-1' },
    checksum: { algorithm: 'sha256', value: 'b'.repeat(64) },
    mediaType: 'application/pdf',
    size: 2048,
    verificationId: 'verification-1',
    ...overrides,
  });
}

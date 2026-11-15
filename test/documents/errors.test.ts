import { describe, expect, it } from 'bun:test';

import { DocumentError, type DocumentErrorCode } from '@flowkitform/documents';

const codes: readonly DocumentErrorCode[] = [
  'invalid_input',
  'not_found',
  'forbidden',
  'conflict',
  'held',
  'retained',
  'stale_lifecycle',
];

describe('DocumentError', () => {
  it('exposes every documented code with a stable message', () => {
    for (const code of codes) {
      const error = new DocumentError(code, 'some_reason');
      expect(error.code).toBe(code);
      expect(error.name).toBe('DocumentError');
      expect(error.message).toMatch(/^[A-Z].*\(some_reason\)$/);
    }
  });

  it('keeps caller data out of messages', () => {
    const secret = 'tenant-acme/patient-91/ssn-123-45-6789';
    const error = DocumentError.notFound(secret);

    expect(error.message).not.toContain(secret);
    expect(error.reason).toBe('unspecified');
  });

  it('accepts only lowercase token reasons', () => {
    expect(DocumentError.conflict('aggregate_revision_stale').reason).toBe('aggregate_revision_stale');
    expect(DocumentError.conflict('Has Spaces').reason).toBe('unspecified');
    expect(DocumentError.conflict('a'.repeat(100)).reason).toBe('unspecified');
  });

  it('carries numeric context only', () => {
    const error = DocumentError.conflict('aggregate_revision_stale', {
      expected: 4,
      actual: 7,
      leaked: 'secret' as unknown as number,
      bad: Number.NaN,
    });

    expect(error.context).toEqual({ expected: 4, actual: 7 });
    expect(Object.isFrozen(error.context)).toBe(true);
  });

  it('round-trips a safe representation', () => {
    const error = DocumentError.staleLifecycle('lifecycle_generation_stale', { expected: 2, actual: 1 });

    expect(error.toSafeJSON()).toEqual({
      code: 'stale_lifecycle',
      reason: 'lifecycle_generation_stale',
      context: { expected: 2, actual: 1 },
    });
  });

  it('narrows by code through the type guard', () => {
    const error: unknown = DocumentError.held('deletion_blocked_by_hold');

    expect(DocumentError.is(error)).toBe(true);
    expect(DocumentError.is(error, 'held')).toBe(true);
    expect(DocumentError.is(error, 'forbidden')).toBe(false);
    expect(DocumentError.is(new Error('plain'))).toBe(false);
  });
});

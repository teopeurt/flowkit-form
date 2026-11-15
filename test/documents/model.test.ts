import { describe, expect, it } from 'bun:test';

import {
  DocumentError,
  canonicalJson,
  limits,
  parseJsonObject,
  parseMetadata,
  parseVerifiedContent,
  requireScope,
} from '@flowkitform/documents';

function expectCode(run: () => unknown, code: string, reason?: string) {
  try {
    run();
  } catch (error) {
    expect(DocumentError.is(error)).toBe(true);
    expect((error as DocumentError).code).toBe(code as never);
    if (reason) expect((error as DocumentError).reason).toBe(reason);
    return;
  }
  throw new Error('expected the call to reject');
}

describe('parseMetadata', () => {
  it('normalizes a minimal document to frozen, canonical values', () => {
    const metadata = parseMetadata({ title: 'Certificate' });

    expect(metadata).toEqual({ title: 'Certificate', tags: [], custom: {}, associations: [] });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.tags)).toBe(true);
  });

  it('keeps optional fields only when supplied', () => {
    const metadata = parseMetadata({
      title: 'Insurance',
      type: 'policy',
      issuer: 'acme',
      expiresAt: '2027-01-01T00:00:00Z',
      tags: ['a', 'b'],
      associations: [{ type: 'application', id: 'app-1' }],
      custom: { nested: { ok: true }, count: 3 },
    });

    expect(metadata.type).toBe('policy');
    expect(metadata.custom).toEqual({ count: 3, nested: { ok: true } });
    expect(metadata.associations).toEqual([{ type: 'application', id: 'app-1' }]);
    expect('issuer' in parseMetadata({ title: 'x' })).toBe(false);
  });

  it.each([
    [{}, 'metadata_title_required'],
    [{ title: '   ' }, 'metadata_title_required'],
    [{ title: 'x', nope: 1 }, 'metadata_unknown_key'],
    [{ title: 'x', tags: 'a' }, 'metadata_tags_invalid'],
    [{ title: 'x', tags: [1] }, 'metadata_tag_invalid'],
    [{ title: 'x', expiresAt: '2027-01-01' }, 'metadata_expires_at_invalid'],
    [{ title: 'x', associations: [{ type: 'a' }] }, 'metadata_association_id_invalid'],
    [{ title: 'x', custom: [1, 2] }, 'metadata_custom_invalid'],
  ])('rejects invalid metadata %#', (input, reason) => {
    expectCode(() => parseMetadata(input), 'invalid_input', reason as string);
  });

  it('rejects metadata beyond the encoded size limit', () => {
    const big = { title: 'x', custom: { blob: 'y'.repeat(limits.metadataBytes) } };
    expectCode(() => parseMetadata(big), 'invalid_input', 'metadata_too_large');
  });
});

describe('parseJsonObject', () => {
  it.each([
    [{ fn: () => 1 }],
    [{ when: new Date() }],
    [{ nope: undefined }],
    [{ big: Number.POSITIVE_INFINITY }],
    [{ nan: Number.NaN }],
    [{ sym: Symbol('s') }],
  ])('rejects non-JSON value %#', (input) => {
    expect(() => parseJsonObject(input as never)).toThrow(DocumentError);
  });

  it('rejects prototype-polluting keys', () => {
    expectCode(() => parseJsonObject(JSON.parse('{"__proto__":{"x":1}}')), 'invalid_input', 'json_unsafe_key');
  });

  it('accepts nested JSON and freezes it deeply', () => {
    const value = parseJsonObject({ a: [1, { b: 'c' }], d: null, e: false });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
  });

  it('produces key-order independent canonical encodings', () => {
    expect(canonicalJson(parseJsonObject({ b: 1, a: 2 }))).toBe(canonicalJson(parseJsonObject({ a: 2, b: 1 })));
  });
});

describe('parseVerifiedContent', () => {
  const valid = {
    artifact: { store: 's3', objectId: 'obj', generation: 'gen-1' },
    checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    mediaType: 'application/pdf',
    size: 1024,
    verificationId: 'ver-1',
  } as const;

  it('accepts well-formed verifier output', () => {
    expect(parseVerifiedContent(valid)).toEqual(valid);
  });

  it.each([
    [{ ...valid, checksum: { algorithm: 'md5', value: 'a'.repeat(32) } }, 'content_checksum_algorithm_unsupported'],
    [{ ...valid, checksum: { algorithm: 'sha256', value: 'A'.repeat(64) } }, 'content_checksum_value_invalid'],
    [{ ...valid, checksum: { algorithm: 'sha256', value: 'a'.repeat(63) } }, 'content_checksum_value_invalid'],
    [{ ...valid, size: -1 }, 'content_size_invalid'],
    [{ ...valid, size: 1.5 }, 'content_size_invalid'],
    [{ ...valid, mediaType: 'not-a-media-type' }, 'content_media_type_invalid'],
    [{ ...valid, artifact: { store: 's3', objectId: 'obj' } }, 'content_artifact_generation_invalid'],
    [{ ...valid, extra: true }, 'content_unknown_key'],
  ])('rejects malformed verifier output %#', (input, reason) => {
    expectCode(() => parseVerifiedContent(input), 'invalid_input', reason as string);
  });
});

describe('requireScope', () => {
  it('accepts a trusted scope', () => {
    expect(requireScope({ tenantId: 't', actorId: 'a', groupIds: [] })).toBeDefined();
  });

  it.each([
    [{ tenantId: '', actorId: 'a', groupIds: [] }],
    [{ tenantId: 't', actorId: '', groupIds: [] }],
    [{ tenantId: 't', actorId: 'a', groupIds: 'nope' }],
    [{ tenantId: 't\u0000x', actorId: 'a', groupIds: [] }],
  ])('rejects malformed scope %#', (scope) => {
    expect(() => requireScope(scope as never)).toThrow(DocumentError);
  });
});

/**
 * Stable error codes. These are part of the package's public contract: adapters
 * map them to transport status codes, and callers branch on them.
 */
export type DocumentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'held'
  | 'retained'
  | 'stale_lifecycle';

/**
 * One fixed, non-sensitive sentence per code. Messages never interpolate
 * caller data, document content, metadata values, identifiers or tenant
 * information, so an error is always safe to return across a trust boundary
 * and safe to log.
 */
const MESSAGES: Readonly<Record<DocumentErrorCode, string>> = {
  invalid_input: 'The request was not valid.',
  not_found: 'The document does not exist.',
  forbidden: 'The actor is not permitted to perform this operation.',
  conflict: 'The document changed since it was read.',
  held: 'The document is under a hold.',
  retained: 'The document is within its retention period.',
  stale_lifecycle: 'The document lifecycle generation has advanced.',
};

/**
 * A short machine token naming the specific rule that failed, e.g.
 * `metadata_too_large`. Constrained to a fixed shape so no free text — and
 * therefore no caller data — can reach a message.
 */
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** Numeric context only: revisions, generations, counts, sizes. Never strings. */
export type SafeContext = Readonly<Record<string, number>>;

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly reason: string;
  readonly context: SafeContext;

  constructor(code: DocumentErrorCode, reason: string, context: SafeContext = {}) {
    const safeReason = REASON.test(reason) ? reason : 'unspecified';
    super(`${MESSAGES[code]} (${safeReason})`);
    this.name = 'DocumentError';
    this.code = code;
    this.reason = safeReason;
    this.context = Object.freeze(sanitizeContext(context));
  }

  static invalidInput(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('invalid_input', reason, context);
  }

  static notFound(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('not_found', reason, context);
  }

  static forbidden(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('forbidden', reason, context);
  }

  static conflict(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('conflict', reason, context);
  }

  static held(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('held', reason, context);
  }

  static retained(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('retained', reason, context);
  }

  static staleLifecycle(reason: string, context?: SafeContext): DocumentError {
    return new DocumentError('stale_lifecycle', reason, context);
  }

  static is(error: unknown, code?: DocumentErrorCode): error is DocumentError {
    return error instanceof DocumentError && (code === undefined || error.code === code);
  }

  /** The complete safe representation; nothing else about the error is disclosable. */
  toSafeJSON(): { code: DocumentErrorCode; reason: string; context: SafeContext } {
    return { code: this.code, reason: this.reason, context: this.context };
  }
}

function sanitizeContext(context: SafeContext): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REASON.test(key) && typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
    }
  }
  return output;
}

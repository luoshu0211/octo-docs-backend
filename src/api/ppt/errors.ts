/**
 * Fixed HTTP-status-to-code map. The first ten codes are C's enum verbatim; the
 * eleventh (`UNSUPPORTED_DOCUMENT_TYPE`) is the PPT-specific addition. C maps
 * `UPSTREAM_UNAVAILABLE` to 502/503 — B pins the single canonical 502 for the
 * outbound status line while still accepting either upstream.
 */
export const PPT_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNSUPPORTED_DOCUMENT_TYPE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_UNAVAILABLE: 502,
} as const

export type PptErrorCode = keyof typeof PPT_ERROR_STATUS

/**
 * The subset of {@link PptErrorCode} that exists in C's `errorEnum`. Kept as an
 * explicit list so a contract test can assert that PPT adds EXACTLY
 * `UNSUPPORTED_DOCUMENT_TYPE` on top of the ported C codes — no silent drift.
 */
export const C_PORTED_ERROR_CODES: readonly PptErrorCode[] = [
  'VALIDATION_ERROR',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'UPSTREAM_UNAVAILABLE',
]

/** The PPT-only additions on top of the C-ported enum. */
export const PPT_ONLY_ERROR_CODES: readonly PptErrorCode[] = ['UNSUPPORTED_DOCUMENT_TYPE']

/** Shape of the `error` object inside a failure envelope. */
export interface PptErrorBody {
  code: PptErrorCode
  message: string
  details?: unknown
  hint?: string
}

/** Cursor pagination block on a list envelope (PRD §4.1 — NOT C's offset shape). */
export interface PptCursorPagination {
  /** Opaque cursor for the next page, or null when there is no next page. */
  nextCursor: string | null
  /** True when another page exists (i.e. `nextCursor` is non-null). */
  hasMore: boolean
}

export interface PptErrorOptions {
  details?: unknown
  hint?: string
}

/**
 * A typed PPT API failure. Handlers throw this (or call {@link sendPptError}
 * directly); the router-scoped {@link pptErrorHandler} renders it as the failure
 * envelope with the enum's fixed HTTP status. Carrying the code (not the status)
 * keeps the HTTP status a pure function of the enum.
 */
export class PptApiError extends Error {
  readonly code: PptErrorCode
  readonly httpStatus: number
  readonly details?: unknown
  readonly hint?: string

  constructor(code: PptErrorCode, message: string, opts: PptErrorOptions = {}) {
    super(message)
    this.name = 'PptApiError'
    this.code = code
    this.httpStatus = PPT_ERROR_STATUS[code]
    if (opts.details !== undefined) this.details = opts.details
    if (opts.hint !== undefined) this.hint = opts.hint
  }

  /** Convenience factory for the PPT-specific wrong-kind failure (422). */
  static unsupportedDocumentType(message = 'document type does not support this operation', opts: PptErrorOptions = {}): PptApiError {
    return new PptApiError('UNSUPPORTED_DOCUMENT_TYPE', message, opts)
  }
}

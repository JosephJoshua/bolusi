// Error-envelope mapping (api/00 §6–§7). Every transport-level failure becomes exactly
// `{ error: { code, message, details? } }` with the §7 registry code for its HTTP status.
// `message` is developer-facing English (§6) — never shown raw to users; clients map `code`
// through the label catalog (07-i18n).
//
// HTTP errors ≠ op rejections (§6): per-op rejection codes travel INSIDE a 200 push body
// (05-operation-log §8) — they never reach this file.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { type HttpErrorCode } from '@bolusi/schemas';

import type { AppEnv } from './env.js';

/** The single source of truth for code → HTTP status (api/00 §7). Constructing an ApiError
 *  looks the status up here, so a code can never be paired with the wrong status. */
const CODE_STATUS: Record<HttpErrorCode, ContentfulStatusCode> = {
  MALFORMED_REQUEST: 400,
  AUTH_TOKEN_MISSING: 401,
  AUTH_TOKEN_INVALID: 401,
  DEVICE_REVOKED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  BODY_TOO_LARGE: 413,
  DECOMPRESSED_TOO_LARGE: 413,
  UNSUPPORTED_ENCODING: 415,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Static English developer messages (api/00 §6). Not localized, not user-facing. */
const CODE_MESSAGE: Record<HttpErrorCode, string> = {
  MALFORMED_REQUEST: 'Malformed request',
  AUTH_TOKEN_MISSING: 'Authentication required',
  AUTH_TOKEN_INVALID: 'Invalid or expired token',
  DEVICE_REVOKED: 'Device revoked',
  PERMISSION_DENIED: 'Permission denied',
  NOT_FOUND: 'Not found',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflict',
  BODY_TOO_LARGE: 'Request body too large',
  DECOMPRESSED_TOO_LARGE: 'Decompressed body too large',
  UNSUPPORTED_ENCODING: 'Unsupported content encoding',
  VALIDATION_FAILED: 'Validation failed',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Internal server error',
};

export type ErrorDetails = Record<string, unknown>;

/**
 * A transport-level failure carrying its §7 registry code. Thrown by middleware/handlers and
 * mapped to the envelope by `onError` (app.ts). The status is derived from the code, never
 * passed separately — the two cannot drift.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: HttpErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: HttpErrorCode, details?: ErrorDetails) {
    super(CODE_MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = CODE_STATUS[code];
    this.details = details;
  }
}

/** Writes the §6 envelope onto the response. Also stamps `Retry-After` for `RATE_LIMITED`
 *  (§11: mandatory on every 429), reading the seconds from the details the caller supplied. */
export function respondError(
  c: Context<AppEnv>,
  code: HttpErrorCode,
  details?: ErrorDetails,
): Response {
  const status = CODE_STATUS[code];
  if (code === 'RATE_LIMITED' && typeof details?.['retryAfterSeconds'] === 'number') {
    c.header('Retry-After', String(details['retryAfterSeconds']));
  }
  const error =
    details === undefined
      ? { code, message: CODE_MESSAGE[code] }
      : { code, message: CODE_MESSAGE[code], details };
  return c.json({ error }, status);
}

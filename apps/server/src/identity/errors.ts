// Identity-surface error codes (api/02-auth §10) that are NOT in the api/00 §7 transport registry
// (@bolusi/schemas HttpErrorCode) — AUTH_INVALID_CREDENTIALS, SESSION_EXPIRED, ACTING_USER_INVALID,
// ENROLL_DEVICE_ID_TAKEN, ENROLL_KEY_REUSED, LAST_ADMIN_PROTECTED. The shared registry + task 12's
// `onError` only know the transport codes, so these are emitted via a small per-handler wrapper
// rather than a thrown ApiError (which would map to the wrong code). The §6 envelope's `code` is an
// open string (schemas `zErrorEnvelope`), so the shape is fully conformant.
//
// Thrown INSIDE a forTenant tx, so a rollback happens before the envelope is written — a
// LAST_ADMIN_PROTECTED or ENROLL_* failure leaves no partial state.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AppEnv } from '../env.js';

export type IdentityErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'SESSION_EXPIRED'
  | 'ACTING_USER_INVALID'
  | 'ENROLL_DEVICE_ID_TAKEN'
  | 'ENROLL_KEY_REUSED'
  | 'LAST_ADMIN_PROTECTED'
  // Not in api/02-auth §10's table (a documented gap flagged to task 31): the globally-unique
  // loginIdentifier constraint (§2, §5.4) needs a 409 code; the acceptance permits "409/422".
  | 'LOGIN_IDENTIFIER_TAKEN';

const STATUS: Record<IdentityErrorCode, ContentfulStatusCode> = {
  AUTH_INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  ACTING_USER_INVALID: 403,
  ENROLL_DEVICE_ID_TAKEN: 409,
  ENROLL_KEY_REUSED: 409,
  LAST_ADMIN_PROTECTED: 409,
  LOGIN_IDENTIFIER_TAKEN: 409,
};

const MESSAGE: Record<IdentityErrorCode, string> = {
  AUTH_INVALID_CREDENTIALS: 'Invalid credentials',
  SESSION_EXPIRED: 'Control session expired or unknown',
  ACTING_USER_INVALID: 'Acting user missing, unknown, or not usable on this device',
  ENROLL_DEVICE_ID_TAKEN: 'Device id already registered',
  ENROLL_KEY_REUSED: 'Public key already registered',
  LAST_ADMIN_PROTECTED: 'Would leave the tenant with no active administrator',
  LOGIN_IDENTIFIER_TAKEN: 'Login identifier already in use',
};

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: IdentityErrorCode, details?: Record<string, unknown>) {
    super(MESSAGE[code]);
    this.name = 'IdentityError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Run `fn`; on an `IdentityError` write the §6 envelope with the surface code + status. Anything
 * else (ApiError, unexpected throws) propagates to task 12's onError untouched.
 */
export async function withIdentityErrors(
  c: Context<AppEnv>,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IdentityError) {
      const error =
        err.details === undefined
          ? { code: err.code, message: MESSAGE[err.code] }
          : { code: err.code, message: MESSAGE[err.code], details: err.details };
      return c.json({ error }, STATUS[err.code]);
    }
    throw err;
  }
}

// Identity-surface errors (api/02-auth §10) — thrown from the identity endpoints and mapped to the
// §6 envelope.
//
// NOT A SECOND CODE REGISTRY (task 33; CLAUDE.md §2.8). Since task 33 these codes are members of the
// ONE `@bolusi/schemas` HTTP_ERROR_CODES registry (the `respondError` call below proves it at compile
// time — see IdentityErrorCode), and their status + developer message come from the single
// `CODE_STATUS` / `CODE_MESSAGE` maps in ../errors.js, written through the shared `respondError`. So
// the envelope is ONE path: an
// `IdentityError` and an `ApiError` construct the same `{ error: { code, message, details? } }` from
// the same maps. This wrapper stays as the identity surface's error BOUNDARY — it catches an
// IdentityError thrown INSIDE a forTenant tx (so the rollback happens before the envelope is written)
// and hands the envelope to the shared writer; any other throw (ApiError, unexpected) propagates to
// task 12's onError untouched.
//
// There is no `SESSION_EXPIRED`: an elapsed or unknown control session maps to `AUTH_TOKEN_INVALID`
// (api/02-auth §10; task 12's verifyToken) — one token-invalidity vocabulary, and a distinct
// expired-vs-invalid code is an attacker oracle.
import type { Context } from 'hono';

import { respondError, type ErrorDetails } from '../errors.js';
import type { AppEnv } from '../env.js';

/**
 * The api/02-auth §10 identity-surface codes — a subset of the shared HTTP_ERROR_CODES registry.
 * The §2.8 guarantee is enforced by USE, not a separate assertion: `withIdentityErrors` passes
 * `err.code` (this type) to `respondError(code: HttpErrorCode)`, so if any member below is NOT in the
 * shared registry, `IdentityErrorCode` stops being assignable to `HttpErrorCode` and that call is a
 * compile error — these codes can never become a second, diverging vocabulary. `LOGIN_IDENTIFIER_TAKEN`
 * covers the globally-unique `loginIdentifier` constraint (api/02-auth §2, §5.4).
 */
export type IdentityErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'ACTING_USER_INVALID'
  | 'ENROLL_DEVICE_ID_TAKEN'
  | 'ENROLL_KEY_REUSED'
  | 'LAST_ADMIN_PROTECTED'
  | 'LOGIN_IDENTIFIER_TAKEN';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: IdentityErrorCode, details?: ErrorDetails) {
    super(code);
    this.name = 'IdentityError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Run `fn`; on an `IdentityError` write the §6 envelope via the shared `respondError` (the single
 * code→status + code→message source, ../errors.js). Anything else (ApiError, unexpected throws)
 * propagates to task 12's onError untouched.
 *
 * Thrown INSIDE a forTenant tx, so a rollback happens before the envelope is written — a
 * LAST_ADMIN_PROTECTED or ENROLL_* failure leaves no partial state.
 */
export async function withIdentityErrors(
  c: Context<AppEnv>,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IdentityError) {
      return respondError(c, err.code, err.details);
    }
    throw err;
  }
}

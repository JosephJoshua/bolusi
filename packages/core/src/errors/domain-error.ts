// DomainError — the typed error every command precondition and runtime-internal state
// machine throws (04-module-contract §5.2–5.3, 03-state-machines §12). The `code` is the
// contract; user-facing copy is resolved from the label catalog key `core.errors.<CODE>`
// (07-i18n) — `message` here is developer-facing diagnostic text only, never rendered.
//
// This is a SEPARATE namespace from the server push-rejection codes (05 §8,
// @bolusi/schemas `RejectionCode`): the two must never be mixed (03-state-machines §12).

/**
 * The closed DomainError code registry (04-module-contract §5.3). Adding a code is a spec
 * change to 04 §5.3 first — encoded once here so both runtimes share one definition
 * (CLAUDE.md §2.8). `NETWORK` is client transport only.
 */
export const DOMAIN_ERROR_CODES = [
  'INVALID_TRANSITION',
  'PERMISSION_DENIED',
  'VALIDATION_FAILED',
  'ENTITY_NOT_FOUND',
  'NOT_AUTHENTICATED',
  'DEVICE_NOT_ENROLLED',
  'USER_DEACTIVATED',
  'PIN_RATE_LIMITED',
  'PIN_LOCKED',
  'LAST_ADMIN_PROTECTED',
  'ROLE_IN_USE',
  'NETWORK',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** Structured, machine-readable context — e.g. `{ machine, from, event }` for a bad transition. */
export type DomainErrorDetails = Readonly<Record<string, unknown>>;

/**
 * A typed domain error.
 *
 * Constructed `(code, details?, message?)`:
 *  - `code` is the closed-registry code — the sole thing UI copy is keyed on (04 §5.3).
 *  - `details` is structured context surfaced to logs/telemetry (03 §12's `details` column).
 *  - `message` is optional developer text; it defaults to `code` + serialized details so a
 *    stack trace is legible without ever standing in for the localized user string.
 */
export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: DomainErrorCode;
  readonly details?: DomainErrorDetails;

  constructor(code: DomainErrorCode, details?: DomainErrorDetails, message?: string) {
    super(message ?? (details ? `${code} ${JSON.stringify(details)}` : code));
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

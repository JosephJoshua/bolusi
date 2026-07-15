// Checked-in mirror of the closed code registries the coverage gate checks (07-i18n §7.3).
//
// TODO(task-10): task 10 lands the real `DomainError` code registry in @bolusi/core. When it
// does, replace DOMAIN_ERROR_CODES with an import of that registry so this file cannot drift —
// the whole point of the gate is that adding a code without its catalog row fails the build,
// which only holds if the code list has a single source of truth.
//
// Until then these lists are transcribed from the specs and pinned by a unit test that
// re-reads the docs, so drift fails CI rather than passing silently.

/** 04-module-contract §5.3 — the closed DomainError set. */
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
];

/**
 * Transport error codes surfaced through the same `core.errors.*` derivation
 * (api/00-conventions §8.2 / §11), plus the mandatory UNEXPECTED fallback (07-i18n §4.2).
 */
export const TRANSPORT_ERROR_CODES = ['IDEMPOTENCY_CONFLICT', 'RATE_LIMITED'];
export const FALLBACK_ERROR_CODE = 'UNEXPECTED';

/** 05-operation-log §8 — the closed rejection-code set. */
export const REJECTION_CODES = [
  'BAD_SIGNATURE',
  'CHAIN_BROKEN',
  'CHAIN_GAP',
  'CHAIN_HALTED',
  'DEVICE_REVOKED',
  'SCHEMA_INVALID',
  'SCOPE_VIOLATION',
  'UNKNOWN_TYPE',
];

/** Every code that must have a `core.errors.<CODE>` row. */
export const ALL_ERROR_CODES = [
  ...DOMAIN_ERROR_CODES,
  ...TRANSPORT_ERROR_CODES,
  FALLBACK_ERROR_CODE,
];

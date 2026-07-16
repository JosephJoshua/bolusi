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

/**
 * api/03-media §8 — the media surface's own machine codes, surfaced through the SAME
 * `core.errors.<CODE>` derivation (06-media-pipeline §8: "Every `failed` item is visible in the
 * sync-status screen with its `lastErrorCode` mapped to label-catalog copy"). Added task 18.
 *
 * These ride `core.errors.*` rather than a `media.errors.*` namespace for two reasons, and the
 * second one is a hard constraint rather than a preference: (1) 07-i18n §4.3's derived-error
 * exception — "the final segment of `core.errors.*` is the SCREAMING_SNAKE code verbatim, so the
 * key is mechanically derivable from the code — no hand-written mapping table may exist" — is
 * exactly the property the drain loop needs, since it must surface codes it does not recognise
 * (api/00 §4). (2) That exception is scoped to `core.*`; `media.errors.HASH_MISMATCH` would FAIL
 * the §3.1 key-grammar gate, whose general branch requires every segment to be camelCase.
 *
 * `DEVICE_REVOKED` and `RATE_LIMITED` are deliberately absent: they already have rows via
 * REJECTION_CODES and TRANSPORT_ERROR_CODES respectively, and one code gets one row.
 * `VALIDATION_FAILED` likewise already ships in DOMAIN_ERROR_CODES.
 *
 * `LOCAL_CORRUPT` and `NETWORK` are CLIENT-ORIGINATED, never on the wire: the server cannot know
 * our file rotted (06 §5.1) or that the socket dropped. They are surfaced through the same column.
 * (`NETWORK` already ships in DOMAIN_ERROR_CODES.)
 */
export const MEDIA_ERROR_CODES = [
  'MEDIA_NOT_FOUND',
  'MEDIA_IMMUTABLE',
  'INIT_MISMATCH',
  'MEDIA_TOO_LARGE',
  'CHUNK_TOO_LARGE',
  'UNSUPPORTED_ENCODING',
  'MIME_UNSUPPORTED',
  'CHUNK_INDEX_INVALID',
  'CHUNK_SIZE_INVALID',
  'CHUNKS_MISSING',
  'HASH_MISMATCH',
  'MIME_MISMATCH',
  'STORAGE_ERROR',
  'LOCAL_CORRUPT',
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_INVALID',
];

/** Every code that must have a `core.errors.<CODE>` row. */
export const ALL_ERROR_CODES = [
  ...DOMAIN_ERROR_CODES,
  ...TRANSPORT_ERROR_CODES,
  ...MEDIA_ERROR_CODES,
  FALLBACK_ERROR_CODE,
];

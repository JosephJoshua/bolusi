// HTTP error envelope + code registry (api/00-conventions §6–7.1).
// HTTP errors ≠ op rejections: per-op rejection codes travel inside 200 push
// responses (./rejection-codes.ts); this file is transport-level failure only.
import { z } from 'zod';

import { zUuidV7 } from './primitives.js';

/** The full §7 registry — all thirteen codes. Additions are spec changes to api/00 first. */
export const HTTP_ERROR_CODES = [
  'MALFORMED_REQUEST',
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_INVALID',
  'DEVICE_REVOKED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'BODY_TOO_LARGE',
  'DECOMPRESSED_TOO_LARGE',
  'UNSUPPORTED_ENCODING',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const zHttpErrorCode = z.enum(HTTP_ERROR_CODES);
export type HttpErrorCode = z.infer<typeof zHttpErrorCode>;

/**
 * Error envelope (api/00 §6) — response-direction: tolerant. `error.code` is an
 * OPEN string: unknown codes must parse and are treated as non-retryable and
 * surfaced generically (api/00 §4). `message` is developer-facing English, never
 * shown raw to users — clients map `code` through the label catalog (07-i18n).
 */
export const zErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.looseObject({}).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof zErrorEnvelope>;

/**
 * 422 VALIDATION_FAILED issue (api/00 §7.1): mapped from ZodError.issues as
 * path/code/message and NOTHING else — strict, so Zod internals (e.g. the
 * `input` echo; payloads may hold sensitive data) can never leak through.
 */
export const zValidationIssue = z.strictObject({
  path: z.array(z.union([z.string(), z.number().int()])),
  code: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof zValidationIssue>;

export const zValidationFailedDetails = z.strictObject({
  issues: z.array(zValidationIssue),
});
export type ValidationFailedDetails = z.infer<typeof zValidationFailedDetails>;

/** 413 details (api/00 §5.3/§7): the exceeded cap in bytes. */
export const zLimitBytesDetails = z.strictObject({
  limitBytes: z.number().int().min(1),
});
export type LimitBytesDetails = z.infer<typeof zLimitBytesDetails>;

export const zBodyTooLargeDetails = zLimitBytesDetails;
export const zDecompressedTooLargeDetails = zLimitBytesDetails;

/** 429 details (api/00 §7/§11): mirrors the mandatory Retry-After header. */
export const zRateLimitedDetails = z.strictObject({
  retryAfterSeconds: z.number().int().min(0),
});
export type RateLimitedDetails = z.infer<typeof zRateLimitedDetails>;

/** 500 details (api/00 §7): the per-request UUIDv7 echoed from X-Request-Id. */
export const zInternalDetails = z.strictObject({
  requestId: zUuidV7,
});
export type InternalDetails = z.infer<typeof zInternalDetails>;

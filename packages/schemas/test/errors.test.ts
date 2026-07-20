import { describe, expect, test } from 'vitest';

import {
  HTTP_ERROR_CODES,
  zBodyTooLargeDetails,
  zDecompressedTooLargeDetails,
  zErrorEnvelope,
  zHttpErrorCode,
  zInternalDetails,
  zRateLimitedDetails,
  zValidationFailedDetails,
} from '../src/index.js';

describe('HTTP error-code registry (api/00 §7)', () => {
  test('the code set is exactly the registry union — api/00 §7 transport + api/02-auth §10 identity surface', () => {
    expect([...HTTP_ERROR_CODES].sort()).toEqual(
      [
        // api/00 §7 transport
        'AUTH_TOKEN_INVALID',
        'AUTH_TOKEN_MISSING',
        'BODY_TOO_LARGE',
        'DECOMPRESSED_TOO_LARGE',
        'DEVICE_REVOKED',
        'IDEMPOTENCY_CONFLICT',
        'INTERNAL',
        'MALFORMED_REQUEST',
        'NOT_FOUND',
        'PERMISSION_DENIED',
        'RATE_LIMITED',
        'UNSUPPORTED_ENCODING',
        'VALIDATION_FAILED',
        // api/02-auth §10 identity surface (task 33). No SESSION_EXPIRED — maps to AUTH_TOKEN_INVALID.
        'ACTING_USER_INVALID',
        'AUTH_INVALID_CREDENTIALS',
        'ENROLL_DEVICE_ID_TAKEN',
        'ENROLL_KEY_REUSED',
        'LAST_ADMIN_PROTECTED',
        'LOGIN_IDENTIFIER_TAKEN',
      ].sort(),
    );
  });

  test('SESSION_EXPIRED is not a registry code (maps to AUTH_TOKEN_INVALID — api/02-auth §10)', () => {
    expect(zHttpErrorCode.safeParse('SESSION_EXPIRED').success).toBe(false);
    expect([...HTTP_ERROR_CODES]).not.toContain('SESSION_EXPIRED');
  });

  test('the known-code enum excludes codes outside the registry', () => {
    expect(zHttpErrorCode.safeParse('QUOTA_EXCEEDED').success).toBe(false);
  });
});

describe('error envelope (api/00 §6) — response-direction: tolerant', () => {
  test('a registry-coded envelope parses', () => {
    const result = zErrorEnvelope.safeParse({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    expect(result.success).toBe(true);
  });

  test('an envelope with an unknown code still parses (forward compat, api/00 §4)', () => {
    const result = zErrorEnvelope.safeParse({
      error: { code: 'FUTURE_CODE', message: 'from a newer server' },
    });
    expect(result.success).toBe(true);
  });

  test('an envelope with an extra unknown field still parses', () => {
    const result = zErrorEnvelope.safeParse({
      error: { code: 'NOT_FOUND', message: 'no such entity', traceId: 'abc-123' },
      meta: { region: 'idn' },
    });
    expect(result.success).toBe(true);
  });

  test('an envelope without message fails', () => {
    expect(zErrorEnvelope.safeParse({ error: { code: 'INTERNAL' } }).success).toBe(false);
  });
});

describe('per-code details shapes (api/00 §7 + §7.1)', () => {
  test('VALIDATION_FAILED issues round-trip', () => {
    const details = {
      issues: [
        { path: ['ops', 3, 'payload', 'title'], code: 'too_small', message: 'too short' },
        { path: ['deviceId'], code: 'invalid_format', message: 'not a uuid' },
      ],
    };
    const result = zValidationFailedDetails.safeParse(details);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(details);
    }
  });

  test('a validation issue carrying anything beyond path/code/message fails (no Zod internals leak)', () => {
    const result = zValidationFailedDetails.safeParse({
      issues: [{ path: ['payload'], code: 'custom', message: 'nope', input: 'SECRET' }],
    });
    expect(result.success).toBe(false);
  });

  test('a validation issue path element outside string|number fails', () => {
    const result = zValidationFailedDetails.safeParse({
      issues: [{ path: [Symbol('k')], code: 'custom', message: 'bad path' }],
    });
    expect(result.success).toBe(false);
  });

  test('BODY_TOO_LARGE limitBytes round-trips', () => {
    const details = { limitBytes: 1048576 };
    const result = zBodyTooLargeDetails.safeParse(details);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(details);
    }
  });

  test('DECOMPRESSED_TOO_LARGE limitBytes round-trips', () => {
    const details = { limitBytes: 10485760 };
    const result = zDecompressedTooLargeDetails.safeParse(details);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(details);
    }
  });

  test('a non-integer limitBytes fails', () => {
    expect(zBodyTooLargeDetails.safeParse({ limitBytes: '1MiB' }).success).toBe(false);
  });

  test('RATE_LIMITED retryAfterSeconds round-trips', () => {
    const details = { retryAfterSeconds: 30 };
    const result = zRateLimitedDetails.safeParse(details);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(details);
    }
  });

  test('INTERNAL requestId round-trips', () => {
    const details = { requestId: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5acc' };
    const result = zInternalDetails.safeParse(details);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(details);
    }
  });
});

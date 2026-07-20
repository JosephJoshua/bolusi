// Adversarial tests for the auth DTOs moved into @bolusi/schemas (task 33). The PIN verifier is a
// SECURITY SURFACE (SEC-AUTH-01 server leg): its bounds are the DoS guard that stops a hostile
// verifier from reaching a verifying device, and the byte-length checks were reimplemented
// platform-free (no Buffer) in the move, so this suite pins the accept/reject decision at the edges
// (security-guide §5; CLAUDE.md §2.5 — adversarial tests before review).
//
// The FIXTURES are built platform-free too (no Buffer, no node globals): @bolusi/schemas is
// platform-free (08 §3.3) and its typecheck has no `node` types, so this test file must not name
// Buffer. `b64OfBytes` synthesises a valid padded base64 string that decodes to exactly `bytes`
// bytes — which is all the schema's byte-length DoS check keys on (the string length + padding).
import { describe, expect, test } from 'vitest';

import { CreateUserReq, EnrollReq, PinVerifierSchema } from '../src/index.js';

/**
 * A standard padded base64 string (RFC 4648 §4) decoding to exactly `bytes` bytes, built without
 * Buffer. Body char is 'A' (base64 zero); only the LENGTH matters to the schema's `b64ByteLength`
 * check. Matches the arithmetic `auth.ts` uses: `(len / 4) * 3 - pad`.
 */
function b64OfBytes(bytes: number): string {
  const rem = bytes % 3; // 0 → no pad, 1 → "==", 2 → "="
  const pad = rem === 0 ? '' : rem === 1 ? '==' : '=';
  const groups = Math.ceil(bytes / 3);
  return 'A'.repeat(groups * 4 - pad.length) + pad;
}

const salt16 = b64OfBytes(16); // 24 chars "…=="
const hash32 = b64OfBytes(32); // 44 chars "…="
const key32 = b64OfBytes(32);
const NIL = '00000000-0000-0000-0000-000000000000';

const VALID_VERIFIER = {
  algorithm: 'argon2id' as const,
  saltB64: salt16,
  mKiB: 19456,
  t: 2,
  p: 1 as const,
  hashB64: hash32,
  asOf: { timestamp: 1, deviceId: NIL, seq: 0 },
};

describe('PinVerifierSchema — SEC-AUTH-01 server-leg DoS guard', () => {
  test('a well-formed verifier at the lower bound passes (positive control)', () => {
    expect(PinVerifierSchema.safeParse(VALID_VERIFIER).success).toBe(true);
    // ...and at the upper argon2 bound.
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, mKiB: 65536, t: 4 }).success).toBe(
      true,
    );
  });

  test('the hostile memory cost the guard exists for (mKiB = 1048576) is rejected', () => {
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, mKiB: 1048576 }).success).toBe(false);
    // just past each bound, both directions
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, mKiB: 19455 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, mKiB: 65537 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, t: 1 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, t: 5 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, p: 2 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, algorithm: 'scrypt' }).success).toBe(
      false,
    );
  });

  test('the platform-free byte-length check rejects wrong-sized salt/hash (16 / 32 bytes exactly)', () => {
    const salt15 = b64OfBytes(15);
    const salt17 = b64OfBytes(17);
    const hash31 = b64OfBytes(31);
    const hash33 = b64OfBytes(33);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, saltB64: salt15 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, saltB64: salt17 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, hashB64: hash31 }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, hashB64: hash33 }).success).toBe(false);
    // A non-base64 / empty string is not 16 bytes either.
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, saltB64: '' }).success).toBe(false);
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, saltB64: 'not base64!' }).success).toBe(
      false,
    );
  });

  test('.strict rejects an unknown key, and a malformed asOf deviceId is rejected', () => {
    expect(PinVerifierSchema.safeParse({ ...VALID_VERIFIER, extra: true }).success).toBe(false);
    expect(
      PinVerifierSchema.safeParse({
        ...VALID_VERIFIER,
        asOf: { timestamp: 1, deviceId: 'ABCDEF', seq: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('EnrollReq — 32-byte public key + non-nil ids', () => {
  const base = {
    deviceId: '11111111-1111-4111-8111-111111111111',
    devicePublicKeyB64: key32,
    storeId: '22222222-2222-4222-8222-222222222222',
    deviceName: 'Till 1',
    platform: 'android' as const,
    appVersion: '1.0.0',
  };
  test('a valid request passes; a 31-byte key and the nil deviceId are rejected', () => {
    expect(EnrollReq.safeParse(base).success).toBe(true);
    expect(EnrollReq.safeParse({ ...base, devicePublicKeyB64: b64OfBytes(31) }).success).toBe(
      false,
    );
    expect(EnrollReq.safeParse({ ...base, deviceId: NIL }).success).toBe(false);
  });
});

describe('CreateUserReq — password requires a loginIdentifier (api/02-auth §5.4)', () => {
  const store = '22222222-2222-4222-8222-222222222222';
  const role = '33333333-3333-4333-8333-333333333333';
  test('password without a loginIdentifier is rejected; with one it passes', () => {
    expect(
      CreateUserReq.safeParse({
        name: 'A',
        loginIdentifier: null,
        password: 'longenoughpw',
        storeIds: [store],
        roleIds: [role],
        pinVerifier: null,
      }).success,
    ).toBe(false);
    expect(
      CreateUserReq.safeParse({
        name: 'A',
        loginIdentifier: 'alice',
        password: 'longenoughpw',
        storeIds: [store],
        roleIds: [role],
        pinVerifier: null,
      }).success,
    ).toBe(true);
  });
});

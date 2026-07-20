// Adversarial tests for the auth DTOs moved into @bolusi/schemas (task 33). The PIN verifier is a
// SECURITY SURFACE (SEC-AUTH-01 server leg): its bounds are the DoS guard that stops a hostile
// verifier from reaching a verifying device, and the byte-length checks were reimplemented
// platform-free (no Buffer) in the move, so this suite pins the accept/reject decision at the edges
// (security-guide §5; CLAUDE.md §2.5 — adversarial tests before review).
//
// The TEST may use Buffer to synthesise exact-length base64 (it runs on Node, is never shipped to
// Hermes); the SCHEMA under test uses no Buffer.
import { describe, expect, test } from 'vitest';

import { CreateUserReq, EnrollReq, PinVerifierSchema } from '../src/index.js';

const salt16 = Buffer.alloc(16, 1).toString('base64'); // 24 chars "…=="
const hash32 = Buffer.alloc(32, 2).toString('base64'); // 44 chars "…="
const key32 = Buffer.alloc(32, 3).toString('base64');
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
    const salt15 = Buffer.alloc(15, 1).toString('base64');
    const salt17 = Buffer.alloc(17, 1).toString('base64');
    const hash31 = Buffer.alloc(31, 2).toString('base64');
    const hash33 = Buffer.alloc(33, 2).toString('base64');
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
    expect(
      EnrollReq.safeParse({ ...base, devicePublicKeyB64: Buffer.alloc(31).toString('base64') })
        .success,
    ).toBe(false);
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

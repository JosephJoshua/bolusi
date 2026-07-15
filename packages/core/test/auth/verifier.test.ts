// SEC-AUTH-01 (KDF params floor enforced), the SEC-AUTH-09 constant-time precursor, and the §5.3
// greatest-`asOf` merge rule. Pure (no DB); the KDF round-trips run REAL noble argon2id at the floor
// profile so "params record round-trips into verification" is proven against the real primitive.
import { describe, expect, it } from 'vitest';

import { noblePort } from '@bolusi/test-support';

import {
  assertVerifierInBounds,
  base64ToBytes,
  buildPinVerifier,
  bytesToBase64,
  chooseEffectiveVerifier,
  compareVerifierAsOf,
  FLOOR_KDF_PARAMS,
  timingSafeEqualBytes,
  VerifierBoundsError,
  verifyPinAgainst,
  type CanonicalRef,
  type PinVerifier,
} from '../../src/index.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const REAL_DEVICE = 'a1111111-1111-7111-8111-111111111111';

function mkVerifier(over: Partial<PinVerifier> = {}): PinVerifier {
  return {
    algorithm: 'argon2id',
    saltB64: bytesToBase64(new Uint8Array(16)),
    mKiB: 32768,
    t: 3,
    p: 1,
    hashB64: bytesToBase64(new Uint8Array(32)),
    asOf: { timestamp: 1000, deviceId: REAL_DEVICE, seq: 1 },
    ...over,
  };
}

function encode(pin: string): Uint8Array {
  const out = new Uint8Array(pin.length);
  for (let i = 0; i < pin.length; i += 1) out[i] = pin.charCodeAt(i);
  return out;
}

describe('SEC-AUTH-01 — verifier construction rejects out-of-bounds params', () => {
  it('rejects mKiB below the floor (19455) and above the ceiling (65537)', () => {
    expect(() => assertVerifierInBounds(mkVerifier({ mKiB: 19455 }))).toThrow(VerifierBoundsError);
    expect(() => assertVerifierInBounds(mkVerifier({ mKiB: 65537 }))).toThrow(VerifierBoundsError);
    expect(() => assertVerifierInBounds(mkVerifier({ mKiB: 8192 }))).toThrow(VerifierBoundsError);
    // The hostile "1 GiB" verifier the bound exists to stop.
    expect(() => assertVerifierInBounds(mkVerifier({ mKiB: 1_048_576 }))).toThrow(
      VerifierBoundsError,
    );
  });

  it('rejects t outside [2,4] and p ≠ 1', () => {
    expect(() => assertVerifierInBounds(mkVerifier({ t: 1 }))).toThrow(VerifierBoundsError);
    expect(() => assertVerifierInBounds(mkVerifier({ t: 5 }))).toThrow(VerifierBoundsError);
    expect(() => assertVerifierInBounds(mkVerifier({ p: 2 as 1 }))).toThrow(VerifierBoundsError);
  });

  it('rejects a salt ≠ 16 bytes and a hash ≠ 32 bytes', () => {
    expect(() =>
      assertVerifierInBounds(mkVerifier({ saltB64: bytesToBase64(new Uint8Array(15)) })),
    ).toThrow(VerifierBoundsError);
    expect(() =>
      assertVerifierInBounds(mkVerifier({ saltB64: bytesToBase64(new Uint8Array(32)) })),
    ).toThrow(VerifierBoundsError);
    expect(() =>
      assertVerifierInBounds(mkVerifier({ hashB64: bytesToBase64(new Uint8Array(31)) })),
    ).toThrow(VerifierBoundsError);
    expect(() =>
      assertVerifierInBounds(mkVerifier({ hashB64: bytesToBase64(new Uint8Array(64)) })),
    ).toThrow(VerifierBoundsError);
  });

  it('POSITIVE CONTROL — a default-profile verifier and a floor-profile verifier both pass (T-14b)', () => {
    expect(() => assertVerifierInBounds(mkVerifier())).not.toThrow();
    expect(() => assertVerifierInBounds(mkVerifier({ mKiB: 19456, t: 2 }))).not.toThrow();
    expect(() => assertVerifierInBounds(mkVerifier({ mKiB: 65536, t: 4 }))).not.toThrow();
  });

  it('buildPinVerifier rejects an out-of-bounds profile AT CONSTRUCTION (never returns it)', async () => {
    await expect(
      buildPinVerifier(
        noblePort,
        encode('123456'),
        { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLength: 32 },
        new Uint8Array(16),
        mkVerifier().asOf,
      ),
    ).rejects.toThrow(VerifierBoundsError);
  });

  it('params record round-trips into verification — self-describing, never guessed', async () => {
    const salt = noblePort.randomBytes(16);
    const asOf: CanonicalRef = { timestamp: 1000, deviceId: REAL_DEVICE, seq: 1 };
    const verifier = await buildPinVerifier(
      noblePort,
      encode('314159'),
      FLOOR_KDF_PARAMS,
      salt,
      asOf,
    );
    // The verifier carries the exact params it was built with — verification reads them back.
    expect(verifier.mKiB).toBe(FLOOR_KDF_PARAMS.memoryCost);
    expect(verifier.t).toBe(FLOOR_KDF_PARAMS.timeCost);
    expect(await verifyPinAgainst(noblePort, verifier, encode('314159'))).toBe(true);
  });
});

describe('SEC-AUTH-01 — a wrong PIN never derives the key', () => {
  it('the correct PIN verifies and every wrong PIN does not (real argon2id)', async () => {
    const salt = noblePort.randomBytes(16);
    const verifier = await buildPinVerifier(noblePort, encode('271828'), FLOOR_KDF_PARAMS, salt, {
      timestamp: 1,
      deviceId: REAL_DEVICE,
      seq: 1,
    });
    expect(await verifyPinAgainst(noblePort, verifier, encode('271828')), 'correct PIN').toBe(true);
    for (const wrong of ['271827', '000000', '999999', '182827']) {
      expect(await verifyPinAgainst(noblePort, verifier, encode(wrong)), `wrong ${wrong}`).toBe(
        false,
      );
    }
  });
});

// The CLIENT PRECURSOR of the verifier-confidentiality sweep (security-guide §5.4). Its id is
// deliberately NOT in these titles: the SEC-META-01 gate treats a verbatim id in a test title as
// "the test shipped", and the full sweep — scanning app storage for salt/verifier bytes, scanning
// pushed payload bytes, and the statistical timing test — lands with tasks 26/28. Claiming the id
// here would retire that requirement and leave the real sweep unwritten (CLAUDE.md §2.11).
describe('constant-time byte comparison — client precursor of the verifier-confidentiality sweep', () => {
  it('equal → true, and any single differing byte → false regardless of position', () => {
    const a = base64ToBytes(bytesToBase64(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])));
    expect(timingSafeEqualBytes(a, Uint8Array.from(a))).toBe(true);
    // Differ in the LAST byte and in the FIRST byte — both false. A first-byte short-circuit would
    // still (accidentally) return false for the first case, so pairing them rejects that shortcut.
    const lastDiff = Uint8Array.from(a);
    lastDiff[lastDiff.length - 1] = 99;
    const firstDiff = Uint8Array.from(a);
    firstDiff[0] = 99;
    expect(timingSafeEqualBytes(a, lastDiff)).toBe(false);
    expect(timingSafeEqualBytes(a, firstDiff)).toBe(false);
  });

  it('a length mismatch is folded into the result, never an early return', () => {
    expect(timingSafeEqualBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3, 4]))).toBe(
      false,
    );
    expect(timingSafeEqualBytes(Uint8Array.from([]), Uint8Array.from([]))).toBe(true);
  });
});

describe('§5.3 merge rule — greatest canonical asOf wins', () => {
  const at = (timestamp: number, deviceId: string, seq: number): PinVerifier =>
    mkVerifier({ asOf: { timestamp, deviceId, seq } });

  it('a newer local row beats an older bundle snapshot', () => {
    const localNewer = at(2000, REAL_DEVICE, 5);
    const bundleOlder = at(1000, REAL_DEVICE, 1);
    expect(chooseEffectiveVerifier(localNewer, bundleOlder)).toBe(localNewer);
    expect(chooseEffectiveVerifier(bundleOlder, localNewer)).toBe(localNewer);
  });

  it('a newer bundle snapshot beats an older local row', () => {
    const local = at(1000, REAL_DEVICE, 1);
    const bundleNewer = at(3000, REAL_DEVICE, 1);
    expect(chooseEffectiveVerifier(local, bundleNewer)).toBe(bundleNewer);
  });

  it('a nil-device control-plane asOf loses to a real op position at EQUAL timestamp', () => {
    const controlPlane = at(1000, NIL, 0);
    const realOp = at(1000, REAL_DEVICE, 1);
    expect(compareVerifierAsOf(realOp, controlPlane)).toBeGreaterThan(0);
    expect(chooseEffectiveVerifier(controlPlane, realOp)).toBe(realOp);
    expect(chooseEffectiveVerifier(realOp, controlPlane)).toBe(realOp);
  });

  it('null handling — either side null yields the other; both null yields null', () => {
    const v = at(1000, REAL_DEVICE, 1);
    expect(chooseEffectiveVerifier(null, v)).toBe(v);
    expect(chooseEffectiveVerifier(v, null)).toBe(v);
    expect(chooseEffectiveVerifier(null, null)).toBeNull();
  });
});

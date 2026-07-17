import { describe, expect, test } from 'vitest';

import { noblePort } from '../crypto/noble-port.js';
import { deriveDeviceKeypair } from './keypair.js';

/** Independent oracle for `SHA-256(harnessSeed ‖ deviceIndex)` — big-endian uint32 each (T-13). */
function expectedSeed(harnessSeed: number, deviceIndex: number): Uint8Array {
  const input = new Uint8Array(8);
  new DataView(input.buffer).setUint32(0, harnessSeed >>> 0, false);
  new DataView(input.buffer).setUint32(4, deviceIndex >>> 0, false);
  return noblePort.sha256(input);
}

describe('deriveDeviceKeypair — SHA-256(harnessSeed ‖ deviceIndex) → Ed25519 (§3.1)', () => {
  test('the RFC 8032 seed is exactly SHA-256(harnessSeed ‖ deviceIndex), 32 bytes', () => {
    const kp = deriveDeviceKeypair(12345, 2);
    expect(kp.seed).toEqual(expectedSeed(12345, 2));
    expect(kp.seed).toHaveLength(32);
  });

  test('the public key is the Ed25519 public key of that seed, 32 bytes', () => {
    const kp = deriveDeviceKeypair(12345, 2);
    expect(kp.publicKey).toEqual(noblePort.ed25519GetPublicKey(expectedSeed(12345, 2)));
    expect(kp.publicKey).toHaveLength(32);
  });

  test('reproducible: identical keys per (harnessSeed, deviceIndex) across calls (RFC 8032 determinism)', () => {
    const a = deriveDeviceKeypair(999, 0);
    const b = deriveDeviceKeypair(999, 0);
    expect(a.seed).toEqual(b.seed);
    expect(a.publicKey).toEqual(b.publicKey);
  });

  test('distinct deviceIndex within one harness → distinct keys', () => {
    const d0 = deriveDeviceKeypair(999, 0);
    const d1 = deriveDeviceKeypair(999, 1);
    expect(d0.seed).not.toEqual(d1.seed);
    expect(d0.publicKey).not.toEqual(d1.publicKey);
  });

  test('distinct harnessSeed → distinct keys for the same deviceIndex', () => {
    const h1 = deriveDeviceKeypair(1, 0);
    const h2 = deriveDeviceKeypair(2, 0);
    expect(h1.publicKey).not.toEqual(h2.publicKey);
  });

  test('positive control: a signature made with the seed verifies under the public key (real, usable keypair)', () => {
    const kp = deriveDeviceKeypair(777, 3);
    const message = new TextEncoder().encode('chaos-harness op body');
    const sig = noblePort.sign(message, kp.seed);
    expect(noblePort.verify(sig, message, kp.publicKey)).toBe(true);
    // Negative arm: a DIFFERENT device's key must NOT verify it.
    const other = deriveDeviceKeypair(777, 4);
    expect(noblePort.verify(sig, message, other.publicKey)).toBe(false);
  });
});

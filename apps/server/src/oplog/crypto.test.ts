// The server CryptoPort against the shared RFC 8032 / SHA-256 golden vectors, and against noble (the
// Node test port) in both directions. The port moved from noble to `node:crypto` for push throughput, so
// these pin that the signatures it accepts and produces are byte-for-byte the ones every other binding
// agrees on.
import { bytesToHex, hexToBytes, utf8ToBytes } from '@bolusi/core';
import {
  ed25519Vectors,
  mulberry32,
  noblePort,
  randomBytes,
  sha256Vectors,
} from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

import { serverCryptoPort as port } from './crypto.js';

describe('serverCryptoPort against the shared vectors', () => {
  it.each(sha256Vectors)('reproduces the $name SHA-256 digest', ({ messageUtf8, digestHex }) => {
    expect(bytesToHex(port.sha256(utf8ToBytes(messageUtf8)))).toBe(digestHex);
  });

  it.each(ed25519Vectors)('derives, signs and verifies $name byte-for-byte', (vector) => {
    const seed = hexToBytes(vector.seedHex);
    const message = hexToBytes(vector.messageHex);
    const keypair = port.ed25519Keygen(seed);
    expect(bytesToHex(keypair.secretKey)).toBe(vector.seedHex);
    expect(bytesToHex(keypair.publicKey)).toBe(vector.publicKeyHex);
    expect(bytesToHex(port.ed25519GetPublicKey(seed))).toBe(vector.publicKeyHex);
    expect(bytesToHex(port.sign(message, seed))).toBe(vector.signatureHex);
    expect(port.verify(hexToBytes(vector.signatureHex), message, keypair.publicKey)).toBe(true);
  });

  it.each(ed25519Vectors)('rejects the $name signature under a foreign key', (vector) => {
    const foreign = port.ed25519GetPublicKey(new Uint8Array(32).fill(9));
    expect(
      port.verify(hexToBytes(vector.signatureHex), hexToBytes(vector.messageHex), foreign),
    ).toBe(false);
  });
});

describe('serverCryptoPort agrees with noble on op-shaped digests', () => {
  const prng = mulberry32(28_918_074);
  const cases = Array.from({ length: 24 }, () => ({
    seed: randomBytes(prng, 32),
    digest: randomBytes(prng, 32),
  }));

  it('verifies what noble signs, and noble verifies what it signs', () => {
    for (const { seed, digest } of cases) {
      const publicKey = noblePort.ed25519GetPublicKey(seed);
      expect(bytesToHex(port.ed25519GetPublicKey(seed))).toBe(bytesToHex(publicKey));
      expect(port.verify(noblePort.sign(digest, seed), digest, publicKey)).toBe(true);
      expect(noblePort.verify(port.sign(digest, seed), digest, publicKey)).toBe(true);
    }
  });

  it('rejects a signature with one flipped bit, or over a different digest', () => {
    for (const { seed, digest } of cases) {
      const publicKey = port.ed25519GetPublicKey(seed);
      const signature = port.sign(digest, seed);
      const flipped = Uint8Array.from(signature);
      flipped[prng() < 0.5 ? 0 : 63]! ^= 0x01;
      const other = Uint8Array.from(digest);
      other[0]! ^= 0x80;
      expect(port.verify(flipped, digest, publicKey)).toBe(false);
      expect(port.verify(signature, other, publicKey)).toBe(false);
    }
  });

  it('returns false rather than throwing on malformed input (port contract)', () => {
    const vector = ed25519Vectors[0]!;
    const publicKey = hexToBytes(vector.publicKeyHex);
    expect(port.verify(new Uint8Array(0), new Uint8Array(0), publicKey)).toBe(false);
    expect(
      port.verify(hexToBytes(vector.signatureHex), new Uint8Array(0), new Uint8Array(31)),
    ).toBe(false);
    expect(port.verify(new Uint8Array(65), new Uint8Array(32), publicKey)).toBe(false);
  });

  it('copies a caller-supplied seed and mints distinct unseeded keys', () => {
    const seed = hexToBytes(ed25519Vectors[0]!.seedHex);
    const { secretKey } = port.ed25519Keygen(seed);
    seed.fill(0);
    expect(bytesToHex(secretKey)).toBe(ed25519Vectors[0]!.seedHex);

    const a = port.ed25519Keygen();
    const b = port.ed25519Keygen();
    expect(a.secretKey).toHaveLength(32);
    expect(bytesToHex(a.secretKey)).not.toBe(bytesToHex(b.secretKey));
    expect(bytesToHex(port.ed25519GetPublicKey(a.secretKey))).toBe(bytesToHex(a.publicKey));
  });
});

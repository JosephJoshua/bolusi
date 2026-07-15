// CI stage 7 — Ed25519 interop, the Node side of the quick-crypto <-> noble RFC 8032
// contract (08-stack-and-repo §5.6; testing-guide §2.2).
//
// Direction 1 (here): noble reproduces every published vector byte-for-byte.
// Direction 2 (device lane / stage 12, task 27): quick-crypto reproduces the SAME file
// and cross-verifies noble-produced signatures.
//
// Both directions read ONE fixture file, which is what makes "RFC 8032-interoperable"
// checkable rather than asserted. Ed25519 is deterministic, so signatures are directly
// byte-comparable — no "both are valid" hand-waving.
import { bytesToHex, hexToBytes, utf8ToBytes, DEFAULT_KDF_PARAMS } from '@bolusi/core';
import { describe, expect, it } from 'vitest';

import { noblePort } from './noble-port.js';
import { argon2idVectors, ed25519Vectors, sha256Vectors } from './vectors.js';

describe('noblePort — SHA-256 vectors', () => {
  it.each(sha256Vectors)('reproduces the $name digest', ({ messageUtf8, digestHex }) => {
    expect(bytesToHex(noblePort.sha256(utf8ToBytes(messageUtf8)))).toBe(digestHex);
  });
});

describe('noblePort — Ed25519 interop vectors (RFC 8032 §7.1)', () => {
  it.each(ed25519Vectors)(
    'derives the $name public key from its seed',
    ({ seedHex, publicKeyHex }) => {
      expect(bytesToHex(noblePort.ed25519GetPublicKey(hexToBytes(seedHex)))).toBe(publicKeyHex);
    },
  );

  it.each(ed25519Vectors)(
    'keygen($name seed) yields the recorded keypair',
    ({ seedHex, publicKeyHex }) => {
      const { secretKey, publicKey } = noblePort.ed25519Keygen(hexToBytes(seedHex));
      expect(bytesToHex(secretKey)).toBe(seedHex);
      expect(bytesToHex(publicKey)).toBe(publicKeyHex);
    },
  );

  it.each(ed25519Vectors)(
    'produces the $name signature byte-for-byte',
    ({ seedHex, messageHex, signatureHex }) => {
      const signature = noblePort.sign(hexToBytes(messageHex), hexToBytes(seedHex));
      expect(bytesToHex(signature)).toBe(signatureHex);
    },
  );

  it.each(ed25519Vectors)(
    'verifies the recorded $name signature',
    ({ publicKeyHex, messageHex, signatureHex }) => {
      // The quick-crypto leg of the contract: these signatures are the fixture's
      // cross-implementation expectations, verified here under noble.
      expect(
        noblePort.verify(
          hexToBytes(signatureHex),
          hexToBytes(messageHex),
          hexToBytes(publicKeyHex),
        ),
      ).toBe(true);
    },
  );

  it.each(ed25519Vectors)(
    'rejects the $name signature under a foreign key',
    ({ messageHex, signatureHex }) => {
      const foreign = noblePort.ed25519GetPublicKey(new Uint8Array(32).fill(9));
      expect(noblePort.verify(hexToBytes(signatureHex), hexToBytes(messageHex), foreign)).toBe(
        false,
      );
    },
  );

  it('returns false rather than throwing on malformed input (port contract)', () => {
    const vector = ed25519Vectors[0]!;
    expect(
      noblePort.verify(new Uint8Array(0), new Uint8Array(0), hexToBytes(vector.publicKeyHex)),
    ).toBe(false);
    expect(
      noblePort.verify(hexToBytes(vector.signatureHex), new Uint8Array(0), new Uint8Array(31)),
    ).toBe(false);
  });

  it('does not alias a caller-supplied seed buffer', () => {
    // noble 2.x reuses a passed seed rather than copying it; if the port leaked that
    // aliasing, a caller zeroing its seed would retroactively change the keypair.
    const seed = hexToBytes(ed25519Vectors[0]!.seedHex);
    const { secretKey } = noblePort.ed25519Keygen(seed);
    seed.fill(0);
    expect(bytesToHex(secretKey)).toBe(ed25519Vectors[0]!.seedHex);
  });
});

describe('noblePort — argon2id', () => {
  it.each(argon2idVectors)('reproduces the $name tag', async (vector) => {
    const tag = await noblePort.kdf(hexToBytes(vector.passwordHex), hexToBytes(vector.saltHex), {
      memoryCost: vector.memoryCost,
      timeCost: vector.timeCost,
      parallelism: vector.parallelism,
      outputLength: vector.outputLength,
      secret: hexToBytes(vector.secretHex),
      associatedData: hexToBytes(vector.associatedDataHex),
    });
    expect(bytesToHex(tag)).toBe(vector.tagHex);
  });

  it('accepts the D8 default parameters and returns a 32-byte key', async () => {
    // D8: m=32768 KiB / t=3 / p=1 / 32-byte output. Enforcing this as a FLOOR is task 14
    // (SEC-AUTH-01); here we only prove the port accepts the documented defaults.
    expect(DEFAULT_KDF_PARAMS).toEqual({
      memoryCost: 32768,
      timeCost: 3,
      parallelism: 1,
      outputLength: 32,
    });

    const key = await noblePort.kdf(
      utf8ToBytes('123456'),
      utf8ToBytes('0123456789abcdef'),
      DEFAULT_KDF_PARAMS,
    );
    expect(key).toHaveLength(32);
  }, 30_000);

  it('is deterministic for the same password, salt and parameters', async () => {
    const derive = () =>
      noblePort.kdf(utf8ToBytes('pin-1234'), utf8ToBytes('0123456789abcdef'), {
        memoryCost: 64,
        timeCost: 2,
        parallelism: 1,
        outputLength: 32,
      });
    expect(bytesToHex(await derive())).toBe(bytesToHex(await derive()));
  });

  it('yields a different key for a different salt', async () => {
    const params = { memoryCost: 64, timeCost: 2, parallelism: 1, outputLength: 32 };
    const a = await noblePort.kdf(utf8ToBytes('pin-1234'), utf8ToBytes('0123456789abcdef'), params);
    const b = await noblePort.kdf(utf8ToBytes('pin-1234'), utf8ToBytes('fedcba9876543210'), params);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

describe('noblePort — randomBytes', () => {
  it('returns the requested length', () => {
    expect(noblePort.randomBytes(32)).toHaveLength(32);
    expect(noblePort.randomBytes(0)).toHaveLength(0);
  });

  it('does not repeat across calls', () => {
    // A smoke test for "actually random", not a statistical test: a stuck or zeroed RNG
    // would silently make every device key identical.
    expect(bytesToHex(noblePort.randomBytes(32))).not.toBe(bytesToHex(noblePort.randomBytes(32)));
  });
});

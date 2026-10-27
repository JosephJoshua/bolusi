// A `CryptoPort` whose hot calls (SHA-256, Ed25519 sign/verify) run on Node's OpenSSL, for benchmarks
// and load tools that must not spend their time in pure-JS crypto. Phones sign and verify through
// OpenSSL too (quick-crypto), so this is also the realistic cost model. Key derivation, keygen and
// randomness stay on `noblePort`; the shared golden vectors pin both bindings (crypto/*.test.ts).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { frameEd25519Pkcs8, frameEd25519Spki, type CryptoPort } from '@bolusi/core';

import { noblePort } from './noble-port.js';

export const opensslPort: CryptoPort = {
  ...noblePort,
  sha256: (data) => new Uint8Array(createHash('sha256').update(data).digest()),
  sign(message, secretKey) {
    const key = createPrivateKey({
      key: Buffer.from(frameEd25519Pkcs8(secretKey)),
      format: 'der',
      type: 'pkcs8',
    });
    return new Uint8Array(sign(null, message, key));
  },
  verify(signature, message, publicKey) {
    try {
      const key = createPublicKey({
        key: Buffer.from(frameEd25519Spki(publicKey)),
        format: 'der',
        type: 'spki',
      });
      return verify(null, message, key, signature);
    } catch {
      return false;
    }
  },
};

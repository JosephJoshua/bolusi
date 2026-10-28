// The PC's crypto: Node's own for hashing, Ed25519 and AES-GCM, the same OpenSSL-shaped calls the
// phone makes through quick-crypto. Electron builds Node on BoringSSL, which has no Argon2, so PINs
// hash with hash-wasm (0.17 s at the PIN cost on a laptop; the pure-JS one took 1.8 s). The rare
// call with associated data, which hash-wasm does not take, falls back to noble.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { argon2id } from 'hash-wasm';

import {
  frameEd25519Pkcs8,
  frameEd25519Spki,
  pointFromSpkiDer,
  type CryptoPort,
  type KdfParams,
} from '@bolusi/core';
import { createNodeCompatibleAead, type AeadCipher } from '@bolusi/db-client';

function bytes(value: Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function privateKeyFromSeed(seed: Uint8Array): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.from(frameEd25519Pkcs8(seed)),
    format: 'der',
    type: 'pkcs8',
  });
}

function rawPublicOf(seed: Uint8Array): Uint8Array {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ type: 'spki', format: 'der' });
  return pointFromSpkiDer(bytes(spki));
}

function kdf(password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
  if (params.associatedData !== undefined && params.associatedData.length > 0) {
    return argon2idAsync(password, salt, {
      m: params.memoryCost,
      t: params.timeCost,
      p: params.parallelism,
      dkLen: params.outputLength,
      ...(params.secret ? { key: params.secret } : {}),
      personalization: params.associatedData,
    });
  }
  return argon2id({
    password,
    salt,
    memorySize: params.memoryCost,
    iterations: params.timeCost,
    parallelism: params.parallelism,
    hashLength: params.outputLength,
    ...(params.secret ? { secret: params.secret } : {}),
    outputType: 'binary',
  });
}

export const nodeCryptoPort: CryptoPort = {
  sha256: (data) => bytes(createHash('sha256').update(data).digest()),
  ed25519Keygen(seed) {
    const secretKey = seed === undefined ? bytes(randomBytes(32)) : Uint8Array.from(seed);
    return { secretKey, publicKey: rawPublicOf(secretKey) };
  },
  ed25519GetPublicKey: (secretKey) => rawPublicOf(secretKey),
  sign: (message, secretKey) => bytes(sign(null, message, privateKeyFromSeed(secretKey))),
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
  kdf,
  randomBytes: (length) => bytes(randomBytes(length)),
};

/** The at-rest column cipher (AES-256-GCM), built the way the phone builds its own. */
export const nodeColumnAead: AeadCipher = createNodeCompatibleAead({
  createCipheriv(algorithm, key, iv) {
    const cipher = createCipheriv(algorithm as 'aes-256-gcm', key, iv);
    return {
      update: (data) => bytes(cipher.update(data)),
      final: () => bytes(cipher.final()),
      getAuthTag: () => bytes(cipher.getAuthTag()),
    };
  },
  createDecipheriv(algorithm, key, iv) {
    const decipher = createDecipheriv(algorithm as 'aes-256-gcm', key, iv);
    return {
      update: (data) => bytes(decipher.update(data)),
      final: () => bytes(decipher.final()),
      setAuthTag: (tag) => decipher.setAuthTag(tag),
    };
  },
  randomBytes: (size) => bytes(randomBytes(size)),
  createHmac: (algorithm, key) => {
    const hmac = createHmac(algorithm, key);
    return {
      update(data: Uint8Array) {
        hmac.update(data);
        return this;
      },
      digest: () => bytes(hmac.digest()),
    };
  },
});

// The Node AES-256-GCM AeadCipher for CI/tests — the counterpart to apps/mobile's quick-crypto binding
// (D22; security-guide §6.4). This is to the at-rest column cipher what `noblePort` is to `CryptoPort`:
// the Node-side binding of an interface the device binds to its native provider, run against identical
// vectors. quick-crypto's GCM and Node's GCM are the same OpenSSL algorithm, so a value sealed in a
// test and one sealed on device are byte-compatible under the same key/nonce.
//
// The `@bolusi/db-client` edge is TYPE-ONLY (this package keeps DB *values* out — 08 §3.3, mirrored by
// driver-conformance/index.ts), so the seal/open framing is implemented here directly over `node:crypto`
// rather than importing db-client's factory. The higher-level nonce/base64/marker framing is NOT
// duplicated — that lives once in db-client's `Aes256GcmColumnCipher`; this file provides only the raw
// AEAD primitive it runs on.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import type { AeadCipher } from '@bolusi/db-client';

const ALGORITHM = 'aes-256-gcm';
const TAG_BYTES = 16;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytes(value: Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** Node-backed AES-256-GCM for the at-rest column cipher in tests (returns/accepts `ciphertext ‖ tag`). */
export const nodeColumnAead: AeadCipher = {
  seal(key, nonce, plaintext) {
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const body = concat(bytes(cipher.update(plaintext)), bytes(cipher.final()));
    return concat(body, bytes(cipher.getAuthTag()));
  },
  open(key, nonce, sealed) {
    if (sealed.length < TAG_BYTES) throw new RangeError('AEAD blob shorter than the tag');
    const split = sealed.length - TAG_BYTES;
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(sealed.subarray(split));
    // `final()` throws when the tag does not verify — the wrong-key / tamper signal (SEC-DEV-06).
    return concat(bytes(decipher.update(sealed.subarray(0, split))), bytes(decipher.final()));
  },
  randomBytes: (length) => bytes(randomBytes(length)),
  hmacSha256: (key, data) => bytes(createHmac('sha256', key).update(data).digest()),
};

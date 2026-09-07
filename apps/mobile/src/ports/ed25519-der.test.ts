// Host oracle for the pure Ed25519 DER framing in `./ed25519-der`.
//
// WHY THIS SUITE EXISTS. The device `CryptoPort` (`crypto.ts`) frames raw Ed25519 seeds/points into
// PKCS8/SPKI DER by prepending a FIXED prefix, because quick-crypto's raw-seed / raw-public handle is
// broken on the Android build. Those prefix bytes are load-bearing: a wrong byte would make
// `createPrivateKey`/`createPublicKey` reject the key (bricking enrollment) or — worse — accept a
// malformed key. But `crypto.ts` imports a JSI native module, so it cannot be loaded under Node, and its
// only proof was the emulator lane. The framing itself needs no native crypto to COMPUTE, only to be
// used — so it is extracted here and pinned against two independent oracles Node can run:
//   1. `node:crypto`'s OWN Ed25519 DER export — the prefixes must be byte-identical to what OpenSSL emits;
//   2. the shared RFC 8032 golden vectors (`@bolusi/test-support` `ed25519Vectors`) — a framed seed must
//      derive the recorded public key and produce the recorded (deterministic) KAT signature.
// If any prefix byte were wrong, oracle 1's `toStrictEqual` fails, or `createPrivateKey` throws, or the
// KAT signature diverges. This does NOT prove quick-crypto's on-device behaviour (that is the emulator
// lane's job) — it proves the ASN.1 framing the on-device path feeds into is correct.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { ed25519Vectors } from '@bolusi/test-support';
import { describe, expect, test } from 'vitest';

import {
  ED25519_RAW_LENGTH,
  frameEd25519Pkcs8,
  frameEd25519Spki,
  PKCS8_ED25519_PREFIX,
  pointFromSpkiDer,
  SPKI_ED25519_PREFIX,
} from './ed25519-der';

/** Hex string -> plain Uint8Array (`''` -> empty), normalised off Buffer so matchers compare contents. */
function hex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

/** Buffer/typed-array -> plain Uint8Array, so `toStrictEqual` sees a Uint8Array not a Buffer subtype. */
function bytes(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

describe('the fixed prefixes are byte-identical to node:crypto / OpenSSL Ed25519 DER', () => {
  test('a node-generated private key IS our PKCS8 prefix followed by its 32-byte seed (48 bytes)', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = bytes(privateKey.export({ type: 'pkcs8', format: 'der' }));

    expect(der).toHaveLength(PKCS8_ED25519_PREFIX.length + ED25519_RAW_LENGTH);
    expect(der).toHaveLength(48);
    expect(der.slice(0, PKCS8_ED25519_PREFIX.length)).toStrictEqual(PKCS8_ED25519_PREFIX);

    // Reframing the seed node itself carved out must reproduce node's DER exactly.
    const seed = der.slice(-ED25519_RAW_LENGTH);
    expect(frameEd25519Pkcs8(seed)).toStrictEqual(der);
  });

  test('a node-generated public key IS our SPKI prefix followed by its 32-byte point (44 bytes)', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const der = bytes(publicKey.export({ type: 'spki', format: 'der' }));

    expect(der).toHaveLength(SPKI_ED25519_PREFIX.length + ED25519_RAW_LENGTH);
    expect(der).toHaveLength(44);
    expect(der.slice(0, SPKI_ED25519_PREFIX.length)).toStrictEqual(SPKI_ED25519_PREFIX);

    const point = pointFromSpkiDer(der);
    expect(point).toHaveLength(ED25519_RAW_LENGTH);
    expect(frameEd25519Spki(point)).toStrictEqual(der);
  });
});

describe('framing round-trips the RFC 8032 golden vectors through node:crypto', () => {
  test('the shared vector set is present (an empty set would make every case below vacuous)', () => {
    expect(ed25519Vectors.length).toBeGreaterThan(0);
  });

  test.each(ed25519Vectors)('$name: framed seed derives the recorded public key', (vector) => {
    // `node:crypto`'s DER `key` input is typed `Buffer`; wrap here (test-only — the on-device quick-crypto
    // path in `crypto.ts` accepts the raw `Uint8Array`, so the framing stays `Uint8Array`-native).
    const privateKey = createPrivateKey({
      key: Buffer.from(frameEd25519Pkcs8(hex(vector.seedHex))),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = bytes(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));

    expect(Buffer.from(pointFromSpkiDer(spki)).toString('hex')).toBe(vector.publicKeyHex);
  });

  test.each(ed25519Vectors)('$name: framed seed signs to the recorded KAT signature', (vector) => {
    // Ed25519 signing is deterministic (RFC 8032), so the signature is a known-answer test: a wrong
    // prefix byte would make node reject the key or produce a different signature.
    const privateKey = createPrivateKey({
      key: Buffer.from(frameEd25519Pkcs8(hex(vector.seedHex))),
      format: 'der',
      type: 'pkcs8',
    });
    const message = hex(vector.messageHex);
    const signature = sign(null, message, privateKey);
    expect(Buffer.from(signature).toString('hex')).toBe(vector.signatureHex);

    // ...and the SPKI-framed recorded public key verifies that signature.
    const publicKey = createPublicKey({
      key: Buffer.from(frameEd25519Spki(hex(vector.publicKeyHex))),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, message, publicKey, signature)).toBe(true);
  });
});

describe('pointFromSpkiDer extracts exactly the trailing 32 bytes', () => {
  test('returns the last 32 bytes regardless of the leading prefix content', () => {
    const der = new Uint8Array(SPKI_ED25519_PREFIX.length + ED25519_RAW_LENGTH);
    for (let i = 0; i < ED25519_RAW_LENGTH; i += 1) der[SPKI_ED25519_PREFIX.length + i] = i + 1;

    const point = pointFromSpkiDer(der);
    expect(point).toHaveLength(ED25519_RAW_LENGTH);
    expect(point[0]).toBe(1);
    expect(point[ED25519_RAW_LENGTH - 1]).toBe(ED25519_RAW_LENGTH);
  });
});

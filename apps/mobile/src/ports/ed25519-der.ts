// Pure RFC 8410 §10 DER framing for Ed25519 keys — the raw<->DER conversion the device `CryptoPort`
// (`crypto.ts`) relies on because quick-crypto 1.1.6's raw-seed / raw-public `KeyObjectHandle` is broken
// on the Android build (see the `crypto.ts` header for the "Failed to create key from raw seed" story).
//
// WHY THIS IS A SEPARATE FILE. `crypto.ts` imports `react-native-quick-crypto` at the top level, a JSI
// native module Node cannot load — so nothing in that file is host-testable, and the on-device leg only
// runs on the emulator lane. But the ASN.1 framing itself is a PURE byte operation over fixed-length
// prefixes; it needs no native crypto to compute, only to be *used*. Splitting it here (importing NOTHING
// native) lets a host test pin these bytes against `node:crypto`'s own Ed25519 DER export — the one
// oracle that can prove the 16-/12-byte prefixes are correct without a device (`ed25519-der.test.ts`).
// `crypto.ts` imports these; it does not redefine them (§2.8 — one implementation).

/** RFC 8032 raw key length: an Ed25519 seed and a compressed point are each exactly 32 bytes. */
export const ED25519_RAW_LENGTH = 32;

/**
 * Fixed 16-byte PKCS8 prefix: a valid Ed25519 private key is this prefix followed by the 32-byte seed
 * (total 48 bytes). It is a CONSTANT, not variable-length ASN.1, because the Ed25519 key type is
 * single-length. Byte-verified against `node:crypto` / OpenSSL `export({ type: 'pkcs8', format: 'der' })`
 * in the sibling test.
 */
export const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Fixed 12-byte SPKI prefix: a valid Ed25519 public key is this prefix followed by the 32-byte point
 * (total 44 bytes). Same single-length rationale as {@link PKCS8_ED25519_PREFIX}; byte-verified against
 * `node:crypto`'s SPKI DER export in the sibling test.
 */
export const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Frame a raw 32-byte value inside its fixed DER prefix (prepend the prefix). */
function framed(prefix: Uint8Array, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
}

/** Build the PKCS8 DER for a raw 32-byte RFC 8032 seed — the import form of a private key. */
export function frameEd25519Pkcs8(seed: Uint8Array): Uint8Array {
  return framed(PKCS8_ED25519_PREFIX, seed);
}

/** Build the SPKI DER for a raw 32-byte compressed point — the import form of a public key. */
export function frameEd25519Spki(point: Uint8Array): Uint8Array {
  return framed(SPKI_ED25519_PREFIX, point);
}

/** Extract the raw 32-byte point from a fixed-length Ed25519 SPKI DER: its trailing 32 bytes. */
export function pointFromSpkiDer(der: Uint8Array): Uint8Array {
  return der.slice(-ED25519_RAW_LENGTH);
}

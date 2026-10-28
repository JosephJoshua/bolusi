// CRC-32 (RFC 2083 §15, PNG chunks) and Adler-32 (RFC 1950, zlib streams).
//
// These are FORMAT checksums, not security ones, and the distinction is worth stating so nobody
// reaches for them by mistake: neither is a hash. Every integrity claim this app makes about
// evidence runs through SHA-256 (06 §2.2 step 6, §3.1) via `react-native-quick-crypto` — the
// pinned, audited implementation — and nothing here is a substitute for it. The only reason these
// exist is that PNG's own container format requires them, and quick-crypto does not offer CRC-32.
//
// Both are the textbook implementations from their RFCs and are verified against the published
// test vectors in `signature-png.test.ts` (CRC-32 of "123456789" is 0xCBF43926; Adler-32 of "Wikipedia"
// is 0x11E60398). A checksum nobody has checked against a vector is a checksum that silently
// produces a file every decoder rejects.

/** The standard reflected CRC-32 table (polynomial 0xEDB88320), built once. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 over `bytes`, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    // The index is `(c ^ byte) & 0xff`, always 0..255, so the lookup cannot miss; the `?? 0` that
    // `noUncheckedIndexedAccess` would otherwise demand is avoided by reading through a local.
    const entry = CRC_TABLE[(c ^ byte) & 0xff];
    c = (entry === undefined ? 0 : entry) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 over `bytes` (RFC 1950 §9), as an unsigned 32-bit number. */
export function adler32(bytes: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

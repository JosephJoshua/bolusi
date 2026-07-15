// Gzip fixtures for the decompression-surface tests. Bombs are built from REAL zlib
// (gzipSync of an all-zeros buffer) — a highly compressible payload whose wire size passes
// bodyLimit while its decompressed size blows the cap. The middleware's bounded-work property
// is witnessed by the onProgress output-count seam (see gzip-decompress.test.ts / sec-sync.test.ts).
import { gzipSync } from 'node:zlib';

export function gzipJson(value: unknown): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
}

/** A gzip whose decompressed size is `decompressedBytes` of zeros (compresses ~1000:1). */
export function gzipBomb(decompressedBytes: number): Uint8Array {
  return gzipSync(Buffer.alloc(decompressedBytes, 0));
}

/** A valid gzip with its final bytes (CRC/ISIZE trailer + tail) chopped off — truncated stream. */
export function truncatedGzip(value: unknown): Uint8Array {
  const full = gzipJson(value);
  return full.subarray(0, Math.max(1, full.length - 6));
}

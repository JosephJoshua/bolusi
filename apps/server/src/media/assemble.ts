// Whole-file assembly + integrity (api/03-media §3.4, §5). Chunks are assembled in index order,
// hashed with a streaming SHA-256 over the assembled bytes, and the leading bytes are checked
// against the declared mime's magic number. Nothing here writes to storage — the caller does the
// blob write only after BOTH the hash and the magic-byte check pass (§3.4 step 5).
import { createHash } from 'node:crypto';

import { MEDIA_MIMES, type MediaMime } from '@bolusi/schemas';

/** The mime allowlist (api/03-media §3.1): the photos', and since v1 the video clips'. */
export const ALLOWED_MIME_TYPES = MEDIA_MIMES;
export type AllowedMime = MediaMime;

export function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

// Magic bytes (api/03-media §3.4), each at its offset:
//   image/jpeg → FF D8 FF
//   image/png  → 89 50 4E 47 0D 0A 1A 0A
//   video/mp4  → "ftyp" at byte 4 (the ISO base media file's first box, after its size)
//   video/webm → 1A 45 DF A3 (the EBML header)
const MAGIC: Record<AllowedMime, { readonly at: number; readonly bytes: readonly number[] }> = {
  'image/jpeg': { at: 0, bytes: [0xff, 0xd8, 0xff] },
  'image/png': { at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'video/mp4': { at: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  'video/webm': { at: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
};

/**
 * Does `bytes` carry the magic number of `declaredMime`?
 *
 * Only the declared mime's signature is checked — the assembled file must actually be what init
 * claimed (a PNG uploaded as `image/jpeg` fails), which is the SEC-MEDIA-05 assertion. A file
 * shorter than the signature cannot match.
 */
export function magicBytesMatch(bytes: Uint8Array, declaredMime: AllowedMime): boolean {
  const { at, bytes: signature } = MAGIC[declaredMime];
  if (bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[at + i] !== signature[i]) return false;
  }
  return true;
}

export interface AssembledFile {
  /** The concatenated file bytes, in chunk-index order. */
  readonly bytes: Uint8Array;
  /** Lowercase hex SHA-256 of the assembled bytes (matches `media.sha256` — char(64)). */
  readonly sha256: string;
}

/**
 * Assemble `chunks` (already ordered by index, gap-free — the caller verifies completeness first)
 * into the whole file, hashing incrementally as bytes are appended.
 *
 * The hash is fed chunk-by-chunk rather than over one giant concatenation, matching §3.4 step 2's
 * "streaming SHA-256 over the assembled bytes" — the assembled buffer (≤ 10 MiB for a photo, ≤ 48 MiB for a video) is still
 * materialised because the blob write and the magic-byte sniff both need it.
 */
export function assembleChunks(chunks: readonly Uint8Array[]): AssembledFile {
  const hash = createHash('sha256');
  let total = 0;
  for (const chunk of chunks) {
    hash.update(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, sha256: hash.digest('hex') };
}

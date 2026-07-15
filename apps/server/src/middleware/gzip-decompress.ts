// Gzip request decompression (api/00 §5.2, §13 step 9) — a declared SECURITY SURFACE
// (CLAUDE.md §2.5): adversarial tests ship in task 12 before review.
//
// Hono has no built-in request decompression (hono/compress is response-only). This middleware:
//   - absent / `identity` Content-Encoding  → pass-through;
//   - `gzip`                                 → decompress and present downstream, header stripped;
//   - anything else (`deflate`, `br`, `gzip, gzip`, …) → 415 UNSUPPORTED_ENCODING;
//   - malformed / truncated gzip, or non-gzip bytes labeled gzip → 400 MALFORMED_REQUEST.
//
// The decompressed-size cap is enforced WHILE STREAMING — count bytes out of
// DecompressionStream and abort at the cap (gzip-bomb defense). bodyLimit (§13 step 8) counts
// only WIRE bytes and cannot see the bomb; that is why this cap exists and why it must never be
// "inflate fully, then measure". Aborting the reader cancels upstream inflation, so peak memory
// is bounded to ~cap regardless of the bomb's decompressed size.
import type { MiddlewareHandler } from 'hono';

import { ApiError } from '../errors.js';
import type { AppEnv } from '../env.js';

export interface GzipDecompressOptions {
  /** Decompressed-byte cap (api/00 §5.3). Exceeding it → 413 DECOMPRESSED_TOO_LARGE. */
  readonly maxDecompressedBytes: number;
  /**
   * Observability seam (no-op in production): called with the cumulative decompressed byte
   * count after each output chunk, including the one that trips the cap. It is the witness the
   * bound-test reads to prove the middleware NEVER inflates past the cap — a naive
   * "inflate fully, then measure" implementation would report the bomb's full size here.
   */
  readonly onProgress?: (decompressedBytesSoFar: number) => void;
}

/** Sentinel so the streaming loop can distinguish "over cap" (413) from a decode failure (400). */
class DecompressedTooLargeError extends Error {}

function contentEncoding(raw: string | null | undefined): 'identity' | 'gzip' | 'unsupported' {
  if (raw === undefined || raw === null) return 'identity';
  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'identity') return 'identity';
  if (normalized === 'gzip') return 'gzip';
  // Everything else — deflate, br, and any multi-encoding like `gzip, gzip` — is unsupported.
  return 'unsupported';
}

export function gzipDecompress(options: GzipDecompressOptions): MiddlewareHandler<AppEnv> {
  const cap = options.maxDecompressedBytes;

  return async (c, next) => {
    const encoding = contentEncoding(c.req.raw.headers.get('Content-Encoding'));

    if (encoding === 'identity') {
      await next();
      return;
    }
    if (encoding === 'unsupported') {
      throw new ApiError('UNSUPPORTED_ENCODING');
    }

    const body = c.req.raw.body;
    if (body === null) {
      // gzip declared but no body — nothing is a valid gzip stream here.
      throw new ApiError('MALFORMED_REQUEST');
    }

    const decompressed = await inflateWithCap(body, cap, options.onProgress);

    // Present the decompressed bytes downstream and strip the encoding header so zValidator
    // (§13 step 10) reads plain JSON. Rebuild the request from the URL (its body is now spent);
    // the buffered body needs no `duplex`, unlike a streamed one.
    const headers = new Headers(c.req.raw.headers);
    headers.delete('Content-Encoding');
    headers.set('Content-Length', String(decompressed.byteLength));
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: decompressed,
    });

    await next();
  };
}

/**
 * Inflate `source` through DecompressionStream('gzip'), counting output bytes and aborting at
 * `cap`. Bounded memory: the reader is cancelled the instant the count crosses the cap, so no
 * more than ~cap + one chunk is ever inflated or buffered — the bomb is never fully expanded.
 */
async function inflateWithCap(
  source: ReadableStream<Uint8Array>,
  cap: number,
  onProgress?: (decompressedBytesSoFar: number) => void,
): Promise<Uint8Array> {
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      onProgress?.(total);
      if (total > cap) {
        // Cancel the output reader: DecompressionStream stops producing (and the source pipe is
        // torn down), so no more than ~cap + one chunk is ever inflated. Never inflate-then-check.
        await reader.cancel();
        throw new DecompressedTooLargeError();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof DecompressedTooLargeError) {
      throw new ApiError('DECOMPRESSED_TOO_LARGE', { limitBytes: cap });
    }
    // Any read rejection from DecompressionStream is a decode failure: malformed, truncated, or
    // non-gzip bytes. No unhandled rejection — we own the whole read loop.
    throw new ApiError('MALFORMED_REQUEST');
  } finally {
    // Release resources on every path (SEC-SYNC-08: resources released). releaseLock can throw
    // on an errored/cancelled reader — swallow so it never masks the ApiError we are throwing.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

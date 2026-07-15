// Media-surface error codes (api/03-media §8). These are NOT the api/00 §7 transport registry
// (HttpErrorCode) — the envelope's `error.code` is an OPEN string (schemas/errors zErrorEnvelope),
// so the media protocol's own codes ride the SAME `{ error: { code, message, details? } }` shape
// without widening the transport registry. Transport-level failures on this surface
// (AUTH_TOKEN_*, RATE_LIMITED, UNSUPPORTED_ENCODING, BODY_TOO_LARGE, VALIDATION_FAILED) still go
// through task 12's ApiError → onError → respondError, so their codes/messages stay single-sourced.
import type { Context } from 'hono';

import type { AppEnv } from '../env.js';
import type { ErrorDetails } from '../errors.js';

/** The media-owned machine codes (api/03-media §8). */
export type MediaErrorCode =
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_IMMUTABLE'
  | 'INIT_MISMATCH'
  | 'MEDIA_TOO_LARGE'
  | 'CHUNK_TOO_LARGE'
  | 'MIME_UNSUPPORTED'
  | 'CHUNK_INDEX_INVALID'
  | 'CHUNK_SIZE_INVALID'
  | 'CHUNKS_MISSING'
  | 'HASH_MISMATCH'
  | 'MIME_MISMATCH'
  | 'STORAGE_ERROR';

import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Code → (HTTP status, developer-facing English message). Status is derived from the code so the
 *  two cannot drift, exactly as task 12's CODE_STATUS does for the transport registry. */
const MEDIA_CODE: Record<MediaErrorCode, { status: ContentfulStatusCode; message: string }> = {
  MEDIA_NOT_FOUND: { status: 404, message: 'Media not found' },
  MEDIA_IMMUTABLE: { status: 409, message: 'Completed media cannot be modified' },
  INIT_MISMATCH: { status: 409, message: 'Init body differs from the stored init' },
  MEDIA_TOO_LARGE: { status: 413, message: 'Media exceeds the size cap' },
  CHUNK_TOO_LARGE: { status: 413, message: 'Chunk body exceeded the size limit' },
  MIME_UNSUPPORTED: { status: 422, message: 'Unsupported media type' },
  CHUNK_INDEX_INVALID: { status: 422, message: 'Chunk index out of range' },
  CHUNK_SIZE_INVALID: { status: 422, message: 'Chunk byte count invalid for its index' },
  CHUNKS_MISSING: { status: 422, message: 'Not all chunks have been received' },
  HASH_MISMATCH: { status: 422, message: 'Assembled hash does not match the declared hash' },
  MIME_MISMATCH: { status: 422, message: 'File contents do not match the declared mime' },
  STORAGE_ERROR: { status: 500, message: 'Blob storage failure' },
};

// Media codes are RETURNED, never thrown: a sub-app mounted with app.route() routes a THROWN error
// to the top-level app.onError, which maps a non-ApiError to 500. So handlers call renderMediaError
// directly; only transport codes (ApiError) travel as exceptions to app.onError (task 12).

/** Write the §6 envelope for a media code. Every out-of-scope/incomplete/nonexistent download leg
 *  renders the SAME `MEDIA_NOT_FOUND` envelope, so 404 responses are byte-indistinguishable
 *  (api/03-media §2, the existence-oracle defense). */
export function renderMediaError(
  c: Context<AppEnv>,
  code: MediaErrorCode,
  details?: ErrorDetails,
): Response {
  const { status, message } = MEDIA_CODE[code];
  const error = details === undefined ? { code, message } : { code, message, details };
  return c.json({ error }, status);
}

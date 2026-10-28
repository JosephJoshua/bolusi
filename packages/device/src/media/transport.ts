// The fetch `MediaTransportPort` — api/03-media §3's wire, in the thin adapter layer.
//
// @bolusi/core is platform-free (08 §3.3 rule 3): it owns the drain loop and knows nothing of
// `fetch`, headers or status codes. This file is the entire translation layer between the two, and
// its ONLY job is to turn HTTP into the port's vocabulary: DTOs on success, `MediaTransportError`
// with the api/00 §7 `error.code` carried VERBATIM on failure.
//
// WHY THE CODE, NOT THE STATUS (the port says this too; it bites hardest here). api/03 §8 puts two
// opposite behaviours behind one status more than once: `409` is `MEDIA_IMMUTABLE` (possibly
// SUCCESS — the item is already uploaded) or `INIT_MISMATCH` (never retry); `422` is
// `CHUNKS_MISSING` (the normal resume path) or `HASH_MISMATCH` (possibly destroyed evidence). An
// adapter that discarded the body and reported the status would collapse those pairs and the drain
// loop could not tell them apart. So the body is parsed on EVERY error path.
import {
  MediaTransportError,
  type MediaChunkResponse,
  type MediaCompleteResponse,
  type MediaInitRequest,
  type MediaInitResponse,
  type MediaStatusResponse,
  type MediaTransportPort,
} from '@bolusi/core';

export interface MediaTransportConfig {
  /** Base URL of the server, no trailing slash (e.g. `https://api.example.com`). */
  readonly baseUrl: string;
  /** The `bdt_`-prefixed device token (api/02-auth §3/§8), read at call time — never cached here. */
  readonly deviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Parse an api/00 §7 error envelope out of a failed response.
 *
 * Deliberately tolerant: a proxy, a load balancer or a captive portal can return HTML or an empty
 * body with a 5xx, and the drain loop must still get a usable failure rather than a JSON parse
 * exception escaping the adapter. An unparseable body yields `code: null`, which the loop treats
 * as a network-class failure (retry under backoff) — the correct reading of "something between us
 * and the server answered".
 */
async function toTransportError(response: Response): Promise<MediaTransportError> {
  let code: string | null = null;
  let message = `HTTP ${response.status}`;
  let missingChunks: readonly number[] | null = null;
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } })
      ?.error;
    if (typeof error?.code === 'string') code = error.code;
    if (typeof error?.message === 'string') message = error.message;
    // api/03 §3.4 step 1: CHUNKS_MISSING's body carries `missingChunks` — the resume instruction.
    const details = error?.details as { missingChunks?: unknown } | undefined;
    if (Array.isArray(details?.missingChunks)) {
      const list = details.missingChunks.filter((n): n is number => Number.isInteger(n));
      missingChunks = list;
    }
  } catch {
    // Body was not JSON. `code` stays null ⇒ treated as a network-class failure.
  }
  return new MediaTransportError(message, { code, status: response.status, missingChunks });
}

export function createFetchMediaTransport(config: MediaTransportConfig): MediaTransportPort {
  const doFetch = config.fetchImpl ?? fetch;

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await config.deviceToken();
    if (token === null) {
      // Fail closed rather than send an unauthenticated request: api/03 §2 requires the device
      // token on EVERY endpoint, and an anonymous request would earn a 401 that the loop would
      // read as "halt the drain" (api/03 §8) — punishing the user for our missing token.
      throw new MediaTransportError('no device token available', {
        code: 'AUTH_TOKEN_MISSING',
        status: null,
      });
    }
    return { Authorization: `Bearer ${token}` };
  }

  async function jsonRequest<T>(path: string, init: RequestInit): Promise<T> {
    const response = await doFetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(await authHeaders()) },
    });
    if (!response.ok) throw await toTransportError(response);
    return (await response.json()) as T;
  }

  return {
    async init(mediaId, request: MediaInitRequest): Promise<MediaInitResponse> {
      // JSON bodies are small and sent PLAIN — no gzip (api/03 §3).
      return jsonRequest<MediaInitResponse>(`/v1/media/${mediaId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    },

    async putChunk(mediaId, index, bytes): Promise<MediaChunkResponse> {
      const response = await doFetch(`${config.baseUrl}/v1/media/${mediaId}/chunks/${index}`, {
        method: 'PUT',
        headers: {
          // RAW BYTES. No `Content-Encoding` header is set, and none may ever be added here:
          // api/03 §7 rejects an encoded chunk PUT with `415 UNSUPPORTED_ENCODING` and nothing is
          // stored, and 06 §5.5's reason is that JPEG/PNG are already compressed so gzip burns
          // 2GB-device CPU for ~0% gain. Note the CONTRAST that makes this worth stating: sync
          // POST bodies ARE gzipped (api/01-sync), so "we gzip request bodies" is true elsewhere
          // in this app and false here. An adapter test asserts the absence of the header.
          'Content-Type': 'application/octet-stream',
          ...(await authHeaders()),
        },
        // Copy into a fresh, exactly-sized buffer. A real chunk is a `subarray` VIEW into a larger
        // file-read buffer (06 §5.5), and passing the view risks the whole backing buffer going
        // over the wire — a partial file per chunk, or a CHUNK_SIZE_INVALID. `new Uint8Array(view)`
        // copies the view's LOGICAL bytes (length = the chunk), never its buffer. It also yields a
        // `Uint8Array<ArrayBuffer>`, which `fetch`'s BodyInit requires (TS 5.9 makes typed arrays
        // generic over their buffer, and a `Uint8Array<ArrayBufferLike>` view is not assignable).
        body: new Uint8Array(bytes),
      });
      if (!response.ok) throw await toTransportError(response);
      return (await response.json()) as MediaChunkResponse;
    },

    async status(mediaId): Promise<MediaStatusResponse> {
      return jsonRequest<MediaStatusResponse>(`/v1/media/${mediaId}/status`, { method: 'GET' });
    },

    async complete(mediaId): Promise<MediaCompleteResponse> {
      return jsonRequest<MediaCompleteResponse>(`/v1/media/${mediaId}/complete`, {
        method: 'POST',
      });
    },

    async download(mediaId): Promise<Uint8Array> {
      const response = await doFetch(`${config.baseUrl}/v1/media/${mediaId}`, {
        method: 'GET',
        headers: await authHeaders(),
      });
      if (!response.ok) throw await toTransportError(response);
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * api/03 §3.5's `ETag: "<sha256>"` + `If-None-Match ⇒ 304`, as the question the drain asks.
     * See `MediaTransportPort.matchesServerHash` for why this exists at all (§8's MEDIA_IMMUTABLE
     * row requires comparing our hash to the server's, and no endpoint returns the server's hash).
     *
     * `304` ⇒ the server's ETag equals ours ⇒ true, and no body crosses the wire. `200` ⇒ the
     * server holds something else. Both are answers; anything else is a rejection, which the drain
     * treats as "cannot confirm" and therefore LOCAL_CORRUPT-class — never as a match.
     */
    async matchesServerHash(mediaId, sha256): Promise<boolean> {
      const response = await doFetch(`${config.baseUrl}/v1/media/${mediaId}`, {
        method: 'GET',
        headers: { 'If-None-Match': `"${sha256}"`, ...(await authHeaders()) },
      });
      if (response.status === 304) return true;
      if (response.ok) return false;
      throw await toTransportError(response);
    },
  };
}

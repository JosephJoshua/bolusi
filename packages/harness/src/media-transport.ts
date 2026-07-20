// The media transport building block (testing-guide §3.1 `net`, §3.6 CHAOS-09).
//
// Mirrors `HttpTransport` (transport.ts): it WIRES the production media drain loop's
// `MediaTransportPort` (core/media/ports.ts) to the REAL in-process `@bolusi/server` media router
// (api/03-media §3) over an injected `fetch` — in the harness that fetch is `FaultFetch(server.fetch)`,
// so every request is captured and any scheduled F1/F2 fault fires at its boundary. No sockets.
//
// The harness owns its transport adapters BY DESIGN (T-7 — it holds no protocol logic of its own,
// and it does NOT import apps/mobile). api/03's wire is the endpoint list; the client half of it is
// a thin HTTP adapter that 08 §4.3 places in the client, so mirroring it here is correct, NOT a §2.8
// duplication — exactly the reasoning transport.ts records for `HttpTransport`.
import {
  MediaTransportError,
  type MediaChunkResponse,
  type MediaCompleteResponse,
  type MediaInitRequest,
  type MediaInitResponse,
  type MediaStatusResponse,
  type MediaTransportPort,
} from '@bolusi/core';

import type { FetchLike } from './fault-fetch.js';

const MEDIA_BASE = 'http://harness.test/v1/media';

/** The api/00 §7 error envelope a failed media request carries (media codes ride the same shape). */
interface MediaErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    /** `422 CHUNKS_MISSING` carries the resume instruction itself (api/03 §3.4 step 1). */
    readonly details?: { readonly missingChunks?: readonly number[] };
  };
}

/** Extra per-request wire options — headers and a raw (`Uint8Array`) or JSON (`string`) body. */
interface SendOptions {
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

/**
 * The production media wire (api/03-media §3) over an injected `fetch`, typed by the core DTOs only
 * (no Response/status leaks past this adapter — the same rule ports.ts states for the port).
 *
 * A pre-response failure (F1 network drop, F2 lost response) becomes a `MediaTransportError` with
 * `code: null` — which the drain loop classifies as `NETWORK` and retries under backoff (drain.ts
 * `classify`). A non-2xx becomes a `MediaTransportError` carrying the envelope's `error.code`
 * verbatim (and `details.missingChunks` for `CHUNKS_MISSING`), which is exactly how the loop tells a
 * routine `CHUNKS_MISSING` resume from an unrecoverable `HASH_MISMATCH` (ports.ts).
 */
export class HarnessMediaTransport implements MediaTransportPort {
  constructor(
    private readonly fetch: FetchLike,
    private readonly authorization: string,
  ) {}

  init(mediaId: string, request: MediaInitRequest): Promise<MediaInitResponse> {
    return this.parsed<MediaInitResponse>('POST', `${MEDIA_BASE}/${mediaId}/init`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  putChunk(mediaId: string, index: number, bytes: Uint8Array): Promise<MediaChunkResponse> {
    // Raw bytes, `application/octet-stream`, NEVER `Content-Encoding: gzip` (api/03 §3.2, §7).
    return this.parsed<MediaChunkResponse>('PUT', `${MEDIA_BASE}/${mediaId}/chunks/${index}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
  }

  status(mediaId: string): Promise<MediaStatusResponse> {
    return this.parsed<MediaStatusResponse>('GET', `${MEDIA_BASE}/${mediaId}/status`, {});
  }

  complete(mediaId: string): Promise<MediaCompleteResponse> {
    // Empty body (api/03 §3.4) — the route has no JSON validator, only the id param.
    return this.parsed<MediaCompleteResponse>('POST', `${MEDIA_BASE}/${mediaId}/complete`, {});
  }

  async download(mediaId: string): Promise<Uint8Array> {
    const response = await this.raw('GET', `${MEDIA_BASE}/${mediaId}`, {});
    if (response.status < 200 || response.status >= 300) throw await this.toError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * api/03 §8's `MEDIA_IMMUTABLE` hash comparison, expressed as the loop's question (ports.ts): a
   * conditional `GET /v1/media/:id` with `If-None-Match: "<sha256>"` — `304` ⇒ bytes match (`true`),
   * `200` ⇒ server holds different bytes (`false`). Any other response cannot confirm ⇒ rejects, and
   * the loop treats that as LOCAL_CORRUPT-class (fail closed).
   */
  async matchesServerHash(mediaId: string, sha256: string): Promise<boolean> {
    const response = await this.raw('GET', `${MEDIA_BASE}/${mediaId}`, {
      headers: { 'If-None-Match': `"${sha256}"` },
    });
    if (response.status === 304) return true;
    if (response.status === 200) return false;
    throw await this.toError(response);
  }

  /** Issue the request, adding the bearer header; a pre-response throw becomes `code: null`. */
  private async raw(method: string, url: string, opts: SendOptions): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { Authorization: this.authorization, ...(opts.headers ?? {}) },
    };
    if (opts.body !== undefined) init.body = opts.body as NonNullable<RequestInit['body']>;
    try {
      return await this.fetch(url, init);
    } catch (error) {
      // F1 (never reached) / F2 (response lost): no status, no code (ports.ts → drain `NETWORK`).
      throw new MediaTransportError(error instanceof Error ? error.message : String(error), {
        code: null,
        status: null,
      });
    }
  }

  private async parsed<T>(method: string, url: string, opts: SendOptions): Promise<T> {
    const response = await this.raw(method, url, opts);
    if (response.status < 200 || response.status >= 300) throw await this.toError(response);
    return (await response.json()) as T;
  }

  private async toError(response: Response): Promise<MediaTransportError> {
    const envelope = (await response.json().catch(() => ({}))) as MediaErrorEnvelope;
    return new MediaTransportError(`media HTTP ${response.status}`, {
      code: envelope.error?.code ?? null,
      status: response.status,
      missingChunks: envelope.error?.details?.missingChunks ?? null,
    });
  }
}

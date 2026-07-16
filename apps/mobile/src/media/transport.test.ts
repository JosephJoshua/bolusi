// The fetch MediaTransportPort adapter (api/03-media §3).
//
// SCOPE, stated because a green run here must not imply more than it proves (D16 clause 3): the
// only fake is `fetch` itself — the I/O boundary (T-7). These assert the REQUEST this adapter
// builds and the ERROR it raises, which is exactly what the platform-free drain loop cannot check
// for itself.
//
// They do NOT prove: that apps/server accepts these requests (task 19's integration suite owns
// that — if this adapter and the real server disagree, these tests stay green), or that React
// Native's `fetch` behaves like Node's `fetch` under them. The second one is the sharper limit:
// **no physical Android device is available (D12/D13)**, and RN's fetch is a different
// implementation over a different networking stack. A `Uint8Array` body, an `If-None-Match`
// round-trip and a 304 with no body are all things Node's undici does correctly and RN's polyfill
// must be verified to do — on a device, which this cannot be.
import { describe, expect, it, vi } from 'vitest';

import { MediaTransportError } from '@bolusi/core';

import { createFetchMediaTransport } from './transport';

const BASE = 'https://api.example.test';

function transportWith(impl: typeof fetch, token: string | null = 'bdt_token') {
  return createFetchMediaTransport({
    baseUrl: BASE,
    deviceToken: async () => token,
    fetchImpl: impl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('chunk PUT wire format (api/03 §3.2, §7; 06 §5.5)', () => {
  it('sends RAW bytes as application/octet-stream and NEVER Content-Encoding: gzip', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ receivedChunks: [0] }));
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await transport.putChunk('m-1', 0, bytes);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/media/m-1/chunks/0`);
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/octet-stream');

    // THE ASSERTION THIS TEST EXISTS FOR (task 18 acceptance; api/03 §7 answers an encoded chunk
    // PUT with 415 and stores nothing). Checked case-insensitively across every header key,
    // because a header the adapter never sets is trivially absent — the failure mode to catch is
    // someone ADDING it later, e.g. by copying the sync adapter, which DOES gzip its bodies
    // (api/01-sync). So this must fail if any spelling appears.
    const keys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('content-encoding');
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('gzip');
  });

  it('sends the chunk bytes themselves, not the whole backing buffer of a subarray', async () => {
    // A real chunk read is a VIEW into a larger buffer. Sending the view's buffer would upload the
    // entire file per chunk and earn a CHUNK_SIZE_INVALID — or worse, silently succeed on chunk 0.
    const backing = new Uint8Array(1000).fill(9);
    const view = backing.subarray(100, 110);
    const fetchMock = vi.fn(async () => jsonResponse({ receivedChunks: [1] }));
    const transport = transportWith(fetchMock as unknown as typeof fetch);

    await transport.putChunk('m-2', 1, view);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as Uint8Array).byteLength).toBe(10);
  });

  it('attaches the device token as a Bearer header (api/03 §2)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ receivedChunks: [] }));
    await transportWith(fetchMock as unknown as typeof fetch).putChunk('m-3', 0, new Uint8Array(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bdt_token');
  });

  it('fails closed when no device token is available — never sends an anonymous request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const transport = transportWith(fetchMock as unknown as typeof fetch, null);
    // An anonymous request would earn a 401, which the drain reads as "halt everything" (api/03
    // §8) — punishing the user for our missing token.
    await expect(transport.putChunk('m-4', 0, new Uint8Array(1))).rejects.toMatchObject({
      code: 'AUTH_TOKEN_MISSING',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('error envelopes are carried VERBATIM as codes, never collapsed to a status', () => {
  it.each([
    ['MEDIA_IMMUTABLE', 409],
    ['INIT_MISMATCH', 409],
    ['CHUNKS_MISSING', 422],
    ['HASH_MISMATCH', 422],
    ['MIME_MISMATCH', 422],
    ['DEVICE_REVOKED', 401],
    ['RATE_LIMITED', 429],
    ['STORAGE_ERROR', 500],
  ])('%s (HTTP %i) arrives as a MediaTransportError carrying the code', async (code, status) => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code, message: 'nope' } }, status));
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    await expect(transport.status('m-1')).rejects.toMatchObject({ code, status });
  });

  it('the two 409s are distinguishable, and so are the two 422s — the whole reason we read the body', async () => {
    // api/03 §8 puts opposite behaviours behind one status: MEDIA_IMMUTABLE may mean SUCCESS while
    // INIT_MISMATCH means never-retry; CHUNKS_MISSING is the normal resume path while
    // HASH_MISMATCH may mean destroyed evidence. A status-only adapter collapses both pairs.
    const immutable = transportWith(
      vi.fn(async () =>
        jsonResponse({ error: { code: 'MEDIA_IMMUTABLE', message: '' } }, 409),
      ) as never,
    );
    const mismatch = transportWith(
      vi.fn(async () =>
        jsonResponse({ error: { code: 'INIT_MISMATCH', message: '' } }, 409),
      ) as never,
    );
    await expect(immutable.status('a')).rejects.toMatchObject({
      code: 'MEDIA_IMMUTABLE',
      status: 409,
    });
    await expect(mismatch.status('a')).rejects.toMatchObject({
      code: 'INIT_MISMATCH',
      status: 409,
    });
  });

  it('CHUNKS_MISSING carries details.missingChunks — the resume instruction itself', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'CHUNKS_MISSING', message: 'm', details: { missingChunks: [2, 5] } } },
        422,
      ),
    );
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    const error = await transport.complete('m-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaTransportError);
    expect((error as MediaTransportError).missingChunks).toEqual([2, 5]);
  });

  it('an unparseable body (a proxy, a captive portal) yields code:null, not a thrown parse error', async () => {
    // A JSON parse exception escaping the adapter would bypass the drain's whole classification
    // table and reject the cycle. code:null is read as a network-class failure — retry, correctly.
    const fetchMock = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    const error = await transport.status('m-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaTransportError);
    expect((error as MediaTransportError).code).toBeNull();
    expect((error as MediaTransportError).status).toBe(502);
  });
});

describe('endpoints (api/03 §3)', () => {
  it('init POSTs the body as PLAIN json — no gzip on this surface at all', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ chunkSize: 262144, totalChunks: 1, receivedChunks: [], status: 'receiving' }),
    );
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    const body = {
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1, location: null, userId: 'u', deviceId: 'd' },
    };
    const result = await transport.init('m-1', body);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/media/m-1/init`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(result.chunkSize).toBe(262144);
  });

  it('status and complete hit their documented paths and methods', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'complete' }));
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    await transport.complete('m-9');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/media/m-9/complete`);
    expect(init.method).toBe('POST');
  });

  it('download returns raw bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    expect(Array.from(await transport.download('m-1'))).toEqual([1, 2, 3]);
  });
});

describe('matchesServerHash — api/03 §3.5s ETag/If-None-Match, the only wire path to the server hash', () => {
  it('sends If-None-Match with our quoted sha256', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    const transport = transportWith(fetchMock as unknown as typeof fetch);
    const hash = 'b'.repeat(64);
    await transport.matchesServerHash('m-1', hash);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe(`"${hash}"`);
  });

  it('304 => true (the hashes match, and no body crossed the wire)', async () => {
    const transport = transportWith(
      vi.fn(async () => new Response(null, { status: 304 })) as never,
    );
    expect(await transport.matchesServerHash('m-1', 'c'.repeat(64))).toBe(true);
  });

  it('200 => false (the server holds different bytes under our id)', async () => {
    const transport = transportWith(
      vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 })) as never,
    );
    expect(await transport.matchesServerHash('m-1', 'c'.repeat(64))).toBe(false);
  });

  it('404 REJECTS rather than answering false — "cannot confirm" is not "does not match"', async () => {
    // The drain treats a rejection here as LOCAL_CORRUPT-class (fail closed). Answering `false`
    // would be a claim we cannot support, and answering `true` would mark evidence uploaded on an
    // assumption — after which the pruning pass deletes the local file (06 §7).
    const transport = transportWith(
      vi.fn(async () =>
        jsonResponse({ error: { code: 'MEDIA_NOT_FOUND', message: '' } }, 404),
      ) as never,
    );
    await expect(transport.matchesServerHash('m-1', 'c'.repeat(64))).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });
});

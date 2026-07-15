// Gzip request-decompression middleware — SECURITY SURFACE (api/00 §5.2, CLAUDE.md §2.5).
// Unit-level: the middleware in isolation (no bodyLimit ahead of it, so the bound witness sees
// the real source). The full production chain is exercised by sec-sync.test.ts / chaos-10.test.ts.
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import type { AppEnv } from '../../src/env.js';
import { ApiError, respondError } from '../../src/errors.js';
import { gzipDecompress } from '../../src/middleware/gzip-decompress.js';
import { gzipBomb, gzipJson, truncatedGzip } from '../helpers/gzip.js';

const CAP = 1024 * 1024; // 1 MiB decompressed cap for the unit app.

/** Minimal app: onError envelope mapping + the gzip middleware + a handler that reads the body. */
function gzipApp(cap = CAP, onProgress?: (n: number) => void) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) =>
    err instanceof ApiError
      ? respondError(c, err.code, err.details)
      : respondError(c, 'INTERNAL', { requestId: 'unit' }),
  );
  const gz = onProgress
    ? gzipDecompress({ maxDecompressedBytes: cap, onProgress })
    : gzipDecompress({ maxDecompressedBytes: cap });
  return app.post('/', gz, async (c) => {
    const body = await c.req.json();
    return c.json({ body, contentEncodingSeen: c.req.header('Content-Encoding') ?? null });
  });
}

function bufferRequest(body: Uint8Array, headers: Record<string, string>): Request {
  return new Request('http://unit.test/', { method: 'POST', headers, body });
}

describe('gzip request decompression', () => {
  test('absent Content-Encoding passes through untouched', async () => {
    const payload = { note: 'plain-42' };
    const res = await gzipApp().request(
      bufferRequest(Buffer.from(JSON.stringify(payload)), { 'Content-Type': 'application/json' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: payload, contentEncodingSeen: null });
  });

  test('identity Content-Encoding passes through untouched', async () => {
    const payload = { note: 'identity-7' };
    const res = await gzipApp().request(
      bufferRequest(Buffer.from(JSON.stringify(payload)), {
        'Content-Type': 'application/json',
        'Content-Encoding': 'identity',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: payload });
  });

  test('valid gzip is decompressed, presented intact, header stripped', async () => {
    const payload = { note: 'compressed-99', deep: { a: [1, 2, 3] } };
    const res = await gzipApp().request(
      bufferRequest(gzipJson(payload), {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      }),
    );
    expect(res.status).toBe(200);
    // Header stripped for the handler; body arrives intact.
    expect(await res.json()).toEqual({ body: payload, contentEncodingSeen: null });
  });

  test.each(['deflate', 'br', 'gzip, gzip', 'gzip,gzip'])(
    'unsupported encoding %s → 415',
    async (encoding) => {
      const res = await gzipApp().request(
        bufferRequest(gzipJson({ x: encoding }), {
          'Content-Type': 'application/json',
          'Content-Encoding': encoding,
        }),
      );
      expect(res.status).toBe(415);
      expect((await readError(res)).error.code).toBe('UNSUPPORTED_ENCODING');
    },
  );

  test('truncated gzip → 400 MALFORMED_REQUEST', async () => {
    const res = await gzipApp().request(
      bufferRequest(truncatedGzip({ note: 'cut-off-3' }), {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      }),
    );
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
  });

  test('non-gzip bytes labeled gzip → 400 MALFORMED_REQUEST', async () => {
    const res = await gzipApp().request(
      bufferRequest(Buffer.from('this is definitely not gzip'), {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      }),
    );
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
  });

  // The BOUND WITNESS (coordinator requirement, CLAUDE.md §2.11): a gzip bomb must be aborted
  // MID-INFLATION, not inflated-then-measured. DecompressionStream yields output lazily and
  // honors backpressure, so the observable bound is on the OUTPUT: the middleware never counts
  // (nor buffers) more than ~cap + one chunk of decompressed bytes. `onProgress` reports the
  // running decompressed count; a 200 MiB bomb whose full inflation the naive
  // "read-all-then-check" implementation WOULD materialize is capped here to just over 1 MiB.
  // Against the naive impl this test goes RED (peak jumps to ~200 MiB, or onProgress never
  // fires) — see the falsification recorded in the task report.
  test('gzip bomb is aborted mid-inflation at the cap (bounded work)', async () => {
    const bombDecompressedSize = 200 * 1024 * 1024; // 200 MiB — full inflation would be enormous.
    const bomb = gzipBomb(bombDecompressedSize);
    expect(bomb.byteLength).toBeLessThan(CAP); // wire bytes sail past a byte-cap; only this defends.

    let peakDecompressed = 0;
    const res = await gzipApp(CAP, (n) => {
      if (n > peakDecompressed) peakDecompressed = n;
    }).request(
      bufferRequest(bomb, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }),
    );

    expect(res.status).toBe(413);
    const body = await readError(res);
    expect(body.error.code).toBe('DECOMPRESSED_TOO_LARGE');
    expect(body.error.details.limitBytes).toBe(CAP);
    // Bound witnesses: decompression DID run past the cap (so the cap, not bodyLimit, tripped)…
    expect(peakDecompressed).toBeGreaterThan(CAP);
    // …but was aborted immediately — never approaching the bomb's full 200 MiB inflation.
    expect(peakDecompressed).toBeLessThan(CAP + 8 * 1024 * 1024); // ≤ cap + one chunk of slack
    expect(peakDecompressed).toBeLessThan(bombDecompressedSize / 4);
  });
});

// No unhandled rejection may escape the middleware on any decode-failure path (SEC-SYNC-08).
describe('gzip middleware releases resources cleanly', () => {
  let unhandled: unknown[];
  const capture = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', capture);
  });
  afterEach(() => {
    process.off('unhandledRejection', capture);
  });

  test('truncated + malformed streams raise no unhandledRejection', async () => {
    const app = gzipApp();
    await app.request(
      bufferRequest(truncatedGzip({ a: 1 }), {
        'Content-Encoding': 'gzip',
        'Content-Type': 'application/json',
      }),
    );
    await app.request(
      bufferRequest(Buffer.from('garbage'), {
        'Content-Encoding': 'gzip',
        'Content-Type': 'application/json',
      }),
    );
    // Let any stray microtask/rejection settle before asserting the absence.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});

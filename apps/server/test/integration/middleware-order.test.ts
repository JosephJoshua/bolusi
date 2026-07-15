// Middleware order is load-bearing (api/00 §13): bearerAuth → bodyLimit → gzip-decompress →
// zValidator. Each case proves the order by observing that an EARLIER stage's rejection
// pre-empts a LATER stage, witnessed by spies on the later stages (gzip onProgress; the stub
// handler; the response code that only one ordering can produce).
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import {
  DECOMPRESSED_CAP_DEFAULT,
  DECOMPRESSED_CAP_SYNC_PUSH,
  WIRE_CAP_DEFAULT,
  WIRE_CAP_SYNC_PUSH,
} from '../../src/deps.js';
import { enrollDevice, makeTestApp, type TestHarness } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';
import { gzipBomb } from '../helpers/gzip.js';

const PUSH = 'http://srv.test/v1/sync/push';
const PUSH_TOKENS = 'http://srv.test/v1/push/tokens';

function authFor(h: TestHarness, seed: string): { auth: string; deviceId: string } {
  const fx = makeFixture(seed);
  const auth = enrollDevice(h, {
    deviceId: fx.deviceId,
    tenantId: fx.tenantId,
    storeId: fx.storeId,
    token: fx.deviceToken,
  });
  return { auth, deviceId: fx.deviceId };
}

function req(url: string, body: Uint8Array, headers: Record<string, string>): Request {
  return new Request(url, { method: 'POST', headers, body });
}

describe('middleware order (api/00 §13)', () => {
  test('invalid bearer + oversized body → 401: auth fires before bodyLimit, body never read', async () => {
    let gzipRan = false;
    const h = makeTestApp({ gzipOnProgress: () => (gzipRan = true) });
    const oversized = Buffer.alloc(WIRE_CAP_SYNC_PUSH + 4096, 0x41); // > wire cap
    const res = await h.app.request(
      req(PUSH, oversized, {
        Authorization: 'Bearer bdt_bogustoken00000',
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      }),
    );
    // If bodyLimit ran first we'd see 413; a 401 proves auth (step 6) pre-empted the body caps.
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_INVALID');
    expect(gzipRan).toBe(false); // gzip (step 9) never reached
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('wire bytes > cap (gzip) → 413 BODY_TOO_LARGE: bodyLimit before decompression', async () => {
    let gzipRan = false;
    const h = makeTestApp({ gzipOnProgress: () => (gzipRan = true) });
    const { auth } = authFor(h, 'order-wire');
    const oversized = Buffer.alloc(WIRE_CAP_SYNC_PUSH + 4096, 0x41);
    const res = await h.app.request(
      req(PUSH, oversized, {
        Authorization: auth,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      }),
    );
    expect(res.status).toBe(413);
    expect((await readError(res)).error.code).toBe('BODY_TOO_LARGE');
    expect(gzipRan).toBe(false); // decompression (step 9) never invoked
  });

  test('bomb within wire cap → 413 DECOMPRESSED_TOO_LARGE: gzip cap before zValidator', async () => {
    const h = makeTestApp();
    const { auth } = authFor(h, 'order-bomb');
    const res = await h.app.request(
      req(PUSH, gzipBomb(50 * 1024 * 1024), {
        Authorization: auth,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      }),
    );
    expect(res.status).toBe(413);
    expect((await readError(res)).error.code).toBe('DECOMPRESSED_TOO_LARGE');
    expect(h.stubCalls).not.toContain('sync.push'); // zValidator + handler (steps 10-11) never ran
  });

  describe('route-class caps (api/00 §5.3), both codes carry details.limitBytes', () => {
    test('sync push: wire cap 1 MiB', async () => {
      const h = makeTestApp();
      const { auth } = authFor(h, 'caps-sync-wire');
      const res = await h.app.request(
        req(PUSH, Buffer.alloc(WIRE_CAP_SYNC_PUSH + 1, 0x41), {
          Authorization: auth,
          'Content-Type': 'application/json',
        }),
      );
      expect(res.status).toBe(413);
      const body = await readError(res);
      expect(body.error.code).toBe('BODY_TOO_LARGE');
      expect(body.error.details.limitBytes).toBe(WIRE_CAP_SYNC_PUSH);
    });

    test('sync push: decompressed cap 10 MiB', async () => {
      const h = makeTestApp();
      const { auth } = authFor(h, 'caps-sync-dec');
      const res = await h.app.request(
        req(PUSH, gzipBomb(11 * 1024 * 1024), {
          Authorization: auth,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        }),
      );
      expect(res.status).toBe(413);
      const body = await readError(res);
      expect(body.error.code).toBe('DECOMPRESSED_TOO_LARGE');
      expect(body.error.details.limitBytes).toBe(DECOMPRESSED_CAP_SYNC_PUSH);
    });

    test('default route: wire cap 256 KiB', async () => {
      const h = makeTestApp();
      const { auth } = authFor(h, 'caps-def-wire');
      const res = await h.app.request(
        req(PUSH_TOKENS, Buffer.alloc(WIRE_CAP_DEFAULT + 1, 0x41), {
          Authorization: auth,
          'Content-Type': 'application/json',
        }),
      );
      expect(res.status).toBe(413);
      const body = await readError(res);
      expect(body.error.code).toBe('BODY_TOO_LARGE');
      expect(body.error.details.limitBytes).toBe(WIRE_CAP_DEFAULT);
    });

    test('default route: decompressed cap 1 MiB', async () => {
      const h = makeTestApp();
      const { auth } = authFor(h, 'caps-def-dec');
      const res = await h.app.request(
        req(PUSH_TOKENS, gzipBomb(2 * 1024 * 1024), {
          Authorization: auth,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        }),
      );
      expect(res.status).toBe(413);
      const body = await readError(res);
      expect(body.error.code).toBe('DECOMPRESSED_TOO_LARGE');
      expect(body.error.details.limitBytes).toBe(DECOMPRESSED_CAP_DEFAULT);
    });
  });

  describe('realtime routes carry the reduced chain (§13 last line)', () => {
    test('bearerAuth applies (no token → 401)', async () => {
      const h = makeTestApp();
      const res = await h.app.request('http://srv.test/v1/realtime');
      expect(res.status).toBe(401);
    });

    test('per-device limiter uses the realtime bucket, and no body middleware is on the path', async () => {
      const h = makeTestApp();
      const { auth, deviceId } = authFor(h, 'rt');
      const res = await h.app.request('http://srv.test/v1/realtime', {
        headers: { Authorization: auth },
      });
      expect(res.status).toBe(200); // reaches the stub — reduced chain, no body middleware blocks it
      // Step 7 ran with the realtime bucket (cap 10), not the default route bucket.
      const keys = h.perDeviceStore.calls.map((call) => call.key);
      expect(keys).toContain(`dev:realtime:${deviceId}`);
      expect(keys).not.toContain(`dev:route:${deviceId}`);
    });
  });
});

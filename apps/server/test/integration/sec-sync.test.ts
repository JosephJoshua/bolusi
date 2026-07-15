// Named sync-endpoint adversarial tests (security-guide §4.2) — titles embed the SEC id verbatim
// so SEC-META-01 can grep them. They run against the PRODUCTION middleware chain on the real
// /v1/sync/push mount (stub handler); task 16 inherits and keeps them green. The decompressed
// cap here is the sync class's 10 MiB (api/00 §5.3).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { DECOMPRESSED_CAP_SYNC_PUSH, WIRE_CAP_SYNC_PUSH } from '../../src/deps.js';
import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';
import { gzipBomb, truncatedGzip } from '../helpers/gzip.js';

const PUSH = 'http://srv.test/v1/sync/push';
const PULL = 'http://srv.test/v1/sync/pull';

function gzipReq(url: string, body: Uint8Array, auth: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    body,
  });
}

function jsonReq(url: string, value: unknown, auth?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== undefined) headers['Authorization'] = auth;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(value) });
}

// "No body processing occurs / validator never runs" (security-guide §4.2) is witnessed
// LOGICALLY: bearerAuth (§13 step 6) rejects strictly before bodyLimit/gzip/zValidator (steps
// 8–10), so a 401 carrying an AUTH_* code — never a body-layer 400/413/415/422 — proves the body
// pipeline never ran, and an empty stubCalls proves the handler never ran. (A live body-read
// witness is unusable here: the Node/undici transport drains an unconsumed request body while
// finalizing the error response, which is transport cleanup, not app processing.) The bodyLimit
// spy proof that auth precedes the body cap lives in middleware-order.test.ts.
describe('SEC-SYNC-01 unauthenticated sync rejected', () => {
  test('SEC-SYNC-01 unauthenticated push → 401 AUTH_TOKEN_MISSING, no body processing', async () => {
    const h = makeTestApp();
    const res = await h.app.request(
      jsonReq(PUSH, { deviceId: makeFixture('s1').deviceId, ops: [] }),
    );
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_MISSING'); // auth layer, not a body layer
    expect(h.stubCalls).not.toContain('sync.push'); // handler never executed
  });

  test('SEC-SYNC-01 unauthenticated pull → 401 AUTH_TOKEN_MISSING, no body processing', async () => {
    const h = makeTestApp();
    const res = await h.app.request(jsonReq(PULL, { cursor: 0, devicesDirectoryVersion: 0 }));
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_MISSING');
    expect(h.stubCalls).not.toContain('sync.pull');
  });

  test('SEC-SYNC-01 unknown bearer token → 401 AUTH_TOKEN_INVALID, no body processing', async () => {
    const h = makeTestApp();
    const res = await h.app.request(
      jsonReq(
        PUSH,
        { deviceId: makeFixture('s1b').deviceId, ops: [] },
        'Bearer bdt_unknowntoken0000',
      ),
    );
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_INVALID'); // auth layer, not a body layer
    expect(h.stubCalls).not.toContain('sync.push');
  });
});

describe('SEC-SYNC-04 gzip bomb bounded', () => {
  test('SEC-SYNC-04 ~50 KiB wire body inflating past 10 MiB → 413 at the cap, bounded', async () => {
    let peak = 0;
    const h = makeTestApp({
      gzipOnProgress: (n) => {
        if (n > peak) peak = n;
      },
    });
    const fx = makeFixture('s4');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });

    const fullInflation = 50 * 1024 * 1024; // 50 MiB decompressed…
    const bomb = gzipBomb(fullInflation); // …compresses to ~50 KiB wire.
    expect(bomb.byteLength).toBeLessThan(WIRE_CAP_SYNC_PUSH); // sails through the 1 MiB wire cap
    const res = await h.app.request(gzipReq(PUSH, bomb, auth));

    expect(res.status).toBe(413);
    const body = await readError(res);
    expect(body.error.code).toBe('DECOMPRESSED_TOO_LARGE'); // decompressed cap tripped, not the wire cap
    expect(body.error.details.limitBytes).toBe(DECOMPRESSED_CAP_SYNC_PUSH);
    expect(h.stubCalls).not.toContain('sync.push'); // no op processed → no partial acceptance
    // Bounded work: aborted just past the cap, never approaching the full 50 MiB inflation.
    expect(peak).toBeGreaterThan(DECOMPRESSED_CAP_SYNC_PUSH);
    expect(peak).toBeLessThan(DECOMPRESSED_CAP_SYNC_PUSH + 8 * 1024 * 1024);
    expect(peak).toBeLessThan(fullInflation / 2);
  });
});

describe('SEC-SYNC-08 truncated gzip stream', () => {
  let unhandled: unknown[];
  const capture = (r: unknown): void => {
    unhandled.push(r);
  };
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', capture);
  });
  afterEach(() => {
    process.off('unhandledRejection', capture);
  });

  test('SEC-SYNC-08 truncated gzip → 400, no unhandled rejection, nothing accepted', async () => {
    const h = makeTestApp();
    const fx = makeFixture('s8');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });

    const res = await h.app.request(
      gzipReq(PUSH, truncatedGzip({ deviceId: fx.deviceId, ops: [] }), auth),
    );
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
    expect(h.stubCalls).not.toContain('sync.push');

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});

describe('SEC-SYNC-10 wrong content-encoding', () => {
  test('SEC-SYNC-10 gzip header on uncompressed JSON → 400, no hang, no pass-through', async () => {
    const h = makeTestApp();
    const fx = makeFixture('s10');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });

    // Uncompressed JSON bytes, but labeled gzip.
    const raw = Buffer.from(JSON.stringify({ deviceId: fx.deviceId, ops: [] }), 'utf8');
    const res = await h.app.request(gzipReq(PUSH, raw, auth));
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
    expect(h.stubCalls).not.toContain('sync.push'); // not passed through to the handler
  });
});

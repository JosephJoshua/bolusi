// CHAOS-10 (testing-guide §3.6) G1–G5 gzip matrix, implemented as integration tests against the
// production chain (bearerAuth → bodyLimit → decompression cap → zValidator) on /v1/sync/push.
// The harness-scenario packaging is task 26; the case coverage lands here. PASS: zero ops
// persisted from G1–G4, and the immediately-following valid push (G5 re-run) succeeds — the
// server survives.
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { WIRE_CAP_SYNC_PUSH } from '../../src/deps.js';
import { enrollDevice, makeTestApp, type TestHarness } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';
import { gzipBomb, gzipJson, truncatedGzip } from '../helpers/gzip.js';

const PUSH = 'http://srv.test/v1/sync/push';

function bodyReq(body: Uint8Array, auth: string, gzip: boolean): Request {
  const headers: Record<string, string> = {
    Authorization: auth,
    'Content-Type': 'application/json',
  };
  if (gzip) headers['Content-Encoding'] = 'gzip';
  return new Request(PUSH, { method: 'POST', headers, body });
}

function harnessWithDevice(seed: string): { h: TestHarness; auth: string; deviceId: string } {
  const h = makeTestApp();
  const fx = makeFixture(seed);
  const auth = enrollDevice(h, {
    deviceId: fx.deviceId,
    tenantId: fx.tenantId,
    storeId: fx.storeId,
    token: fx.deviceToken,
  });
  return { h, auth, deviceId: fx.deviceId };
}

describe('CHAOS-10 gzip bomb + malformed gzip on push', () => {
  test('G1 gzip bomb within wire cap → 413, no op persisted', async () => {
    const { h, auth } = harnessWithDevice('g1');
    const res = await h.app.request(bodyReq(gzipBomb(200 * 1024 * 1024), auth, true));
    expect(res.status).toBe(413);
    expect((await readError(res)).error.code).toBe('DECOMPRESSED_TOO_LARGE');
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('G2 truncated gzip → 400, no op persisted', async () => {
    const { h, auth, deviceId } = harnessWithDevice('g2');
    const res = await h.app.request(bodyReq(truncatedGzip({ deviceId, ops: [] }), auth, true));
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('G3 non-gzip bytes labeled gzip → 400, no op persisted', async () => {
    const { h, auth } = harnessWithDevice('g3');
    const res = await h.app.request(bodyReq(Buffer.from('not gzip at all'), auth, true));
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('G4 wire bytes > bodyLimit → 413 before decompression runs', async () => {
    let gzipRan = false;
    const h = makeTestApp({ gzipOnProgress: () => (gzipRan = true) });
    const fx = makeFixture('g4');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    // > 1 MiB wire (sync push cap), labeled gzip. bodyLimit must reject before the gzip mw runs.
    const oversized = Buffer.alloc(WIRE_CAP_SYNC_PUSH + 1024, 0x41);
    const res = await h.app.request(bodyReq(oversized, auth, true));
    expect(res.status).toBe(413);
    const body = await readError(res);
    expect(body.error.code).toBe('BODY_TOO_LARGE');
    expect(body.error.details.limitBytes).toBe(WIRE_CAP_SYNC_PUSH);
    expect(gzipRan).toBe(false); // decompression never invoked
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('G5 valid gzip within both caps → 200, and an immediate re-run also succeeds (survival)', async () => {
    const { h, auth, deviceId } = harnessWithDevice('g5');
    const valid = gzipJson({ deviceId, ops: [] });

    const first = await h.app.request(bodyReq(valid, auth, true));
    expect(first.status).toBe(200);
    expect(h.stubCalls).toContain('sync.push');

    // Server survives a prior rejection storm: re-run the valid push immediately.
    const second = await h.app.request(bodyReq(gzipJson({ deviceId, ops: [] }), auth, true));
    expect(second.status).toBe(200);
    expect(h.stubCalls.filter((k) => k === 'sync.push')).toHaveLength(2);
  });

  test('G1–G4 rejected then G5 succeeds on the SAME server instance (survival across the matrix)', async () => {
    const { h, auth, deviceId } = harnessWithDevice('gmatrix');
    // G1
    expect((await h.app.request(bodyReq(gzipBomb(50 * 1024 * 1024), auth, true))).status).toBe(413);
    // G2
    expect(
      (await h.app.request(bodyReq(truncatedGzip({ deviceId, ops: [] }), auth, true))).status,
    ).toBe(400);
    // G3
    expect((await h.app.request(bodyReq(Buffer.from('garbage'), auth, true))).status).toBe(400);
    // G4
    expect(
      (await h.app.request(bodyReq(Buffer.alloc(WIRE_CAP_SYNC_PUSH + 512, 1), auth, true))).status,
    ).toBe(413);
    // No op processed by any rejection.
    expect(h.stubCalls).not.toContain('sync.push');
    // G5 — the server still serves a valid push.
    const g5 = await h.app.request(bodyReq(gzipJson({ deviceId, ops: [] }), auth, true));
    expect(g5.status).toBe(200);
    expect(h.stubCalls).toContain('sync.push');
  });
});

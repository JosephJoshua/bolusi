// Response headers on EVERY response (api/00 §5.1, §9): X-Server-Time (integer ms) and
// X-Request-Id (UUIDv7 per request) — success and every error status alike.
import { describe, expect, test } from 'vitest';

import { zUuidV7 } from '@bolusi/schemas';

import { WIRE_CAP_SYNC_PUSH } from '../../src/deps.js';
import { enrollDevice, makeTestApp, type TestHarness } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';

const PUSH = 'http://srv.test/v1/sync/push';
const DEVICES = 'http://srv.test/v1/devices';

function deviceAuth(h: TestHarness, seed: string): { auth: string; deviceId: string } {
  const fx = makeFixture(seed);
  const auth = enrollDevice(h, {
    deviceId: fx.deviceId,
    tenantId: fx.tenantId,
    storeId: fx.storeId,
    token: fx.deviceToken,
  });
  return { auth, deviceId: fx.deviceId };
}

/** One request per status the middleware chain must stamp headers on. */
async function responseWithStatus(status: number): Promise<Response> {
  switch (status) {
    case 200: {
      // /v1/devices is a real (DB-backed) handler now; probe the still-stub /v1/sync/push for a
      // DB-free 200.
      const h = makeTestApp();
      const { auth, deviceId } = deviceAuth(h, `hdr-200`);
      return h.app.request(
        new Request(PUSH, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, ops: [] }),
        }),
      );
    }
    case 401:
      return makeTestApp().app.request(DEVICES);
    case 404: {
      const h = makeTestApp();
      const { auth } = deviceAuth(h, 'hdr-404');
      return h.app.request('http://srv.test/v1/nope', { headers: { Authorization: auth } });
    }
    case 413: {
      const h = makeTestApp();
      const { auth } = deviceAuth(h, 'hdr-413');
      return h.app.request(
        new Request(PUSH, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: Buffer.alloc(WIRE_CAP_SYNC_PUSH + 1, 0x41),
        }),
      );
    }
    case 422: {
      const h = makeTestApp();
      const { auth } = deviceAuth(h, 'hdr-422');
      return h.app.request(
        new Request(PUSH, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'not-a-uuid', ops: [] }),
        }),
      );
    }
    case 429: {
      const h = makeTestApp();
      const { auth, deviceId } = deviceAuth(h, 'hdr-429');
      h.perDeviceStore.denyKeys.add(`dev:route:${deviceId}`);
      return h.app.request(DEVICES, { headers: { Authorization: auth } });
    }
    case 500: {
      const h = makeTestApp({
        onStub: () => {
          throw new Error('boom');
        },
      });
      const { auth, deviceId } = deviceAuth(h, 'hdr-500');
      return h.app.request(
        new Request(PUSH, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, ops: [] }),
        }),
      );
    }
    default:
      throw new Error(`unhandled status ${status}`);
  }
}

describe('X-Server-Time is present and an integer on every status', () => {
  test.each([200, 401, 404, 413, 422, 429, 500])('status %i', async (status) => {
    const res = await responseWithStatus(status);
    expect(res.status).toBe(status);
    const header = res.headers.get('X-Server-Time');
    expect(header).not.toBeNull();
    expect(header).toMatch(/^\d+$/); // integer ms epoch
    expect(Number.isInteger(Number(header))).toBe(true);
  });
});

describe('X-Request-Id is a UUIDv7 present on every status', () => {
  test.each([200, 401, 404, 413, 422, 429, 500])('status %i', async (status) => {
    const res = await responseWithStatus(status);
    const header = res.headers.get('X-Request-Id');
    expect(header).not.toBeNull();
    expect(zUuidV7.safeParse(header).success).toBe(true);
  });

  test('each request gets a distinct X-Request-Id', async () => {
    const h = makeTestApp();
    const a = await h.app.request('http://srv.test/v1/nope');
    const b = await h.app.request('http://srv.test/v1/nope');
    expect(a.headers.get('X-Request-Id')).not.toBe(b.headers.get('X-Request-Id'));
  });
});

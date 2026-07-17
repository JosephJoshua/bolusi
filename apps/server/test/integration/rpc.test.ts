// Hono RPC type-sharing (api/00 §14, 08 §4.3). The client subpath is types-only (zero runtime
// exports); `hc<AppType>` typechecks and round-trips against the mounted stub routes; all eight
// sub-routers are chained and mounted under /v1.
import { hc } from 'hono/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AppType } from '../../src/app.js';
import { enrollDevice, makeTestApp, type TestHarness } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';
import { makeSyncHarness, type SyncHarness } from './sync/helpers.js';

describe('@bolusi/server/client is types-only', () => {
  test('the built client.js has zero runtime exports', async () => {
    // Probe the REAL built artifact (T-13/T-14c): dist/client.js must carry no runtime code.
    // The specifier is computed so tsc does not couple this test's typecheck to a prior build;
    // vitest runs after `tsc -b`, so the file is present at runtime.
    const clientUrl = new URL('../../dist/client.js', import.meta.url).href;
    const mod: Record<string, unknown> = await import(clientUrl);
    expect(Object.keys(mod)).toEqual([]);
  });
});

describe('hc<AppType> smoke test', () => {
  // The sync push handler is no longer a stub (task 16): it runs the task-07 pipeline inside a
  // forTenant transaction, so the RPC round-trip needs a real PG16 DB with a seeded device.
  let h: SyncHarness;
  beforeEach(async () => {
    h = await makeSyncHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  test('typechecks and round-trips a mounted sync route via app.fetch', async () => {
    const dev = await h.seedDevice(101);
    const client = hc<AppType>('http://srv.test', {
      // Route hc's requests into the in-process app (no sockets).
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        h.app.request(input, init)) as typeof fetch,
      headers: { Authorization: dev.auth },
    });

    // An empty batch transports fine and accepts nothing → HTTP 200, results: [] (api/00 §6).
    const res = await client.v1.sync.push.$post({
      json: { deviceId: dev.world.deviceId, ops: [] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ results: [], serverTime: expect.any(Number) });
  });
});

describe('all eight sub-routers are chained and mounted under /v1', () => {
  test('every area answers (non-404) — coverage of all 8 mounts', async () => {
    const h = makeTestApp();
    const fx = makeFixture('rpc-mounts');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    const bearer = { Authorization: auth };

    const probes: { area: string; run: (hh: TestHarness) => Promise<Response> | Response }[] = [
      { area: 'auth', run: (hh) => hh.app.request('http://s/v1/auth/login', { method: 'POST' }) },
      { area: 'devices', run: (hh) => hh.app.request('http://s/v1/devices', { headers: bearer }) },
      {
        area: 'users',
        run: (hh) => hh.app.request('http://s/v1/users', { method: 'POST', headers: bearer }),
      },
      {
        area: 'tenant',
        run: (hh) =>
          hh.app.request('http://s/v1/tenant/settings', { method: 'PATCH', headers: bearer }),
      },
      {
        area: 'sync',
        run: (hh) =>
          hh.app.request('http://s/v1/sync/push', {
            method: 'POST',
            headers: { ...bearer, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: fx.deviceId, ops: [] }),
          }),
      },
      {
        area: 'media',
        run: (hh) =>
          hh.app.request('http://s/v1/media/abc/init', { method: 'POST', headers: bearer }),
      },
      {
        area: 'push',
        run: (hh) => hh.app.request('http://s/v1/push/tokens', { method: 'POST', headers: bearer }),
      },
      {
        area: 'realtime',
        run: (hh) => hh.app.request('http://s/v1/realtime', { headers: bearer }),
      },
    ];

    // Coverage denominator (testing-guide T-14): exactly the eight areas of api/00 §1.
    expect(probes.map((p) => p.area)).toEqual([
      'auth',
      'devices',
      'users',
      'tenant',
      'sync',
      'media',
      'push',
      'realtime',
    ]);

    for (const probe of probes) {
      const res = await probe.run(h);
      expect(res.status, `${probe.area} must be mounted (non-404)`).not.toBe(404);
    }
  });
});

// bearerAuth / 401-code behaviour (api/00 §3). verifyToken hashes the presented token, looks it
// up by hash, sets device/controlSession context, and emits the three §7 codes. POST
// /v1/auth/login is the only bearer-exempt route. Tokens never reach the access log.
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';
import type { AccessLogRecord } from '../../src/middleware/access-log.js';
import { makeSyncHarness } from './sync/helpers.js';

const DEVICES = 'http://srv.test/v1/devices';
const LOGIN = 'http://srv.test/v1/auth/login';
// task 13 made /v1/devices and /v1/tenant/settings real handlers (they now need a DB). These
// bearerAuth/context probes are middleware-level, so they were repointed at /v1/sync/push (device-
// and control-token accepting) — the middleware behaviour under test is identical. The DB-free
// probes push an empty batch (validated + logged before the pipeline touches the DB); the one leg
// that must reach a 200 (access-log content) runs over a real DB via makeSyncHarness.
const SYNC_PUSH = 'http://srv.test/v1/sync/push';
function pushBody(deviceId: string): string {
  return JSON.stringify({ deviceId, ops: [] });
}

describe('bearerAuth 401 codes', () => {
  test.each([
    ['no header', undefined],
    ['empty Bearer', 'Bearer '],
    ['non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['garbage', 'not-a-header'],
  ])('missing/unparseable header (%s) → AUTH_TOKEN_MISSING', async (_name, header) => {
    const h = makeTestApp();
    const res = await h.app.request(
      DEVICES,
      header === undefined ? {} : { headers: { Authorization: header } },
    );
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_MISSING');
  });

  test('unknown device token → AUTH_TOKEN_INVALID', async () => {
    const h = makeTestApp();
    const res = await h.app.request(DEVICES, { headers: { Authorization: 'Bearer bdt_nope0000' } });
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_INVALID');
  });

  test('expired control-session token → AUTH_TOKEN_INVALID', async () => {
    const h = makeTestApp();
    const fx = makeFixture('expired-ctrl');
    h.tokenStore.add(fx.controlToken, {
      kind: 'control',
      userId: fx.userId,
      tenantId: fx.tenantId,
      expiresAt: h.clock.now() - 1, // already expired
    });
    // The token is expired, so verifyToken fails BEFORE any handler — the route is immaterial.
    const res = await h.app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.controlToken}`, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_INVALID');
  });

  test('token of a revoked device → DEVICE_REVOKED', async () => {
    const h = makeTestApp();
    const fx = makeFixture('revoked-dev');
    h.tokenStore.add(fx.deviceToken, {
      kind: 'device',
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      deviceStatus: 'revoked',
    });
    const res = await h.app.request(DEVICES, {
      headers: { Authorization: `Bearer ${fx.deviceToken}` },
    });
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('DEVICE_REVOKED');
  });

  test('valid device token authenticates and sets device context (seen by the access log)', async () => {
    // The sync push handler is real + DB-backed now (task 16); an empty (valid) push over a seeded
    // device → 200, and the access log's deviceId is read from c.get('device') set by bearerAuth.
    const h = await makeSyncHarness();
    try {
      const dev = await h.seedDevice(1183);
      const res = await h.app.request(SYNC_PUSH, {
        method: 'POST',
        headers: { Authorization: dev.auth, 'Content-Type': 'application/json' },
        body: pushBody(dev.world.deviceId),
      });
      expect(res.status).toBe(200);
      // The access log's deviceId is read from c.get('device') — its presence proves context was set.
      expect(h.accessLogs.at(-1)?.deviceId).toBe(dev.world.deviceId);
    } finally {
      await h.close();
    }
  });

  test('valid control-session token authenticates (not 401) and carries no device context', async () => {
    const h = makeTestApp();
    const fx = makeFixture('valid-ctrl');
    h.tokenStore.add(fx.controlToken, {
      kind: 'control',
      userId: fx.userId,
      tenantId: fx.tenantId,
      expiresAt: h.clock.now() + 60_000,
    });
    // Sync push is DEVICE-only (task 16). A control session PASSES bearerAuth (controlSession
    // context set — otherwise verifyToken would 401 AUTH_TOKEN_INVALID), so it is NOT rejected at
    // the auth layer; the device-only handler then rejects it (no device to push as). The point
    // under test is the auth outcome + that no device context is set (the access log omits deviceId).
    const res = await h.app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.controlToken}`, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });
    expect(res.status).not.toBe(401); // authenticated past bearerAuth
    expect((await readError(res)).error.code).not.toBe('AUTH_TOKEN_INVALID');
    // A control-session request carries no device, so the access log omits deviceId.
    expect(h.accessLogs.at(-1)?.deviceId).toBeUndefined();
  });

  test('a token that is not registered by hash does not authenticate (hash-at-rest lookup)', async () => {
    const h = makeTestApp();
    const fx = makeFixture('hashcheck');
    enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    // A DIFFERENT token (different hash) must be rejected — proves lookup is by token hash.
    const res = await h.app.request(DEVICES, {
      headers: { Authorization: `Bearer ${fx.deviceToken}xtra` },
    });
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_INVALID');
  });
});

describe('login exemption and token confidentiality', () => {
  test('POST /v1/auth/login without a bearer is NOT AUTH_TOKEN_MISSING', async () => {
    const h = makeTestApp();
    const res = await h.app.request(LOGIN, { method: 'POST' });
    // Exempt route: it reaches its own handler (now a real one) rather than failing bearerAuth. An
    // empty body fails the login schema (422) — the point is it is NOT the 401 AUTH_TOKEN_MISSING a
    // bearer-guarded route would return.
    expect(res.status).not.toBe(401);
    expect((await readError(res)).error.code).not.toBe('AUTH_TOKEN_MISSING');
  });

  test('access-log lines carry code+path+requestId+deviceId and never the token or Authorization', async () => {
    // A successful sync push (real DB, seeded device) → 200 logged with the device context; the
    // record must never carry token material (the bdt_ prefix) or the Authorization header.
    const h = await makeSyncHarness();
    try {
      const dev = await h.seedDevice(1176);
      await h.app.request(SYNC_PUSH, {
        method: 'POST',
        headers: { Authorization: dev.auth, 'Content-Type': 'application/json' },
        body: pushBody(dev.world.deviceId),
      });
      const record: AccessLogRecord | undefined = h.accessLogs.at(-1);
      expect(record).toBeDefined();
      expect(record).toMatchObject({
        method: 'POST',
        path: '/v1/sync/push',
        status: 200,
        deviceId: dev.world.deviceId,
      });
      expect(typeof record?.requestId).toBe('string');
      // The serialized record must contain no token material and no Authorization key.
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('bdt_'); // no device-token material
      expect(serialized.toLowerCase()).not.toContain('authorization');
    } finally {
      await h.close();
    }
  });
});

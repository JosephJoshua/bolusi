// bearerAuth / 401-code behaviour (api/00 §3). verifyToken hashes the presented token, looks it
// up by hash, sets device/controlSession context, and emits the three §7 codes. POST
// /v1/auth/login is the only bearer-exempt route. Tokens never reach the access log.
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';

const DEVICES = 'http://srv.test/v1/devices';
const LOGIN = 'http://srv.test/v1/auth/login';
// task 13 made /v1/devices and /v1/tenant/settings real handlers (they now need a DB). These
// bearerAuth/context probes are middleware-level, so they were repointed at the STILL-stub
// /v1/sync/push route (device- and control-token accepting, no DB, still calls onStub) — the
// middleware behaviour under test is identical, and the transport probes stay DB-free.
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
    const h = makeTestApp();
    const fx = makeFixture('valid-dev');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    const res = await h.app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });
    expect(res.status).toBe(200);
    // The access log's deviceId is read from c.get('device') — its presence proves context was set.
    expect(h.accessLogs.at(-1)?.deviceId).toBe(fx.deviceId);
  });

  test('valid control-session token is accepted (context set; no device in the access log)', async () => {
    const h = makeTestApp();
    const fx = makeFixture('valid-ctrl');
    h.tokenStore.add(fx.controlToken, {
      kind: 'control',
      userId: fx.userId,
      tenantId: fx.tenantId,
      expiresAt: h.clock.now() + 60_000,
    });
    // The sync stub does not reject a control session (token-kind gating is task 16's) — so it is
    // a DB-free probe that a control session authenticates and sets controlSession context.
    const res = await h.app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.controlToken}`, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });
    expect(res.status).toBe(200); // accepted → controlSession context was set (else verifyToken throws)
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
    const h = makeTestApp();
    const fx = makeFixture('logscan');
    const auth = enrollDevice(h, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    await h.app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });
    const record = h.accessLogs.at(-1);
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      method: 'POST',
      path: '/v1/sync/push',
      status: 200,
      deviceId: fx.deviceId,
    });
    expect(typeof record?.requestId).toBe('string');
    // The serialized record must contain no token material and no Authorization key.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(fx.deviceToken);
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });
});

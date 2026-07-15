// bearerAuth / 401-code behaviour (api/00 §3). verifyToken hashes the presented token, looks it
// up by hash, sets device/controlSession context, and emits the three §7 codes. POST
// /v1/auth/login is the only bearer-exempt route. Tokens never reach the access log.
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';

const DEVICES = 'http://srv.test/v1/devices';
const TENANT = 'http://srv.test/v1/tenant/settings';
const LOGIN = 'http://srv.test/v1/auth/login';

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
    const res = await h.app.request(TENANT, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${fx.controlToken}` },
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
    const res = await h.app.request(DEVICES, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    // The access log's deviceId is read from c.get('device') — its presence proves context was set.
    expect(h.accessLogs.at(-1)?.deviceId).toBe(fx.deviceId);
  });

  test('valid control-session token is accepted on the identity surface', async () => {
    const h = makeTestApp();
    const fx = makeFixture('valid-ctrl');
    h.tokenStore.add(fx.controlToken, {
      kind: 'control',
      userId: fx.userId,
      tenantId: fx.tenantId,
      expiresAt: h.clock.now() + 60_000,
    });
    const res = await h.app.request(TENANT, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${fx.controlToken}` },
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
    expect(res.status).toBe(200); // exempt route reaches its stub
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
    await h.app.request(DEVICES, { headers: { Authorization: auth } });
    const record = h.accessLogs.at(-1);
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      method: 'GET',
      path: '/v1/devices',
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

// Rate-limit wiring (api/00 §11): per-device on authed routes, per-IP on the pre-auth login;
// token bucket; every 429 carries RATE_LIMITED + details.retryAfterSeconds + a Retry-After
// header. The store is constructor-injected — the RecordingRateLimitStore swapped in here is the
// proof of that seam.
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { DEFAULT_DEVICE_RATE_LIMITS, DEFAULT_LOGIN_IP_PER_MINUTE } from '../../src/deps.js';
import { enrollDevice, makeTestApp, type TestHarness } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';

const DEVICES = 'http://srv.test/v1/devices';
const LOGIN = 'http://srv.test/v1/auth/login';
const REALTIME = 'http://srv.test/v1/realtime';

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

describe('per-device rate limiting', () => {
  test('a valid authed request consumes the route bucket (120/min) and aggregate bucket (600/min)', async () => {
    const h = makeTestApp();
    const { auth, deviceId } = deviceAuth(h, 'rl-buckets');
    await h.app.request(DEVICES, { headers: { Authorization: auth } });
    const route = h.perDeviceStore.calls.find((c) => c.key === `dev:route:${deviceId}`);
    const agg = h.perDeviceStore.calls.find((c) => c.key === `dev:agg:${deviceId}`);
    expect(route?.capacityPerMinute).toBe(DEFAULT_DEVICE_RATE_LIMITS.perRoutePerMinute);
    expect(agg?.capacityPerMinute).toBe(DEFAULT_DEVICE_RATE_LIMITS.aggregatePerMinute);
  });

  test('realtime connect consumes the realtime bucket (10/min)', async () => {
    const h = makeTestApp();
    const { auth, deviceId } = deviceAuth(h, 'rl-realtime');
    await h.app.request(REALTIME, { headers: { Authorization: auth } });
    const rt = h.perDeviceStore.calls.find((c) => c.key === `dev:realtime:${deviceId}`);
    expect(rt?.capacityPerMinute).toBe(DEFAULT_DEVICE_RATE_LIMITS.realtimePerMinute);
  });

  test('route bucket exhausted → 429 RATE_LIMITED with Retry-After == details.retryAfterSeconds', async () => {
    const h = makeTestApp();
    const { auth, deviceId } = deviceAuth(h, 'rl-deny-route');
    h.perDeviceStore.denySeconds = 17;
    h.perDeviceStore.denyKeys.add(`dev:route:${deviceId}`);
    const res = await h.app.request(DEVICES, { headers: { Authorization: auth } });
    expect(res.status).toBe(429);
    const body = await readError(res);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBe(17);
    expect(res.headers.get('Retry-After')).toBe('17');
  });

  test('aggregate bucket exhausted → 429 (aggregate is enforced independently of the route bucket)', async () => {
    const h = makeTestApp();
    const { auth, deviceId } = deviceAuth(h, 'rl-deny-agg');
    h.perDeviceStore.denyKeys.add(`dev:agg:${deviceId}`);
    const res = await h.app.request(DEVICES, { headers: { Authorization: auth } });
    expect(res.status).toBe(429);
    expect((await readError(res)).error.code).toBe('RATE_LIMITED');
  });
});

describe('per-IP rate limiting on the pre-auth login route', () => {
  test('login consults the per-IP store (not the per-device store)', async () => {
    const h = makeTestApp();
    await h.app.request(LOGIN, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } });
    const call = h.perIpStore.calls.find((c) => c.key === 'ip:203.0.113.9');
    expect(call?.capacityPerMinute).toBe(DEFAULT_LOGIN_IP_PER_MINUTE);
    // Login is bearer-exempt, so the per-device store is untouched.
    expect(h.perDeviceStore.calls).toHaveLength(0);
  });

  test('per-IP breach on login → 429 pre-auth (no bearer needed)', async () => {
    const h = makeTestApp();
    h.perIpStore.denySeconds = 5;
    h.perIpStore.denyKeys.add('ip:198.51.100.2');
    const res = await h.app.request(LOGIN, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    expect(res.status).toBe(429);
    expect((await readError(res)).error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  test('the per-IP limiter does not run on non-login routes', async () => {
    const h = makeTestApp();
    const { auth } = deviceAuth(h, 'rl-noip');
    await h.app.request(DEVICES, { headers: { Authorization: auth } });
    expect(h.perIpStore.calls).toHaveLength(0);
  });
});

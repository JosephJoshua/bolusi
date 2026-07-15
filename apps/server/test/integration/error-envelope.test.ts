// Error-envelope conformance (api/00 §6–§7). Every 4xx/5xx body parses against the
// @bolusi/schemas error-envelope schema and carries the §7 registry code for its status; no 2xx
// body ever contains `error`; 422 comes from the shared hook with {path,code,message} issues and
// no input echo; 500 echoes the request id.
import { describe, expect, test } from 'vitest';
import { readError } from '../helpers/http.js';

import { zErrorEnvelope, zValidationIssue } from '@bolusi/schemas';

import { WIRE_CAP_SYNC_PUSH } from '../../src/deps.js';
import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { makeFixture } from '../helpers/fixtures.js';
import { gzipJson } from '../helpers/gzip.js';
import { makeSyncHarness } from './sync/helpers.js';

const PUSH = 'http://srv.test/v1/sync/push';
const DEVICES = 'http://srv.test/v1/devices';

function deviceAuth(
  h: ReturnType<typeof makeTestApp>,
  seed: string,
): { auth: string; deviceId: string } {
  const fx = makeFixture(seed);
  const auth = enrollDevice(h, {
    deviceId: fx.deviceId,
    tenantId: fx.tenantId,
    storeId: fx.storeId,
    token: fx.deviceToken,
  });
  return { auth, deviceId: fx.deviceId };
}

describe('every 4xx/5xx body is a valid §7 envelope with the registry code for its status', () => {
  test('401 AUTH_TOKEN_MISSING', async () => {
    const h = makeTestApp();
    const res = await h.app.request(DEVICES);
    expect(res.status).toBe(401);
    const parsed = zErrorEnvelope.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error.code).toBe('AUTH_TOKEN_MISSING');
  });

  test('404 NOT_FOUND for an unknown route (authenticated — auth runs before routing on /v1/*)', async () => {
    const h = makeTestApp();
    const { auth } = deviceAuth(h, 'env-404');
    const res = await h.app.request('http://srv.test/v1/does/not/exist', {
      headers: { Authorization: auth },
    });
    expect(res.status).toBe(404);
    const parsed = zErrorEnvelope.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error.code).toBe('NOT_FOUND');
  });

  test('an UNAUTHENTICATED unknown /v1 route is 401, not 404 (auth precedes route disclosure)', async () => {
    const h = makeTestApp();
    const res = await h.app.request('http://srv.test/v1/does/not/exist');
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_MISSING');
  });

  test('413 BODY_TOO_LARGE', async () => {
    const h = makeTestApp();
    const { auth } = deviceAuth(h, 'env-413');
    const res = await h.app.request(
      new Request(PUSH, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: Buffer.alloc(WIRE_CAP_SYNC_PUSH + 1, 0x41),
      }),
    );
    expect(res.status).toBe(413);
    const parsed = zErrorEnvelope.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error.code).toBe('BODY_TOO_LARGE');
  });

  test('415 UNSUPPORTED_ENCODING', async () => {
    const h = makeTestApp();
    const { auth } = deviceAuth(h, 'env-415');
    const res = await h.app.request(
      new Request(PUSH, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          'Content-Encoding': 'deflate',
        },
        body: Buffer.from('{}'),
      }),
    );
    expect(res.status).toBe(415);
    const parsed = zErrorEnvelope.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error.code).toBe('UNSUPPORTED_ENCODING');
  });

  test('429 RATE_LIMITED', async () => {
    const h = makeTestApp();
    const { auth, deviceId } = deviceAuth(h, 'env-429');
    h.perDeviceStore.denyKeys.add(`dev:route:${deviceId}`);
    const res = await h.app.request(DEVICES, { headers: { Authorization: auth } });
    expect(res.status).toBe(429);
    const parsed = zErrorEnvelope.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error.code).toBe('RATE_LIMITED');
  });

  test('500 INTERNAL for an unhandled throw, echoing the request id', async () => {
    // task 13 made /v1/auth/login a real handler; the unhandled-throw probe uses the still-stub
    // /v1/sync/push (onStub throws → onError maps to 500).
    const h = makeTestApp({
      onStub: () => {
        throw new Error('boom from a stub');
      },
    });
    const { auth, deviceId } = deviceAuth(h, 'env-500');
    const res = await h.app.request(
      new Request(PUSH, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, ops: [] }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await readError(res);
    const parsed = zErrorEnvelope.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error.code).toBe('INTERNAL');
    // details.requestId === X-Request-Id (api/00 §7).
    expect(body.error.details.requestId).toBe(res.headers.get('X-Request-Id'));
  });
});

describe('validation errors (api/00 §7.1)', () => {
  test('invalid body → 422 VALIDATION_FAILED with {path,code,message} issues, no input echo', async () => {
    const h = makeTestApp();
    const { auth } = deviceAuth(h, 'env-422');
    const badDeviceId = 'definitely-not-a-uuid';
    const res = await h.app.request(
      new Request(PUSH, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: badDeviceId, ops: [] }),
      }),
    );
    // Never zValidator's default 400.
    expect(res.status).toBe(422);
    const body = await readError(res);
    expect(zErrorEnvelope.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.details.issues)).toBe(true);
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    // Each issue is EXACTLY {path,code,message} — strict parse rejects any leaked Zod internals.
    for (const issue of body.error.details.issues) {
      expect(zValidationIssue.safeParse(issue).success).toBe(true);
    }
    // No input echo anywhere (payloads may hold sensitive data).
    expect(JSON.stringify(body)).not.toContain(badDeviceId);
  });

  test('missing gzip body (Content-Encoding: gzip, empty) → 400 MALFORMED_REQUEST', async () => {
    const h = makeTestApp();
    const { auth } = deviceAuth(h, 'env-400');
    const res = await h.app.request(
      new Request(PUSH, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: Buffer.from('plain not gzip'),
      }),
    );
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
  });
});

describe('2xx bodies never contain error', () => {
  // The sync push handler is a real DB-backed handler now (task 16), so an empty (valid) push needs
  // a migrated PGlite DB + a seeded device; it accepts nothing → 200 with no error key.
  test('a valid identity push → 200 with no error key', async () => {
    const h = await makeSyncHarness();
    try {
      const dev = await h.seedDevice(200);
      const res = await h.app.request(
        new Request(PUSH, {
          method: 'POST',
          headers: { Authorization: dev.auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: dev.world.deviceId, ops: [] }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('error');
    } finally {
      await h.close();
    }
  });

  test('a valid GZIP push → 200 with no error key (decompressed, validated, handled)', async () => {
    const h = await makeSyncHarness();
    try {
      const dev = await h.seedDevice(201);
      const res = await h.app.request(
        new Request(PUSH, {
          method: 'POST',
          headers: {
            Authorization: dev.auth,
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
          body: gzipJson({ deviceId: dev.world.deviceId, ops: [] }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('error');
    } finally {
      await h.close();
    }
  });
});

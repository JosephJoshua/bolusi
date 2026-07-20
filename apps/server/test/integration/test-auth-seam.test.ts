// Task 103 — the `@bolusi/server/test-support` seam must drive a REAL wire auth error through the
// real app. This is the capability CHAOS-05 T7 builds on: a revoked device pushed to /v1/sync/push
// comes back as HTTP 401 DEVICE_REVOKED (api/00 §7 registry row, api/02-auth §8, 05-operation-log
// §8), rendered by the PRODUCTION onError/ApiError path — the harness (which cannot see internal
// modules) must be able to make the server EMIT it without forging the 401 itself (testing-guide
// T-7: no protocol logic in the harness).
//
// The seam under test is the PUBLIC surface the harness imports: `createVerifyToken` +
// `InMemoryTokenStore` from `@bolusi/server/test-support`. The boundary rule (08 §4.3) forbids
// apps/server from value-importing the package BY NAME, so this test reaches the same files by
// relative path — but only the two PUBLIC entry modules (`src/index.ts` for `createApp`,
// `src/test-support.ts` for the seam), never the internal `middleware/auth.ts`. If the re-export in
// test-support.ts is broken this file fails to resolve, so the seam is load-bearing here.
import { describe, expect, test } from 'vitest';

import type { ForTenant } from '@bolusi/db-server';

import type { ServerDeps } from '../../src/deps.js';
import { createApp } from '../../src/index.js';
import { InMemoryTokenStore, createVerifyToken } from '../../src/test-support.js';
import { makeFixture } from '../helpers/fixtures.js';
import { readError } from '../helpers/http.js';

const SYNC_PUSH = 'http://srv.test/v1/sync/push';
const NOW = 1_700_000_000_000;

// A forTenant that never touches a DB. This suite proves outcomes at bearerAuth, which runs BEFORE
// the push handler (app.ts §13 step 6). Only the valid-token leg reaches the handler, and it must
// terminate deterministically without the real Postgres — so the handler's one DB call rejects fast
// instead of connecting. No assertion here depends on what it returns.
const failFastForTenant: ForTenant = () =>
  Promise.reject(new Error('test-auth-seam: forTenant is not wired (auth-layer test)'));

/**
 * Build the REAL app with the PUBLIC test-support seam as its `verifyToken`. Records push-handler
 * entry via `deps.onStub` so a test can distinguish "auth passed, handler ran" from "auth rejected
 * before the handler" — the difference between injecting a verdict and skipping auth.
 */
function makeSeamApp(seed: (store: InMemoryTokenStore) => void) {
  const store = new InMemoryTokenStore();
  seed(store);
  const stubCalls: string[] = [];
  const overrides: Partial<ServerDeps> = {
    now: () => NOW,
    verifyToken: createVerifyToken({ store, now: () => NOW }),
    forTenant: failFastForTenant,
    accessLogSink: () => {},
    onStub: (routeKey) => stubCalls.push(routeKey),
  };
  return { app: createApp(overrides), stubCalls };
}

function pushBody(deviceId: string): string {
  return JSON.stringify({ deviceId, ops: [] });
}

describe('@bolusi/server/test-support drives a real wire 401 (task 103, CHAOS-05 T7)', () => {
  test('a REVOKED device pushed to /v1/sync/push → 401 DEVICE_REVOKED (exact envelope); handler never entered', async () => {
    const fx = makeFixture('t103-revoked');
    const { app, stubCalls } = makeSeamApp((store) =>
      store.add(fx.deviceToken, {
        kind: 'device',
        deviceId: fx.deviceId,
        tenantId: fx.tenantId,
        storeId: fx.storeId,
        deviceStatus: 'revoked',
      }),
    );

    const res = await app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.deviceToken}`, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });

    expect(res.status).toBe(401);
    // The exact §6/§7 envelope, produced by the production errors.ts registry: message present, no
    // `details` for DEVICE_REVOKED (api/00 §7 row). The harness asserts on THIS shape.
    expect(await readError(res)).toEqual({
      error: { code: 'DEVICE_REVOKED', message: 'Device revoked' },
    });
    // The seam INJECTS a verdict; it does not SKIP auth. bearerAuth threw before the push handler,
    // so the handler's onStub marker never fired.
    expect(stubCalls).not.toContain('sync.push');
  });

  test('an UNKNOWN token still 401s AUTH_TOKEN_INVALID (production reject path intact through the seam)', async () => {
    const fx = makeFixture('t103-unknown');
    const { app, stubCalls } = makeSeamApp((store) =>
      store.add(fx.deviceToken, {
        kind: 'device',
        deviceId: fx.deviceId,
        tenantId: fx.tenantId,
        storeId: fx.storeId,
        deviceStatus: 'active',
      }),
    );

    // A token that is not registered (different hash) must be rejected — the seam cannot make an
    // unknown token authenticate.
    const res = await app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: 'Bearer bdt_not_registered', 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });

    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_INVALID');
    expect(stubCalls).not.toContain('sync.push');
  });

  test('a MISSING bearer still 401s AUTH_TOKEN_MISSING (the seam opens no unauthenticated path)', async () => {
    const { app, stubCalls } = makeSeamApp(() => {});
    const res = await app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pushBody(makeFixture('t103-missing').deviceId),
    });

    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('AUTH_TOKEN_MISSING');
    expect(stubCalls).not.toContain('sync.push');
  });

  test('a VALID active device authenticates: NOT a 401, and the push handler IS entered', async () => {
    const fx = makeFixture('t103-valid');
    const { app, stubCalls } = makeSeamApp((store) =>
      store.add(fx.deviceToken, {
        kind: 'device',
        deviceId: fx.deviceId,
        tenantId: fx.tenantId,
        storeId: fx.storeId,
        deviceStatus: 'active',
      }),
    );

    const res = await app.request(SYNC_PUSH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.deviceToken}`, 'Content-Type': 'application/json' },
      body: pushBody(fx.deviceId),
    });

    // bearerAuth accepted the token and set device context, so the request reached the push handler
    // (onStub fired). It is NOT an auth rejection — the fail-fast forTenant then makes the handler
    // 500, which is immaterial here: the point is that a valid device authenticates and is not
    // revoked, so the seam's revoked verdict is a real per-record decision, not a blanket reject.
    expect(stubCalls).toContain('sync.push');
    expect(res.status).not.toBe(401);
  });
});

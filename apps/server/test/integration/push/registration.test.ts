// POST /v1/push/tokens — the registration endpoint (api/04-push §2). Real PG16 (the push_tokens
// table + its RLS), the real production createApp, an in-process app.fetch, and the FakeClock for the
// daily rate window. Auth (bearer + X-Acting-User) is the real middleware chain.
import { afterAll, beforeAll, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  expoToken,
  makePushHarness,
  registerReq,
  type DeviceContext,
  type PushHarness,
} from '../../helpers/push.js';

let h: PushHarness;
beforeAll(async () => {
  h = await makePushHarness();
});
afterAll(async () => {
  await h.close();
});

/** Make ctx's user usable as the acting user on its store (resolveActingUser membership check). */
async function makeActingUsable(ctx: DeviceContext): Promise<void> {
  if (ctx.storeId === null) return;
  await h.db
    .insertInto('userStores')
    .values({ tenantId: ctx.tenantId, userId: ctx.userId, storeId: ctx.storeId })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

async function tokenRow(deviceId: string) {
  return h.db
    .selectFrom('pushTokens')
    .select(['deviceId', 'userId', 'expoPushToken', 'updatedAt', 'id'])
    .where('deviceId', '=', deviceId)
    .executeTakeFirst();
}

test('no bearer → 401 AUTH_TOKEN_MISSING', async () => {
  const ctx = await h.seedDevice('reg-noauth');
  const res = await h.app.request(
    registerReq({ expoPushToken: expoToken('t'), deviceId: ctx.deviceId }),
  );
  expect(res.status).toBe(401);
  expect((await readError(res)).error.code).toBe('AUTH_TOKEN_MISSING');
});

test('pre-login register (no X-Acting-User) → 200 {deviceId, updatedAt}, row user_id null', async () => {
  const ctx = await h.seedDevice('reg-prelogin');
  h.clock.set(1_700_000_500_000);
  const res = await h.app.request(
    registerReq({ expoPushToken: expoToken('p1'), deviceId: ctx.deviceId }, { auth: ctx.auth }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceId: string; updatedAt: number };
  expect(body.deviceId).toBe(ctx.deviceId);
  expect(body.updatedAt).toBe(1_700_000_500_000); // server-stamped, not client-supplied

  const row = await tokenRow(ctx.deviceId);
  expect(row?.userId).toBeNull();
  expect(row?.expoPushToken).toBe(expoToken('p1'));
});

test('X-Acting-User stamps user_id; a later authed registration fills a previously-null id', async () => {
  const ctx = await h.seedDevice('reg-acting');
  await makeActingUsable(ctx);

  // First, pre-login → null.
  await h.app.request(
    registerReq({ expoPushToken: expoToken('a1'), deviceId: ctx.deviceId }, { auth: ctx.auth }),
  );
  expect((await tokenRow(ctx.deviceId))?.userId).toBeNull();

  // Then with a session → the previously-null user_id is filled.
  const res = await h.app.request(
    registerReq(
      { expoPushToken: expoToken('a2'), deviceId: ctx.deviceId },
      { auth: ctx.auth, actingUser: ctx.userId },
    ),
  );
  expect(res.status).toBe(200);
  expect((await tokenRow(ctx.deviceId))?.userId).toBe(ctx.userId);
});

test('an X-Acting-User for a user not usable on the device → 403 ACTING_USER_INVALID', async () => {
  const ctx = await h.seedDevice('reg-badacting'); // no userStores membership seeded
  const res = await h.app.request(
    registerReq(
      { expoPushToken: expoToken('b1'), deviceId: ctx.deviceId },
      { auth: ctx.auth, actingUser: ctx.userId },
    ),
  );
  expect(res.status).toBe(403);
  expect((await readError(res)).error.code).toBe('ACTING_USER_INVALID');
});

test('upsert: re-register with a new token → one row, token overwritten, updated_at re-stamped', async () => {
  const ctx = await h.seedDevice('reg-upsert');
  h.clock.set(1_700_001_000_000);
  await h.app.request(
    registerReq({ expoPushToken: expoToken('u1'), deviceId: ctx.deviceId }, { auth: ctx.auth }),
  );
  const first = await tokenRow(ctx.deviceId);

  h.clock.set(1_700_002_000_000);
  await h.app.request(
    registerReq({ expoPushToken: expoToken('u2'), deviceId: ctx.deviceId }, { auth: ctx.auth }),
  );
  expect(await h.countTokens(ctx.deviceId)).toBe(1); // still exactly one row for the device
  const second = await tokenRow(ctx.deviceId);
  expect(second?.id).toBe(first?.id); // same row (upsert keyed by device_id)
  expect(second?.expoPushToken).toBe(expoToken('u2'));
  expect(Number(second?.updatedAt)).toBe(1_700_002_000_000);
});

test('byte-identical replay converges on the same row; an Idempotency-Key header is ignored', async () => {
  const ctx = await h.seedDevice('reg-replay');
  const body = { expoPushToken: expoToken('r1'), deviceId: ctx.deviceId };
  const r1 = await h.app.request(registerReq(body, { auth: ctx.auth }));
  // Same body + an Idempotency-Key: NOT a 422, NOT replay semantics — just ignored (§2).
  const req2 = registerReq(body, { auth: ctx.auth });
  req2.headers.set('Idempotency-Key', 'abc-123');
  const r2 = await h.app.request(req2);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  expect(await h.countTokens(ctx.deviceId)).toBe(1);
});

test('deviceId ≠ bearer device → 403 PERMISSION_DENIED', async () => {
  const ctx = await h.seedDevice('reg-mismatch');
  const res = await h.app.request(
    registerReq(
      { expoPushToken: expoToken('m1'), deviceId: '018f4e2a-9999-4abc-8def-000000000099' },
      { auth: ctx.auth },
    ),
  );
  expect(res.status).toBe(403);
  expect((await readError(res)).error.code).toBe('PERMISSION_DENIED');
  expect(await h.countTokens(ctx.deviceId)).toBe(0); // nothing written
});

test('a token not matching ExponentPushToken[…] → 422 VALIDATION_FAILED', async () => {
  const ctx = await h.seedDevice('reg-badtoken');
  const res = await h.app.request(
    registerReq({ expoPushToken: 'fcm-raw-token-xyz', deviceId: ctx.deviceId }, { auth: ctx.auth }),
  );
  expect(res.status).toBe(422);
  expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
});

test('rate limit: 31st registration/day/device → 429 (Retry-After + retryAfterSeconds); 2nd device unaffected; window resets', async () => {
  const ctx = await h.seedDevice('reg-rate');
  const other = await h.seedDeviceInTenant('reg-rate-2', {
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
  });
  h.clock.set(1_700_010_000_000);

  for (let i = 0; i < 30; i += 1) {
    const res = await h.app.request(
      registerReq(
        { expoPushToken: expoToken(`rl-${i}`), deviceId: ctx.deviceId },
        { auth: ctx.auth },
      ),
    );
    expect(res.status).toBe(200);
  }
  const denied = await h.app.request(
    registerReq({ expoPushToken: expoToken('rl-31'), deviceId: ctx.deviceId }, { auth: ctx.auth }),
  );
  expect(denied.status).toBe(429);
  expect(denied.headers.get('Retry-After')).not.toBeNull();
  const err = await readError(denied);
  expect(err.error.code).toBe('RATE_LIMITED');
  expect(typeof err.error.details.retryAfterSeconds).toBe('number');

  // A DIFFERENT device is unaffected (per-device window).
  const otherRes = await h.app.request(
    registerReq(
      { expoPushToken: expoToken('rl-other'), deviceId: other.deviceId },
      { auth: other.auth },
    ),
  );
  expect(otherRes.status).toBe(200);

  // The window resets after a day (fake clock).
  h.clock.advance(24 * 60 * 60 * 1000 + 1);
  const afterReset = await h.app.request(
    registerReq(
      { expoPushToken: expoToken('rl-after'), deviceId: ctx.deviceId },
      { auth: ctx.auth },
    ),
  );
  expect(afterReset.status).toBe(200);
});

// api/04-push §2 "last registrant wins": the global UNIQUE on expo_push_token means a token can
// belong to at most one device. When a second device in the SAME tenant registers a token another
// device already holds, ownership TRANSFERS to the newest registrant — a 200, not a 500 (the
// expo_push_token 23505 must not escape; task 118) and not a hard reject.
test('same-tenant token collision → transfers to the new device (200); old device no longer owns it', async () => {
  const a = await h.seedDevice('reg-xfer-a');
  const b = await h.seedDeviceInTenant('reg-xfer-b', {
    tenantId: a.tenantId,
    storeId: a.storeId,
  });
  const token = expoToken('xfer-shared');

  h.clock.set(1_700_020_000_000);
  const first = await h.app.request(
    registerReq({ expoPushToken: token, deviceId: a.deviceId }, { auth: a.auth }),
  );
  expect(first.status).toBe(200);
  expect((await tokenRow(a.deviceId))?.expoPushToken).toBe(token);

  // Device B registers the SAME token → last registrant wins.
  h.clock.set(1_700_021_000_000);
  const transfer = await h.app.request(
    registerReq({ expoPushToken: token, deviceId: b.deviceId }, { auth: b.auth }),
  );
  expect(transfer.status).toBe(200);
  const body = (await transfer.json()) as { deviceId: string; updatedAt: number };
  expect(body.deviceId).toBe(b.deviceId);
  expect(body.updatedAt).toBe(1_700_021_000_000);

  // T now points at B; A no longer owns T (ownership moved, not duplicated).
  expect((await tokenRow(b.deviceId))?.expoPushToken).toBe(token);
  expect(await h.countTokens(b.deviceId)).toBe(1);
  expect(await tokenRow(a.deviceId)).toBeUndefined();
  expect(await h.countTokens(a.deviceId)).toBe(0);
});

// A cross-TENANT collision cannot be transferred: RLS hides the other tenant's row (bolusi_app is
// NOBYPASSRLS), so re-pointing it would breach tenant isolation. The endpoint must FAIL CLOSED —
// never a 500, never touching or revealing the other tenant's row (task 118).
test('cross-tenant token collision → fails closed (not 500); the other tenant keeps its token', async () => {
  const a = await h.seedDevice('reg-xtenant-a');
  const b = await h.seedDevice('reg-xtenant-b'); // a DIFFERENT tenant
  expect(b.tenantId).not.toBe(a.tenantId);
  const token = expoToken('xtenant-shared');

  h.clock.set(1_700_030_000_000);
  expect(
    (
      await h.app.request(
        registerReq({ expoPushToken: token, deviceId: a.deviceId }, { auth: a.auth }),
      )
    ).status,
  ).toBe(200);

  const denied = await h.app.request(
    registerReq({ expoPushToken: token, deviceId: b.deviceId }, { auth: b.auth }),
  );
  expect(denied.status).not.toBe(500);
  expect(denied.status).toBe(403);
  expect((await readError(denied)).error.code).toBe('PERMISSION_DENIED');

  // Tenant isolation preserved: A (the other tenant) still owns T; B wrote nothing.
  expect((await tokenRow(a.deviceId))?.expoPushToken).toBe(token);
  expect(await h.countTokens(b.deviceId)).toBe(0);
});

// Positive control: a fresh, unheld token takes the ordinary (non-collision) path — a plain 200
// with a new row — so the transfer/fail-closed handling never fires for the common case.
test('fresh unique token registers normally (no collision path)', async () => {
  const ctx = await h.seedDevice('reg-fresh-unique');
  h.clock.set(1_700_040_000_000);
  const res = await h.app.request(
    registerReq(
      { expoPushToken: expoToken('fresh-unique'), deviceId: ctx.deviceId },
      {
        auth: ctx.auth,
      },
    ),
  );
  expect(res.status).toBe(200);
  expect((await tokenRow(ctx.deviceId))?.expoPushToken).toBe(expoToken('fresh-unique'));
  expect(await h.countTokens(ctx.deviceId)).toBe(1);
});

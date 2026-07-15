// Enrollment (§4.3): idempotency-key semantics, the §4.3 validation order, and the 24 h purge.
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { IDEMPOTENCY_RETENTION_MS } from '../../src/identity/idempotency.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  makeIdentityHarness,
  provision,
  seedControlSession,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

async function setup() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  return { p, control, storeId: p.storeIds[0] as string };
}

function enrollBody(storeId: string, overrides: Record<string, unknown> = {}) {
  return {
    deviceId: uuidv7(h.clock.now()),
    devicePublicKeyB64: Buffer.from(ed25519.keygen().publicKey).toString('base64'),
    storeId,
    deviceName: 'Tablet',
    platform: 'android',
    appVersion: '1.0.0',
    ...overrides,
  };
}

async function deviceCount(): Promise<number> {
  const rows = await h.idb.db
    .selectFrom('devices')
    .select('id')
    .where('kind', '=', 'member')
    .execute();
  return rows.length;
}

test('idempotent replay: same key + same body → verbatim response (same deviceToken) + X-Idempotent-Replay, no second device row', async () => {
  const { control, storeId } = await setup();
  const key = uuidv7(h.clock.now());
  const body = enrollBody(storeId);

  const first = await enroll(h, control, body, key);
  expect(first.status).toBe(201);
  const firstBody = (await first.json()) as { deviceToken: string };
  const countAfterFirst = await deviceCount();

  const replay = await enroll(h, control, body, key);
  expect(replay.status).toBe(201);
  expect(replay.headers.get('X-Idempotent-Replay')).toBe('true');
  const replayBody = (await replay.json()) as { deviceToken: string };
  expect(replayBody.deviceToken).toBe(firstBody.deviceToken); // verbatim, incl. the token
  expect(await deviceCount()).toBe(countAfterFirst); // no second device row
});

test('same key + different body → 409 IDEMPOTENCY_CONFLICT, nothing executed', async () => {
  const { control, storeId } = await setup();
  const key = uuidv7(h.clock.now());
  const first = await enroll(h, control, enrollBody(storeId), key);
  expect(first.status).toBe(201);
  const countAfterFirst = await deviceCount();

  const conflict = await enroll(h, control, enrollBody(storeId), key); // different deviceId/pubkey
  expect(conflict.status).toBe(409);
  expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
    'IDEMPOTENCY_CONFLICT',
  );
  expect(await deviceCount()).toBe(countAfterFirst); // nothing executed
});

test('§4.3 validation order: missing key → 422; no permission → 403; taken deviceId → 409; reused pubkey → 409; malformed pubkey → 422', async () => {
  const { p, control, storeId } = await setup();

  // Missing Idempotency-Key → 422 (valid body).
  const noKey = await h.app.request('http://srv.test/v1/devices/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control}` },
    body: JSON.stringify(enrollBody(storeId)),
  });
  expect(noKey.status).toBe(422);

  // No auth.device_enroll → 403 (a staff user's control session).
  const staff = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Staff',
    storeIds: [storeId],
    roleKeys: ['staff'],
  });
  const staffControl = await seedControlSession(h, { tenantId: p.tenantId, userId: staff });
  const noPerm = await enroll(h, staffControl, enrollBody(storeId), uuidv7(h.clock.now()));
  expect(noPerm.status).toBe(403);

  // Taken deviceId → 409 ENROLL_DEVICE_ID_TAKEN.
  const existing = enrollBody(storeId);
  const ok = await enroll(h, control, existing, uuidv7(h.clock.now()));
  expect(ok.status).toBe(201);
  const takenId = await enroll(
    h,
    control,
    { ...enrollBody(storeId), deviceId: existing['deviceId'] },
    uuidv7(h.clock.now()),
  );
  expect(takenId.status).toBe(409);
  expect(((await takenId.json()) as { error: { code: string } }).error.code).toBe(
    'ENROLL_DEVICE_ID_TAKEN',
  );

  // Reused pubkey → 409 ENROLL_KEY_REUSED.
  const reusedKey = await enroll(
    h,
    control,
    { ...enrollBody(storeId), devicePublicKeyB64: existing['devicePublicKeyB64'] },
    uuidv7(h.clock.now()),
  );
  expect(reusedKey.status).toBe(409);
  expect(((await reusedKey.json()) as { error: { code: string } }).error.code).toBe(
    'ENROLL_KEY_REUSED',
  );

  // Malformed pubkey (not 32 bytes) → 422 (Zod).
  const badKey = await enroll(
    h,
    control,
    enrollBody(storeId, { devicePublicKeyB64: 'AAAA' }),
    uuidv7(h.clock.now()),
  );
  expect(badKey.status).toBe(422);
});

test('past the 24 h retention window the idempotency record is purged; a replay then re-executes and fails ENROLL_DEVICE_ID_TAKEN', async () => {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const storeId = p.storeIds[0] as string;
  // A control session that outlives the 24 h window (a normal 10-min session would expire first).
  const control = await seedControlSession(h, {
    tenantId: p.tenantId,
    userId: p.ownerUserId,
    expiresAt: h.clock.now() + IDEMPOTENCY_RETENTION_MS + 2 * 60 * 60 * 1000,
  });
  const key = uuidv7(h.clock.now());
  const body = enrollBody(storeId);
  const first = await enroll(h, control, body, key);
  expect(first.status).toBe(201);

  // Advance past retention → the next request purges the record, so the same key no longer
  // replays; it re-executes and hits the now-registered deviceId.
  h.clock.advance(IDEMPOTENCY_RETENTION_MS + 1000);
  const replay = await enroll(h, control, body, key);
  expect(replay.status).toBe(409);
  expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
    'ENROLL_DEVICE_ID_TAKEN',
  );

  // And the idempotency row is gone.
  const rows = await h.idb.db
    .selectFrom('idempotencyKeys')
    .select('key')
    .where('key', '=', key)
    .execute();
  expect(rows).toHaveLength(0);
});

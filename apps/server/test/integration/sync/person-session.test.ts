// Person sessions (least-privilege sync, owner decision 2026-11-01). A shared store device holds
// what its staff may read; someone who may read more signs in with their PIN, the server checks it
// itself, and a person pull with that session serves only the extra, for that device and person.
// Real Postgres, real routes, the production op registry's read permissions.
import { buildPinVerifier, FLOOR_KDF_PARAMS, utf8ToBytes } from '@bolusi/core';
import { buildPinVerifierRow } from '@bolusi/db-server';
import {
  PERSON_SESSION_HEADER,
  type PersonSessionResponse,
  type PullResponse,
  type SignedOperation,
} from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { PERSON_SESSION_TTL_MS } from '../../../src/auth/person-sessions.js';
import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness, type PullBody, type SeededDevice, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const NOTES_READ = 'notes.read';
const PIN = '482915';
const NIL_DEVICE = '00000000-0000-0000-0000-000000000000';

async function pushNotes(dev: SeededDevice, count: number): Promise<SignedOperation[]> {
  const ops = [
    dev.builder.genesis(),
    ...Array.from({ length: count }, (_, i) =>
      dev.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        payload: { title: `t${String(i)}`, body: 'b' },
      }),
    ),
  ];
  expect((await h.push(dev.auth, dev.world.deviceId, ops)).status).toBe(200);
  return ops;
}

/** Notes become something only owners read: staff roles lose it. */
async function notesOwnerOnly(tenantId: string): Promise<void> {
  await h.db
    .deleteFrom('rolePermissions')
    .where('tenantId', '=', tenantId)
    .where('permissionId', '=', NOTES_READ)
    .where('roleId', 'in', (eb) =>
      eb
        .selectFrom('roles')
        .select('id')
        .where('tenantId', '=', tenantId)
        .where('scopeType', '=', 'store'),
    )
    .execute();
}

async function setPin(tenantId: string, userId: string, pin = PIN): Promise<void> {
  const verifier = await buildPinVerifier(
    serverCryptoPort,
    utf8ToBytes(pin),
    FLOOR_KDF_PARAMS,
    new Uint8Array(16).fill(7),
    { timestamp: 1, deviceId: NIL_DEVICE, seq: 0 },
  );
  await h.db
    .insertInto('userPinVerifiers')
    .values(buildPinVerifierRow(verifier, { userId, tenantId }))
    .execute();
}

async function signIn(dev: SeededDevice, userId: string, pin = PIN): Promise<Response> {
  return h.app.request('http://srv.test/v1/sync/person-session', {
    method: 'POST',
    headers: { Authorization: dev.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin }),
  });
}

async function personPull(
  dev: SeededDevice,
  token: string | undefined,
  body: PullBody,
): Promise<Response> {
  return h.app.request('http://srv.test/v1/sync/pull', {
    method: 'POST',
    headers: {
      Authorization: dev.auth,
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { [PERSON_SESSION_HEADER]: token }),
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** A store whose notes only owners read, an owner with a PIN, and a shop device to sign in on. */
async function world() {
  const writer = await h.seedDevice(9201);
  const shop = await h.seedDeviceIn(writer.world.tenantId, writer.world.storeId, 9202);
  const notes = await pushNotes(writer, 2);
  await notesOwnerOnly(writer.world.tenantId);
  // The writer's person holds every permission (an owner); give them a PIN.
  await setPin(writer.world.tenantId, writer.world.userId);
  return { writer, shop, owner: writer.world.userId, notes };
}

async function session(dev: SeededDevice, userId: string): Promise<PersonSessionResponse> {
  const res = await signIn(dev, userId);
  expect(res.status).toBe(200);
  return (await res.json()) as PersonSessionResponse;
}

const PULL: PullBody = { cursor: 0, devicesDirectoryVersion: 0, person: true };

describe('a person reads their extras online on a shared device', () => {
  test('the device pull leaves them out; the person pull serves only them', async () => {
    const { shop, owner, notes } = await world();
    const device = (await (
      await h.pull(shop.auth, { cursor: 0, devicesDirectoryVersion: 0 })
    ).json()) as PullResponse;
    expect(device.ops.map((op) => op.type)).not.toContain('notes.note_created');

    const signedIn = await session(shop, owner);
    expect(signedIn.readSet).toContain(NOTES_READ);
    const res = await personPull(shop, signedIn.token, PULL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullResponse;
    // Only the extra: the notes, none of what the device already holds or every device reads.
    expect(body.ops.map((op) => op.id)).toEqual(notes.slice(1).map((op) => op.id));
    expect(body.readSet).toEqual(signedIn.readSet);
    expect(body.devices).toBeUndefined();
  });

  test('someone who may read nothing beyond the device gets an empty extra', async () => {
    const { shop } = await world();
    const staff = `${shop.world.storeId.slice(0, 24)}57aff0000000`;
    await setPin(shop.world.tenantId, staff);
    const signedIn = await session(shop, staff);
    expect(signedIn.readSet).toEqual([]);
    const body = (await (await personPull(shop, signedIn.token, PULL)).json()) as PullResponse;
    expect(body.ops).toEqual([]);
  });
});

describe('the server checks the person itself', () => {
  test('a wrong PIN, a person with no PIN, or one who does not work here all answer the same', async () => {
    const { shop, owner, writer } = await world();
    expect(await errorCode(await signIn(shop, owner, '000000'))).toBe('AUTH_INVALID_CREDENTIALS');
    const staff = `${shop.world.storeId.slice(0, 24)}57aff0000000`;
    expect(await errorCode(await signIn(shop, staff))).toBe('AUTH_INVALID_CREDENTIALS');
    const elsewhere = await h.seedDevice(9203);
    await setPin(elsewhere.world.tenantId, elsewhere.world.userId);
    expect(await errorCode(await signIn(shop, elsewhere.world.userId))).toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
    expect(writer.world.userId).toBe(owner);
  });

  test("nobody else signs in on someone's own phone, even with their right PIN", async () => {
    const { shop, owner } = await world();
    const staff = `${shop.world.storeId.slice(0, 24)}57aff0000000`;
    await h.db
      .updateTable('devices')
      .set({ personalUserId: staff })
      .where('id', '=', shop.world.deviceId)
      .execute();
    expect(await errorCode(await signIn(shop, owner))).toBe('AUTH_INVALID_CREDENTIALS');
  });

  test('five wrong PINs lock the person out on that device, even with the right one after', async () => {
    const { shop, owner } = await world();
    for (let i = 0; i < 5; i += 1) {
      expect((await signIn(shop, owner, '000000')).status).toBe(401);
    }
    expect((await signIn(shop, owner)).status).toBe(429);
  });

  test('a right PIN gives its slot back, so earlier mistakes do not pile up', async () => {
    const { shop, owner } = await world();
    for (let i = 0; i < 4; i += 1) await signIn(shop, owner, '000000');
    expect((await signIn(shop, owner)).status).toBe(200);
    expect((await signIn(shop, owner, '000000')).status).toBe(401);
  });
});

describe('a person session is only good for its device, its person, and its time', () => {
  test('a person pull without a session, or a device pull with one, is refused', async () => {
    const { shop, owner } = await world();
    expect(await errorCode(await personPull(shop, undefined, PULL))).toBe('PERSON_SESSION_INVALID');
    const { token } = await session(shop, owner);
    expect(
      await errorCode(await personPull(shop, token, { cursor: 0, devicesDirectoryVersion: 0 })),
    ).toBe('PERSON_SESSION_INVALID');
  });

  test('another device cannot use it', async () => {
    const { shop, owner, writer } = await world();
    const { token } = await session(shop, owner);
    const other = await h.seedDeviceIn(writer.world.tenantId, writer.world.storeId, 9204);
    expect(await errorCode(await personPull(other, token, PULL))).toBe('PERSON_SESSION_INVALID');
  });

  test('it ends on sign-out, on expiry, and when the person is deactivated', async () => {
    const { shop, owner } = await world();
    const first = await session(shop, owner);
    await h.app.request('http://srv.test/v1/sync/person-session', {
      method: 'DELETE',
      headers: { Authorization: shop.auth, [PERSON_SESSION_HEADER]: first.token },
    });
    expect(await errorCode(await personPull(shop, first.token, PULL))).toBe(
      'PERSON_SESSION_INVALID',
    );

    const second = await session(shop, owner);
    h.clock.advance(PERSON_SESSION_TTL_MS);
    expect(await errorCode(await personPull(shop, second.token, PULL))).toBe(
      'PERSON_SESSION_INVALID',
    );

    const third = await session(shop, owner);
    await h.db
      .updateTable('users')
      .set({ status: 'deactivated' })
      .where('id', '=', owner)
      .execute();
    expect(await errorCode(await personPull(shop, third.token, PULL))).toBe(
      'PERSON_SESSION_INVALID',
    );
  });
});

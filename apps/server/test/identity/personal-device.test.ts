// Personal devices (permission-scoped sync, owner decisions 2026-10-31): a phone set up as one
// person's own is synced what that person may read, and only they sign in on it. Real Postgres and
// real routes: who the login offers, what the enroll accepts, what the bundle carries, and the
// read set a pull is filtered by.
import { ed25519 } from '@noble/curves/ed25519.js';
import type { ReadScopeRegistry } from '@bolusi/core';
import { PURCHASING_PERMISSION } from '@bolusi/modules/purchasing';
import type { DeviceBundle } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { deviceReadSet } from '../../src/sync/read-set.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  login,
  makeIdentityHarness,
  provision,
  seedControlSession,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

const NIL_DEVICE = '00000000-0000-0000-0000-000000000000';
const OWNER_LOGIN = 'owner-personal';
const OWNER_PASSWORD = 'Owner1PasswordBase58xyz9';

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
    ownerName: 'Olivia',
    ownerLogin: OWNER_LOGIN,
  });
  const storeId = p.storeIds[0] as string;
  const budi = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Budi',
    storeIds: [storeId],
    roleKeys: ['staff'],
  });
  const ani = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Ani',
    storeIds: [storeId],
    roleKeys: ['staff'],
  });
  await writeVerifier(budi, p.tenantId);
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  return { p, storeId, budi, ani, control };
}

async function writeVerifier(userId: string, tenantId: string): Promise<void> {
  await h.idb.db
    .insertInto('userPinVerifiers')
    .values({
      userId,
      tenantId,
      algo: 'argon2id',
      salt: Buffer.alloc(16, 1).toString('base64'),
      params: { m: 32768, t: 3, p: 1 } as never,
      hash: Buffer.alloc(32, 2).toString('base64'),
      asOfTimestamp: 1n,
      asOfDeviceId: NIL_DEVICE,
      asOfSeq: 0n,
    })
    .execute();
}

function enrollBody(storeId: string, overrides: Record<string, unknown> = {}) {
  return {
    deviceId: uuidv7(h.clock.now()),
    devicePublicKeyB64: Buffer.from(ed25519.keygen().publicKey).toString('base64'),
    storeId,
    deviceName: 'HP',
    platform: 'android',
    appVersion: '1.0.0',
    ...overrides,
  };
}

async function enrolled(control: string, body: Record<string, unknown>) {
  const res = await enroll(h, control, body, uuidv7(h.clock.now()));
  return { status: res.status, body: (await res.json()) as { bundle: DeviceBundle } };
}

describe('setting a phone up as someone’s own', () => {
  test('the login offers the owner first, then staff who have a PIN, never one without', async () => {
    const { budi } = await setup();
    const res = await login(h, OWNER_LOGIN, OWNER_PASSWORD);
    expect(res.status).toBe(200);
    const stores = res.body['stores'] as { people: { id: string; name: string }[] }[];
    expect(stores[0]?.people.map((person) => person.name)).toEqual(['Olivia', 'Budi']);
    expect(stores[0]?.people[1]?.id).toBe(budi);
  });

  test('someone who sees more than the person setting the phone up is not offered', async () => {
    // A store owner sets a phone up: the business's main owner sees more, so their phone is theirs
    // to set up; a staff member is offered.
    const { p, storeId, budi } = await setup();
    await writeVerifier(p.ownerUserId, p.tenantId);
    const storeOwner = await seedUser(h, {
      tenantId: p.tenantId,
      name: 'Sam',
      storeIds: [storeId],
      roleKeys: ['store_owner'],
    });
    const control = await seedControlSession(h, { tenantId: p.tenantId, userId: storeOwner });
    const res = await enrolled(control, enrollBody(storeId, { personalUserId: p.ownerUserId }));
    expect(res.status).toBe(422);
    const ok = await enrolled(control, enrollBody(storeId, { personalUserId: budi }));
    expect(ok.status).toBe(201);
  });

  test('enrolling for someone the store does not offer is refused, and no device is made', async () => {
    const { storeId, ani, control } = await setup();
    const body = enrollBody(storeId, { personalUserId: ani });
    const res = await enrolled(control, body);
    expect(res.status).toBe(422);
    const row = await h.idb.db
      .selectFrom('devices')
      .select('id')
      .where('id', '=', body.deviceId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  test('a personal phone records its person, and its bundle lets only them sign in', async () => {
    const { p, storeId, budi, control } = await setup();
    await writeVerifier(p.ownerUserId, p.tenantId);
    const body = enrollBody(storeId, { personalUserId: budi });
    const res = await enrolled(control, body);
    expect(res.status).toBe(201);

    const row = await h.idb.db
      .selectFrom('devices')
      .select('personalUserId')
      .where('id', '=', body.deviceId)
      .executeTakeFirstOrThrow();
    expect(row.personalUserId).toBe(budi);
    expect(res.body.bundle.personalUserId).toBe(budi);
    // Everyone is still listed (their names show in history), but only Budi has a PIN here.
    const withPin = res.body.bundle.users.filter((user) => user.pinVerifier !== null);
    expect(withPin.map((user) => user.id)).toEqual([budi]);
    expect(res.body.bundle.users.length).toBeGreaterThan(1);
  });

  test('a shared phone’s bundle carries no person and every PIN, as before', async () => {
    const { p, storeId, control } = await setup();
    await writeVerifier(p.ownerUserId, p.tenantId);
    const res = await enrolled(control, enrollBody(storeId));
    expect(res.status).toBe(201);
    expect('personalUserId' in res.body.bundle).toBe(false);
    expect(res.body.bundle.users.filter((user) => user.pinVerifier !== null)).toHaveLength(2);
  });
});

describe('what a device is synced', () => {
  // Two reads: one every staff role holds, one only owners hold.
  const STAFF_READ = 'notes.read';
  const OWNER_READ = 'auth.device_enroll';
  const registry: ReadScopeRegistry = {
    types: () => ['x.staff_thing', 'x.owner_thing'],
    readPermissionFor: (type) =>
      type === 'x.staff_thing' ? STAFF_READ : type === 'x.owner_thing' ? OWNER_READ : undefined,
  };
  const readSetOf = (tenantId: string, storeId: string, personalUserId: string | null) =>
    h.idb.forTenant(tenantId, (db) =>
      deviceReadSet(db, tenantId, { storeId, personalUserId }, registry),
    );

  test('a shared device gets staff-level data, an owner’s own phone gets the owner’s too', async () => {
    const { p, storeId } = await setup();
    expect(await readSetOf(p.tenantId, storeId, null)).toEqual([STAFF_READ]);
    expect([...(await readSetOf(p.tenantId, storeId, p.ownerUserId))].sort()).toEqual(
      [OWNER_READ, STAFF_READ].sort(),
    );
  });

  test('a shared device gets what a staff role can be given, though no staff role has it yet', async () => {
    const { p, storeId } = await setup();
    const buying: ReadScopeRegistry = {
      types: () => ['purchasing.order_drafted'],
      readPermissionFor: (type) =>
        type === 'purchasing.order_drafted' ? PURCHASING_PERMISSION.buy : undefined,
    };
    const shared = await h.idb.forTenant(p.tenantId, (db) =>
      deviceReadSet(db, p.tenantId, { storeId, personalUserId: null }, buying),
    );
    expect(shared).toEqual([PURCHASING_PERMISSION.buy]);
  });

  test('a staff member’s own phone gets only what they may read, and nothing once deactivated', async () => {
    const { p, storeId, budi } = await setup();
    expect(await readSetOf(p.tenantId, storeId, budi)).toEqual([STAFF_READ]);
    await h.idb.db
      .updateTable('users')
      .set({ status: 'deactivated' })
      .where('id', '=', budi)
      .execute();
    expect(await readSetOf(p.tenantId, storeId, budi)).toEqual([]);
  });
});

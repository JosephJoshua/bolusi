// A re-enrolled phone pushes the changes its old registration never sent (core auth/carry-over.ts).
//
// The phone re-signs them under its new device with their original ids, authors and times, after an
// `auth.device_changes_transferred` record. The server must treat each one as an ordinary change from
// the new device: accept what is new, answer `duplicate` for what it already holds, and refuse what
// any other push would refuse (here, a change by an employee deactivated since).
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect, inject, test } from 'vitest';

import { resolveDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { grantAllPermissions, seedDevice, seedUser, seedWorld } from '../oplog/helpers.js';

let db: Kysely<DB>;
let appForTenant: ForTenant;
let closeDb: (() => Promise<void>) | undefined;

function forTenantOn(handle: Kysely<DB>): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

function productionDeps(): OplogPipelineDeps {
  const deps = resolveDeps({ forTenant: appForTenant, now: () => 1_726_100_000_000 });
  return {
    forTenant: deps.forTenant,
    crypto: deps.serverCrypto,
    now: deps.now,
    newId: deps.newOpLogId,
    registry: deps.opRegistry,
    projections: deps.projections,
  };
}

beforeEach(async () => {
  const handle = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );
  db = handle.db;
  closeDb = handle.close;
  appForTenant = forTenantOn(db);
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
});

const id = (n: number): string =>
  `01920000-0000-7000-8000-0000000d${n.toString(16).padStart(4, '0')}`;

/** The same phone's new registration: same tenant, store and owner, a new device id and key. */
function reEnrolled(old: ChainWorld, seed: number): ChainWorld {
  const fresh = makeWorld(seed, serverCryptoPort);
  return {
    ...old,
    deviceId: fresh.deviceId,
    secretKey: fresh.secretKey,
    publicKey: fresh.publicKey,
    publicKeyB64: fresh.publicKeyB64,
  };
}

const note = (entityId: string, title: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  entityId,
  schemaVersion: 3,
  payload: { title, body: '', mediaRef: null },
});

async function push(world: ChainWorld, ops: Parameters<typeof processPushBatch>[2]) {
  const result = await processPushBatch(
    productionDeps(),
    { deviceId: world.deviceId, tenantId: world.tenantId },
    ops,
  );
  return result.results.map((r) => r.status);
}

test('carried changes are accepted as new, duplicate when already held, and refused like any other push', async () => {
  const oldPhone = makeWorld(5101, serverCryptoPort);
  await seedWorld(db, oldPhone);
  const former = id(1);
  await seedUser(db, oldPhone.tenantId, former);
  await grantAllPermissions(db, oldPhone.tenantId, former);

  // The old registration sent one note, then saved two more it never sent.
  const oldChain = new ChainBuilder(oldPhone, serverCryptoPort);
  const oldGenesis = oldChain.genesis();
  const sent = oldChain.append(note(id(2), 'terkirim'));
  expect(await push(oldPhone, [oldGenesis, sent])).toEqual(['accepted', 'accepted']);
  const neverSent = oldChain.append(note(id(3), 'belum terkirim'));
  const byFormer = oldChain.append({ ...note(id(4), 'oleh mantan karyawan'), userId: former });
  // Since then the second employee was deactivated, and the server forgot the old phone.
  await db.updateTable('users').set({ status: 'deactivated' }).where('id', '=', former).execute();

  // The owner re-enrolled the phone; it carries over all three changes it believes are unsent (the
  // ack for the first was lost), keeping their ids, authors and times.
  const newPhone = reEnrolled(oldPhone, 5102);
  await seedDevice(db, newPhone);
  const chain = new ChainBuilder(newPhone, serverCryptoPort);
  const ordered = [
    chain.genesis(),
    chain.append({
      type: 'auth.device_changes_transferred',
      entityType: 'device',
      entityId: newPhone.deviceId,
      payload: { fromDeviceIds: [oldPhone.deviceId], opCount: 3 },
      source: 'system',
    }),
    ...[sent, neverSent, byFormer].map((op) =>
      chain.append({
        id: op.id,
        type: op.type,
        entityType: op.entityType,
        entityId: op.entityId,
        schemaVersion: op.schemaVersion,
        payload: op.payload,
        userId: op.userId,
        timestamp: op.timestamp,
      }),
    ),
  ];

  expect(await push(newPhone, ordered)).toEqual([
    'accepted', // genesis
    'accepted', // the transfer record
    'duplicate', // already on the server under the old phone
    'accepted', // never sent before
    'rejected', // its author was deactivated
  ]);

  // A retried batch (its answer lost) gets the same answers and moves nothing.
  expect(await push(newPhone, ordered)).toEqual([
    'duplicate',
    'duplicate',
    'duplicate',
    'duplicate',
    'rejected',
  ]);

  const stored = await db
    .selectFrom('operations')
    .select(['id', 'deviceId', 'userId', 'timestampMs'])
    .where('id', '=', neverSent.id)
    .executeTakeFirstOrThrow();
  expect(stored).toEqual({
    id: neverSent.id,
    deviceId: newPhone.deviceId,
    userId: oldPhone.userId,
    timestampMs: String(neverSent.timestamp),
  });
  const notes = await db.selectFrom('notes').select('title').orderBy('title').execute();
  expect(notes.map((row) => row.title)).toEqual(['belum terkirim', 'terkirim']);
});

test('the transfer record must be about the device that signs it', async () => {
  const world = makeWorld(5103, serverCryptoPort);
  await seedWorld(db, world);
  const chain = new ChainBuilder(world, serverCryptoPort);
  const statuses = await push(world, [
    chain.genesis(),
    chain.append({
      type: 'auth.device_changes_transferred',
      entityType: 'device',
      entityId: world.deviceId,
      payload: { fromDeviceIds: [world.deviceId], opCount: 1 },
    }),
  ]);
  expect(statuses).toEqual(['accepted', 'rejected']);
});

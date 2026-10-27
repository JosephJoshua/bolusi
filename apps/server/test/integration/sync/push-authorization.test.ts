// The server is the authority on who may do what: every pushed op is checked against its type's
// declared permission and the author's roles in the SERVER directory, through the production
// registry and pipeline on real PostgreSQL (owner decision, 2026-10-26).
//
// Also pinned here: a refused op still spends its place in the device chain, so the device's later
// ops keep syncing, and a re-push of a refused op gets the same answer.
//
// Falsification: drop the authorization step from pipeline.ts and the refusal tests go green-to-red
// (the technician's cancel is accepted). Drop `refuse`'s head advance and every "keeps syncing" test
// fails with CHAIN_GAP.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { resolveDeps } from '../../../src/deps.js';
import { DEFAULT_ROLES, type RoleKey } from '../../../src/identity/permissions.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import {
  readAnomalies,
  readOps,
  seedRepairTicket,
  seedUser,
  seedWorld,
  testId,
} from '../oplog/helpers.js';

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

/** An enrolled device whose user holds NO role yet; each test grants exactly what it needs. */
async function setupWorld(seed: number): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis();
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash, grants: 'none' });
  await seedRepairTicket(db, world, TICKET);
  return { world, builder };
}

/** Grant `userId` the provisioned default role `key` (its real permission set) in one store. */
async function grantDefaultRole(
  world: ChainWorld,
  userId: string,
  key: RoleKey,
  storeId: string | null,
  roleSeed: number,
): Promise<string> {
  const def = DEFAULT_ROLES.find((role) => role.key === key)!;
  const roleId = testId(roleSeed);
  await db
    .insertInto('roles')
    .values({
      id: roleId,
      tenantId: world.tenantId,
      name: key,
      scopeType: def.scopeType,
      isSystemDefault: true,
      createdAt: 1_726_000_000_000n,
    })
    .execute();
  await db
    .insertInto('rolePermissions')
    .values(
      def.permissionIds.map((permissionId) => ({ roleId, permissionId, tenantId: world.tenantId })),
    )
    .execute();
  await db
    .insertInto('userRoles')
    .values({ tenantId: world.tenantId, userId, roleId, storeId })
    .execute();
  return roleId;
}

const TICKET = '01920000-0000-7000-8000-0000000d0001';

function cancel(builder: ChainBuilder, userId?: string) {
  return builder.append({
    type: 'repair.ticket_cancelled',
    schemaVersion: 2,
    entityType: 'repair_ticket',
    entityId: TICKET,
    payload: { reason: 'Pelanggan batal', fee: 0, standardFee: 0 },
    ...(userId === undefined ? {} : { userId }),
  });
}

/** A cashier's op: declining a proposed price change. */
/** A cashier's own price change (repair.quote_change), on a fresh line each time. */
function changePrice(builder: ChainBuilder, n: number) {
  return builder.append({
    type: 'repair.quote_changed',
    entityType: 'repair_ticket',
    entityId: TICKET,
    schemaVersion: 2,
    payload: {
      lineId: `01920000-0000-7000-8000-0000000d00${n.toString().padStart(2, '0')}`,
      kind: 'part',
      description: 'LCD',
      amount: 100_000,
      reason: 'Ganti LCD',
      customerAgreed: true,
      fromProposal: false,
      waitsForCustomer: false,
    },
  });
}

function startWork(builder: ChainBuilder, userId?: string) {
  return builder.append({
    type: 'repair.work_started',
    entityType: 'repair_ticket',
    entityId: TICKET,
    payload: {},
    ...(userId === undefined ? {} : { userId }),
  });
}

async function push(world: ChainWorld, ops: Parameters<typeof processPushBatch>[2]) {
  return processPushBatch(
    productionDeps(),
    { deviceId: world.deviceId, tenantId: world.tenantId },
    ops,
  );
}

async function refusedRows(tenantId: string) {
  return db
    .selectFrom('refusedOperations')
    .select(['id', 'code', 'userId', 'type'])
    .where('tenantId', '=', tenantId)
    .execute();
}

describe('every pushed op is authorized against the server directory', () => {
  test('a technician cannot cancel a repair: refused PERMISSION_DENIED, never logged or folded', async () => {
    const { world, builder } = await setupWorld(3201);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 3201);
    const op = cancel(builder);

    const result = await push(world, [op]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'PERMISSION_DENIED',
      reason: expect.stringContaining('repair.cancel'),
    });
    expect(await readOps(db, world.tenantId)).toEqual([]);
    expect(await refusedRows(world.tenantId)).toEqual([
      { id: op.id, code: 'PERMISSION_DENIED', userId: world.userId, type: op.type },
    ]);
    // A role change while offline is not tampering: no device alarm.
    expect(await readAnomalies(db, world.deviceId)).toEqual([]);
  });

  test('positive control: the same op from a store owner in this store is accepted', async () => {
    const { world, builder } = await setupWorld(3202);
    await grantDefaultRole(world, world.userId, 'store_owner', world.storeId, 3202);

    const result = await push(world, [cancel(builder)]);

    expect(result.results[0]).toMatchObject({ status: 'accepted' });
  });

  test('a cashier may no longer cancel, nor set the store’s cancellation fees', async () => {
    // Counter staff kept customers' cash by cancelling (product-scope.md, "Cancelling a servisan").
    const { world, builder } = await setupWorld(3207);
    await grantDefaultRole(world, world.userId, 'cashier', world.storeId, 3207);
    const cancelled = cancel(builder);
    const fees = builder.append({
      type: 'repair.store_cancel_fees_changed',
      entityType: 'repair_store_cancel_fees',
      entityId: world.storeId,
      payload: { beforeWork: 0, afterWork: 0 },
    });

    const result = await push(world, [cancelled, fees]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'PERMISSION_DENIED',
      'PERMISSION_DENIED',
    ]);
  });

  test('a store-owner grant in ANOTHER store does not authorize this store', async () => {
    const { world, builder } = await setupWorld(3203);
    const otherStore = testId(32031);
    await db
      .insertInto('stores')
      .values({ id: otherStore, tenantId: world.tenantId, name: 'other', createdAt: 1n })
      .execute();
    await grantDefaultRole(world, world.userId, 'store_owner', otherStore, 3203);

    const result = await push(world, [cancel(builder)]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'PERMISSION_DENIED' });
  });

  test('a tenant-wide main_owner grant authorizes every store', async () => {
    const { world, builder } = await setupWorld(3204);
    await grantDefaultRole(world, world.userId, 'main_owner', null, 3204);

    const result = await push(world, [cancel(builder)]);

    expect(result.results[0]).toMatchObject({ status: 'accepted' });
  });

  test('a role removed on the server before the push is honoured: the next op is refused', async () => {
    const { world, builder } = await setupWorld(3205);
    const roleId = await grantDefaultRole(world, world.userId, 'cashier', world.storeId, 3205);
    expect((await push(world, [startWork(builder)])).results[0]).toMatchObject({
      status: 'rejected',
      code: 'PERMISSION_DENIED',
    });
    expect((await push(world, [changePrice(builder, 1)])).results[0]).toMatchObject({
      status: 'accepted',
    });

    await db.deleteFrom('userRoles').where('roleId', '=', roleId).execute();

    expect((await push(world, [changePrice(builder, 2)])).results[0]).toMatchObject({
      status: 'rejected',
      code: 'PERMISSION_DENIED',
    });
  });

  test('an op attributed to a member who holds the permission is judged by THAT user, not the device', async () => {
    const { world, builder } = await setupWorld(3206);
    const ownerId = testId(32061);
    await seedUser(db, world.tenantId, ownerId);
    await grantDefaultRole(world, ownerId, 'store_owner', world.storeId, 3206);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 32062);

    const result = await push(world, [cancel(builder, ownerId), cancel(builder)]);

    expect(result.results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
  });
});

describe('an op is credited only to an employee of the device`s store', () => {
  /** A user of this tenant who works ONLY at a new other store. */
  async function outsider(world: ChainWorld, seed: number): Promise<string> {
    const otherStore = testId(seed);
    await db
      .insertInto('stores')
      .values({ id: otherStore, tenantId: world.tenantId, name: 'other', createdAt: 1n })
      .execute();
    const userId = testId(seed + 1);
    await db
      .insertInto('users')
      .values({ id: userId, tenantId: world.tenantId, name: 'outsider', createdAt: 1n })
      .execute();
    await db
      .insertInto('userStores')
      .values({ userId, storeId: otherStore, tenantId: world.tenantId })
      .execute();
    return userId;
  }

  test('borrowing a main owner who does not work at this store is refused', async () => {
    // Falsification: without the store-membership rule the owner's tenant-wide grant passes and a
    // technician's device cancels the repair in the owner's name.
    const { world, builder } = await setupWorld(3240);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 3240);
    const owner = await outsider(world, 32401);
    await grantDefaultRole(world, owner, 'main_owner', null, 32403);

    const result = await push(world, [cancel(builder, owner)]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'PERMISSION_DENIED',
      reason: expect.stringContaining('does not work at this store'),
    });
    // Positive control: the same owner, once they work here, may cancel.
    await db
      .insertInto('userStores')
      .values({ userId: owner, storeId: world.storeId, tenantId: world.tenantId })
      .execute();
    expect((await push(world, [cancel(builder, owner)])).results[0]).toMatchObject({
      status: 'accepted',
    });
  });

  test('unlocking the PIN of an employee of another store needs the grant there too', async () => {
    const { world, builder } = await setupWorld(3241);
    await grantDefaultRole(world, world.userId, 'store_owner', world.storeId, 3241);
    const colleague = testId(32413);
    await seedUser(db, world.tenantId, colleague); // before the other store exists: works here only
    const elsewhere = await outsider(world, 32411);
    const unlock = (target: string) =>
      builder.append({
        type: 'auth.pin_lockout_cleared',
        entityType: 'user_credential',
        entityId: target,
        payload: {},
      });

    const result = await push(world, [unlock(elsewhere), unlock(colleague)]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'PERMISSION_DENIED',
      reason: expect.stringContaining('every store of the target'),
    });
    // Positive control: a colleague at this store.
    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });
});

describe('a deactivated author is refused for every op type, permission-free ones included', () => {
  test('a session switch by a deactivated user is refused, an active user`s is accepted', async () => {
    // Joseph (2026-10-26): refuse ALL of a deactivated employee's unsynced changes. A runtime-written
    // type declares no permission, so without the active-author rule it would slip through.
    const { world, builder } = await setupWorld(3230);
    const formerId = testId(32301);
    await seedUser(db, world.tenantId, formerId, 'deactivated');
    const switchTo = (userId?: string) =>
      builder.append({
        type: 'auth.user_switched',
        entityType: 'auth_session',
        payload: { previousSessionId: null, previousUserId: null },
        ...(userId === undefined ? {} : { userId }),
      });

    const result = await push(world, [switchTo(formerId), switchTo()]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'PERMISSION_DENIED',
      reason: expect.stringContaining('no longer active'),
    });
    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });
});

describe('a refused op does not stop the device syncing', () => {
  test('the ops after a refused one are accepted, in the same batch and in the next', async () => {
    const { world, builder } = await setupWorld(3210);
    const ownerId = testId(32101);
    await seedUser(db, world.tenantId, ownerId);
    await grantDefaultRole(world, ownerId, 'store_owner', world.storeId, 3210);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 32102);

    const refused = cancel(builder); // technician: no repair.cancel
    const sameBatch = startWork(builder); // technician: repair.work
    const first = await push(world, [refused, sameBatch]);
    const nextBatch = await push(world, [cancel(builder, ownerId)]);

    expect(first.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(nextBatch.results[0]).toMatchObject({ status: 'accepted' });
    const device = await db
      .selectFrom('devices')
      .select('lastSeq')
      .where('id', '=', world.deviceId)
      .executeTakeFirstOrThrow();
    expect(Number(device.lastSeq)).toBe(4);
  });

  test('a schema-invalid op spends its place too, so one bad payload cannot wedge a device', async () => {
    const { world, builder } = await setupWorld(3211);
    await grantDefaultRole(world, world.userId, 'store_owner', world.storeId, 3211);
    const bad = builder.append({
      type: 'repair.ticket_cancelled',
      schemaVersion: 2,
      entityType: 'repair_ticket',
      entityId: TICKET,
      payload: { reason: '', fee: 0, standardFee: 0 }, // reason must be non-empty
    });

    const result = await push(world, [bad, cancel(builder)]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'SCHEMA_INVALID',
      'accepted',
    ]);
  });

  test('an op naming a record kind its type does not write is refused SCHEMA_INVALID', async () => {
    // A cancel aimed at a customer row would fold, and conflict-match, against the wrong records.
    const { world, builder } = await setupWorld(3214);
    await grantDefaultRole(world, world.userId, 'store_owner', world.storeId, 3214);
    const misfiled = builder.append({
      type: 'repair.ticket_cancelled',
      schemaVersion: 2,
      entityType: 'repair_customer',
      entityId: TICKET,
      payload: { reason: 'Pelanggan batal', fee: 0, standardFee: 0 },
    });

    const result = await push(world, [misfiled, cancel(builder)]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_INVALID',
      reason: expect.stringContaining('repair_customer'),
    });
    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('re-pushing a batch whose response was lost gives the same answers, with no tamper alarm', async () => {
    const { world, builder } = await setupWorld(3212);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 3212);
    const batch = [cancel(builder), startWork(builder)];

    const first = await push(world, batch);
    const retry = await push(world, batch);

    expect(retry.results).toEqual([first.results[0], { id: batch[1]!.id, status: 'duplicate' }]);
    expect(await readAnomalies(db, world.deviceId)).toEqual([]);
    expect(await refusedRows(world.tenantId)).toHaveLength(1);
  });

  test('a different op reusing a refused op id is not answered from the refusal', async () => {
    const { world, builder } = await setupWorld(3213);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 3213);
    const refused = cancel(builder);
    await push(world, [refused]);

    // Same id, different content, re-signed at the same position: it must go through validation
    // (and break the chain), not borrow the stored verdict.
    const impostor = { ...refused, hash: 'a'.repeat(64) };
    const result = await push(world, [impostor]);

    expect(result.results[0]).toMatchObject({ status: 'rejected' });
    expect(result.results[0]).not.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('a later refused op reusing a refused id is still answered, not a batch-wide 500', async () => {
    const { world, builder } = await setupWorld(3215);
    await grantDefaultRole(world, world.userId, 'technician', world.storeId, 3215);
    const first = cancel(builder);
    const reused = builder.append({
      id: first.id,
      type: 'repair.ticket_cancelled',
      schemaVersion: 2,
      entityType: 'repair_ticket',
      entityId: TICKET,
      payload: { reason: 'Lagi', fee: 0, standardFee: 0 },
    });

    const result = await push(world, [first, reused, startWork(builder)]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'PERMISSION_DENIED',
      'PERMISSION_DENIED',
      'accepted',
    ]);
  });
});

describe('a refusal can always be stored', () => {
  test('an unknown type carrying a NUL character is refused, not a batch-wide 500', async () => {
    const { world, builder } = await setupWorld(3250);
    await grantDefaultRole(world, world.userId, 'store_owner', world.storeId, 3250);
    const odd = builder.append({
      type: 'repair.ticket\u0000cancelled',
      entityType: 'repair_ticket',
      entityId: TICKET,
      payload: {},
    });

    const result = await push(world, [odd, cancel(builder)]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'UNKNOWN_TYPE',
      'accepted',
    ]);
  });
});

describe('every media ref in a payload is bound to the op signer', () => {
  function ref(world: ChainWorld, deviceId: string) {
    return {
      mediaId: '01920000-0000-7000-8000-0000000f00a1',
      sha256: 'e'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      sizeBytes: 4_211,
      capturedAt: 1_726_000_000_000,
      location: null,
      userId: world.userId,
      deviceId,
    };
  }

  test('a handover citing another device`s signature capture is refused SCOPE_VIOLATION', async () => {
    // Falsification: the binding used to read only payload.mediaRef, so this reached the schema
    // and permission steps as an honest handover.
    const { world, builder } = await setupWorld(3220);
    await grantDefaultRole(world, world.userId, 'cashier', world.storeId, 3220);
    const other = makeWorld(3221, serverCryptoPort);
    const op = builder.append({
      type: 'repair.device_returned',
      entityType: 'repair_ticket',
      entityId: TICKET,
      payload: {
        handoverPhoto: ref(world, world.deviceId),
        signature: ref(world, other.deviceId),
        note: '',
      },
    });

    const result = await push(world, [op]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
      reason: expect.stringContaining('media ref deviceId'),
    });
  });
});

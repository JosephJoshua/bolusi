// An op type whose rule only judges newer versions declares `minPushVersion`: a new push signed at
// an older version would skip that check, so the server refuses it. Stored history still folds.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { resolveDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { grantRole, seedRepairTicket, seedWorld, testId } from '../oplog/helpers.js';

let db: Kysely<DB>;
let closeDb: (() => Promise<void>) | undefined;

const NOW = 1_726_100_000_000;
const TICKET = '01920000-0000-7000-8000-0000000a0001';

function forTenantOn(handle: Kysely<DB>): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

function productionDeps(): OplogPipelineDeps {
  const deps = resolveDeps({ forTenant: forTenantOn(db), now: () => NOW });
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
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
});

async function setupWorld(
  seed: number,
  grants: 'all' | 'none',
): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis();
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash, grants });
  await seedRepairTicket(db, world, TICKET);
  return { world, builder };
}

function push(world: ChainWorld, ops: Parameters<typeof processPushBatch>[2]) {
  return processPushBatch(
    productionDeps(),
    { deviceId: world.deviceId, tenantId: world.tenantId },
    ops,
  );
}

describe('a push signed at a retired schemaVersion', () => {
  test('a limited manager cannot waive the cancel fee by signing ticket_cancelled v1', async () => {
    const { world, builder } = await setupWorld(9101, 'none');
    const roleId = testId(9102);
    await grantRole(db, {
      tenantId: world.tenantId,
      userId: world.userId,
      roleId,
      roleName: 'manager',
      permissionIds: ['repair.cancel'],
    });
    // A limited role with no priceDrop row: its limit at this store is Rp 0.
    await db.updateTable('roles').set({ limited: true }).where('id', '=', roleId).execute();
    await db
      .insertInto('repairStoreCancelFees')
      .values({
        storeId: world.storeId,
        tenantId: world.tenantId,
        beforeWork: 50_000n,
        afterWork: 50_000n,
        updatedBy: world.userId,
        updatedAt: 1n,
      })
      .execute();
    const cancel = (schemaVersion: number, payload: Record<string, unknown>) =>
      builder.append({
        type: 'repair.ticket_cancelled',
        schemaVersion,
        entityType: 'repair_ticket',
        entityId: TICKET,
        payload,
      });

    const result = await push(world, [
      cancel(2, { reason: 'Pelanggan batal', fee: 0, standardFee: 50_000 }),
      cancel(1, { reason: 'Pelanggan batal' }),
      cancel(2, { reason: 'Pelanggan batal', fee: 50_000, standardFee: 50_000 }),
    ]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'RULE_VIOLATED',
      reason: 'repair.refusal.overLimit',
    });
    expect(result.results[1]).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_INVALID',
      reason: 'repair.ticket_cancelled v1 is no longer accepted; the oldest accepted is v2',
    });
    // The refusal spends the chain position, so the device's next op still syncs.
    expect(result.results[2]).toMatchObject({ status: 'accepted' });
    const ticket = await db
      .selectFrom('repairTickets')
      .select(['outcome', 'cancelFee'])
      .where('id', '=', TICKET)
      .executeTakeFirstOrThrow();
    expect(ticket).toEqual({ outcome: 'cancelled', cancelFee: '50000' });
  });

  test.each([
    ['repair.ticket_opened', 3, 4],
    ['repair.quote_changed', 1, 2],
    ['repair.device_returned', 1, 3],
    ['repair.device_returned', 2, 3],
  ])('%s v%i is refused, naming v%i as the oldest accepted', async (type, version, floor) => {
    const { world, builder } = await setupWorld(9300 + version, 'all');
    const op = builder.append({
      type,
      schemaVersion: version,
      entityType: 'repair_ticket',
      entityId: TICKET,
      payload: {},
    });

    const result = await push(world, [op]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_INVALID',
      reason: `${type} v${version} is no longer accepted; the oldest accepted is v${floor}`,
    });
  });
});

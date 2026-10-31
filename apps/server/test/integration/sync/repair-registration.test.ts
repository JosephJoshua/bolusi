// The repair module folds through the real push path on real PostgreSQL: a device pushes a
// customer, a ticket with its six intake photos, a claim, the work photos, a price change and the
// handover, and the server's projections (uuid/bigint columns, RLS) end up with the same ticket the
// device shows.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { formatTicketNumber } from '@bolusi/modules/repair';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import type { MediaRef } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect, inject, test } from 'vitest';

import { resolveDeps, SERVER_MODULES } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { seedWorld } from '../oplog/helpers.js';

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

async function setupWorld(seed: number): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis();
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash });
  return { world, builder };
}

test('the production module list carries repair', () => {
  expect(SERVER_MODULES.map((m) => m.id)).toContain('repair');
});

test('a pushed repair journey folds into the server projections', async () => {
  const { world, builder } = await setupWorld(3101);
  const photo = (n: number): MediaRef => ({
    mediaId: `01920000-0000-7000-8000-00000000f0${n.toString().padStart(2, '0')}`,
    sha256: 'd'.repeat(64),
    mime: 'image/jpeg',
    type: 'image',
    sizeBytes: 50_000,
    capturedAt: 1_726_000_000_000,
    location: null,
    userId: world.userId,
    deviceId: world.deviceId,
  });
  const customerId = '01920000-0000-7000-8000-0000000c0001';
  const ticketId = '01920000-0000-7000-8000-0000000c0002';
  const lineId = '01920000-0000-7000-8000-0000000c0003';
  const changeId = '01920000-0000-7000-8000-0000000c0004';
  const ticketNumber = formatTicketNumber(world.deviceId, 1);
  const document = { kind: 'repair.ticket', id: ticketId, label: ticketNumber };

  const ops = [
    builder.append({
      type: 'repair.customer_registered',
      entityType: 'repair_customer',
      entityId: customerId,
      payload: { name: 'Yohanis Wenda', phone: null },
    }),
    builder.append({
      type: 'repair.ticket_opened',
      entityType: 'repair_ticket',
      entityId: ticketId,
      schemaVersion: 4,
      payload: {
        ticketNumber,
        customerId,
        device: { brand: 'Samsung', model: 'A14', color: 'Hitam', imei: null, passcode: null },
        complaint: 'Layar retak',
        intakeNotes: '',
        checklist: [{ item: 'screen', label: null, state: 'issue', note: '' }],
        peripherals: [{ item: 'charger', label: null }],
        estimatedReadyAt: 1_726_200_000_000,
        quoteLines: [{ lineId, kind: 'part', description: 'LCD', amount: 650_000 }],
        photos: (['front', 'back', 'left', 'right', 'top', 'bottom'] as const).map((slot, i) => ({
          slot,
          label: null,
          ref: photo(i + 1),
        })),
        repairTypes: [],
        claimOf: null,
        ownershipVideo: null,
      },
    }),
    builder.append({
      type: 'repair.ticket_claimed',
      entityType: 'repair_ticket',
      entityId: ticketId,
      payload: {},
    }),
    builder.append({
      type: 'repair.work_photos_added',
      entityType: 'repair_ticket',
      entityId: ticketId,
      payload: { stage: 'before', photos: [photo(9)] },
    }),
    builder.append({
      type: 'repair.work_started',
      entityType: 'repair_ticket',
      entityId: ticketId,
      payload: {},
    }),
    builder.append({
      type: 'repair.quote_changed',
      entityType: 'repair_ticket',
      entityId: ticketId,
      schemaVersion: 2,
      payload: {
        lineId: changeId,
        kind: 'discount',
        description: 'Diskon',
        amount: -50_000,
        reason: 'Langganan',
        customerAgreed: true,
        fromProposal: false,
        waitsForCustomer: false,
      },
    }),
    builder.append({
      type: 'repair.work_photos_added',
      entityType: 'repair_ticket',
      entityId: ticketId,
      payload: { stage: 'after', photos: [photo(10)] },
    }),
    builder.append({
      type: 'repair.marked_repaired',
      entityType: 'repair_ticket',
      entityId: ticketId,
      payload: { note: '' },
    }),
    // The handover settles the bill first, as `returnDevice` does: charged, then paid.
    builder.append({
      type: 'money.charge_recorded',
      entityType: 'money_entry',
      entityId: '01920000-0000-7000-8000-0000000c0005',
      payload: { document, amount: 600_000, account: 'service_revenue' },
    }),
    builder.append({
      type: 'money.payment_received',
      entityType: 'money_entry',
      entityId: '01920000-0000-7000-8000-0000000c0006',
      payload: { document, account: 'cash', amount: 600_000, reference: null, tendered: null },
    }),
    builder.append({
      type: 'repair.device_returned',
      entityType: 'repair_ticket',
      entityId: ticketId,
      schemaVersion: 3,
      payload: {
        handoverPhoto: photo(7),
        signature: photo(8),
        note: '',
        unpaidReason: null,
        checklist: [{ item: 'charger', label: null, kind: 'accessory', done: true }],
      },
    }),
  ];

  const result = await processPushBatch(
    productionDeps(),
    { deviceId: world.deviceId, tenantId: world.tenantId },
    ops,
  );
  expect(result.results.map((r) => r.status)).toEqual(ops.map(() => 'accepted'));

  const ticket = await db
    .selectFrom('repairTickets')
    .select(['ticketNumber', 'outcome', 'location', 'quoteTotal', 'customerId', 'returnedBy'])
    .executeTakeFirstOrThrow();
  expect(ticket).toEqual({
    ticketNumber,
    outcome: 'repaired',
    location: 'returned',
    quoteTotal: '600000', // bigint comes back as a string from pg
    customerId,
    returnedBy: world.userId,
  });
  const photos = await db.selectFrom('repairTicketPhotos').select('slot').execute();
  expect(photos).toHaveLength(10);
  const events = await db.selectFrom('repairTicketEvents').select('kind').execute();
  expect(events).toHaveLength(8);
});

test('a ticket payload missing a required photo is rejected and folds nothing', async () => {
  const { world, builder } = await setupWorld(3102);
  const op = builder.append({
    type: 'repair.ticket_opened',
    entityType: 'repair_ticket',
    schemaVersion: 4,
    payload: {
      ticketNumber: 'K7Q-0001',
      customerId: '01920000-0000-7000-8000-0000000c0001',
      device: { brand: 'Samsung', model: 'A14', color: '', imei: null, passcode: null },
      complaint: 'x',
      intakeNotes: '',
      checklist: [],
      peripherals: [],
      estimatedReadyAt: null,
      quoteLines: [
        {
          lineId: '01920000-0000-7000-8000-0000000c0003',
          kind: 'part',
          description: 'LCD',
          amount: 1,
        },
      ],
      photos: [],
      repairTypes: [],
      claimOf: null,
      ownershipVideo: null,
    },
  });
  const result = await processPushBatch(
    productionDeps(),
    { deviceId: world.deviceId, tenantId: world.tenantId },
    [op],
  );
  expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCHEMA_INVALID' });
  expect(await db.selectFrom('repairTickets').select('id').execute()).toEqual([]);
});

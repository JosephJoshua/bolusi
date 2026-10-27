// The server judges every pushed repair op by its type's rules against the server's own records, so
// a signed op from a tampered or stale phone cannot forge a state change, reach into another store,
// assign a non-technician, take a ticket number its device did not mint, flip a price line's sign,
// or carry a future timestamp that would win last-writer-wins. Each refusal spends the op's chain
// position, so the phone's later ops still sync.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { CLOCK_AHEAD_MARGIN_MS } from '@bolusi/core';
import { formatTicketNumber } from '@bolusi/modules/repair';
import type { MediaRef } from '@bolusi/schemas';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { resolveDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import {
  grantRole,
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

const NOW = 1_726_100_000_000;

function forTenantOn(handle: Kysely<DB>): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

function productionDeps(): OplogPipelineDeps {
  const deps = resolveDeps({ forTenant: appForTenant, now: () => NOW });
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

const TICKET = '01920000-0000-7000-8000-0000000e0001';

async function setupWorld(
  seed: number,
  grants: 'all' | 'none' = 'all',
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

function ticketOp(
  builder: ChainBuilder,
  type: string,
  payload: Record<string, unknown>,
  extra: {
    readonly entityId?: string;
    readonly timestamp?: number;
    readonly schemaVersion?: number;
  } = {},
) {
  return builder.append({
    type,
    entityType: 'repair_ticket',
    entityId: extra.entityId ?? TICKET,
    payload,
    ...(extra.timestamp === undefined ? {} : { timestamp: extra.timestamp }),
    ...(extra.schemaVersion === undefined ? {} : { schemaVersion: extra.schemaVersion }),
  });
}

const cancel = (builder: ChainBuilder, extra?: { readonly timestamp?: number }) =>
  ticketOp(builder, 'repair.ticket_cancelled', { reason: 'Pelanggan batal' }, extra);

async function outcome(ticketId = TICKET): Promise<string | undefined> {
  const row = await db
    .selectFrom('repairTickets')
    .select('outcome')
    .where('id', '=', ticketId)
    .executeTakeFirst();
  return row?.outcome;
}

async function refusals(tenantId: string) {
  return db
    .selectFrom('refusedOperations')
    .select(['id', 'code'])
    .where('tenantId', '=', tenantId)
    .execute();
}

function photo(world: ChainWorld, n: number): MediaRef {
  return {
    mediaId: `01920000-0000-7000-8000-00000000f1${n.toString().padStart(2, '0')}`,
    sha256: 'd'.repeat(64),
    mime: 'image/jpeg',
    type: 'image',
    sizeBytes: 50_000,
    capturedAt: 1_726_000_000_000,
    location: null,
    userId: world.userId,
    deviceId: world.deviceId,
  };
}

/** A ticket_opened op for the seeded customer, numbered `ticketNumber`. */
function openTicket(
  builder: ChainBuilder,
  world: ChainWorld,
  ticketId: string,
  ticketNumber: string,
) {
  const lineId = `${ticketId.slice(0, -8)}aaaa${ticketId.slice(-4)}`;
  return ticketOp(
    builder,
    'repair.ticket_opened',
    {
      ticketNumber,
      customerId: `${TICKET.slice(0, -4)}cccc`,
      device: { brand: 'Oppo', model: 'A57', color: '', imei: null, passcode: null },
      complaint: 'Tidak bisa dicas',
      intakeNotes: '',
      checklist: [],
      peripherals: [],
      estimatedReadyAt: null,
      quoteLines: [{ lineId, kind: 'labour', description: 'Ganti konektor', amount: 150_000 }],
      photos: {
        front: photo(world, 1),
        back: photo(world, 2),
        left: photo(world, 3),
        right: photo(world, 4),
        top: photo(world, 5),
        bottom: photo(world, 6),
      },
    },
    { entityId: ticketId },
  );
}

describe('a pushed repair op must be legal against the server`s records', () => {
  test('a forged state change is refused RULE_VIOLATED, and the device`s next op still syncs', async () => {
    const { world, builder } = await setupWorld(3301);
    // The seeded ticket is `received`: nobody started work, so it cannot be marked repaired.
    const forged = ticketOp(builder, 'repair.marked_repaired', { note: '' });

    const result = await push(world, [forged, cancel(builder)]);

    // The reason is the rule's refusal key: the phone shows its copy ("belum mulai dikerjakan").
    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'RULE_VIOLATED',
      reason: 'repair.refusal.notStarted',
    });
    expect(result.results[1]).toMatchObject({ status: 'accepted' });
    expect(await outcome()).toBe('cancelled');
    expect(await refusals(world.tenantId)).toEqual([{ id: forged.id, code: 'RULE_VIOLATED' }]);
    // Two people changing one ticket offline is not tampering: no device alarm.
    expect(await readAnomalies(db, world.deviceId)).toEqual([]);
  });

  test('a ticket in another store of the tenant cannot be touched', async () => {
    const { world, builder } = await setupWorld(3302);
    const otherStore = testId(33021);
    const otherTicket = '01920000-0000-7000-8000-0000000f0001';
    await db
      .insertInto('stores')
      .values({ id: otherStore, tenantId: world.tenantId, name: 'other', createdAt: 1n })
      .execute();
    await seedRepairTicket(db, { ...world, storeId: otherStore }, otherTicket);

    const op = ticketOp(
      builder,
      'repair.ticket_cancelled',
      { reason: 'x' },
      { entityId: otherTicket },
    );
    const result = await push(world, [op]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'RULE_VIOLATED',
      reason: 'repair.refusal.ticketNotFound',
    });
    expect(await outcome(otherTicket)).toBe('received');
  });

  test('a ticket can be assigned only to someone who holds repair.work in this store', async () => {
    const { world, builder } = await setupWorld(3303);
    const cashier = testId(33031);
    await seedUser(db, world.tenantId, cashier); // works at the store, holds no role

    const assign = (technicianId: string) =>
      ticketOp(builder, 'repair.technician_assigned', { technicianId });
    const technician = testId(33032);
    await seedUser(db, world.tenantId, technician);
    await db
      .insertInto('roles')
      .values({
        id: testId(33033),
        tenantId: world.tenantId,
        name: 'technician',
        scopeType: 'store',
        isSystemDefault: false,
        createdAt: 1n,
      })
      .execute();
    await db
      .insertInto('rolePermissions')
      .values({ roleId: testId(33033), permissionId: 'repair.work', tenantId: world.tenantId })
      .execute();
    await db
      .insertInto('userRoles')
      .values({
        tenantId: world.tenantId,
        userId: technician,
        roleId: testId(33033),
        storeId: world.storeId,
      })
      .execute();

    const result = await push(world, [assign(cashier), assign(technician)]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(result.results[0]).toMatchObject({
      code: 'RULE_VIOLATED',
      reason: 'repair.refusal.notTechnician',
    });
    const row = await db
      .selectFrom('repairTickets')
      .select('technicianId')
      .where('id', '=', TICKET)
      .executeTakeFirstOrThrow();
    expect(row.technicianId).toBe(technician);
  });

  test('a ticket number must be minted by the sending device, and only once', async () => {
    const { world, builder } = await setupWorld(3304);
    const own = formatTicketNumber(world.deviceId, 7);
    const foreignCode = own.startsWith('ZZZ-') ? 'YYY' : 'ZZZ';
    const ids = ['f001', 'f002', 'f003'].map((s) => `01920000-0000-7000-8000-0000000e${s}`);

    const result = await push(world, [
      openTicket(builder, world, ids[0]!, `${foreignCode}-0007`),
      openTicket(builder, world, ids[1]!, own),
      openTicket(builder, world, ids[2]!, own),
    ]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted', 'rejected']);
    expect(result.results[0]).toMatchObject({ reason: 'repair.refusal.numberNotThisDevice' });
    expect(result.results[2]).toMatchObject({ reason: 'repair.refusal.numberUsed' });
    const tickets = await db
      .selectFrom('repairTickets')
      .select('id')
      .where('ticketNumber', '=', own)
      .execute();
    expect(tickets).toEqual([{ id: ids[1] }]);
  });

  test('a discount line that raises the price is refused', async () => {
    const { world, builder } = await setupWorld(3305);
    const line = (lineId: string, amount: number) =>
      ticketOp(builder, 'repair.quote_changed', {
        lineId,
        kind: 'discount',
        description: 'Diskon',
        amount,
        reason: 'Langganan',
        customerAgreed: true,
        fromProposal: false,
      });

    const result = await push(world, [
      line('01920000-0000-7000-8000-0000000e0a01', 50_000),
      line('01920000-0000-7000-8000-0000000e0a02', -50_000),
    ]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(result.results[0]).toMatchObject({ reason: 'repair.refusal.wrongSign' });
    const lines = await db.selectFrom('repairQuoteLines').select(['id', 'amount']).execute();
    expect(lines.map((line) => [line.id, Number(line.amount)])).toEqual([
      ['01920000-0000-7000-8000-0000000e0a02', -50_000],
    ]);
  });
});

describe('owner-only prices and settings', () => {
  test('lowering a price needs repair.discount, on a change and on a proposal', async () => {
    const { world, builder } = await setupWorld(3340, 'none');
    await grantRole(db, {
      tenantId: world.tenantId,
      userId: world.userId,
      roleId: testId(3341),
      roleName: 'cashier',
      permissionIds: ['repair.quote_change', 'repair.work'],
    });
    const lineId = (n: number) => `01920000-0000-7000-8000-0000000e0b0${n}`;
    const change = (n: number, kind: string, amount: number) =>
      ticketOp(
        builder,
        'repair.quote_changed',
        {
          lineId: lineId(n),
          kind,
          description: 'Ubah harga',
          amount,
          reason: 'Langganan',
          customerAgreed: true,
          fromProposal: false,
          waitsForCustomer: false,
        },
        { schemaVersion: 2 },
      );
    const discount = change(1, 'discount', -10_000);
    const part = change(2, 'part', 80_000);
    const propose = ticketOp(builder, 'repair.quote_change_proposed', {
      lineId: lineId(3),
      kind: 'adjustment',
      description: 'Potongan',
      amount: -5_000,
      reason: 'Langganan',
    });

    const result = await push(world, [discount, part, propose]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted', 'rejected']);
    for (const refused of [result.results[0], result.results[2]]) {
      expect(refused).toMatchObject({
        code: 'RULE_VIOLATED',
        reason: 'repair.refusal.discountOwnerOnly',
      });
    }
  });

  test('a price change waits exactly when the customer has not agreed yet', async () => {
    const { world, builder } = await setupWorld(3342);
    const change = (n: number, customerAgreed: boolean, waitsForCustomer: boolean) =>
      ticketOp(
        builder,
        'repair.quote_changed',
        {
          lineId: `01920000-0000-7000-8000-0000000e0c0${n}`,
          kind: 'part',
          description: 'LCD',
          amount: 300_000,
          reason: 'Ganti LCD',
          customerAgreed,
          fromProposal: false,
          waitsForCustomer,
        },
        { schemaVersion: 2 },
      );

    const result = await push(world, [change(1, true, true), change(2, false, true)]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(result.results[0]).toMatchObject({
      reason: 'repair.refusal.customerAgreementMismatch',
    });
  });

  test('a store sets cancellation fees only for itself', async () => {
    const { world, builder } = await setupWorld(3343);
    const setFees = (entityId: string) =>
      builder.append({
        type: 'repair.store_cancel_fees_changed',
        entityType: 'repair_store_cancel_fees',
        entityId,
        storeId: world.storeId,
        payload: { beforeWork: 0, afterWork: 50_000 },
      });

    const result = await push(world, [setFees(testId(3344)), setFees(world.storeId)]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(result.results[0]).toMatchObject({ reason: 'repair.refusal.notThisStore' });
  });
});

describe('a pushed op stamped in the future is refused', () => {
  test('beyond the margin: CLOCK_AHEAD with a device alarm, and the next op still syncs', async () => {
    const { world, builder } = await setupWorld(3310);
    const ahead = ticketOp(
      builder,
      'repair.ticket_claimed',
      {},
      { timestamp: NOW + CLOCK_AHEAD_MARGIN_MS + 1 },
    );

    const result = await push(world, [ahead, cancel(builder, { timestamp: NOW })]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'CLOCK_AHEAD' });
    expect(result.results[1]).toMatchObject({ status: 'accepted' });
    expect((await readOps(db, world.tenantId)).map((op) => op.id)).not.toContain(ahead.id);
    expect(await refusals(world.tenantId)).toEqual([{ id: ahead.id, code: 'CLOCK_AHEAD' }]);
    expect(await readAnomalies(db, world.deviceId)).toEqual([
      expect.objectContaining({ kind: 'CLOCK_SKEW' }),
    ]);
  });

  test('within the margin the op is accepted', async () => {
    const { world, builder } = await setupWorld(3311);

    const result = await push(world, [cancel(builder, { timestamp: NOW + CLOCK_AHEAD_MARGIN_MS })]);

    expect(result.results[0]).toMatchObject({ status: 'accepted' });
  });
});

describe('every module`s ops are judged by their rules, not only repair', () => {
  test('notes: an edit of a note that does not exist in this store is refused', async () => {
    const { world, builder } = await setupWorld(3320);
    const noteId = '01920000-0000-7000-8000-0000000e0b01';
    const create = builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      entityId: noteId,
      schemaVersion: 3,
      payload: { title: 'Stok', body: 'awal', mediaRef: null },
    });
    const ghostEdit = builder.append({
      type: 'notes.note_body_edited',
      entityType: 'note',
      entityId: '01920000-0000-7000-8000-0000000e0b02',
      payload: { body: 'x' },
    });
    const recreate = builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      entityId: noteId,
      schemaVersion: 3,
      payload: { title: 'Lain', body: 'timpa', mediaRef: null },
    });

    const result = await push(world, [create, ghostEdit, recreate]);

    expect(result.results.map((r) => r.status)).toEqual(['accepted', 'rejected', 'rejected']);
    expect(result.results[1]).toMatchObject({
      code: 'RULE_VIOLATED',
      reason: 'notes.refusal.noteNotFound',
    });
    expect(result.results[2]).toMatchObject({
      code: 'RULE_VIOLATED',
      reason: 'notes.refusal.alreadyRecorded',
    });
  });

  test('platform: a user cannot change another user`s language', async () => {
    const { world, builder } = await setupWorld(3321);
    const colleague = testId(33211);
    await seedUser(db, world.tenantId, colleague);
    const setLocale = (entityId: string) =>
      builder.append({
        type: 'platform.user_locale_changed',
        entityType: 'user_pref',
        entityId,
        storeId: null,
        payload: { locale: 'en' },
      });

    const result = await push(world, [setLocale(colleague), setLocale(world.userId)]);

    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(result.results[0]).toMatchObject({
      code: 'RULE_VIOLATED',
      reason: 'platform.refusal.notYourPreference',
    });
  });

  test('platform: acknowledging a conflict that does not exist is refused', async () => {
    const { world, builder } = await setupWorld(3322);
    const ack = builder.append({
      type: 'platform.conflict_acknowledged',
      entityType: 'conflict',
      entityId: '01920000-0000-7000-8000-0000000e0c01',
      payload: { note: null },
    });

    const result = await push(world, [ack]);

    expect(result.results[0]).toMatchObject({
      status: 'rejected',
      code: 'RULE_VIOLATED',
      reason: 'platform.refusal.conflictNotFound',
    });
  });
  test('repair intake options: a store hides options only for itself, and a list must be valid', async () => {
    const { world, builder } = await setupWorld(3323);
    const hide = (entityId: string) =>
      builder.append({
        type: 'repair.store_intake_options_changed',
        entityType: 'repair_store_intake_options',
        entityId,
        storeId: world.storeId,
        payload: { list: 'brands', hidden: [] },
      });
    const saveList = (items: readonly { id: string; label: string | null }[]) =>
      builder.append({
        type: 'repair.intake_options_changed',
        entityType: 'repair_intake_options',
        entityId: world.tenantId,
        storeId: null,
        payload: { list: 'brands', items },
      });

    const result = await push(world, [
      hide(testId(3324)), // another store's record
      hide(world.storeId),
      saveList([]), // brands may be empty
      saveList([
        { id: testId(3325), label: 'Oppo' },
        { id: testId(3326), label: 'oppo' }, // the same name twice
      ]),
    ]);

    expect(result.results.map((r) => r.status)).toEqual([
      'rejected',
      'accepted',
      'accepted',
      'rejected',
    ]);
    expect(result.results[0]).toMatchObject({ reason: 'repair.refusal.notThisStore' });
    expect(result.results[3]).toMatchObject({ reason: 'repair.refusal.invalidOptions' });
  });
});

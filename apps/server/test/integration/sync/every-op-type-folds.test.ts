// Every op type a device can push is accepted and folded on real PostgreSQL.
//
// Appliers run on every phone (SQLite) and on the server, inside the push transaction. An applier
// that writes something Postgres refuses (a 32-bit column, a malformed uuid, a missing row it
// expected) fails the whole push, and the device re-sends the same batch forever. Each module's
// registration suite pushes a journey, but those journeys are picked by hand: before this file,
// eight of the fourteen repair op types had never folded on Postgres in any test.
//
// So the list of samples below is checked against the registered modules. A new op type fails
// here until it has a sample that the server accepts and folds. The samples form legal journeys,
// so they also pass every type's rule: a rule that refuses ordinary shop work fails here too.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { formatTicketNumber, statusCodeFor } from '@bolusi/modules/repair';
import { ChainBuilder, makeWorld, type ChainWorld, type OpSpec } from '@bolusi/test-support';
import type { MediaRef } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect, inject, test } from 'vitest';

import { resolveDeps, SERVER_MODULES } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { grantRole, seedUser, seedWorld } from '../oplog/helpers.js';

/** A status link as a phone makes it: a nonce and the code it gives this servisan. */
function statusLink(world: ChainWorld, ticketId: string): { code: string; nonce: string } {
  const nonce = '0123456789abcdef'.repeat(2);
  const owner = { tenantId: world.tenantId, storeId: world.storeId, ticketId };
  return { code: statusCodeFor(owner, nonce, (data) => serverCryptoPort.sha256(data)), nonce };
}

/** Built by the server itself (conflict detection); a device that pushes it is refused. */
const SERVER_WRITTEN = new Set(['platform.conflict_detected']);

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
  `01920000-0000-7000-8000-0000000c${n.toString(16).padStart(4, '0')}`;

/** A colleague who asks for approvals; only someone else may answer them. */
const ASKER = id(0x5ff);

/** One legal journey per module, in push order, touching every op type a device can push. */
function journey(world: ChainWorld): OpSpec[] {
  const photo = (n: number): MediaRef => ({
    mediaId: id(0x100 + n),
    sha256: 'd'.repeat(64),
    mime: 'image/jpeg',
    type: 'image',
    sizeBytes: 50_000,
    capturedAt: 1_726_000_000_000,
    location: null,
    userId: world.userId,
    deviceId: world.deviceId,
  });
  const customer = id(1);
  const ticket = id(2);
  const cancelledTicket = id(3);
  const note = id(4);
  const screen = { item: 'screen', label: null, warrantyDays: 30, needsVideo: false };
  const part = id(8);
  const category = id(9);
  // A part drawn for the servisan while it is being worked on, and the unused one put back.
  const partsUsed = (): OpSpec[] => {
    const use = { kind: 'repair_ticket', id: ticket, label: formatTicketNumber(world.deviceId, 1) };
    const movement = (n: number, type: string, payload: Record<string, unknown>): OpSpec => ({
      type,
      entityType: 'inventory_movement',
      entityId: id(0x300 + n),
      payload,
    });
    const lcdFields = [
      { id: 'hp', label: 'HP', kind: 'phones', options: [] },
      { id: 'q', label: 'Kualitas', kind: 'one', options: ['Original', 'OEM'] },
    ];
    return [
      {
        type: 'inventory.category_added',
        entityType: 'inventory_category',
        entityId: category,
        storeId: null,
        payload: { name: 'LCD', isPart: true, fields: lcdFields, nameFormat: 'LCD {HP}' },
      },
      {
        type: 'inventory.category_edited',
        entityType: 'inventory_category',
        entityId: category,
        storeId: null,
        payload: {
          name: 'LCD',
          isPart: true,
          fields: lcdFields,
          nameFormat: 'LCD {HP} {Kualitas}',
          archived: false,
        },
      },
      {
        type: 'inventory.item_added',
        entityType: 'inventory_item',
        entityId: part,
        storeId: null,
        payload: {
          name: 'LCD Samsung Galaxy A14 Original',
          nameAuto: true,
          code: null,
          barcode: '8991234567890',
          categoryId: category,
          values: { q: ['Original'] },
          tags: ['laris'],
          fits: [{ brand: 'Samsung', model: 'Galaxy A14' }],
        },
      },
      {
        type: 'inventory.item_edited',
        entityType: 'inventory_item',
        entityId: part,
        storeId: null,
        payload: {
          name: 'LCD Samsung A14',
          nameAuto: false,
          code: 'LCD-A14',
          barcode: null,
          categoryId: null,
          values: {},
          tags: [],
          fits: [
            { brand: 'Samsung', model: 'Galaxy A14' },
            { brand: '', model: 'A14 5G' },
          ],
          archived: false,
        },
      },
      movement(1, 'inventory.stock_counted', { itemId: part, counted: 3, expected: 0, note: null }),
      movement(2, 'inventory.item_taken', { itemId: part, qty: 2, use }),
      movement(3, 'inventory.item_put_back', { itemId: part, qty: 1, use }),
    ];
  };
  /** The current version, with the repair types picked at intake (none when left out). */
  const opened = (
    ticketId: string,
    ticketNumber: string,
    lineId: string,
    repairTypes: readonly object[] = [],
  ): OpSpec => ({
    type: 'repair.ticket_opened',
    entityType: 'repair_ticket',
    entityId: ticketId,
    schemaVersion: 4,
    payload: {
      repairTypes,
      claimOf: null,
      ownershipVideo: null,
      ticketNumber,
      customerId: customer,
      device: { brand: 'Samsung', model: 'A14', color: 'Hitam', imei: null, passcode: null },
      complaint: 'Layar retak',
      intakeNotes: '',
      checklist: [{ item: 'screen', label: null, state: 'issue', note: '' }],
      peripherals: [{ item: 'charger', label: null }],
      estimatedReadyAt: 1_726_200_000_000,
      quoteLines: [{ lineId, kind: 'part', description: 'LCD', amount: 650_000 }],
      // Every angle the store asks for (the six defaults): the server checks them too.
      photos: ['front', 'back', 'left', 'right', 'top', 'bottom'].map((slot, i) => ({
        slot,
        label: null,
        ref: photo(i === 0 ? 1 : i === 1 ? 2 : 20 + i),
      })),
    },
  });
  /** Discount requests on the open second servisan: one line (650.000) until the third applies. */
  const approvals = (): OpSpec[] => {
    const line = {
      ticketId: cancelledTicket,
      kind: 'discount',
      description: 'Diskon langganan',
      amount: -10_000,
      reason: 'Langganan',
      customerAgreed: false,
    };
    const asked = (n: number): OpSpec => ({
      type: 'approvals.request_made',
      entityType: 'approval_request',
      entityId: id(n),
      userId: ASKER,
      payload: {
        kind: 'repair.discount',
        target: { entityType: 'repair_ticket', entityId: cancelledTicket },
        input: line,
        amount: 10_000,
        reason: 'Langganan',
        basis: 'received|in_store|650000|1',
      },
    });
    const answered = (type: string, n: number, userId = world.userId): OpSpec => ({
      type,
      entityType: 'approval_request',
      entityId: id(n),
      userId,
      payload: type === 'approvals.request_withdrawn' ? {} : { note: null },
    });
    return [
      asked(0x500),
      answered('approvals.request_rejected', 0x500),
      asked(0x501),
      answered('approvals.request_withdrawn', 0x501, ASKER),
      asked(0x502),
      answered('approvals.request_approved', 0x502),
      // The decision, as the approver's, on a line named after the request.
      {
        type: 'repair.quote_changed',
        entityType: 'repair_ticket',
        entityId: cancelledTicket,
        schemaVersion: 2,
        payload: {
          lineId: id(0x502),
          kind: 'discount',
          description: 'Diskon langganan',
          amount: -10_000,
          reason: 'Langganan',
          customerAgreed: false,
          fromProposal: false,
          waitsForCustomer: true,
        },
      },
    ];
  };
  const onTicket = (type: string, payload: Record<string, unknown>): OpSpec => ({
    type,
    entityType: 'repair_ticket',
    entityId: ticket,
    payload,
  });
  const document = {
    kind: 'repair.ticket',
    id: ticket,
    label: formatTicketNumber(world.deviceId, 1),
  };
  const money = (type: string, n: number, payload: Record<string, unknown>): OpSpec => ({
    type,
    entityType: 'money_entry',
    entityId: id(n),
    payload,
  });
  const credential = (type: string, payload: Record<string, unknown>): OpSpec => ({
    type,
    entityType: 'user_credential',
    entityId: world.userId,
    payload,
  });

  return [
    // platform
    {
      type: 'platform.user_locale_changed',
      entityType: 'user_pref',
      entityId: world.userId,
      storeId: null,
      payload: { locale: 'en' },
    },
    {
      type: 'platform.conflict_acknowledged',
      entityType: 'conflict',
      entityId: id(5),
      payload: { note: null },
    },

    // notes
    {
      type: 'notes.note_created',
      entityType: 'note',
      entityId: note,
      schemaVersion: 3,
      payload: { title: 'Stok', body: 'awal', mediaRef: photo(9) },
    },
    { type: 'notes.note_body_edited', entityType: 'note', entityId: note, payload: { body: 'b' } },
    { type: 'notes.note_archived', entityType: 'note', entityId: note, payload: {} },

    // repair
    {
      type: 'repair.intake_options_changed',
      entityType: 'repair_intake_options',
      entityId: world.tenantId,
      storeId: null,
      payload: {
        list: 'checks',
        items: [
          { id: 'screen', label: null },
          { id: 'tinta-bocor', label: 'Tinta bocor' },
        ],
      },
    },
    {
      type: 'repair.intake_options_changed',
      entityType: 'repair_intake_options',
      entityId: world.tenantId,
      storeId: null,
      schemaVersion: 2,
      payload: {
        list: 'repairTypes',
        items: [
          { id: 'screen', label: null, warrantyDays: 30, needsVideo: false },
          { id: 'battery', label: null, warrantyDays: 30, needsVideo: false },
          { id: 'buka-icloud', label: 'Buka iCloud', warrantyDays: 0, needsVideo: true },
        ],
      },
    },
    {
      type: 'repair.store_cancel_fees_changed',
      entityType: 'repair_store_cancel_fees',
      entityId: world.storeId,
      payload: { beforeWork: 0, afterWork: 25_000 },
    },
    {
      type: 'repair.store_uncollected_days_changed',
      entityType: 'repair_store_uncollected',
      entityId: world.storeId,
      payload: { days: 45 },
    },
    {
      type: 'repair.store_intake_options_changed',
      entityType: 'repair_store_intake_options',
      entityId: world.storeId,
      payload: { list: 'checks', hidden: ['tinta-bocor'] },
    },
    {
      type: 'repair.store_intake_options_changed',
      entityType: 'repair_store_intake_options',
      entityId: world.storeId,
      schemaVersion: 2,
      payload: { list: 'repairTypes', hidden: ['buka-icloud'] },
    },
    {
      type: 'repair.store_print_settings_changed',
      entityType: 'repair_store_print_settings',
      entityId: world.storeId,
      payload: {
        name: 'Bolusi Cell Sorong',
        address: 'Jl. Basuki Rahmat No. 12',
        phone: '0812-4800-1234',
        logo: photo(12),
        logoOnDotMatrix: false,
        intakeTerms: 'Bawa nota ini saat ambil HP.',
        handoverTerms: null,
      },
    },
    {
      type: 'repair.customer_registered',
      entityType: 'repair_customer',
      entityId: customer,
      payload: { name: 'Yohanis Wenda', phone: null },
    },
    {
      type: 'repair.customer_details_corrected',
      entityType: 'repair_customer',
      entityId: customer,
      payload: { name: 'Yohanis Wenda', phone: '081234567890' },
    },
    opened(ticket, formatTicketNumber(world.deviceId, 1), id(0x200), [screen]),
    onTicket('repair.down_payment_received', { amount: 100_000 }),
    onTicket('repair.down_payment_corrected', { amount: 150_000, reason: 'Salah ketik' }),
    onTicket('repair.slip_printed', { slip: 'intake' }),
    onTicket('repair.status_link_made', statusLink(world, ticket)),
    onTicket('repair.ticket_claimed', {}),
    onTicket('repair.work_photos_added', { stage: 'before', photos: [photo(7)] }),
    onTicket('repair.work_started', {}),
    onTicket('repair.ticket_repair_types_changed', {
      repairTypes: [screen, { item: 'battery', label: null, warrantyDays: 30, needsVideo: false }],
    }),
    ...partsUsed(),
    onTicket('repair.quote_change_proposed', {
      lineId: id(0x201),
      kind: 'part',
      description: 'Baterai',
      amount: 250_000,
      reason: 'Baterai kembung',
    }),
    onTicket('repair.quote_proposal_declined', { lineId: id(0x201), note: 'Tidak jadi' }),
    {
      ...onTicket('repair.quote_changed', {}),
      schemaVersion: 2,
      payload: {
        lineId: id(0x202),
        kind: 'discount',
        description: 'Diskon',
        amount: -50_000,
        reason: 'Langganan',
        customerAgreed: true,
        fromProposal: false,
        waitsForCustomer: false,
      },
    },
    onTicket('repair.work_paused', { note: 'Tunggu sparepart' }),
    onTicket('repair.work_started', {}),
    onTicket('repair.work_photos_added', { stage: 'after', photos: [photo(8)] }),
    onTicket('repair.marked_repaired', { note: '' }),
    onTicket('repair.ticket_details_corrected', {
      device: { brand: 'Samsung', model: 'Galaxy A15', color: 'Hitam', imei: null },
      reason: 'Salah ketik',
    }),

    // money: a DP, the charge, a split payment, an owner's refund, a void, and the drawer
    {
      type: 'money.account_saved',
      entityType: 'money_account',
      entityId: id(0x400),
      payload: { kind: 'qris', name: 'QRIS BCA toko', active: true },
    },
    {
      type: 'money.central_account_saved',
      entityType: 'money_account',
      entityId: id(0x401),
      storeId: null,
      payload: { kind: 'transfer', name: 'BCA pusat', active: true, storeIds: [] },
    },
    money('money.payment_received', 0x402, {
      document,
      account: 'cash',
      amount: 100_000,
      reference: null,
      tendered: 150_000,
    }),
    // A DP fix asked against that payment (read on Postgres the way the device reads it), then
    // taken back.
    {
      type: 'approvals.request_made',
      entityType: 'approval_request',
      entityId: id(0x503),
      userId: ASKER,
      payload: {
        kind: 'repair.downPayment',
        target: { entityType: 'repair_ticket', entityId: ticket },
        input: { ticketId: ticket, amount: 80_000, reason: 'Salah ketik', reference: null },
        amount: 20_000,
        reason: 'Salah ketik',
        basis: `repaired|in_store|600000|3|${id(0x402)}`,
      },
    },
    {
      type: 'approvals.request_withdrawn',
      entityType: 'approval_request',
      entityId: id(0x503),
      userId: ASKER,
      payload: {},
    },
    money('money.charge_recorded', 0x403, {
      document,
      amount: 600_000,
      account: 'service_revenue',
    }),
    money('money.payment_received', 0x404, {
      document,
      account: `account:${id(0x400)}`,
      amount: 500_000,
      reference: null,
      tendered: null,
    }),
    money('money.payment_received', 0x405, {
      document,
      account: `account:${id(0x401)}`,
      amount: 5_000,
      reference: 'TRF-1',
      tendered: null,
    }),
    { ...money('money.payment_voided', 0x405, { reason: 'Salah catat' }) },
    money('money.charge_reduced', 0x406, { document, amount: 10_000, reason: 'Komplain' }),
    money('money.refund_paid', 0x407, {
      document,
      account: 'cash',
      amount: 10_000,
      reason: 'Komplain',
      reference: null,
    }),
    money('money.cash_moved', 0x408, {
      kind: 'withdrawal',
      amount: 50_000,
      reason: 'Setor ke pemilik',
      account: null,
    }),
    money('money.cash_moved', 0x40b, {
      kind: 'float',
      amount: 5_000_000,
      reason: 'Uang kembalian',
      account: null,
    }),
    money('money.cash_move_voided', 0x40b, { reason: 'Kelebihan nol' }),
    money('money.cash_counted', 0x409, { counted: 30_000, note: '' }),
    money('money.cash_adjusted', 0x40a, { amount: -10_000, countId: id(0x409), reason: 'Kurang' }),

    // Paid in full above, so the phone may leave.
    {
      ...onTicket('repair.device_returned', {
        handoverPhoto: photo(10),
        signature: photo(11),
        note: '',
        unpaidReason: null,
        checklist: [{ item: 'charger', label: null, kind: 'accessory', done: true }],
      }),
      schemaVersion: 3,
    },
    onTicket('repair.slip_printed', { slip: 'handover' }),
    // Handed over by mistake, then handed over again.
    onTicket('repair.handover_reversed', { reason: 'Salah servisan' }),
    {
      ...onTicket('repair.device_returned', {
        handoverPhoto: photo(13),
        signature: photo(14),
        note: '',
        unpaidReason: null,
        checklist: [{ item: 'charger', label: null, kind: 'accessory', done: true }],
      }),
      schemaVersion: 3,
    },
    opened(cancelledTicket, formatTicketNumber(world.deviceId, 2), id(0x210)),
    {
      type: 'repair.technician_assigned',
      entityType: 'repair_ticket',
      entityId: cancelledTicket,
      payload: { technicianId: world.userId },
    },
    // approvals: a colleague asks for a discount three times; it is rejected, withdrawn, approved
    ...approvals(),
    {
      type: 'repair.ticket_cancelled',
      entityType: 'repair_ticket',
      entityId: cancelledTicket,
      schemaVersion: 2,
      payload: { reason: 'Pelanggan batal', fee: 0, standardFee: 0 },
    },

    // auth (the genesis `auth.device_enrolled` is pushed first, by the test)
    {
      type: 'auth.device_changes_transferred',
      entityType: 'device',
      entityId: world.deviceId,
      payload: { fromDeviceIds: [id(0x300)], opCount: 1 },
    },
    {
      type: 'auth.user_switched',
      entityType: 'auth_session',
      entityId: id(6),
      payload: { previousSessionId: null, previousUserId: null },
    },
    credential('auth.pin_changed', { targetUserId: world.userId, verifierRef: world.userId }),
    credential('auth.pin_reset', { targetUserId: world.userId, verifierRef: world.userId }),
    credential('auth.pin_locked_out', {
      consecutiveFailures: 10,
      windowStartedAt: 1_726_000_000_000,
    }),
    credential('auth.pin_lockout_cleared', {}),
    {
      type: 'auth.permission_denied',
      entityType: 'permission_denial',
      payload: {
        permissionId: 'auth.role_manage',
        surface: 'command',
        target: 'auth.manageRole',
        reason: 'not_granted',
        scopeStoreId: null,
        suppressedRepeats: 0,
      },
    },
    {
      type: 'auth.session_ended',
      entityType: 'auth_session',
      entityId: id(6),
      payload: { reason: 'manual_lock' },
    },
  ];
}

test('the journey covers every op type a device can push, across every registered module', () => {
  const world = makeWorld(3201, serverCryptoPort);
  const declared = SERVER_MODULES.flatMap((module) => Object.keys(module.operations));
  const pushable = declared.filter((type) => !SERVER_WRITTEN.has(type)).sort();
  const sampled = new Set(['auth.device_enrolled', ...journey(world).map((spec) => spec.type)]);

  expect(pushable.length).toBeGreaterThan(20);
  expect([...sampled].sort()).toEqual(pushable);
  for (const type of SERVER_WRITTEN) expect(declared).toContain(type);
});

test('every sampled op is accepted and folds on PostgreSQL', async () => {
  const world = makeWorld(3202, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  await seedWorld(db, world);
  // The author holds every permission, so a refusal here is about the op, never about the role.
  await grantRole(db, {
    tenantId: world.tenantId,
    userId: world.userId,
    roleId: id(7),
    roleName: 'store_owner',
    permissionIds: SERVER_MODULES.flatMap((module) => Object.keys(module.permissions ?? {})),
  });
  await seedUser(db, world.tenantId, ASKER);
  await grantRole(db, {
    tenantId: world.tenantId,
    userId: ASKER,
    roleId: id(0x5fe),
    roleName: 'cashier',
    permissionIds: ['approvals.use', 'repair.read', 'repair.quote_change', 'repair.intake'],
  });
  // Conflicts are recorded only by the server, so the one the journey acknowledges is seeded.
  await db
    .insertInto('conflicts')
    .values({
      id: id(5),
      tenantId: world.tenantId,
      storeId: world.storeId,
      entityType: 'note',
      entityId: id(4),
      conflictKey: 'note.body',
      severity: 'minor',
      status: 'surfaced',
      opAId: id(0x300),
      opBId: id(0x301),
      detectedAt: 1_726_000_000_000n,
    })
    .execute();
  const ops = [builder.genesis(), ...journey(world).map((spec) => builder.append(spec))];

  const result = await processPushBatch(
    productionDeps(),
    { deviceId: world.deviceId, tenantId: world.tenantId },
    ops,
  );

  const refused = result.results
    .map((r, i) => ({ type: ops[i]!.type, ...r }))
    .filter((r) => r.status !== 'accepted');
  expect(refused).toEqual([]);

  // The folds landed: each journey's end state is in the server's projections.
  const tickets = await db
    .selectFrom('repairTickets')
    .select(['ticketNumber', 'outcome', 'location', 'downPayment', 'repairTypesJson'])
    .orderBy('ticketNumber')
    .execute();
  expect(tickets).toEqual([
    {
      ticketNumber: formatTicketNumber(world.deviceId, 1),
      outcome: 'repaired',
      location: 'returned',
      downPayment: '150000',
      repairTypesJson: expect.stringContaining('"item":"battery"'),
    },
    {
      ticketNumber: formatTicketNumber(world.deviceId, 2),
      outcome: 'cancelled',
      location: 'in_store',
      downPayment: null,
      repairTypesJson: '[]',
    },
  ]);
  const notes = await db.selectFrom('notes').select('archived').execute();
  expect(notes).toEqual([{ archived: true }]);
  // The money folds balance, and the servisan is settled: 100k DP + 500k QRIS, less the owner's 10k.
  const books = await sql<{ debit: string; credit: string }>`
    SELECT SUM(debit) AS debit, SUM(credit) AS credit FROM money_lines
  `.execute(db);
  expect(books.rows[0]!.debit).toBe(books.rows[0]!.credit);
  const owed = await sql<{ balance: string }>`
    SELECT SUM(debit - credit) AS balance FROM money_lines
    WHERE account = 'receivable' AND document_id = ${id(2)}
  `.execute(db);
  expect(Number(owed.rows[0]!.balance)).toBe(0);
});

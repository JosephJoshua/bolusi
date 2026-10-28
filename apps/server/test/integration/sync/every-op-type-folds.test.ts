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
import { formatTicketNumber } from '@bolusi/modules/repair';
import { ChainBuilder, makeWorld, type ChainWorld, type OpSpec } from '@bolusi/test-support';
import type { MediaRef } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect, inject, test } from 'vitest';

import { resolveDeps, SERVER_MODULES } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { grantRole, seedWorld } from '../oplog/helpers.js';

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
  const opened = (ticketId: string, ticketNumber: string, lineId: string): OpSpec => ({
    type: 'repair.ticket_opened',
    entityType: 'repair_ticket',
    entityId: ticketId,
    schemaVersion: 2,
    payload: {
      ticketNumber,
      customerId: customer,
      device: { brand: 'Samsung', model: 'A14', color: 'Hitam', imei: null, passcode: null },
      complaint: 'Layar retak',
      intakeNotes: '',
      checklist: [{ item: 'screen', label: null, state: 'issue', note: '' }],
      peripherals: [{ item: 'charger', label: null }],
      estimatedReadyAt: 1_726_200_000_000,
      quoteLines: [{ lineId, kind: 'part', description: 'LCD', amount: 650_000 }],
      photos: [
        { slot: 'front', label: null, ref: photo(1) },
        { slot: 'back', label: null, ref: photo(2) },
      ],
    },
  });
  const onTicket = (type: string, payload: Record<string, unknown>): OpSpec => ({
    type,
    entityType: 'repair_ticket',
    entityId: ticket,
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
      type: 'repair.store_cancel_fees_changed',
      entityType: 'repair_store_cancel_fees',
      entityId: world.storeId,
      payload: { beforeWork: 0, afterWork: 25_000 },
    },
    {
      type: 'repair.store_intake_options_changed',
      entityType: 'repair_store_intake_options',
      entityId: world.storeId,
      payload: { list: 'checks', hidden: ['tinta-bocor'] },
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
    opened(ticket, formatTicketNumber(world.deviceId, 1), id(0x200)),
    onTicket('repair.down_payment_received', { amount: 100_000 }),
    onTicket('repair.down_payment_corrected', { amount: 150_000, reason: 'Salah ketik' }),
    onTicket('repair.slip_printed', { slip: 'intake' }),
    onTicket('repair.ticket_claimed', {}),
    onTicket('repair.work_photos_added', { stage: 'before', photos: [photo(7)] }),
    onTicket('repair.work_started', {}),
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
    onTicket('repair.device_returned', {
      handoverPhoto: photo(10),
      signature: photo(11),
      note: '',
    }),
    onTicket('repair.slip_printed', { slip: 'handover' }),
    opened(cancelledTicket, formatTicketNumber(world.deviceId, 2), id(0x210)),
    {
      type: 'repair.technician_assigned',
      entityType: 'repair_ticket',
      entityId: cancelledTicket,
      payload: { technicianId: world.userId },
    },
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
    .select(['ticketNumber', 'outcome', 'location', 'downPayment'])
    .orderBy('ticketNumber')
    .execute();
  expect(tickets).toEqual([
    {
      ticketNumber: formatTicketNumber(world.deviceId, 1),
      outcome: 'repaired',
      location: 'returned',
      downPayment: '150000',
    },
    {
      ticketNumber: formatTicketNumber(world.deviceId, 2),
      outcome: 'cancelled',
      location: 'in_store',
      downPayment: null,
    },
  ]);
  const notes = await db.selectFrom('notes').select('archived').execute();
  expect(notes).toEqual([{ archived: true }]);
});

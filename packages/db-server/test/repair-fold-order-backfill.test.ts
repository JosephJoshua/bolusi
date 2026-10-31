// Migration 0029 settles tickets the old appliers folded wrong when ops folded in another order than
// the server judged them: the server never re-folds, so this is what corrects its records.
import { afterAll, beforeAll, expect, test } from 'vitest';

import { up } from '../migrations/0029_repair_fold_order.js';
import { seedTenant, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let world: TenantFixture;

beforeAll(async () => {
  testDb = await createTestDb();
  world = await seedTenant(testDb.db);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

const OPENED_AT = 5_000;

type Event = readonly [kind: string, at: number, detail?: object];

async function seedTicket(
  row: { outcome: string; location?: string; technicianId?: string | null; quoteTotal?: number },
  events: readonly Event[],
  lines: readonly { id: string; amount: number; status: string }[] = [],
): Promise<string> {
  const scope = { tenantId: world.tenantId, storeId: world.storeId };
  const customerId = uuid();
  const ticketId = uuid();
  await testDb.db
    .insertInto('repairCustomers')
    .values({
      ...scope,
      id: customerId,
      name: 'Pelanggan',
      phone: null,
      createdBy: world.userId,
      createdAt: BigInt(OPENED_AT),
      updatedBy: world.userId,
      updatedAt: BigInt(OPENED_AT),
    })
    .execute();
  await testDb.db
    .insertInto('repairTickets')
    .values({
      ...scope,
      id: ticketId,
      ticketNumber: `SEED-${ticketId.slice(0, 4)}`,
      customerId,
      deviceBrand: 'Samsung',
      deviceModel: 'A14',
      deviceColor: '',
      deviceImei: null,
      devicePasscode: null,
      complaint: 'Layar retak',
      intakeNotes: '',
      checklistJson: '[]',
      peripheralsJson: '[]',
      estimatedReadyAt: null,
      outcome: row.outcome,
      outcomeNote: null,
      location: row.location ?? 'in_store',
      technicianId: row.technicianId === undefined ? world.userId : row.technicianId,
      quoteTotal: BigInt(row.quoteTotal ?? 650_000),
      createdBy: world.userId,
      createdAt: BigInt(OPENED_AT),
      updatedAt: BigInt(OPENED_AT),
      returnedBy: null,
      returnedAt: null,
    })
    .execute();
  await testDb.db
    .insertInto('repairQuoteLines')
    .values(
      [{ id: uuid(), amount: 650_000, status: 'intake' }, ...lines].map((line) => ({
        ...scope,
        id: line.id,
        ticketId,
        kind: 'part',
        description: 'LCD',
        amount: BigInt(line.amount),
        status: line.status,
        reason: null,
        customerAgreed: null,
        createdBy: world.userId,
        createdAt: BigInt(OPENED_AT),
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      })),
    )
    .execute();
  for (const [kind, at, detail = {}] of events) {
    await testDb.db
      .insertInto('repairTicketEvents')
      .values({
        ...scope,
        id: uuid(),
        ticketId,
        kind,
        actorId: world.userId,
        at: BigInt(at),
        detailJson: JSON.stringify(detail),
      })
      .execute();
  }
  return ticketId;
}

async function ticket(id: string) {
  return testDb.db
    .selectFrom('repairTickets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

test('existing tickets settle to what the server judged', async () => {
  // The owner's cancel was signed before the technician started, but judged after.
  const cancelled = await seedTicket({ outcome: 'in_repair' }, [
    ['repair.ticket_opened', OPENED_AT],
    ['repair.ticket_cancelled', 6_000, { reason: 'Batal', fee: 0, standardFee: 0 }],
    ['repair.work_started', 7_000],
  ]);
  // A technician on a phone running behind took it and paused, folding before the intake.
  const early = await seedTicket({ outcome: 'received', technicianId: null }, [
    ['repair.ticket_claimed', 1_000, { technicianId: world.userId }],
    ['repair.work_started', 1_100],
    ['repair.work_paused', 1_200, { note: 'Tunggu LCD' }],
    ['repair.ticket_opened', OPENED_AT],
  ]);
  // An approval signed before the proposal it approves, and a decline signed before its own.
  const approvedLine = uuid();
  const declinedLine = uuid();
  const decided = await seedTicket(
    { outcome: 'received' },
    [
      ['repair.ticket_opened', OPENED_AT],
      [
        'repair.quote_changed',
        6_000,
        {
          lineId: approvedLine,
          description: 'Baterai',
          amount: 200_000,
          reason: 'OK',
          customerAgreed: true,
          fromProposal: true,
        },
      ],
      ['repair.quote_proposal_declined', 6_100, { lineId: declinedLine, note: 'Mahal' }],
      ['repair.quote_change_proposed', 7_000, { lineId: approvedLine }],
      ['repair.quote_change_proposed', 7_100, { lineId: declinedLine }],
    ],
    [
      { id: approvedLine, amount: 200_000, status: 'proposed' },
      { id: declinedLine, amount: 30_000, status: 'proposed' },
    ],
  );
  // A price change folded before the intake, so the intake's total left it out.
  const shortTotal = await seedTicket(
    { outcome: 'received', quoteTotal: 650_000 },
    [['repair.ticket_opened', OPENED_AT]],
    [{ id: uuid(), amount: 50_000, status: 'applied' }],
  );
  const untouched = await seedTicket({ outcome: 'in_repair' }, [
    ['repair.ticket_opened', OPENED_AT],
    ['repair.work_started', 6_000],
  ]);
  // An undo signed on a phone running behind its handover folded first, so the phone read as out.
  const undone = await seedTicket({ outcome: 'repaired', location: 'returned' }, [
    ['repair.ticket_opened', OPENED_AT],
    ['repair.marked_repaired', 6_000, { note: '' }],
    ['repair.handover_reversed', 6_500, { reason: 'Salah servisan' }],
    ['repair.device_returned', 7_000, { note: '' }],
  ]);
  // Handed over, taken back, handed over again: out, from the first handover.
  const again = await seedTicket({ outcome: 'repaired', location: 'in_store' }, [
    ['repair.ticket_opened', OPENED_AT],
    ['repair.marked_repaired', 6_000, { note: '' }],
    ['repair.device_returned', 7_000, { note: '' }],
    ['repair.handover_reversed', 7_500, { reason: 'Salah servisan' }],
    ['repair.device_returned', 8_000, { note: '' }],
  ]);
  const before = await ticket(untouched);

  await up(testDb.db as never);

  const u = await ticket(undone);
  expect(u.location).toBe('in_store');
  expect(u.returnedBy).toBeNull();
  expect(u.outcome).toBe('repaired');
  const a = await ticket(again);
  expect(a.location).toBe('returned');
  expect(a.returnedBy).toBe(world.userId);
  expect(Number(a.returnedAt)).toBe(7_000);

  const c = await ticket(cancelled);
  expect(c.outcome).toBe('cancelled');
  expect(c.outcomeNote).toBe('Batal');
  expect(Number(c.cancelledAt)).toBe(6_000);
  expect(Number(c.readyAt)).toBe(6_000);

  const e = await ticket(early);
  expect(e.outcome).toBe('waiting_for_parts');
  expect(e.outcomeNote).toBe('Tunggu LCD');
  expect(e.technicianId).toBe(world.userId);

  const lines = await testDb.db
    .selectFrom('repairQuoteLines')
    .select(['id', 'status', 'decisionNote'])
    .where('ticketId', '=', decided)
    .execute();
  const status = new Map(lines.map((line) => [line.id, line.status]));
  expect(status.get(approvedLine)).toBe('applied');
  expect(status.get(declinedLine)).toBe('declined');
  expect(Number((await ticket(decided)).quoteTotal)).toBe(850_000);

  expect(Number((await ticket(shortTotal)).quoteTotal)).toBe(700_000);
  expect(await ticket(untouched)).toStrictEqual(before);
});

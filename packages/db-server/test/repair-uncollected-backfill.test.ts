// Migration 0021 fills `ready_at` for servisan finished before it, from their event history: the
// server never re-folds, so this is the only thing that flags a phone left before the upgrade.
import { afterAll, beforeAll, expect, test } from 'vitest';

import { down, up } from '../migrations/0021_repair_uncollected.js';
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

async function seedTicket(
  outcome: 'repaired' | 'cancelled' | 'in_repair',
  events: readonly (readonly [kind: string, at: number])[],
): Promise<string> {
  const scope = { tenantId: world.tenantId, storeId: world.storeId };
  const customerId = uuid();
  const ticketId = uuid();
  const at = 1_726_000_000_000n;
  await testDb.db
    .insertInto('repairCustomers')
    .values({
      ...scope,
      id: customerId,
      name: 'Pelanggan',
      phone: null,
      createdBy: world.userId,
      createdAt: at,
      updatedBy: world.userId,
      updatedAt: at,
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
      outcome,
      outcomeNote: null,
      location: 'in_store',
      technicianId: world.userId,
      quoteTotal: 650_000n,
      createdBy: world.userId,
      createdAt: at,
      updatedAt: at,
      returnedBy: null,
      returnedAt: null,
    })
    .execute();
  for (const [kind, eventAt] of events) {
    await testDb.db
      .insertInto('repairTicketEvents')
      .values({
        ...scope,
        id: uuid(),
        ticketId,
        kind,
        actorId: world.userId,
        at: BigInt(eventAt),
        detailJson: '{}',
      })
      .execute();
  }
  return ticketId;
}

test('servisan finished before the upgrade get the time of their latest repaired or cancel', async () => {
  const repairedTwice = await seedTicket('repaired', [
    ['repair.marked_repaired', 1_000],
    ['repair.work_started', 2_000],
    ['repair.marked_repaired', 3_000],
  ]);
  const cancelled = await seedTicket('cancelled', [['repair.ticket_cancelled', 5_000]]);
  // Finished once, then reopened: back on the bench, so not waiting for its owner.
  const reopened = await seedTicket('in_repair', [
    ['repair.marked_repaired', 1_000],
    ['repair.work_started', 2_000],
  ]);

  await down(testDb.db);
  await up(testDb.db);

  const rows = await testDb.db.selectFrom('repairTickets').select(['id', 'readyAt']).execute();
  const readyAt = new Map(
    rows.map((row) => [row.id, row.readyAt === null ? null : Number(row.readyAt)]),
  );
  expect(readyAt.get(repairedTwice)).toBe(3_000);
  expect(readyAt.get(cancelled)).toBe(5_000);
  expect(readyAt.get(reopened)).toBeNull();
});

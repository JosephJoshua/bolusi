// Migration 0028: the customer's status page arrives with a link code and nothing else, so the code
// resolves through one definer function. It must find any tenant's servisan by its code, and be the
// only way to: an ordinary SELECT as the app role still sees only its own tenant.
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import type { DB } from '../src/generated/db.js';
import { seedTenant, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  testDb = await createTestDb();
  a = await seedTenant(testDb.db);
  b = await seedTenant(testDb.db);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

async function seedTicket(world: TenantFixture, statusCode: string | null): Promise<string> {
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
      outcome: 'received',
      outcomeNote: null,
      location: 'in_store',
      technicianId: null,
      quoteTotal: 650_000n,
      createdBy: world.userId,
      createdAt: at,
      updatedAt: at,
      returnedBy: null,
      returnedAt: null,
      statusCode,
    })
    .execute();
  return ticketId;
}

/** As bolusi_app with `app.tenant_id` set, the way every request handler runs. */
function asAppScopedTo<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return testDb.db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

function lookup(trx: Transaction<DB>, code: string) {
  // The test handle has the CamelCasePlugin, so the columns come back camel-cased.
  return sql<{
    tenantId: string;
    storeId: string;
    ticketId: string;
  }>`SELECT * FROM public_find_status_link(${code})`.execute(trx);
}

test('a code finds its servisan in any tenant, and only through the definer function', async () => {
  const ticketB = await seedTicket(b, 'B7M2Q9XA4B');
  await seedTicket(a, 'A7M2Q9XA4B');

  const result = await asAppScopedTo(a.tenantId, async (trx) => ({
    found: await lookup(trx, 'B7M2Q9XA4B'),
    arbitrary: await trx
      .selectFrom('repairTickets')
      .select('id')
      .where('statusCode', '=', 'B7M2Q9XA4B')
      .execute(),
  }));

  expect(result.found.rows).toEqual([
    { tenantId: b.tenantId, storeId: b.storeId, ticketId: ticketB },
  ]);
  expect(result.arbitrary).toHaveLength(0);
});

test('an unknown code finds nothing, and a code two servisan share returns both for the caller to refuse', async () => {
  await seedTicket(a, 'SAME000000');
  await seedTicket(b, 'SAME000000');
  await seedTicket(a, null);

  const result = await asAppScopedTo(a.tenantId, async (trx) => ({
    missing: await lookup(trx, 'NONE000000'),
    shared: await lookup(trx, 'SAME000000'),
  }));

  expect(result.missing.rows).toHaveLength(0);
  expect(result.shared.rows).toHaveLength(2);
});

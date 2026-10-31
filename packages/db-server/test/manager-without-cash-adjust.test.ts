// Migration 0030 takes money.adjust_cash off the Manajer preset that 0025 seeded: settling a drawer
// shortage stays with the owners. A role someone made keeps what they gave it.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { down, up } from '../migrations/0030_manager_without_cash_adjust.js';
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

async function seedRole(name: string, isSystemDefault: boolean): Promise<string> {
  const id = uuid();
  await testDb.db
    .insertInto('roles')
    .values({
      id,
      tenantId: world.tenantId,
      name,
      scopeType: 'store',
      isSystemDefault,
      createdAt: 1_726_000_000_000n,
    })
    .execute();
  await testDb.db
    .insertInto('rolePermissions')
    .values({ roleId: id, permissionId: 'money.adjust_cash', tenantId: world.tenantId })
    .execute();
  return id;
}

async function holds(roleId: string): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM role_permissions
    WHERE role_id = ${roleId} AND permission_id = 'money.adjust_cash'
  `.execute(testDb.db);
  return rows[0]!.n > 0;
}

test('the preset Manajer loses money.adjust_cash; a made role keeps it; down restores it', async () => {
  const preset = await seedRole('manager', true);
  const made = await seedRole('kepala_toko', false);

  await up(testDb.db as never);
  expect(await holds(preset)).toBe(false);
  expect(await holds(made)).toBe(true);

  await down(testDb.db as never);
  expect(await holds(preset)).toBe(true);
});

// The server refuses to boot on a connection role that RLS does not bind. A superuser skips every
// policy even under FORCE, so the owner URL of the dev cluster would serve every tenant.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { assertRowSecurityRoleOn } from '../src/connection-role.js';
import { APP_ROLE } from '../src/schema/security.js';

import { seedNote, seedTenant } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

/** Runs the check on one pinned connection after `SET ROLE role`, so current_user is that role. */
async function checkAs(role: string): Promise<void> {
  await testDb.db.connection().execute(async (conn) => {
    await sql`SET ROLE ${sql.id(role)}`.execute(conn);
    try {
      await assertRowSecurityRoleOn(conn);
    } finally {
      await sql`RESET ROLE`.execute(conn);
    }
  });
}

test('a superuser connection reads across tenants, so the boot check refuses it', async () => {
  const a = await seedTenant(testDb.db);
  const b = await seedTenant(testDb.db);
  const bNote = await seedNote(testDb.db, b);
  // The production forTenant shape over the superuser handle sees tenant B from tenant A.
  const ids = await testDb.ownerForTenant(a.tenantId, (db) =>
    db.selectFrom('notes').select('id').execute(),
  );
  expect(ids.map((r) => r.id)).toContain(bNote);

  await expect(assertRowSecurityRoleOn(testDb.db)).rejects.toThrow(/is a superuser.*db:app-url/s);
});

test('a BYPASSRLS role is refused', async () => {
  await expect(checkAs('bolusi_auth')).rejects.toThrow(/'bolusi_auth', which has BYPASSRLS/);
});

test('bolusi_app passes', async () => {
  await expect(checkAs(APP_ROLE)).resolves.toBeUndefined();
});

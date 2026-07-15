// Migration apply / idempotency / revert (task 05 acceptance; 10-db-schema §11).
//
// This file drives the migrator itself, so it starts from an EMPTY schema (`skipMigrations`)
// rather than the migrated fixture the other files use. It ends by migrating back to latest so
// the shared postgres database is left in the state the next file expects.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { createMigrator, migrateDownToStart, migrateToLatest } from '../src/migrator.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb({ skipMigrations: true });
}, 120_000);

afterAll(async () => {
  // Leave the database migrated: on the postgres lane this schema is shared with the files
  // that run after this one.
  if (testDb !== undefined) {
    await migrateToLatest(testDb.db).catch(() => undefined);
    await testDb.close();
  }
});

async function tableNames(): Promise<string[]> {
  const { rows } = await sql<{ tableName: string }>`
    SELECT c.relname AS "tableName"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `.execute(testDb.db);
  return rows.map((r) => r.tableName);
}

test('every migration applies from an empty schema', async () => {
  const { error, results } = await createMigrator(testDb.db).migrateToLatest();

  expect(error).toBeUndefined();
  expect(results?.map((r) => r.status)).toEqual(Array(results?.length).fill('Success'));

  // The full §4–§8 table set, named so a dropped table cannot pass as "fewer results".
  const tables = await tableNames();
  for (const table of [
    'tenants',
    'tenant_op_counters',
    'stores',
    'devices',
    'system_device_chain_state',
    'permissions',
    'device_anomalies',
    'idempotency_keys',
    'operations',
    'users',
    'user_pin_verifiers',
    'roles',
    'role_permissions',
    'user_roles',
    'user_stores',
    'identity_audit',
    'control_sessions',
    'media',
    'media_chunks',
    'push_tokens',
    'conflicts',
    'auth_sessions',
    'pin_lockout_events',
    'auth_permission_denials',
    'user_prefs',
    'notes',
    'projection_watermarks',
  ]) {
    expect(tables, `${table} is missing after migrateToLatest`).toContain(table);
  }
});

test('re-running the migrations applies nothing new', async () => {
  await migrateToLatest(testDb.db);
  const { error, results } = await createMigrator(testDb.db).migrateToLatest();

  expect(error).toBeUndefined();
  expect(results).toEqual([]); // no migration re-executed
});

test('the roles migration is idempotent against pre-existing cluster roles', async () => {
  // Roles are CLUSTER-wide: a database re-created on an existing cluster re-runs 0001 against
  // roles that already exist, and CREATE ROLE has no IF NOT EXISTS. This is the exact path the
  // postgres test lane takes on every run.
  await migrateToLatest(testDb.db);

  const migrations = await createMigrator(testDb.db).getMigrations();
  const roles = migrations.find((m) => m.name === '0001_roles');
  expect(roles).toBeDefined();

  await expect(roles?.migration.up(testDb.db as never)).resolves.toBeUndefined();
});

test('both server roles exist after migrating, with neither superuser nor bypassrls', async () => {
  await migrateToLatest(testDb.db);
  const { rows } = await sql<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
     WHERE rolname IN ('bolusi_app', 'bolusi_provision') ORDER BY rolname
  `.execute(testDb.db);

  expect(rows).toEqual([
    { rolname: 'bolusi_app', rolsuper: false, rolbypassrls: false },
    { rolname: 'bolusi_provision', rolsuper: false, rolbypassrls: false },
  ]);
});

test('every table is owned by the provisioning role, not the app role', async () => {
  await migrateToLatest(testDb.db);
  const { rows } = await sql<{ tableName: string; owner: string }>`
    SELECT c.relname AS "tableName", pg_get_userbyid(c.relowner) AS "owner"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'kysely_%'
     ORDER BY c.relname
  `.execute(testDb.db);

  expect(rows.length).toBeGreaterThan(20);
  expect(rows.filter((r) => r.owner !== 'bolusi_provision')).toEqual([]);
});

test('every migration reverts cleanly to an empty schema', async () => {
  await migrateToLatest(testDb.db);
  await expect(migrateDownToStart(testDb.db)).resolves.toBeUndefined();

  // Only the migrator's own bookkeeping may remain.
  expect((await tableNames()).filter((t) => !t.startsWith('kysely_'))).toEqual([]);

  const { rows: leftovers } = await sql<{ proname: string }>`
    SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  `.execute(testDb.db);
  expect(leftovers.map((r) => r.proname)).toEqual([]); // forbid_mutation is gone too
});

test('migrations can be re-applied after a full revert', async () => {
  await migrateToLatest(testDb.db);
  await migrateDownToStart(testDb.db);

  const { error } = await createMigrator(testDb.db).migrateToLatest();
  expect(error).toBeUndefined();
  expect(await tableNames()).toContain('operations');
});

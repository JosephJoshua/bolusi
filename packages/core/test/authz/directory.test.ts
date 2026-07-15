// L2: the evaluator against the REAL client directory mirrors (10-db-schema §9.5) — the client
// migrations, the db-client shim dialect, better-sqlite3 `:memory:` (testing-guide §2.1/§2.3).
//
// The L1 suites prove the algorithm against hand-built snapshots. This one proves the loader reads
// the DDL that actually ships: column names, the `meta_kv` tenant, SQLite's NULL store_id, and the
// JSON `permission_ids` blob. A snapshot builder can agree with a wrong loader forever.
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { beforeEach, afterEach, describe, expect, test } from 'vitest';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';

import {
  assemblePermissionRegistry,
  createDirectorySource,
  loadDirectorySnapshot,
  PermissionEvaluator,
  TENANT_ID_META_KEY,
} from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';
import {
  MAIN_OWNER_IDS,
  ROLE_MAIN_OWNER,
  ROLE_STAFF,
  ROLE_STORE_OWNER,
  STAFF_IDS,
  STORE_A,
  STORE_B,
  STORE_OWNER_IDS,
  TENANT,
  USER_OWNER,
  USER_STAFF,
  USER_STORE_OWNER,
  V0_MODULES,
} from './_fixtures.js';

const registry = assemblePermissionRegistry(V0_MODULES);

let driver: DbDriver;
let db: Kysely<ClientDatabase>;

/** Write the fixture bundle into the mirrors, exactly as a bundle apply would (api/02-auth §5.2). */
async function writeBundle(): Promise<void> {
  await db
    .insertInto('metaKv')
    .values({ key: TENANT_ID_META_KEY, value: TENANT })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: TENANT }))
    .execute();

  await db.deleteFrom('usersDirectory').execute();
  await db
    .insertInto('usersDirectory')
    .values([
      { id: USER_OWNER, name: 'Owner', photoMediaId: null, status: 'active' },
      { id: USER_STORE_OWNER, name: 'Store Owner', photoMediaId: null, status: 'active' },
      { id: USER_STAFF, name: 'Staff', photoMediaId: null, status: 'active' },
    ])
    .execute();

  await db.deleteFrom('rolesDirectory').execute();
  await db
    .insertInto('rolesDirectory')
    .values([
      {
        id: ROLE_MAIN_OWNER,
        name: 'main_owner',
        scopeType: 'tenant',
        isSystemDefault: 1,
        permissionIds: JSON.stringify(MAIN_OWNER_IDS),
      },
      {
        id: ROLE_STORE_OWNER,
        name: 'store_owner',
        scopeType: 'store',
        isSystemDefault: 1,
        permissionIds: JSON.stringify(STORE_OWNER_IDS),
      },
      {
        id: ROLE_STAFF,
        name: 'staff',
        scopeType: 'store',
        isSystemDefault: 1,
        permissionIds: JSON.stringify(STAFF_IDS),
      },
    ])
    .execute();

  await db.deleteFrom('userRolesDirectory').execute();
  await db
    .insertInto('userRolesDirectory')
    .values([
      // The tenant-wide grant: store_id NULL (10-db §9.5).
      { userId: USER_OWNER, roleId: ROLE_MAIN_OWNER, storeId: null },
      { userId: USER_STORE_OWNER, roleId: ROLE_STORE_OWNER, storeId: STORE_A },
      { userId: USER_STAFF, roleId: ROLE_STAFF, storeId: STORE_A },
    ])
    .execute();
}

beforeEach(async () => {
  driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  await writeBundle();
});

afterEach(async () => {
  await db.destroy();
  await driver.close();
});

describe('loadDirectorySnapshot (10-db §9.5)', () => {
  test('reads the tenant from meta_kv — the mirrors carry no tenant_id column', async () => {
    const snapshot = await loadDirectorySnapshot(db);
    expect(snapshot.tenantId).toBe(TENANT);

    // The DDL fact this depends on: no tenant_id on the mirrors (single-tenant device DB).
    const columns = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('users_directory')
    `.execute(db);
    expect(columns.rows.length).toBeGreaterThan(0); // denominator (T-14)
    expect(columns.rows.map((r) => r.name)).not.toContain('tenant_id');
  });

  test('loads users, roles, and grants with the DDL’s real column names', async () => {
    const snapshot = await loadDirectorySnapshot(db);
    expect(snapshot.users.size).toBe(3);
    expect(snapshot.roles.size).toBe(3);
    expect(snapshot.grantsByUser.size).toBe(3);

    expect(snapshot.users.get(USER_STAFF)).toEqual({ status: 'active' });
    expect(snapshot.roles.get(ROLE_MAIN_OWNER)?.scopeType).toBe('tenant');
    expect(JSON.parse(snapshot.roles.get(ROLE_STAFF)!.permissionIdsJson)).toEqual([...STAFF_IDS]);
  });

  test('a tenant-wide grant round-trips as storeId null (not the empty string)', async () => {
    const snapshot = await loadDirectorySnapshot(db);
    expect(snapshot.grantsByUser.get(USER_OWNER)).toEqual([
      { roleId: ROLE_MAIN_OWNER, storeId: null },
    ]);
    expect(snapshot.grantsByUser.get(USER_STAFF)).toEqual([
      { roleId: ROLE_STAFF, storeId: STORE_A },
    ]);
  });

  test('a user holding two roles loads both grants (the union input, FR-1023)', async () => {
    await db
      .insertInto('userRolesDirectory')
      .values({ userId: USER_STAFF, roleId: ROLE_STORE_OWNER, storeId: STORE_A })
      .execute();

    const snapshot = await loadDirectorySnapshot(db);
    expect(snapshot.grantsByUser.get(USER_STAFF)).toHaveLength(2);
  });

  test('an empty directory loads to an empty snapshot, not an error', async () => {
    await db.deleteFrom('usersDirectory').execute();
    await db.deleteFrom('rolesDirectory').execute();
    await db.deleteFrom('userRolesDirectory').execute();
    await sql`DELETE FROM meta_kv`.execute(db);

    const snapshot = await loadDirectorySnapshot(db);
    expect(snapshot.tenantId).toBeNull();
    expect(snapshot.users.size).toBe(0);
  });
});

describe('the evaluator over the real mirrors', () => {
  test('the §12 matrix holds end-to-end against the shipped DDL', async () => {
    const evaluator = new PermissionEvaluator(registry, createDirectorySource(db));
    await evaluator.prime();

    // main_owner, via a tenant-wide grant: every id, in any store of the tenant.
    expect(
      evaluator.hasPermission({
        userId: USER_OWNER,
        tenantId: TENANT,
        storeId: STORE_B,
        permissionId: 'auth.role_manage',
      }),
    ).toEqual({ allowed: true });

    // store_owner at their store, but not the other one.
    expect(
      evaluator.hasPermission({
        userId: USER_STORE_OWNER,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'auth.user_create',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluator.hasPermission({
        userId: USER_STORE_OWNER,
        tenantId: TENANT,
        storeId: STORE_B,
        permissionId: 'auth.user_create',
      }),
    ).toEqual({ allowed: false, reason: 'not_granted' });

    // staff: notes yes, administration no (§12's built-in denial fixture).
    expect(
      evaluator.hasPermission({
        userId: USER_STAFF,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'notes.create',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluator.hasPermission({
        userId: USER_STAFF,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'auth.user_create',
      }),
    ).toEqual({ allowed: false, reason: 'not_granted' });
  });

  test('a bundle refresh that deactivates a user is observed only after onBundleRefresh (§6)', async () => {
    const evaluator = new PermissionEvaluator(registry, createDirectorySource(db));
    await evaluator.prime();
    const query = {
      userId: USER_STAFF,
      tenantId: TENANT,
      storeId: STORE_A,
      permissionId: 'notes.create',
    } as const;
    expect(evaluator.hasPermission(query)).toEqual({ allowed: true });

    // A real write to the real table — with no event.
    await db
      .updateTable('usersDirectory')
      .set({ status: 'deactivated' })
      .where('id', '=', USER_STAFF)
      .execute();
    expect(evaluator.hasPermission(query)).toEqual({ allowed: true });

    await evaluator.onBundleRefresh();
    expect(evaluator.hasPermission(query)).toEqual({ allowed: false, reason: 'user_inactive' });
  });

  test('a corrupt permission_ids row in the real table denies evaluation_error (§5.3)', async () => {
    await db
      .updateTable('rolesDirectory')
      .set({ permissionIds: '["notes.create"' })
      .where('id', '=', ROLE_STAFF)
      .execute();

    const evaluator = new PermissionEvaluator(registry, createDirectorySource(db));
    await evaluator.prime();

    // The corrupt row denies for the user who holds it...
    expect(
      evaluator.hasPermission({
        userId: USER_STAFF,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'notes.create',
      }),
    ).toEqual({ allowed: false, reason: 'evaluation_error' });
    // ...and only for them: a corrupt row is not allowed to take the whole device down with it.
    expect(
      evaluator.hasPermission({
        userId: USER_OWNER,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'notes.create',
      }),
    ).toEqual({ allowed: true });
  });

  test('a cross-tenant evaluation denies tenant_mismatch against the real meta_kv tenant', async () => {
    const evaluator = new PermissionEvaluator(registry, createDirectorySource(db));
    await evaluator.prime();
    expect(
      evaluator.hasPermission({
        userId: USER_STAFF,
        tenantId: 'tenant-somebody-else',
        storeId: STORE_A,
        permissionId: 'notes.create',
      }),
    ).toEqual({ allowed: false, reason: 'tenant_mismatch' });
  });
});

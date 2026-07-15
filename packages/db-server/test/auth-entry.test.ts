// D14 (10-db-schema §6.4) — the auth-entry cross-tenant lookups are a DELIBERATE hole in the
// tenant boundary, so this suite attacks them: the three SECURITY DEFINER functions must be the
// ONLY way a query crosses tenants, and bolusi_app must stay unable to run an arbitrary
// cross-tenant SELECT. Every probe runs as bolusi_app (SET LOCAL ROLE inside the tx) — testing
// -guide §2.5: PGlite connects as superuser and superusers bypass RLS, so a probe that skips SET
// ROLE passes vacuously. Fixtures are asserted PRESENT (owner handle) before any absence is
// believed (T-14b — the exact task-05 vacuity trap).
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import type { DB } from '../src/generated/db.js';
import { uuid, timestampMs } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

interface AuthSeed {
  tenantId: string;
  storeId: string;
  deviceId: string;
  deviceTokenHash: string;
  sessionId: string;
  sessionTokenHash: string;
  userId: string;
  loginIdentifier: string;
  passwordVerifier: string;
}

/** Seed one tenant with a device+token, a control session+token, and a user+login credential. */
async function seedAuthTenant(tag: string): Promise<AuthSeed> {
  const s: AuthSeed = {
    tenantId: uuid(),
    storeId: uuid(),
    deviceId: uuid(),
    deviceTokenHash: `dhash-${tag}-${uuid()}`,
    sessionId: uuid(),
    sessionTokenHash: `shash-${tag}-${uuid()}`,
    userId: uuid(),
    loginIdentifier: `login-${tag}-${uuid()}`,
    passwordVerifier: `pv-${tag}`,
  };
  const db = testDb.db; // owner handle — seeding legitimately bypasses RLS
  await db
    .insertInto('tenants')
    .values({ id: s.tenantId, name: `t-${tag}`, createdAt: BigInt(timestampMs()) })
    .execute();
  await db
    .insertInto('stores')
    .values({
      id: s.storeId,
      tenantId: s.tenantId,
      name: `st-${tag}`,
      createdAt: BigInt(timestampMs()),
    })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: s.deviceId,
      tenantId: s.tenantId,
      storeId: s.storeId,
      kind: 'member',
      signingKeyPublic: `pk-${s.deviceId}`,
      tokenHash: s.deviceTokenHash,
      enrolledAt: BigInt(timestampMs()),
    })
    .execute();
  await db
    .insertInto('users')
    .values({
      id: s.userId,
      tenantId: s.tenantId,
      name: `u-${tag}`,
      loginIdentifier: s.loginIdentifier,
      passwordVerifier: s.passwordVerifier,
      createdAt: BigInt(timestampMs()),
    })
    .execute();
  await db
    .insertInto('controlSessions')
    .values({
      id: s.sessionId,
      tenantId: s.tenantId,
      userId: s.userId,
      tokenHash: s.sessionTokenHash,
      createdAt: BigInt(timestampMs()),
      expiresAt: BigInt(timestampMs() + 600_000),
    })
    .execute();
  return s;
}

/** Run `fn` as bolusi_app with `app.tenant_id` = `tenantId` set transaction-locally (production shape). */
async function asAppScopedTo<T>(
  tenantId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return testDb.db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

test('D14 the three definer functions are the ONLY cross-tenant read; an arbitrary SELECT as bolusi_app is not', async () => {
  const a = await seedAuthTenant('a');
  const b = await seedAuthTenant('b');

  // FIXTURE PRESENCE FIRST (T-14b): B's rows must provably EXIST via the owner handle, else every
  // "0 rows" below is vacuous — a wiped DB would look like flawless isolation.
  const bDeviceOwner = await testDb.db
    .selectFrom('devices')
    .select('id')
    .where('tokenHash', '=', b.deviceTokenHash)
    .execute();
  const bSessionOwner = await testDb.db
    .selectFrom('controlSessions')
    .select('id')
    .where('tokenHash', '=', b.sessionTokenHash)
    .execute();
  const bUserOwner = await testDb.db
    .selectFrom('users')
    .select('id')
    .where('loginIdentifier', '=', b.loginIdentifier)
    .execute();
  expect(bDeviceOwner, 'B device fixture missing — probe would be vacuous').toHaveLength(1);
  expect(bSessionOwner, 'B session fixture missing — probe would be vacuous').toHaveLength(1);
  expect(bUserOwner, 'B user fixture missing — probe would be vacuous').toHaveLength(1);

  // Same bolusi_app context (scoped to tenant A): an ARBITRARY cross-tenant SELECT for B's rows
  // returns nothing (RLS holds), but the definer FUNCTIONS return exactly B's row (the sanctioned
  // hole). One context, opposite outcomes — that contrast is the whole point.
  const result = await asAppScopedTo(a.tenantId, async (trx) => {
    const arbitraryDevice = await trx
      .selectFrom('devices')
      .select(['id', 'tenantId'])
      .where('tokenHash', '=', b.deviceTokenHash)
      .execute();
    const arbitrarySession = await trx
      .selectFrom('controlSessions')
      .select(['id'])
      .where('tokenHash', '=', b.sessionTokenHash)
      .execute();
    const arbitraryUser = await trx
      .selectFrom('users')
      .select(['id'])
      .where('loginIdentifier', '=', b.loginIdentifier)
      .execute();
    // getDb / the test harness both wire CamelCasePlugin (10-db §11.3), which camelCases result
    // keys — so the definer functions surface exactly as the production auth-entry.ts reads them.
    const fnDevice = await sql<{
      tenantId: string;
      storeId: string | null;
      deviceId: string;
      status: string;
    }>`SELECT * FROM auth_find_device_by_token_hash(${b.deviceTokenHash})`.execute(trx);
    const fnSession = await sql<{
      tenantId: string;
      userId: string;
      sessionId: string;
    }>`SELECT * FROM auth_find_control_session_by_token_hash(${b.sessionTokenHash})`.execute(trx);
    const fnLogin = await sql<{
      tenantId: string;
      userId: string;
      passwordVerifier: string | null;
      status: string;
    }>`SELECT * FROM auth_find_login_credential(${b.loginIdentifier})`.execute(trx);
    return {
      arbitraryDevice,
      arbitrarySession,
      arbitraryUser,
      fnDevice: fnDevice.rows,
      fnSession: fnSession.rows,
      fnLogin: fnLogin.rows,
    };
  });

  // Arbitrary cross-tenant reads: blocked.
  expect(result.arbitraryDevice).toHaveLength(0);
  expect(result.arbitrarySession).toHaveLength(0);
  expect(result.arbitraryUser).toHaveLength(0);

  // Definer functions: cross the boundary and return exactly B's row.
  expect(result.fnDevice).toHaveLength(1);
  expect(result.fnDevice[0]).toMatchObject({
    tenantId: b.tenantId,
    storeId: b.storeId,
    deviceId: b.deviceId,
    status: 'active',
  });
  expect(result.fnSession).toHaveLength(1);
  expect(result.fnSession[0]).toMatchObject({
    tenantId: b.tenantId,
    userId: b.userId,
    sessionId: b.sessionId,
  });
  expect(result.fnLogin).toHaveLength(1);
  expect(result.fnLogin[0]).toMatchObject({
    tenantId: b.tenantId,
    userId: b.userId,
    passwordVerifier: b.passwordVerifier,
    status: 'active',
  });
  // Ensure it is not just returning A's data by coincidence.
  expect(result.fnDevice[0]?.tenantId).not.toBe(a.tenantId);
});

test('D14 each function returns only the matched-row minimal fields, and nothing on no-match', async () => {
  const a = await seedAuthTenant('nomatch');

  await asAppScopedTo(a.tenantId, async (trx) => {
    // Minimal field set: exactly the RETURNS TABLE columns, no token_hash, no extra columns.
    const dev =
      await sql`SELECT * FROM auth_find_device_by_token_hash(${a.deviceTokenHash})`.execute(trx);
    expect(Object.keys(dev.rows[0] as object).sort()).toEqual([
      'deviceId',
      'status',
      'storeId',
      'tenantId',
    ]);
    const login = await sql`SELECT * FROM auth_find_login_credential(${a.loginIdentifier})`.execute(
      trx,
    );
    expect(Object.keys(login.rows[0] as object).sort()).toEqual([
      'passwordVerifier',
      'status',
      'tenantId',
      'userId',
    ]);

    // No-match: fail closed — zero rows, never a leak.
    const missDev = await sql`SELECT * FROM auth_find_device_by_token_hash('no-such-hash')`.execute(
      trx,
    );
    const missSession =
      await sql`SELECT * FROM auth_find_control_session_by_token_hash('no-such-hash')`.execute(trx);
    const missLogin = await sql`SELECT * FROM auth_find_login_credential('no-such-login')`.execute(
      trx,
    );
    expect(missDev.rows).toHaveLength(0);
    expect(missSession.rows).toHaveLength(0);
    expect(missLogin.rows).toHaveLength(0);
  });
});

test('D14 the definer owner bolusi_auth has BYPASSRLS while the app role bolusi_app does NOT', async () => {
  // The security hinge: the FUNCTION crosses tenants only because its owner bypasses RLS; the
  // CALLER must not. If bolusi_app ever gained BYPASSRLS, the arbitrary-read probe above would
  // pass for the wrong reason.
  const { rows } = await sql<{ rolname: string; rolbypassrls: boolean; rolcanlogin: boolean }>`
    SELECT rolname, rolbypassrls, rolcanlogin
      FROM pg_roles WHERE rolname IN ('bolusi_app', 'bolusi_auth') ORDER BY rolname
  `.execute(testDb.db);
  const byName = Object.fromEntries(rows.map((r) => [r.rolname, r]));
  expect(byName['bolusi_app']?.rolbypassrls).toBe(false);
  expect(byName['bolusi_auth']?.rolbypassrls).toBe(true);
  // bolusi_auth is a definer identity only — it never connects.
  expect(byName['bolusi_auth']?.rolcanlogin).toBe(false);
});

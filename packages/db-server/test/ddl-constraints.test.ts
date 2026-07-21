// DDL spot-checks with INVALID input (task 05 acceptance). These assert the CHECK/UNIQUE
// constraints of 10-db-schema §4/§5/§7 actually reject what the doc says they reject —
// constraints that exist but do not bite are the usual failure.
//
// Runs as the owner (RLS bypassed): the subject here is the constraint, not the policy.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { seedTenant, timestampMs, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenant: TenantFixture;

beforeAll(async () => {
  testDb = await createTestDb();
  tenant = await seedTenant(testDb.db);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

test('devices rejects kind=member with a NULL store_id', async () => {
  // CHECK (kind = 'system' OR store_id IS NOT NULL) — a member device always belongs to a store.
  await expect(
    testDb.db
      .insertInto('devices')
      .values({
        id: uuid(),
        tenantId: tenant.tenantId,
        storeId: null,
        kind: 'member',
        signingKeyPublic: `pubkey-${uuid()}`,
        enrolledAt: BigInt(timestampMs()),
      })
      .execute(),
  ).rejects.toThrow(/violates check constraint/i);
});

test('devices accepts kind=system with a NULL store_id', async () => {
  // The other side of the same CHECK: the system device legitimately has no store.
  const id = uuid();
  await testDb.db
    .insertInto('devices')
    .values({
      id,
      tenantId: tenant.tenantId,
      storeId: null,
      kind: 'system',
      signingKeyPublic: `pubkey-${id}`,
      enrolledAt: BigInt(timestampMs()),
    })
    .execute();

  const row = await testDb.db
    .selectFrom('devices')
    .select('kind')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  expect(row.kind).toBe('system');
});

test('devices rejects an unknown status', async () => {
  await expect(
    testDb.db
      .insertInto('devices')
      .values({
        id: uuid(),
        tenantId: tenant.tenantId,
        storeId: tenant.storeId,
        kind: 'member',
        signingKeyPublic: `pubkey-${uuid()}`,
        enrolledAt: BigInt(timestampMs()),
        status: 'suspended' as 'active',
      })
      .execute(),
  ).rejects.toThrow(/violates check constraint/i);
});

test('devices rejects status=revoked without revoked_at', async () => {
  // CHECK (status = 'active' OR revoked_at IS NOT NULL) — revocation always has a timestamp.
  await expect(
    testDb.db
      .insertInto('devices')
      .values({
        id: uuid(),
        tenantId: tenant.tenantId,
        storeId: tenant.storeId,
        kind: 'member',
        signingKeyPublic: `pubkey-${uuid()}`,
        enrolledAt: BigInt(timestampMs()),
        status: 'revoked',
      })
      .execute(),
  ).rejects.toThrow(/violates check constraint/i);
});

test('user_roles UNIQUE NULLS NOT DISTINCT rejects a duplicate tenant-wide grant', async () => {
  // PG15+ semantics, pinned by 10-db §1 (PG16 required). Default UNIQUE treats NULLs as
  // distinct, which would let the same tenant-wide grant be inserted unboundedly.
  const roleId = uuid();
  await testDb.db
    .insertInto('roles')
    .values({
      id: roleId,
      tenantId: tenant.tenantId,
      name: `role-${roleId}`,
      scopeType: 'tenant',
      createdAt: BigInt(timestampMs()),
    })
    .execute();

  const grant = {
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    roleId,
    storeId: null,
  };

  await testDb.db.insertInto('userRoles').values(grant).execute();
  await expect(testDb.db.insertInto('userRoles').values(grant).execute()).rejects.toThrow(
    /duplicate key value violates unique constraint/i,
  );
});

test('operations rejects a duplicate (tenant_id, server_seq)', async () => {
  const serverSeq = BigInt(timestampMs());
  await insertOperation({ serverSeq });

  await expect(insertOperation({ serverSeq })).rejects.toThrow(
    /duplicate key value violates unique constraint/i,
  );
});

test('operations rejects a duplicate (device_id, seq)', async () => {
  const seq = BigInt(timestampMs());
  await insertOperation({ seq });

  await expect(insertOperation({ seq })).rejects.toThrow(
    /duplicate key value violates unique constraint/i,
  );
});

test('operations rejects an unknown source', async () => {
  // CHECK (source IN ('ui','agent','api','system')) — 05-operation-log §2.1.
  await expect(insertOperation({ source: 'telepathy' as 'ui' })).rejects.toThrow(
    /violates check constraint/i,
  );
});

test('operations rejects seq below 1', async () => {
  await expect(insertOperation({ seq: 0n })).rejects.toThrow(/violates check constraint/i);
});

test('operations rejects schema_version below 1', async () => {
  await expect(insertOperation({ schemaVersion: 0 })).rejects.toThrow(/violates check constraint/i);
});

test('media rejects a non-positive byte_size', async () => {
  await expect(insertMedia({ byteSize: 0n })).rejects.toThrow(/violates check constraint/i);
});

test('media rejects an unknown type', async () => {
  await expect(insertMedia({ type: 'hologram' as 'image' })).rejects.toThrow(
    /violates check constraint/i,
  );
});

test('media rejects an unknown status', async () => {
  // The SERVER wire enum is receiving|complete. The client machine's 'uploading' is a different
  // enum entirely (10-db §8) — a value crossing over is exactly the bug this CHECK catches.
  await expect(insertMedia({ status: 'uploading' as 'complete' })).rejects.toThrow(
    /violates check constraint/i,
  );
});

test('permissions rejects an unknown scope', async () => {
  await expect(
    testDb.db
      .insertInto('permissions')
      .values({
        id: `notes.act-${uuid()}`,
        module: 'notes',
        action: 'act',
        scope: 'galaxy' as 'tenant',
        description: 'invalid scope',
      })
      .execute(),
  ).rejects.toThrow(/violates check constraint/i);
});

test('user_pin_verifiers rejects an algo other than argon2id', async () => {
  await expect(
    testDb.db
      .insertInto('userPinVerifiers')
      .values({
        userId: tenant.userId,
        tenantId: tenant.tenantId,
        algo: 'bcrypt',
        salt: 'c2FsdA==',
        params: JSON.stringify({ m: 32768, t: 3, p: 1 }),
        hash: 'aGFzaA==',
        asOfTimestamp: BigInt(timestampMs()),
        asOfDeviceId: tenant.deviceId,
        asOfSeq: 1n,
      })
      .execute(),
  ).rejects.toThrow(/violates check constraint/i);
});

test('conflicts rejects an unknown severity', async () => {
  await expect(
    testDb.db
      .insertInto('conflicts')
      .values({
        id: uuid(),
        tenantId: tenant.tenantId,
        storeId: tenant.storeId,
        entityType: 'note',
        entityId: uuid(),
        conflictKey: 'body',
        severity: 'catastrophic' as 'minor',
        status: 'surfaced',
        opAId: uuid(),
        opBId: uuid(),
        detectedAt: BigInt(timestampMs()),
      })
      .execute(),
  ).rejects.toThrow(/violates check constraint/i);
});

test('user_prefs.locale is NOT NULL with NO column default (task 76)', async () => {
  // The column holds a `Locale` (`id` | `en`) — the `z.enum(['id','en'])` payload the platform
  // applier writes verbatim — NOT an Intl formatting tag. It once declared `DEFAULT 'id-ID'`
  // (`INTL_LOCALE_TAG.id`, not a `Locale`): a decoy no fold could reach, since the applier always
  // supplies `locale`. The read fallback ("default `id` when the row is absent") belongs to the
  // reader (`resolveLocale`), which a column default cannot express. So migration 0009 dropped it;
  // NOT NULL stays because every insert (the applier) supplies the value.
  const { rows } = await sql<{ isNullable: string; columnDefault: string | null }>`
    SELECT is_nullable AS "isNullable", column_default AS "columnDefault"
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'user_prefs' AND column_name = 'locale'
  `.execute(testDb.db);
  expect(rows).toEqual([{ isNullable: 'NO', columnDefault: null }]);
});

/** Inserts a structurally valid operation row, overridden per case. */
async function insertOperation(overrides: Record<string, unknown> = {}): Promise<unknown> {
  const zeros = '0'.repeat(64);
  return testDb.db
    .insertInto('operations')
    .values({
      id: uuid(),
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      userId: tenant.userId,
      deviceId: tenant.deviceId,
      seq: BigInt(timestampMs()),
      type: 'notes.note_created',
      entityType: 'note',
      entityId: uuid(),
      schemaVersion: 1,
      payload: JSON.stringify({ title: 't' }),
      timestampMs: BigInt(timestampMs()),
      source: 'ui',
      previousHash: zeros,
      hash: zeros,
      signature: 'c2ln',
      signedCoreJcs: '{}',
      serverSeq: BigInt(timestampMs()),
      receivedAt: BigInt(timestampMs()),
      ...overrides,
    } as never)
    .execute();
}

/** Inserts a structurally valid media row, overridden per case. */
async function insertMedia(overrides: Record<string, unknown> = {}): Promise<unknown> {
  return testDb.db
    .insertInto('media')
    .values({
      id: uuid(),
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      capturedByUserId: tenant.userId,
      deviceId: tenant.deviceId,
      type: 'image',
      mimeType: 'image/jpeg',
      byteSize: 1024n,
      sha256: 'a'.repeat(64),
      capturedAt: BigInt(timestampMs()),
      chunkSize: 256,
      chunksTotal: 4,
      createdAt: BigInt(timestampMs()),
      ...overrides,
    } as never)
    .execute();
}

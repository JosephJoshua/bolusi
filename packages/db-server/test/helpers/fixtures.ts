// Seeded fixtures. testing-guide T-3: every case builds its OWN values — no shared
// `TEST_TENANT_ID` constants, because shared constants make tests pass by coincidence and fail
// in bulk. Every call to `uuid()` returns a value no other case has seen.
//
// The determinism kit (mulberry32/FakeClock/IdSource, testing-guide §3.3) lives in
// @bolusi/test-support, which is still a placeholder shell at this task's commit — so this is a
// LOCAL, deliberately tiny stand-in for id generation only. It is deterministic (a counter, not
// an RNG — T-6 forbids real RNG in tests) and should be replaced by the kit when it lands.
import type { Kysely } from 'kysely';

import type { DB } from '../../src/generated/db.js';

let counter = 0;

/** A unique lowercase canonical UUID (v7 layout). Deterministic per process; unique per call. */
export function uuid(): string {
  counter += 1;
  const tail = counter.toString(16).padStart(12, '0');
  return `0198f000-0000-7000-8000-${tail}`;
}

/** A distinct ms-epoch stamp per call (10-db-schema §2: timestamps are ms-epoch integers). */
export function timestampMs(): number {
  counter += 1;
  return 1_752_000_000_000 + counter;
}

export interface TenantFixture {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly userId: string;
}

/**
 * Seeds one tenant + store + device + user through the OWNER handle.
 *
 * Seeding bypasses RLS on purpose: a fixture's job is to put rows on the other side of the
 * boundary so a probe can fail to reach them. Probes must use `appForTenant` instead.
 */
export async function seedTenant(db: Kysely<DB>): Promise<TenantFixture> {
  const tenantId = uuid();
  const storeId = uuid();
  const deviceId = uuid();
  const userId = uuid();

  await db
    .insertInto('tenants')
    .values({ id: tenantId, name: `tenant-${tenantId}`, createdAt: BigInt(timestampMs()) })
    .execute();

  await db
    .insertInto('stores')
    .values({
      id: storeId,
      tenantId,
      name: `store-${storeId}`,
      createdAt: BigInt(timestampMs()),
    })
    .execute();

  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      tenantId,
      storeId,
      kind: 'member',
      signingKeyPublic: `pubkey-${deviceId}`,
      enrolledAt: BigInt(timestampMs()),
    })
    .execute();

  await db
    .insertInto('users')
    .values({
      id: userId,
      tenantId,
      name: `user-${userId}`,
      createdAt: BigInt(timestampMs()),
    })
    .execute();

  return { tenantId, storeId, deviceId, userId };
}

/** Seeds one note row for `tenant`, returning its id. */
export async function seedNote(db: Kysely<DB>, tenant: TenantFixture): Promise<string> {
  const id = uuid();
  const at = BigInt(timestampMs());

  await db
    .insertInto('notes')
    .values({
      id,
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      title: `title-${id}`,
      body: `body-${id}`,
      createdBy: tenant.userId,
      createdAt: at,
      lastEditedBy: tenant.userId,
      lastEditedAt: at,
    })
    .execute();

  return id;
}

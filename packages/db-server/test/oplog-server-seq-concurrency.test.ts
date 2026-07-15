// The per-tenant serverSeq row lock under GENUINE concurrency (10-db §3) — task 07's hard case.
//
// WHY THIS FILE LIVES IN db-server AND NOT NEXT TO THE PIPELINE (apps/server/src/oplog):
// proving a row lock requires two transactions holding two REAL connections at the same instant.
// PGlite drives a single in-process connection, so Kysely serialises transactions there and a
// "concurrent" PGlite test passes with the FOR UPDATE lock ABSENT — it would prove nothing
// (testing-guide T-11). Only `pnpm test:rls` (real postgres:16 + a pg Pool) can race, and `pg` is
// boundary-locked to THIS package (08 §3.3), so apps/server test code cannot open a pool.
//
// MIRROR — keep in sync with apps/server/src/oplog/server-seq.ts. These two statements ARE the
// tenant_op_counters contract (10-db §3); the pipeline cannot be imported here (the boundary rule
// forbids db-server value-importing @bolusi/server, and it would invert the dependency). The other
// half of the proof lives in apps/server/test/integration/oplog/server-seq.test.ts, which asserts
// the pipeline EMITS exactly these statements (FOR UPDATE + UPDATE ... RETURNING) and allocates
// once per accepted op. This lane proves those statements are correct under contention.
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { DB } from '../src/generated/db.js';
import { seedTenant, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenantA: TenantFixture;
let tenantB: TenantFixture;

beforeAll(async () => {
  testDb = await createTestDb();
  tenantA = await seedTenant(testDb.db);
  tenantB = await seedTenant(testDb.db);
  await seedCounter(tenantA.tenantId);
  await seedCounter(tenantB.tenantId);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

async function seedCounter(tenantId: string): Promise<void> {
  await testDb.db
    .insertInto('tenantOpCounters')
    .values({ tenantId, nextServerSeq: 1n })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** MIRROR of server-seq.ts `lockTenantCounter`: the FOR UPDATE taken at transaction start. */
async function lockCounter(db: Transaction<DB>, tenantId: string): Promise<void> {
  await db
    .selectFrom('tenantOpCounters')
    .select('nextServerSeq')
    .where('tenantId', '=', tenantId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/** MIRROR of server-seq.ts `allocateServerSeq`: increment, return the value just consumed. */
async function allocate(db: Transaction<DB>, tenantId: string): Promise<number> {
  const row = await db
    .updateTable('tenantOpCounters')
    .set({ nextServerSeq: sql<string>`next_server_seq + 1` })
    .where('tenantId', '=', tenantId)
    .returning(sql<string>`next_server_seq - 1`.as('serverSeq'))
    .executeTakeFirstOrThrow();
  return Number(row.serverSeq);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One simulated push: take the lock, then allocate `count` values (one per accepted op). */
async function simulatedPush(tenantId: string, count: number): Promise<number[]> {
  return testDb.appForTenant(tenantId, async (db) => {
    await lockCounter(db, tenantId);
    const allocated: number[] = [];
    for (let i = 0; i < count; i += 1) allocated.push(await allocate(db, tenantId));
    return allocated;
  });
}

describe('fixture validity (T-14b — an empty/wiped DB reads exactly like a clean pass)', () => {
  test('the tenants and their counter rows actually exist before anything races', async () => {
    // The docker daemon is shared across worktrees: a neighbour resetting the schema mid-run
    // leaves tables and policies but ZERO rows, and every assertion below would then pass
    // vacuously. Assert the fixture inline rather than trusting an absence.
    const counters = await testDb.db
      .selectFrom('tenantOpCounters')
      .select(['tenantId', 'nextServerSeq'])
      .where('tenantId', 'in', [tenantA.tenantId, tenantB.tenantId])
      .execute();
    expect(counters).toHaveLength(2);
    expect(counters.every((c) => Number(c.nextServerSeq) >= 1)).toBe(true);
  });

  test('reports which engine produced these results', () => {
    // Numbers from this file mean different things per lane; make the lane explicit rather than
    // leaving a reader to assume the strong one.
    expect(['pglite', 'postgres']).toContain(ENGINE);
  });
});

describe('same-tenant concurrent allocation is gapless and duplicate-free', () => {
  test('8 concurrent pushes x 20 ops allocate one exact contiguous range', async () => {
    const CONCURRENCY = 8;
    const PER_PUSH = 20;
    const before = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', tenantA.tenantId)
      .executeTakeFirstOrThrow();
    const start = Number(before.nextServerSeq);

    // On postgres these are 8 REAL pooled connections contending for one row. Without the FOR
    // UPDATE lock, concurrent read-modify-write loses updates → duplicates and gaps → red.
    const batches = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => simulatedPush(tenantA.tenantId, PER_PUSH)),
    );

    const all = batches.flat().sort((a, b) => a - b);
    const expected = Array.from({ length: CONCURRENCY * PER_PUSH }, (_, i) => start + i);
    expect(all).toEqual(expected); // exact set ⇒ no duplicate, no gap, monotonic
    expect(new Set(all).size).toBe(CONCURRENCY * PER_PUSH);
  });

  test('each concurrent push receives a CONTIGUOUS block (the lock held for the whole batch)', async () => {
    const batches = await Promise.all(
      Array.from({ length: 4 }, () => simulatedPush(tenantA.tenantId, 10)),
    );

    // Because the counter row stays locked for the transaction's life, a push's allocations are
    // never interleaved with another tenant-mate's — this is what makes a batch's serverSeq range
    // dense rather than merely unique.
    for (const batch of batches) {
      const first = batch[0] as number;
      expect(batch).toEqual(Array.from({ length: 10 }, (_, i) => first + i));
    }
  });

  test('the counter advances by exactly the number of allocations', async () => {
    const before = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', tenantA.tenantId)
      .executeTakeFirstOrThrow();

    await Promise.all(Array.from({ length: 5 }, () => simulatedPush(tenantA.tenantId, 3)));

    const after = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', tenantA.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(after.nextServerSeq) - Number(before.nextServerSeq)).toBe(15);
  });
});

// These two require two transactions ALIVE AT THE SAME INSTANT. PGlite has one connection, so the
// held-lock transaction would starve the prober forever (a hang, not a failure) — hence real
// postgres only. This is the pair that actually falsifies "the lock exists" vs "the lock is
// over-broad"; the gapless test above cannot tell a per-row lock from a table lock.
describe.runIf(ENGINE === 'postgres')('the lock is per-row: exclusive within a tenant', () => {
  test('a second push for the SAME tenant BLOCKS on the counter lock', async () => {
    const locked = deferred();
    const release = deferred();

    const holder = testDb.appForTenant(tenantB.tenantId, async (db) => {
      await lockCounter(db, tenantB.tenantId);
      locked.resolve();
      await release.promise; // hold the lock open
    });
    await locked.promise;

    // lock_timeout turns "blocks forever" into a deterministic, non-flaky error (55P03). No sleeps,
    // no timing assertions. If the FOR UPDATE were absent this would return 'acquired' → red.
    const outcome = await testDb.appForTenant(tenantB.tenantId, async (db) => {
      await sql`SET LOCAL lock_timeout = '1s'`.execute(db);
      try {
        await lockCounter(db, tenantB.tenantId);
        return 'acquired';
      } catch (error) {
        return String(error);
      }
    });

    release.resolve();
    await holder;
    expect(outcome).toMatch(/lock timeout/i);
  });

  test('a push for a DIFFERENT tenant does NOT contend (separate counter rows)', async () => {
    const locked = deferred();
    const release = deferred();

    const holder = testDb.appForTenant(tenantA.tenantId, async (db) => {
      await lockCounter(db, tenantA.tenantId);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    // Tenant A's lock is held. Tenant B must sail straight through: same 1s lock_timeout, so an
    // over-broad lock (table-level, or a shared row) surfaces as a timeout instead of silently
    // serialising every tenant behind one another — which correctness assertions alone cannot see.
    const outcome = await testDb.appForTenant(tenantB.tenantId, async (db) => {
      await sql`SET LOCAL lock_timeout = '1s'`.execute(db);
      try {
        await lockCounter(db, tenantB.tenantId);
        const seq = await allocate(db, tenantB.tenantId);
        return `allocated:${seq}`;
      } catch (error) {
        return String(error);
      }
    });

    release.resolve();
    await holder;
    expect(outcome).toMatch(/^allocated:\d+$/);
  });

  test('two tenants allocate concurrently and each stream stays independently gapless', async () => {
    const [a0, b0] = await Promise.all([
      testDb.db
        .selectFrom('tenantOpCounters')
        .select('nextServerSeq')
        .where('tenantId', '=', tenantA.tenantId)
        .executeTakeFirstOrThrow(),
      testDb.db
        .selectFrom('tenantOpCounters')
        .select('nextServerSeq')
        .where('tenantId', '=', tenantB.tenantId)
        .executeTakeFirstOrThrow(),
    ]);

    const [aBatches, bBatches] = await Promise.all([
      Promise.all(Array.from({ length: 4 }, () => simulatedPush(tenantA.tenantId, 5))),
      Promise.all(Array.from({ length: 4 }, () => simulatedPush(tenantB.tenantId, 5))),
    ]);

    const aAll = aBatches.flat().sort((x, y) => x - y);
    const bAll = bBatches.flat().sort((x, y) => x - y);
    expect(aAll).toEqual(Array.from({ length: 20 }, (_, i) => Number(a0.nextServerSeq) + i));
    expect(bAll).toEqual(Array.from({ length: 20 }, (_, i) => Number(b0.nextServerSeq) + i));
  });
});

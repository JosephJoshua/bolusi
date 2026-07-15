// The atomic-batch-apply contract (task 16 §39, from the task-08 projection-engine review) on the
// REAL engine lane — driving the REAL store.
//
// WHY THIS FILE LIVES IN db-server: this package is the only one whose suite re-runs against real
// PostgreSQL 16 (`pnpm test:rls`, CI stage 9 — test-db.ts). The apps/server copy of this contract
// (test/integration/sync/batch-atomicity.test.ts) runs the same property on PGlite, which embeds
// PostgreSQL **18**; production and the merge gate pin **16**. Running it here re-runs it on 16, so
// a rollback/contiguity divergence between the two engines cannot hide behind the fast loop.
//
// THE PROPERTY. `applied_server_seq` advances to the highest CONTIGUOUS serverSeq PRESENT IN THE
// LOG (04 §4.3), not the highest applied. So once a batch is inserted, ONE apply computes a
// watermark at the TOP of the batch. Unless the inserts, the applies and the watermark share ONE
// transaction, a crash leaves a watermark that claims ops were folded that never were — and every
// watermark-trusting catch-up skips them forever, silently.
//
// The engine runs through `appForTenant` (SET LOCAL ROLE bolusi_app), so the reads — which carry
// no tenant predicate of their own (oplog-source.ts) — are scoped by RLS, not by luck. Each case
// gets its OWN tenant, so its serverSeq stream starts at 1.
//
// ── WHAT TASK 47 CHANGED HERE, AND WHY THE MIRROR IS GONE ──────────────────────────────────────
//
// This file used to hand-copy `createServerWatermarkStore` as a local `serverWatermarkStore`
// MIRROR, because the original lived in apps/server and `packages/*` may not import `apps/*`
// (08 §3.3 rule 1). Its header asked that "the two must be kept in sync". They were not kept in
// sync by anything except that sentence, and the measurement was brutal: neutering PRODUCTION
// `advanceServerSeq` left this lane 95/95 GREEN, because this lane never ran it. The test proved
// PostgreSQL 16 implements rollback — a fact not in dispute — and nothing about the code it named.
//
// The store now lives in `../src/watermarks.ts` (a db-server concern; its only imports are kysely
// and @bolusi/core, both edges 08 §3.3 already grants). This file imports it. There is nothing to
// keep in sync, so nothing can drift — the guard is closed BY CONSTRUCTION, not by discipline
// (CLAUDE.md §2.11).
//
// ── AND WHY THE WATERMARK IS NO LONGER ADVANCED BY HAND ────────────────────────────────────────
//
// The old file also called `advanceServerSeq(MODULE_ID, 3)` with a literal 3, because on real
// Postgres `highestContiguousServerSeq` compared an int8 STRING to a number and never advanced
// (the bug this lane found, now fixed as task 46's int8 seam). A hardcoded 3 cannot detect a
// watermark computed wrongly: it asserts that the number the test just wrote is the number the
// test just wrote. With 46 landed, the ENGINE computes the value on this driver, so every case
// below drives `applyPulledOp` and lets the real path produce the watermark. The 3s asserted here
// are now OUTPUTS of production code, not inputs to it.
//
// This lane is also the only thing that executes `highestContiguousServerSeq` on ANY engine:
// applier-conformance (T-8) calls only `applyAppendedOp`, and the contiguity walk is reachable
// solely from the PULL branch (engine.ts:154). See task 47's T-8 scope note.
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  ProjectionEngine,
  ProjectionRegistry,
  type ModuleProjectionManifest,
  type ProjectionApplier,
  type RebuildStore,
} from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { DB } from '../src/generated/db.js';
import { APP_ROLE } from '../src/schema/security.js';
// THE POINT OF THIS FILE: the production store, on the production driver.
import { createServerWatermarkStore } from '../src/watermarks.js';
import { seedTenant, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

const MODULE_ID = 'atomicity_probe';
const PROBE_TABLE = 'atomicity_probe_items';
const OP_TYPE = 'probe.item_created';
const HEX64 = 'a'.repeat(64);

let testDb: TestDb;
let tenant: TenantFixture;

interface ProbeDb {
  atomicity_probe_items: { id: string; label: string };
}

/** The one applier: entity-scoped, dialect-neutral (04 §4.1). */
const probeApplier: ProjectionApplier<ProbeDb> = async (db, op) => {
  const payload = op.payload as unknown as { label: string };
  await db
    .insertInto('atomicity_probe_items')
    .values({ id: op.entityId, label: payload.label })
    .execute();
};

const probeManifest: ModuleProjectionManifest<ProbeDb> = {
  id: MODULE_ID,
  tables: {
    [PROBE_TABLE]: {
      columns: { id: 'text', label: 'text' },
      primaryKey: ['id'],
      entityType: 'probe_item',
      entityIdColumn: 'id',
      projectionVersion: 1,
    },
  },
  appliers: { [OP_TYPE]: probeApplier },
};

const unusedRebuildStore: RebuildStore = {
  readCursor: () => Promise.reject(new Error('rebuild not exercised')),
  writeCursor: () => Promise.reject(new Error('rebuild not exercised')),
  clearCursor: () => Promise.reject(new Error('rebuild not exercised')),
  readVersion: () => Promise.reject(new Error('rebuild not exercised')),
  writeVersion: () => Promise.reject(new Error('rebuild not exercised')),
};

/** The PRODUCTION store, bound to a tenant-scoped handle — the same call apps/server makes.
 *  `Transaction<DB>` extends `Kysely<DB>`, so this one parameter type accepts both handles. */
function store(trx: Kysely<DB>) {
  return createServerWatermarkStore(trx, tenant.tenantId);
}

function makeEngine(trx: Transaction<DB>): ProjectionEngine<ProbeDb> {
  const registry = new ProjectionRegistry<ProbeDb>();
  registry.register(probeManifest);
  return new ProjectionEngine<ProbeDb>({
    db: trx as unknown as Kysely<ProbeDb>,
    registry,
    watermarks: store(trx), // production read() + advanceServerSeq(), driven by the engine
    makeRebuildStore: () => unusedRebuildStore,
  });
}

/** A minimal accepted-op row. Signatures are irrelevant here — the projection path never verifies. */
function probeOp(seq: number, label: string): SignedOperation {
  return {
    id: uuid(),
    tenantId: tenant.tenantId,
    storeId: tenant.storeId,
    userId: tenant.userId,
    deviceId: tenant.deviceId,
    seq,
    type: OP_TYPE,
    entityType: 'probe_item',
    entityId: uuid(),
    schemaVersion: 1,
    payload: { label },
    timestamp: 1_752_000_000_000 + seq,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: HEX64,
    hash: HEX64,
    signature: 'sig',
  };
}

async function insertOp(
  trx: Transaction<DB>,
  op: SignedOperation,
  serverSeq: number,
): Promise<void> {
  await trx
    .insertInto('operations')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: op.storeId,
      userId: op.userId,
      deviceId: op.deviceId,
      seq: BigInt(op.seq),
      type: op.type,
      entityType: op.entityType,
      entityId: op.entityId,
      schemaVersion: op.schemaVersion,
      payload: JSON.stringify(op.payload),
      timestampMs: BigInt(op.timestamp),
      location: null,
      source: op.source,
      agentInitiated: op.agentInitiated,
      agentConversationId: op.agentConversationId,
      previousHash: op.previousHash,
      hash: op.hash,
      signature: op.signature,
      signedCoreJcs: JSON.stringify(op),
      serverSeq: BigInt(serverSeq),
      receivedAt: BigInt(op.timestamp),
      clockSkewFlagged: false,
    })
    .execute();
}

/** Read the watermark row RAW (not through the store) — an independent oracle (T-12). */
async function durableWatermark(): Promise<number> {
  const row = await testDb.db
    .selectFrom('projectionWatermarks')
    .select('appliedServerSeq')
    .where('tenantId', '=', tenant.tenantId)
    .where('moduleId', '=', MODULE_ID)
    .executeTakeFirst();
  return row === undefined ? 0 : Number(row.appliedServerSeq);
}
async function countOps(): Promise<number> {
  const rows = await testDb.db
    .selectFrom('operations')
    .select('id')
    .where('tenantId', '=', tenant.tenantId)
    .execute();
  return rows.length;
}
async function countProbeRows(): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM ${sql.table(PROBE_TABLE)}
  `.execute(testDb.db);
  return Number(result.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  testDb = await createTestDb();
  // A scratch projection table for the probe module. `operations` is append-only (10-db §5), so
  // isolation between cases comes from a FRESH TENANT per case, not from deleting op rows.
  await sql`
    CREATE TABLE ${sql.table(PROBE_TABLE)} (id text PRIMARY KEY, label text NOT NULL)
  `.execute(testDb.db);
  await sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${sql.table(PROBE_TABLE)} TO ${sql.id(APP_ROLE)}
  `.execute(testDb.db);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  tenant = await seedTenant(testDb.db); // own tenant ⇒ own serverSeq stream, own watermark row
  await sql`DELETE FROM ${sql.table(PROBE_TABLE)}`.execute(testDb.db);
});

describe('fixture validity (T-14b) + engine attribution (T-14d)', () => {
  test('reports which engine produced these results', () => {
    // These numbers mean different things per lane: pglite embeds PG18, test:rls pins PG16.
    expect(['pglite', 'postgres']).toContain(ENGINE);
  });

  test('the tenant fixture exists and the probe table starts empty', async () => {
    const rows = await testDb.db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenant.tenantId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(await countProbeRows()).toBe(0);
    expect(await countOps()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE COVERAGE THIS FILE EXISTS TO PROVIDE (task 47). The contract tests below drive the store
// through the engine, which is the honest shape but also an INDIRECT one: if the store regressed,
// they would fail with a confusing number. These name the store's own behaviour directly, so a
// break points at the line that broke.
//
// THE DENOMINATOR (T-14): `createServerWatermarkStore` exports exactly THREE functions —
// `read`, `advanceServerSeq`, `advanceLocalSeq`. All three are executed here, on real PG16.
// "The lane runs" is not "the lane covers this", so the count is asserted, not asserted-about.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('the production store itself, on the production driver (task 47)', () => {
  test('DENOMINATOR — the store surface is exactly the three functions this file exercises', () => {
    const s = createServerWatermarkStore(testDb.db, tenant.tenantId);
    expect(Object.keys(s).sort()).toEqual(['advanceLocalSeq', 'advanceServerSeq', 'read']);
    // Not zero, and not a surface that grew a function nobody here runs.
    expect(Object.values(s).every((f) => typeof f === 'function')).toBe(true);
  });

  test('read() returns a NUMBER, not an int8 string — the seam is load-bearing on real pg', async () => {
    // THE FALSIFICATION TARGET. `applied_server_seq` is bigint (10-db §5) and the real `pg` driver
    // hands int8 back as a STRING. Delete `int8ToNumber` from the store's read() and this goes RED
    // here with 'string' !== 'number' — the assertion task 46's bug needed and did not have.
    // PGlite CANNOT express this (it marshals int8 to a number, T-14f), which is exactly why this
    // test lives in the lane that pins PG16.
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      await store(trx).advanceServerSeq(MODULE_ID, 7);
    });
    const state = await testDb.appForTenant(tenant.tenantId, (trx) => store(trx).read(MODULE_ID));

    expect(typeof state.appliedServerSeq).toBe('number');
    expect(state.appliedServerSeq).toBe(7);
    // The arithmetic the watermark is FOR. A string here makes `+ 1` concatenate: "7" + 1 = "71",
    // which is why a string watermark is not a cosmetic defect (task 46).
    expect(state.appliedServerSeq + 1).toBe(8);
    // A missing row reads as 0, not NaN/undefined (the store's documented empty case).
    expect(
      (await testDb.appForTenant(tenant.tenantId, (t) => store(t).read('absent_module')))
        .appliedServerSeq,
    ).toBe(0);
  });

  test('advanceServerSeq() is monotonic — a lower value cannot regress the watermark (04 §4.3)', async () => {
    // The CASE upsert, on the engine whose `max()` is an aggregate. This is the invariant the
    // store keeps independently of what the engine computes, so it gets its own assertion.
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      const s = store(trx);
      await s.advanceServerSeq(MODULE_ID, 5); // insert path
      await s.advanceServerSeq(MODULE_ID, 9); // conflict path, higher  → moves up
      expect((await s.read(MODULE_ID)).appliedServerSeq).toBe(9);
      await s.advanceServerSeq(MODULE_ID, 2); // conflict path, lower   → must NOT regress
      expect((await s.read(MODULE_ID)).appliedServerSeq).toBe(9);
      await s.advanceServerSeq(MODULE_ID, 9); // conflict path, equal   → stays
      expect((await s.read(MODULE_ID)).appliedServerSeq).toBe(9);
    });
    expect(await durableWatermark()).toBe(9);
  });

  test('advanceLocalSeq() is a no-op — the server table has no applied_local_seq column (10-db §8)', async () => {
    // The third function. It is a no-op by design, and "by design" is a claim: if it ever grew a
    // write, this lane is where the missing column would raise. Asserting it writes NOTHING is
    // what makes the denominator 3/3 rather than 2/3-and-a-shrug.
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      const s = store(trx);
      await s.advanceServerSeq(MODULE_ID, 4);
      await s.advanceLocalSeq(MODULE_ID, 99);
      const state = await s.read(MODULE_ID);
      expect(state.appliedServerSeq).toBe(4); // untouched by the local-seq call
      expect(state.appliedLocalSeq).toBe(0); // the port's server shape always reports 0
    });
    expect(await durableWatermark()).toBe(4);
  });
});

describe('LOAD-BEARING: insert + apply + watermark commit in ONE transaction (task 16 §39)', () => {
  test('ATOMIC — an abort mid-batch rolls the watermark back together with the un-applied ops', async () => {
    const ops = [probeOp(1, 'a'), probeOp(2, 'b'), probeOp(3, 'c')];

    await expect(
      testDb.appForTenant(tenant.tenantId, async (trx) => {
        for (const [i, op] of ops.entries()) await insertOp(trx, op, i + 1);
        // ONE apply. The ENGINE computes the watermark from log presence and drives the store —
        // no hand-written value. On this driver that exercises production read() +
        // highestContiguousServerSeq (task 46) + production advanceServerSeq().
        await makeEngine(trx).applyPulledOp(ops[0] as SignedOperation);

        // In-transaction the watermark has ALREADY jumped to the TOP OF THE BATCH (3) — computed,
        // not asserted: contiguity comes from the three ops being in the log, while only ONE was
        // folded. This is the state that becomes a permanent lie if it commits.
        expect((await store(trx).read(MODULE_ID)).appliedServerSeq).toBe(3);
        throw new Error('crash mid-batch');
      }),
    ).rejects.toThrow('crash mid-batch');

    // ONE transaction ⇒ the abort took ALL of it: no durable skip is possible.
    expect(await durableWatermark()).toBe(0); // rolled back WITH the batch
    expect(await countOps()).toBe(0);
    expect(await countProbeRows()).toBe(0);
  });

  test('ATOMIC — a committed batch leaves watermark == top with every op folded (positive control)', async () => {
    const ops = [probeOp(1, 'x'), probeOp(2, 'y'), probeOp(3, 'z')];
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      for (const [i, op] of ops.entries()) await insertOp(trx, op, i + 1);
      const engine = makeEngine(trx);
      for (const op of ops) await engine.applyPulledOp(op); // engine advances the watermark itself
    });
    // watermark N means "every op with serverSeq ≤ N is folded" — and here it tells the truth.
    expect(await durableWatermark()).toBe(3);
    expect(await countOps()).toBe(3);
    expect(await countProbeRows()).toBe(3);
  });

  test('CONTIGUITY — a GAP in the log holds the watermark below the batch top', async () => {
    // The other half of what the hardcoded 3 could never see: the watermark is not "the top of
    // whatever arrived", it is the top of the CONTIGUOUS prefix. Insert serverSeq 1 and 3 (2 is
    // missing, still in flight) and the computed watermark must stop at 1. A store or walk that
    // returned the max would say 3 and strand op 2 forever.
    const first = probeOp(1, 'g1');
    const third = probeOp(3, 'g3');
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      await insertOp(trx, first, 1);
      await insertOp(trx, third, 3); // gap at 2
      const engine = makeEngine(trx);
      await engine.applyPulledOp(first);
      await engine.applyPulledOp(third);
    });
    expect(await durableWatermark()).toBe(1); // NOT 3 — contiguity stops at the gap
    expect(await countProbeRows()).toBe(2); // both ops folded; only the watermark is held back
  });

  test('FALSIFICATION — committing per-op advances the watermark past un-applied ops: the silent skip', async () => {
    const ops = [probeOp(1, 'p'), probeOp(2, 'q'), probeOp(3, 'r')];

    // The broken shape §39 names: insert the whole batch and COMMIT …
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      for (const [i, op] of ops.entries()) await insertOp(trx, op, i + 1);
    });
    // … then apply ONE op — and its engine-computed watermark — in their own transaction, and
    // COMMIT. Then "crash" before ops 2 and 3 are ever folded.
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      await makeEngine(trx).applyPulledOp(ops[0] as SignedOperation);
    });

    const watermark = await durableWatermark();
    const folded = await countProbeRows();
    expect(watermark).toBe(3); // claims caught-up through serverSeq 3 …
    expect(folded).toBe(1); // … while only ONE op was ever folded
    // Ops 2 and 3 sit in the log, unfolded, BELOW the watermark — so a catch-up that trusts
    // `applied_server_seq` ("is this projection caught up?", 04 §4.3) skips them forever.
    expect(await countOps()).toBe(3);
    expect(folded).toBeLessThan(watermark); // the durable lie the atomic path prevents
  });
});

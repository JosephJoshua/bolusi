// The atomic-batch-apply contract (task 16 §39, from the task-08 projection-engine review) on the
// REAL engine lane.
//
// WHY THIS FILE LIVES IN db-server AND NOT NEXT TO THE SYNC ROUTER: this package is the only one
// whose suite re-runs against real Postgres 16 (`pnpm test:rls`, CI stage 9 — test-db.ts). The
// apps/server copy of this contract (test/integration/sync/batch-atomicity.test.ts) runs the same
// property on PGlite, which embeds PostgreSQL **18**; production and the merge gate pin **16**.
// Running it here re-runs it on 16, so a rollback/contiguity divergence between the two engines
// cannot hide behind the fast loop — the same drift check test-db.ts's header describes.
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
// ── WHY THE WATERMARK IS ADVANCED EXPLICITLY HERE, NOT BY `highestContiguousServerSeq` ─────────
//
// This lane found a REAL BUG in @bolusi/core (reported, not fixed here — `@bolusi/core` is
// contended and task 14 is live in it): `highestContiguousServerSeq` compares
// `row.serverSeq === watermark + 1`, but on REAL Postgres the `pg` driver returns `bigint` as a
// **string** (`"1"`, typeof string), so the strict comparison is always false and the function
// returns `from` unchanged — i.e. the server-side `applied_server_seq` NEVER advances on the
// production engine. PGlite returns a number, so every existing lane (better-sqlite3 in core,
// PGlite in applier-conformance) passes; only real PG16 exposes it. `createSqlWatermarkStore.read`
// already normalizes with `Number(...)` for exactly this reason — the contiguity walk was missed.
//
// That is task 08's computation, not task 16's contract. So this file advances the watermark
// through the STORE directly (the value the engine WOULD compute, and DOES compute on PGlite —
// see apps/server/test/integration/sync/batch-atomicity.test.ts, which drives the real engine
// end-to-end). What is proven HERE, on the pinned engine, is task 16's actual property: that the
// op INSERTs, the projection APPLY and the watermark advance commit — or roll back — as ONE unit.
//
// MIRROR — the watermark statements below mirror apps/server/src/sync/watermarks.ts
// (`createServerWatermarkStore`). db-server cannot value-import @bolusi/server (08 §3.3 boundary,
// and it would invert the dependency), so the two must be kept in sync; they ARE the server
// `projection_watermarks` contract (10-db §8).
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  ProjectionEngine,
  ProjectionRegistry,
  type ModuleProjectionManifest,
  type ProjectionApplier,
  type RebuildStore,
  type WatermarkStore,
} from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { DB } from '../src/generated/db.js';
import { APP_ROLE } from '../src/schema/security.js';
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

/** MIRROR of apps/server/src/sync/watermarks.ts — the server `projection_watermarks` shape. */
function serverWatermarkStore(db: Kysely<never>, tenantId: string): WatermarkStore {
  return {
    async read(moduleId: string) {
      const result = await sql<{ appliedServerSeq: string | number }>`
        SELECT applied_server_seq FROM projection_watermarks
        WHERE tenant_id = ${tenantId} AND module_id = ${moduleId}
      `.execute(db);
      const row = result.rows[0];
      return {
        appliedServerSeq: row === undefined ? 0 : Number(row.appliedServerSeq),
        appliedLocalSeq: 0,
      };
    },
    async advanceServerSeq(moduleId: string, value: number) {
      await sql`
        INSERT INTO projection_watermarks (tenant_id, module_id, applied_server_seq)
        VALUES (${tenantId}, ${moduleId}, ${value})
        ON CONFLICT (tenant_id, module_id) DO UPDATE
        SET applied_server_seq = CASE
          WHEN projection_watermarks.applied_server_seq > excluded.applied_server_seq
          THEN projection_watermarks.applied_server_seq
          ELSE excluded.applied_server_seq
        END
      `.execute(db);
    },
    async advanceLocalSeq() {
      /* no applied_local_seq column server-side (10-db §8) */
    },
  };
}

function makeEngine(trx: Transaction<DB>): ProjectionEngine<ProbeDb> {
  const registry = new ProjectionRegistry<ProbeDb>();
  registry.register(probeManifest);
  return new ProjectionEngine<ProbeDb>({
    db: trx as unknown as Kysely<ProbeDb>,
    registry,
    watermarks: serverWatermarkStore(trx as unknown as Kysely<never>, tenant.tenantId),
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

describe('LOAD-BEARING: insert + apply + watermark commit in ONE transaction (task 16 §39)', () => {
  test('ATOMIC — an abort mid-batch rolls the watermark back together with the un-applied ops', async () => {
    const ops = [probeOp(1, 'a'), probeOp(2, 'b'), probeOp(3, 'c')];

    await expect(
      testDb.appForTenant(tenant.tenantId, async (trx) => {
        for (const [i, op] of ops.entries()) await insertOp(trx, op, i + 1);
        await makeEngine(trx).applyPulledOp(ops[0] as SignedOperation);
        // The watermark the engine WOULD compute once the whole batch is in the log: the TOP of the
        // batch (contiguity is computed from log PRESENCE, not from what was applied). This is the
        // state that becomes a permanent lie if it is allowed to commit without ops 2–3 folded.
        await serverWatermarkStore(
          trx as unknown as Kysely<never>,
          tenant.tenantId,
        ).advanceServerSeq(MODULE_ID, 3);
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
      for (const op of ops) await engine.applyPulledOp(op);
      await serverWatermarkStore(trx as unknown as Kysely<never>, tenant.tenantId).advanceServerSeq(
        MODULE_ID,
        3,
      );
    });
    // watermark N means "every op with serverSeq ≤ N is folded" — and here it tells the truth.
    expect(await durableWatermark()).toBe(3);
    expect(await countOps()).toBe(3);
    expect(await countProbeRows()).toBe(3);
  });

  test('FALSIFICATION — committing per-op advances the watermark past un-applied ops: the silent skip', async () => {
    const ops = [probeOp(1, 'p'), probeOp(2, 'q'), probeOp(3, 'r')];

    // The broken shape §39 names: insert the whole batch and COMMIT …
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      for (const [i, op] of ops.entries()) await insertOp(trx, op, i + 1);
    });
    // … then apply ONE op — and its watermark — in their own transaction, and COMMIT. Then "crash"
    // before ops 2 and 3 are ever folded.
    await testDb.appForTenant(tenant.tenantId, async (trx) => {
      await makeEngine(trx).applyPulledOp(ops[0] as SignedOperation);
      await serverWatermarkStore(trx as unknown as Kysely<never>, tenant.tenantId).advanceServerSeq(
        MODULE_ID,
        3,
      );
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

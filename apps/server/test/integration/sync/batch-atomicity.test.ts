// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE LOAD-BEARING CONDITION (task 16 §39, from the task-08 projection-engine review).
//
// The projection engine's watermark skip-safety depends on a pulled/accepted batch being applied
// ATOMICALLY: the op INSERTs, the projection APPLIES, and the `applied_server_seq` watermark
// advance MUST all commit in ONE transaction.
//
// WHY IT SILENTLY BREAKS. `applied_server_seq` advances to the highest CONTIGUOUS serverSeq
// **present in the log** (04 §4.3; core/projection/oplog-source.ts `highestContiguousServerSeq`) —
// NOT to the highest one applied. So the moment a whole batch is in the log, the watermark that a
// single apply computes is already the TOP OF THE BATCH. If the applier then commits per-op
// ("insert the whole batch, then apply+commit one op at a time"), the first commit durably
// advances the watermark past ops that were never folded. A crash there leaves a watermark that
// LIES: it claims caught-up through serverSeq N while the projection is missing rows, and any
// watermark-trusting catch-up or recovery skips those ops forever — permanently wrong, no error.
//
// Both tests below run the REAL task-08 engine (`ProjectionEngine` + `highestContiguousServerSeq`)
// over the REAL server tables (`operations`, `projection_watermarks`) via this task's server
// watermark store, on PGlite — which embeds a real PostgreSQL, so transaction abort/rollback is
// genuine Postgres MVCC, not an emulation. The falsification test is the deliverable: it exhibits
// the exact skip the atomic path prevents.
// ══════════════════════════════════════════════════════════════════════════════════════════════
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyModuleMigrations,
  canonicalizeJcs,
  decodeCursor,
  defineModule,
  encodeCursor,
  ProjectionRegistry,
  type JsonValue,
  type ModuleProjectionManifest,
  type ProjectionApplier,
  type ProjectionEngine,
} from '@bolusi/core';
import {
  FIXTURE_TABLE,
  makeFixtureModuleManifest,
  toSignedCore,
  type FixtureDatabase,
} from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';

import { createServerProjectionEngine, createServerWatermarkStore } from '@bolusi/db-server';

import { makeSyncHarness, type SeededDevice, type SyncHarness } from './helpers.js';

const MODULE_ID = 'fixture';

let h: SyncHarness;
let dev: SeededDevice;
let tenantId: string;

/** The fixture module (a real `defineModule` result) — one applier, one projection table. The
 *  type args are explicit: `DB` sits in a contravariant position on `apply`, so inference alone
 *  widens it to `unknown` (the same reason core's applier-conformance names them). */
const fixtureManifest = makeFixtureModuleManifest({ encodeCursor, decodeCursor });
const fixtureModule = defineModule<FixtureDatabase, typeof fixtureManifest>(fixtureManifest);

/** The projection-facing slice the engine consumes — the same mapping `registerModules` makes. */
function projectionManifest(): ModuleProjectionManifest<FixtureDatabase> {
  const appliers: Record<string, ProjectionApplier<FixtureDatabase>> = {};
  for (const [type, declaration] of Object.entries(fixtureModule.operations)) {
    appliers[type] = declaration.apply;
  }
  return { id: fixtureModule.id, tables: fixtureModule.projections.tables, appliers };
}

/** The engine bound to one transaction handle via the PRODUCTION factory (task 49) — the exact
 *  construction apps/server's push pipeline runs (server watermark store + no-rebuild store,
 *  composed once in db-server so this lane executes it, not a copy — CLAUDE.md §2.8). */
function makeEngine(trx: unknown): ProjectionEngine<FixtureDatabase> {
  const db = trx as Kysely<FixtureDatabase>;
  const registry = new ProjectionRegistry<FixtureDatabase>();
  registry.register(projectionManifest());
  return createServerProjectionEngine<FixtureDatabase>(db, tenantId, registry);
}

/** Insert an accepted op into the log with an explicit serverSeq (the push pipeline's INSERT). */
async function insertOpRow(trx: unknown, op: SignedOperation, serverSeq: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (trx as any)
    .insertInto('operations')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: op.storeId,
      userId: op.userId,
      deviceId: op.deviceId,
      seq: op.seq,
      type: op.type,
      entityType: op.entityType,
      entityId: op.entityId,
      schemaVersion: op.schemaVersion,
      payload: JSON.stringify(op.payload),
      timestampMs: op.timestamp,
      location: null,
      source: op.source,
      agentInitiated: op.agentInitiated,
      agentConversationId: op.agentConversationId,
      previousHash: op.previousHash,
      hash: op.hash,
      signature: op.signature,
      signedCoreJcs: canonicalizeJcs(toSignedCore(op) as unknown as JsonValue),
      serverSeq,
      receivedAt: op.timestamp,
      clockSkewFlagged: false,
    })
    .execute();
}

const item = (label: string) => ({
  type: 'fixture.item_created',
  entityType: 'fixture_item',
  payload: { label, secretNote: `secret-${label}` },
});

/** The durable watermark for the fixture module, read OUTSIDE any transaction under test. */
async function durableWatermark(): Promise<number> {
  const row = await h.db
    .selectFrom('projectionWatermarks')
    .select('appliedServerSeq')
    .where('tenantId', '=', tenantId)
    .where('moduleId', '=', MODULE_ID)
    .executeTakeFirst();
  return row === undefined ? 0 : Number(row.appliedServerSeq);
}
async function countOps(): Promise<number> {
  const rows = await h.db.selectFrom('operations').select('id').execute();
  return rows.length;
}
async function countProjectionRows(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (h.db as any).selectFrom(FIXTURE_TABLE).select('id').execute();
  return (rows as unknown[]).length;
}

beforeEach(async () => {
  h = await makeSyncHarness();
  dev = await h.seedDevice(300);
  tenantId = dev.world.tenantId;
  // The fixture module's projection table (its own declared migration) alongside the server schema.
  await applyModuleMigrations<FixtureDatabase>(h.db as unknown as Kysely<FixtureDatabase>, [
    fixtureModule,
  ]);
});
afterEach(async () => {
  await h.close();
});

describe('LOAD-BEARING: a batch applies atomically (task 16 §39; api/01-sync §4)', () => {
  test('ATOMIC — an abort mid-batch rolls the watermark BACK together with the un-applied ops (no durable skip)', async () => {
    const ops = [
      dev.builder.append(item('a')),
      dev.builder.append(item('b')),
      dev.builder.append(item('c')),
    ];

    // ONE transaction: insert the whole batch, apply op 1, then crash before ops 2 and 3.
    await expect(
      h.forTenant(tenantId, async (trx) => {
        for (const [i, op] of ops.entries()) await insertOpRow(trx, op, i + 1);
        const engine = makeEngine(trx);
        await engine.applyPulledOp(ops[0] as SignedOperation);

        // In-transaction the watermark has ALREADY jumped to the top of the batch (3): contiguity
        // is computed from LOG PRESENCE, and all three ops are inserted. This is exactly the state
        // that becomes a permanent lie if it is allowed to commit without ops 2–3 being applied.
        const midFlight = await createServerWatermarkStore(
          trx as unknown as Kysely<FixtureDatabase>,
          tenantId,
        ).read(MODULE_ID);
        expect(midFlight.appliedServerSeq).toBe(3);

        throw new Error('crash mid-batch');
      }),
    ).rejects.toThrow('crash mid-batch');

    // …and because insert + apply + watermark share ONE transaction, the abort took ALL of it:
    expect(await durableWatermark()).toBe(0); // the watermark rolled BACK with the batch
    expect(await countOps()).toBe(0); // the un-applied ops are not in the log
    expect(await countProjectionRows()).toBe(0); // no half-folded projection
    // Re-pulling the same batch is therefore a clean re-apply, not a skip (api/01-sync §4).
  });

  test('ATOMIC — a committed batch leaves watermark == top and every op folded (the positive control)', async () => {
    const ops = [
      dev.builder.append(item('x')),
      dev.builder.append(item('y')),
      dev.builder.append(item('z')),
    ];
    await h.forTenant(tenantId, async (trx) => {
      for (const [i, op] of ops.entries()) await insertOpRow(trx, op, i + 1);
      const engine = makeEngine(trx);
      for (const op of ops) await engine.applyPulledOp(op);
    });
    expect(await durableWatermark()).toBe(3);
    expect(await countOps()).toBe(3);
    expect(await countProjectionRows()).toBe(3); // watermark 3 ⇔ three folded rows: it tells the truth
  });

  test('FALSIFICATION — committing PER-OP lets the watermark advance past un-applied ops: the silent skip', async () => {
    const ops = [
      dev.builder.append(item('p')),
      dev.builder.append(item('q')),
      dev.builder.append(item('r')),
    ];

    // The broken shape §39 names: "insert the whole batch, then apply+commit one op at a time".
    // Step 1 — insert the batch and COMMIT it.
    await h.forTenant(tenantId, async (trx) => {
      for (const [i, op] of ops.entries()) await insertOpRow(trx, op, i + 1);
    });

    // Step 2 — apply ONLY op 1 in its own transaction, and COMMIT.
    await h.forTenant(tenantId, async (trx) => {
      await makeEngine(trx).applyPulledOp(ops[0] as SignedOperation);
    });

    // Step 3 — "crash": ops 2 and 3 are never applied.

    // The damage, durable and silent: the watermark claims the projection is caught up through
    // serverSeq 3 …
    expect(await durableWatermark()).toBe(3);
    expect(await countOps()).toBe(3);
    // … while only ONE op was ever folded. Two ops are in the log, unapplied, and BELOW the
    // watermark — so a catch-up/recovery that trusts `applied_server_seq` (its entire purpose:
    // "is this projection caught up?", 04 §4.3) will never re-apply them. The projection is
    // permanently wrong with no error anywhere.
    expect(await countProjectionRows()).toBe(1);

    // Stated as the invariant the atomic path holds and this one breaks: watermark N must mean
    // "every op with serverSeq ≤ N is folded". Here it does not.
    const watermark = await durableWatermark();
    const folded = await countProjectionRows();
    expect(folded).toBeLessThan(watermark); // the lie, made explicit
  });
});

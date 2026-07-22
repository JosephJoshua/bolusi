// The push transaction's SIXTH step: apply projections (10-db §3, 04 §5.1 step 6, 04 §4.3).
//
// This drives the REAL push path — `processPushBatch`, the production orchestrator behind
// POST /v1/sync/push — not a hand-built engine over hand-inserted ops. That distinction is the
// whole point of the file (T-14b / T-17): the atomicity suites (this dir's sibling
// sync/batch-atomicity.test.ts and db-server's) prove the ENGINE + STORE fold and roll back
// atomically, but they call `applyPulledOp` themselves and insert ops by hand. Neither proves the
// pipeline CALLS the apply step. Task 49 wired it; this file drives the pushed op through the
// whole pipeline (dedupe → binding → signature → chain → scope → schema → INSERT → APPLY) and
// reads the projection table the applier writes.
//
// THE REPRODUCTION (T-11), captured as the RED state of the HEAD test: before the wiring, pushing
// a projecting op left `operations` with a row and the projection table EMPTY. The empty table WAS
// the bug (the missing sixth step), and `pipeline.ts`'s header comment agreed with the five-step
// code, so nobody reading it would notice.
//
// A neutral PROBE module (not `notes`/`auth`) stands in for the real appliers (tasks 17/25/43 are
// todo). It is registered through the same `ProjectionRegistry` the production `deps.projections`
// carries, so this exercises the seam, not a module. Its applier writes a scratch table via raw
// `sql` (dialect-neutral, 04 §2) so nothing here depends on a real projection table's shape.
import { ProjectionRegistry, type ProjectionApplier } from '@bolusi/core';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import type { DB } from '@bolusi/db-server';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { processPushBatch } from '../../../src/oplog/pipeline.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import type { OpRegistry } from '../../../src/oplog/types.js';
import {
  APP_ROLE,
  makeDeps,
  makeOplogTestDb,
  readOps,
  seedWorld,
  testScopeOf,
  type OplogTestDb,
} from './helpers.js';

const GENESIS_TYPE = 'auth.device_enrolled';
const PROBE_MODULE = 'probe';
const PROBE_TYPE = 'probe.item_created';
const PROBE_ENTITY = 'probe_item';
const PROBE_TABLE = 'probe_projection_items';

let testDb: OplogTestDb;

function identityOf(world: ChainWorld) {
  return { deviceId: world.deviceId, tenantId: world.tenantId };
}

/** A world + a genesis-rooted chain, seeded and ready to push. */
async function setupWorld(seed: number) {
  const world = makeWorld(seed, serverCryptoPort);
  await seedWorld(testDb.db, world);
  const builder = new ChainBuilder(world, serverCryptoPort);
  return { world, builder };
}

const probeOp = (label: string) => ({
  type: PROBE_TYPE,
  entityType: PROBE_ENTITY,
  payload: { label },
});

/** The probe's applier: entity-scoped, dialect-neutral (04 §4.1). Raw `sql` so it needs no typed
 *  DB slice — the engine's own re-fold DELETE uses the same escape hatch. Optionally throws, to
 *  falsify atomicity from inside the real push transaction. */
function probeApplier(opts: { throwOn?: string } = {}): ProjectionApplier<DB> {
  return async (db, op) => {
    const label = (op.payload as { label: string }).label;
    if (opts.throwOn !== undefined && label === opts.throwOn) {
      throw new Error(`probe applier deliberately failed on ${label}`);
    }
    await sql`INSERT INTO ${sql.table(PROBE_TABLE)} (id, label) VALUES (${op.entityId}, ${label})`.execute(
      db,
    );
  };
}

/** A ProjectionRegistry carrying exactly the probe module — the shape production `deps.projections`
 *  gets from `registerModules(SERVER_MODULES)`. `auth.device_enrolled` is genesis and has NO probe
 *  applier, so it folds via the `unregistered` no-op — the mixed case the server always sees. */
function probeProjections(opts: { throwOn?: string } = {}): ProjectionRegistry<DB> {
  const registry = new ProjectionRegistry<DB>();
  registry.register({
    id: PROBE_MODULE,
    tables: {
      [PROBE_TABLE]: {
        columns: { id: 'text', label: 'text' },
        primaryKey: ['id'],
        entityType: PROBE_ENTITY,
        entityIdColumn: 'id',
        projectionVersion: 1,
      },
    },
    appliers: { [PROBE_TYPE]: probeApplier(opts) },
  });
  return registry;
}

/** An OpRegistry that accepts the genesis type AND the probe type (so both pass the schema step
 *  and are INSERTed). The SAME module list feeds both registries in production; here both are
 *  built from the same constants, modelling that one-list property (CLAUDE.md §2.8). */
const probeOpRegistry: OpRegistry = {
  // Both types this probe knows are store-scoped (the `OperationDeclaration.scope` default), so
  // their ops must carry a store — which the probe's ops do (05 §9.2).
  scopeOf: testScopeOf((type) => type === GENESIS_TYPE || type === PROBE_TYPE),

  resolve(type) {
    if (type === GENESIS_TYPE) return { kind: 'known', validate: () => true };
    if (type === PROBE_TYPE) {
      return {
        kind: 'known',
        validate: (p) => typeof (p as { label?: unknown }).label === 'string',
      };
    }
    return { kind: 'unknown' };
  },
};

async function countProbeRows(): Promise<number> {
  const result = await sql<{
    n: string;
  }>`SELECT count(*) AS n FROM ${sql.table(PROBE_TABLE)}`.execute(testDb.db);
  return Number(result.rows[0]?.n ?? 0);
}

async function probeLabels(): Promise<string[]> {
  const result = await sql<{ label: string }>`
    SELECT label FROM ${sql.table(PROBE_TABLE)} ORDER BY label
  `.execute(testDb.db);
  return result.rows.map((r) => r.label);
}

beforeEach(async () => {
  testDb = await makeOplogTestDb();
  // A scratch projection table for the probe module, granted to the app role so the applier can
  // write it while the pipeline runs as bolusi_app (SET LOCAL ROLE, appForTenant). No RLS: the
  // apply-under-RLS property belongs to the real modules (17/25/43); THIS file proves the pipeline
  // CALLS the applier atomically, which a granted scratch table shows without coupling to a DDL.
  await sql`CREATE TABLE ${sql.table(PROBE_TABLE)} (id text PRIMARY KEY, label text NOT NULL)`.execute(
    testDb.db,
  );
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${sql.table(PROBE_TABLE)} TO ${sql.id(APP_ROLE)}`.execute(
    testDb.db,
  );
}, 120_000);

afterEach(async () => {
  await testDb?.close();
});

describe('the push transaction applies projections for accepted ops (10-db §3 step 6)', () => {
  test('HEAD — a pushed projecting op writes its projection row through the real pipeline', async () => {
    // RED before task 49's wiring: `result` was `accepted`, `operations` had the row, and
    // `probe_projection_items` was EMPTY. The empty table WAS the bug (the missing sixth step).
    const { world, builder } = await setupWorld(4901);
    const ops = [builder.genesis(), builder.append(probeOp('alpha'))];

    const result = await processPushBatch(
      makeDeps({
        forTenant: testDb.appForTenant,
        registry: probeOpRegistry,
        projections: probeProjections(),
      }),
      identityOf(world),
      ops,
    );

    // Both ops accepted and logged: genesis (unregistered → no fold) + the probe op …
    expect(result.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    const logged = await readOps(testDb.db, world.tenantId);
    expect(logged.map((o) => o.type)).toEqual([GENESIS_TYPE, PROBE_TYPE]);

    // … AND the probe op's projection was folded in the SAME transaction. This line is the fix's
    // proof: genesis folded nothing (no applier), the probe op folded exactly one row.
    expect(await probeLabels()).toEqual(['alpha']);
  });

  test('DENOMINATOR — every accepted projecting op in a batch is folded (not just the first)', async () => {
    const { world, builder } = await setupWorld(4902);
    const ops = [
      builder.genesis(), // auth.device_enrolled — accepted, unregistered (no fold)
      builder.append(probeOp('b')),
      builder.append(probeOp('c')),
      builder.append(probeOp('d')),
    ];

    const result = await processPushBatch(
      makeDeps({
        forTenant: testDb.appForTenant,
        registry: probeOpRegistry,
        projections: probeProjections(),
      }),
      identityOf(world),
      ops,
    );

    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
    // Three PROBE ops in ⇒ three projection rows out (the genesis folds nothing). A loop that
    // folded only op 1, or zero, fails here — the denominator asserted, not assumed (T-14).
    expect(await countProbeRows()).toBe(3);
    expect(await probeLabels()).toEqual(['b', 'c', 'd']);
  });

  test('UNREGISTERED — an accepted op with no applier is a clean no-op, not a crash (honest v0)', async () => {
    // The production default: SERVER_MODULES is empty, so no applier is registered. An accepted op
    // must log and leave every projection untouched WITHOUT error — the `unregistered` path. A
    // vacuous-green failure mode (a loop over zero appliers "succeeding") is this repo's signature
    // bug; this proves the empty case is a deliberate, observable no-op.
    const { world, builder } = await setupWorld(4903);
    const ops = [builder.genesis(), builder.append(probeOp('lonely'))];

    const result = await processPushBatch(
      makeDeps({
        forTenant: testDb.appForTenant,
        registry: probeOpRegistry,
        projections: new ProjectionRegistry<DB>(), // EMPTY — no probe applier
      }),
      identityOf(world),
      ops,
    );

    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
    const logged = await readOps(testDb.db, world.tenantId);
    expect(logged.map((o) => o.type)).toContain(PROBE_TYPE); // logged …
    expect(await countProbeRows()).toBe(0); // … but nothing folded, and no throw
  });

  test('ATOMIC — an applier throw mid-batch aborts the WHOLE push: neither ops nor rows survive', async () => {
    // Falsification of atomicity THROUGH the production path (§2.11). The apply is inside the push
    // transaction, so a fold failure on the 'BOOM' op must roll back the genesis + 'ok1' log rows
    // AND 'ok1's projection row. If the apply happened after commit (or per-op-commit), 'ok1' would
    // survive — the permanent half-applied read model 10-db §3 exists to prevent.
    const { world, builder } = await setupWorld(4904);
    const ops = [
      builder.genesis(),
      builder.append(probeOp('ok1')),
      builder.append(probeOp('BOOM')),
      builder.append(probeOp('ok3')),
    ];

    await expect(
      processPushBatch(
        makeDeps({
          forTenant: testDb.appForTenant,
          registry: probeOpRegistry,
          projections: probeProjections({ throwOn: 'BOOM' }),
        }),
        identityOf(world),
        ops,
      ),
    ).rejects.toThrow('probe applier deliberately failed on BOOM');

    // ONE transaction ⇒ the abort took all of it. 'ok1' was folded in-flight, then rolled back.
    expect(await readOps(testDb.db, world.tenantId)).toHaveLength(0);
    expect(await countProbeRows()).toBe(0);
  });
});

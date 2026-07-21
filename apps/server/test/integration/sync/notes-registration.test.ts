// THE NOTES REGISTRATION (task 49's seam, task 25's obligation) — `SERVER_MODULES` in `deps.ts`.
//
// Task 49 built the push transaction's sixth step (apply projections) and the ONE list it folds
// from: `SERVER_MODULES`. `registerModules(SERVER_MODULES)` derives BOTH the op-payload validators
// AND the projection appliers from it, so validation and folding can never name different module
// sets (CLAUDE.md §2.8). It shipped EMPTY at v0; 17/25/43 append their module. This file is task
// 25's line, proven against the REAL push path.
//
// THE TRAP (task 49's finding): ship the `notes` appliers but forget to append the module, and every
// pushed `notes.*` op is `UNKNOWN_TYPE` — the op is rejected and the `notes` projection stays EMPTY
// in production, silently, while the module suite (which folds through a hand-built engine) stays
// GREEN. So this drives `processPushBatch` — the production orchestrator behind POST /v1/sync/push —
// over PRODUCTION deps (`resolveDeps()`, i.e. the real `SERVER_MODULES`) on real PG16. A test that
// INSERTs its own projection row, or hands the pipeline a hand-built registry, proves nothing about
// the fold: it would be green with `SERVER_MODULES = []`, the exact state this file detects.
//
// FALSIFICATION (§2.11): with `notes` registered, removing the `notesModule` line from
// `SERVER_MODULES` turns the HEAD test RED (`UNKNOWN_TYPE`, and 0 notes rows) while the
// NEGATIVE-CONTROL test stays green. Reported in the task Outcome.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld, resign, type ChainWorld } from '@bolusi/test-support';
import type { MediaRef, SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { resolveDeps, SERVER_MODULES } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { seedWorld } from '../oplog/helpers.js';

const APP_ROLE = 'bolusi_app';

let db: Kysely<DB>;
let appForTenant: ForTenant;
let closeDb: (() => Promise<void>) | undefined;

function forTenantOn(handle: Kysely<DB>, role?: string): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      if (role !== undefined) await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

/** PRODUCTION pipeline deps, composed exactly as routes/sync.ts does — registry AND appliers both
 *  from `resolveDeps()` (the real `SERVER_MODULES`). Only `forTenant` + clock are swapped. */
function productionDeps(): OplogPipelineDeps {
  const deps = resolveDeps({ forTenant: appForTenant, now: () => 1_726_100_000_000 });
  return {
    forTenant: deps.forTenant,
    crypto: deps.serverCrypto,
    now: deps.now,
    newId: deps.newOpLogId,
    registry: deps.opRegistry,
    projections: deps.projections,
  };
}

beforeEach(async () => {
  const handle = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );
  db = handle.db;
  closeDb = handle.close;
  appForTenant = forTenantOn(db, APP_ROLE);
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
});

/** A world whose device is ALREADY ENROLLED (seeded at the genesis head), so this batch pushes only
 *  notes ops — genesis (`auth.device_enrolled`) is task 43's type and is not pushed here. */
async function setupWorld(seed: number): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis(); // advances the builder's chain; never pushed
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash });
  return { world, builder };
}

/**
 * A v3 `notes.note_created` chained after the genesis (seq 2). The `ChainBuilder` stamps
 * schemaVersion 1; the current version is 3 (`{title, body, mediaRef}`), so re-sign the built op
 * with schemaVersion 3 — `resign` recomputes hash+signature over the mutated core, preserving seq
 * and previousHash. Every FRESH `note_created` in production is v3, and the registry validates
 * against exactly the v3 payload.
 */
function noteCreated(
  world: ChainWorld,
  builder: ChainBuilder,
  payload: { title: string; body: string; mediaRef: MediaRef | null },
): SignedOperation {
  const v1 = builder.append({ type: 'notes.note_created', entityType: 'note', payload });
  return resign({ ...v1, schemaVersion: 3 }, world.secretKey, serverCryptoPort);
}

async function readNotes(): Promise<
  { id: string; title: string; mediaId: string | null; mediaSha256: string | null }[]
> {
  const rows = await db
    .selectFrom('notes')
    .select(['id', 'title', 'mediaId', 'mediaSha256'])
    .execute();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    mediaId: r.mediaId,
    mediaSha256: r.mediaSha256,
  }));
}

describe('SERVER_MODULES registration — the notes module folds through the real push path', () => {
  test('REGISTERED — the production module list carries the notes module', () => {
    // The one-line assertion the whole trap reduces to (task 25's line in the list task 49 left
    // empty). Asserted directly AND behaviourally below, so a regression names ITSELF rather than
    // surfacing as a puzzling UNKNOWN_TYPE two tests down.
    expect(SERVER_MODULES.map((m) => m.id)).toContain('notes');
  });

  test('HEAD — a pushed v3 notes.note_created folds a notes row through production deps', async () => {
    const { world, builder } = await setupWorld(2501);
    const op = noteCreated(world, builder, {
      title: 'Stok kopi',
      body: 'Sisa 4 karung',
      mediaRef: {
        mediaId: '01920000-0000-7000-8000-0000000f000a',
        sha256: 'c'.repeat(64),
        mime: 'image/jpeg',
        type: 'image',
        sizeBytes: 231_044,
        capturedAt: 1_726_000_000_000,
        location: null,
        userId: world.userId,
        deviceId: world.deviceId,
      },
    });

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [op],
    );

    // Accepted by the PRODUCTION registry — the op type is declared by a registered module.
    expect(result.results.map((r) => r.status)).toEqual(['accepted']);
    // …and folded by the PRODUCTION appliers, in the same transaction. This row is the fix: the note
    // carries its v3 media attachment, on real PG16 — where `media_id` is a `uuid` column (so the
    // applier's value must be a real UUIDv7, 01 §5.3) and `archived` a real boolean. PGlite over the
    // module suite's text DDL masked both; the real `pg` driver validates them (T-14f).
    //
    // `mediaSha256` is asserted on REAL PG because it is the whole point of v3: this is the value a
    // DIFFERENT device will verify its download against (06 §6), and it has to survive the wire, the
    // registry, and the fold to get there.
    expect(await readNotes()).toEqual([
      {
        id: op.entityId,
        title: 'Stok kopi',
        mediaId: '01920000-0000-7000-8000-0000000f000a',
        mediaSha256: 'c'.repeat(64),
      },
    ]);
  });

  test('NEGATIVE CONTROL — an undeclared notes-ish type is still UNKNOWN_TYPE and folds nothing', async () => {
    // Keeps the HEAD test honest (T-17): it asserts a row APPEARS, so it could be satisfied by a
    // pipeline that folded everything. This proves the registry is still a closed set — registration
    // adds exactly the declared types — and it stays GREEN when the registration line is removed,
    // making the falsification attributable to the registration, not to a broken harness.
    const { world, builder } = await setupWorld(2502);
    const bogus = builder.append({
      type: 'notes.note_frobnicated',
      entityType: 'note',
      payload: { title: 't', body: 'b', mediaRef: null },
    });

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [bogus],
    );

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_TYPE' });
    expect(await readNotes()).toEqual([]);
  });
});

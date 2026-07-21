// THE schemaVersion PUSH GATE (task 121) — a bogus-version op must be REJECTED at push, never
// accepted-and-then-thrown-at-fold on an op already in the signed, append-only log (05 §7).
//
// The bug: `deriveOpRegistry`'s `resolve(type)` ignored the claimed `schemaVersion` and validated
// every push against the ONE current payload schema. So an op claiming `schemaVersion: 99` whose
// payload satisfied the CURRENT (v3) schema passed the schema step, was accepted, then the applier's
// version `switch` hit its `default` and THREW at fold time (`notes.note_created is at schemaVersion
// 99, which this applier does not fold`) — inside the push transaction, poisoning the whole batch.
//
// This drives `processPushBatch` over PRODUCTION deps (`resolveDeps()` — the real `SERVER_MODULES`,
// so the real v3 `notes.note_created` schema AND the real applier that folds v1/v2/v3) on real PG16.
// A hand-built registry would prove nothing: the whole point is the SAME registry validation and
// applier folding production uses. The DB that answered is asserted (T-14d).
//
// FALSIFICATION (§2.11): revert the version gate in `deriveOpRegistry` (deps.ts) — the reject-99 test
// goes RED (the push throws the applier's fold error, or accepts + folds a row) while the v3 and v2
// positive controls stay green. Restore → green. Reported verbatim in the task Outcome.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld, resign, type ChainWorld } from '@bolusi/test-support';
import type { MediaRef, SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { resolveDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { seedWorld } from '../oplog/helpers.js';

const APP_ROLE = 'bolusi_app';

let db: Kysely<DB>;
let appForTenant: ForTenant;
let provenance = '';
let closeDb: (() => Promise<void>) | undefined;

function forTenantOn(handle: Kysely<DB>, role?: string): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      if (role !== undefined) await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

/** PRODUCTION pipeline deps — registry AND appliers both from `resolveDeps()` (real SERVER_MODULES),
 *  exactly as routes/sync.ts composes them; only `forTenant` + clock are swapped. */
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
  provenance = handle.provenance;
  closeDb = handle.close;
  appForTenant = forTenantOn(db, APP_ROLE);
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
});

/** A device already enrolled at its genesis head, so this batch pushes only the notes op under test. */
async function setupWorld(seed: number): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis(); // advances the builder's chain; never pushed
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash });
  return { world, builder };
}

/**
 * A `notes.note_created` chained after the genesis (seq 2), re-signed to claim `schemaVersion`. The
 * `ChainBuilder` stamps v1; `resign` recomputes hash+signature over the mutated core, so the op is
 * genuinely signed for whatever (version, payload) it claims — the version gate, not a bad signature,
 * is what decides it.
 */
function noteCreatedAt(
  world: ChainWorld,
  builder: ChainBuilder,
  schemaVersion: number,
  payload: Record<string, unknown>,
): SignedOperation {
  const v1 = builder.append({ type: 'notes.note_created', entityType: 'note', payload });
  return resign({ ...v1, schemaVersion, payload }, world.secretKey, serverCryptoPort);
}

/** The valid CURRENT (v3) payload — `{title, body, mediaRef}` (01 §9). */
function v3Payload(world: ChainWorld): { title: string; body: string; mediaRef: MediaRef | null } {
  return {
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
  };
}

async function logHas(id: string): Promise<boolean> {
  const rows = await db.selectFrom('operations').select('id').where('id', '=', id).execute();
  return rows.length > 0;
}

async function noteIds(): Promise<string[]> {
  const rows = await db.selectFrom('notes').select('id').execute();
  return rows.map((r) => r.id);
}

describe('schemaVersion push gate — the applier folds a RANGE; the gate accepts exactly it', () => {
  test('provenance — the DB that answered (T-14d)', () => {
    console.log(`[task-121] schemaVersion gate — real PG16 database: ${provenance}`);
    expect(provenance).not.toBe('');
  });

  test('REJECT — schemaVersion 99 with an otherwise-valid v3 payload → SCHEMA_INVALID, never logged', async () => {
    // THE reproduction (T-11). BEFORE the fix this op is accepted at the schema step (its payload
    // satisfies the current v3 schema) and the applier THROWS at fold — poisoning the batch. AFTER,
    // the version gate rejects it up front: a clean per-op SCHEMA_INVALID, and it never enters the log.
    const { world, builder } = await setupWorld(3101);
    const op = noteCreatedAt(world, builder, 99, v3Payload(world));

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [op],
    );

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCHEMA_INVALID' });
    // Fail closed: the op is rejected at push, so it is NOT durably in the signed, append-only log,
    // and nothing folded.
    expect(await logHas(op.id)).toBe(false);
    expect(await noteIds()).toEqual([]);
  });

  test('ACCEPT (current) — schemaVersion 3 with a valid v3 payload → accepted + folds', async () => {
    const { world, builder } = await setupWorld(3102);
    const op = noteCreatedAt(world, builder, 3, v3Payload(world));

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [op],
    );

    expect(result.results.map((r) => r.status)).toEqual(['accepted']);
    expect(await logHas(op.id)).toBe(true);
    expect(await noteIds()).toEqual([op.entityId]);
  });

  test('ACCEPT (old foldable) — schemaVersion 2 STILL accepts + folds (the nuance)', async () => {
    // A rolling-out v2 client pushes a v2 payload (`{title, body, mediaId}`) while the server is at
    // v3. The applier folds v2 forever (05 §7); the gate must accept it — rejecting a legit foldable
    // version is the exact over-correction the task warns against. The v2 payload is NOT re-validated
    // against the current v3 schema (there is no retained v2 schema), which is why `mediaId` — a key
    // v3's `.strict()` would reject — is fine here.
    const { world, builder } = await setupWorld(3103);
    const op = noteCreatedAt(world, builder, 2, {
      title: 'Catatan lama',
      body: 'dari klien v2',
      mediaId: null,
    });

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [op],
    );

    expect(result.results.map((r) => r.status)).toEqual(['accepted']);
    expect(await logHas(op.id)).toBe(true);
    expect(await noteIds()).toEqual([op.entityId]);
  });
});

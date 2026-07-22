// The PRODUCTION-PATH wiring of conflict detection (conflict-wiring.ts; 01 §8.2).
//
// conflict-detection.test.ts drives `processPushBatch` directly and proves the RULES. It does NOT
// prove the production HTTP path reaches them: `resolveDeps → routes/sync.ts → runPush →
// processPushBatch` must THREAD `detectConflicts` through, and that thread was unwired when the
// engine first shipped — the same handoff-ring shape task 49 closed for projections (a fully-tested
// engine the production route never called). This file closes two distinct gaps:
//
//   A. CONSTRUCTION — `resolveDeps` builds a `detectConflicts` IFF a `SystemKeyStore` is injected,
//      and leaves it undefined otherwise (the honest v0 default: no secret-store loader exists, so
//      detection is off but wired — conflict-wiring.ts header).
//   B. THREADING — `runPush` passes `detectConflicts` + `onConflictSurfaced` to `processPushBatch`,
//      so a colliding push through the ROUTE orchestrator produces a conflict and fires the hook.
//
// Note the denominator (T-14): production `SERVER_MODULES` carries only `platform`, and NO platform
// op type declares a conflict (01 §8.1) — so production detects nothing until `notes` (task 25)
// registers a conflicting type, even with a key store. Gap A tests that honest state directly. Gap
// B swaps in a notes-carrying module list — exactly what SERVER_MODULES will hold once 25 lands —
// to exercise the thread end to end today.
import { buildConflictDetection, type SystemKeyStore } from '../../../src/sync/conflict-wiring.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { resolveDeps } from '../../../src/deps.js';
import { runPush, type PushDeps } from '../../../src/sync/push.js';
import type { SurfacedConflict } from '../../../src/sync/conflict-detection.js';
import type { SystemSigner } from '../../../src/oplog/system-op.js';
import type { OpRegistry } from '../../../src/oplog/types.js';
import { ProjectionRegistry, type ProjectionApplier } from '@bolusi/core';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { InProcessPokeHub } from '../../../src/realtime/poke-hub.js';
import { seedDevice, seedWorld, testScopeOf } from '../oplog/helpers.js';

const APP_ROLE = 'bolusi_app';
const NOTE_CREATED = 'notes.note_created';
const NOTE_EDITED = 'notes.note_body_edited';
const NOTE_ARCHIVED = 'notes.note_archived';

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

beforeEach(async () => {
  // Real PG16 clone from the pre-migrated template (D16, task 81) — the seam owns `pg` so this
  // file does not; the production HTTP push path this suite exercises now runs over the real driver.
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

/** Member device (at genesis head) + second device + the tenant system device (01 §3.6). */
async function setup(seed: number) {
  const member = makeWorld(seed, serverCryptoPort);
  const mBuilder = new ChainBuilder(member, serverCryptoPort, 1_726_000_100_000);
  await seedWorld(db, member, { lastSeq: 1, lastHash: mBuilder.genesis().hash });

  const rawB = makeWorld(seed + 100, serverCryptoPort);
  const devB: ChainWorld = {
    ...rawB,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  const bBuilder = new ChainBuilder(devB, serverCryptoPort, 1_726_000_200_000);
  await seedDevice(db, devB, { lastSeq: 1, lastHash: bBuilder.genesis().hash });

  const rawSys = makeWorld(seed + 500, serverCryptoPort);
  const system: ChainWorld = {
    ...rawSys,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  await seedDevice(db, system, { deviceKind: 'system' });
  await db
    .insertInto('systemDeviceChainState')
    .values({ tenantId: member.tenantId, deviceId: system.deviceId })
    .execute();
  // The system actor is flagged by `users.is_system` (01 §3.6); the wiring reads it by that flag.
  await db.updateTable('users').set({ isSystem: true }).where('id', '=', member.userId).execute();

  const keyStore: SystemKeyStore = {
    getSystemSigner: (): SystemSigner => (hash) => serverCryptoPort.sign(hash, system.secretKey),
  };
  return { member, devB, mBuilder, bBuilder, keyStore };
}

async function conflictCount(): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM conflicts`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

// ── Gap A: resolveDeps construction ─────────────────────────────────────────────────────────────

describe('A. resolveDeps wires detection iff a system key store is present', () => {
  test('no key store ⇒ detectConflicts is undefined (the honest v0 default)', () => {
    const deps = resolveDeps({ forTenant: appForTenant });
    // Detection off — no secret-store loader exists (filed as a deployment task). NOT a throwing
    // stub: undefined, so the pipeline's guard skips detection and pushes proceed.
    expect(deps.detectConflicts).toBeUndefined();
  });

  test('a key store ⇒ detectConflicts is a function (the positive control, T-17)', async () => {
    const { keyStore } = await setup(6010);
    const deps = resolveDeps({ forTenant: appForTenant, systemKeyStore: keyStore });
    // Without this, the test above is satisfied by a resolveDeps that can NEVER build one.
    expect(deps.detectConflicts).toBeInstanceOf(Function);
  });
});

// ── Gap B: runPush threads the detector + hook to the pipeline ───────────────────────────────────

/** A notes-shaped module list (what SERVER_MODULES holds once task 25 lands) for the thread test. */
const notesModuleList = [
  {
    id: 'notes',
    operations: {
      [NOTE_CREATED]: {},
      [NOTE_EDITED]: { conflict: { key: 'note.body', severity: 'minor' as const } },
    },
  },
] as unknown as Parameters<typeof buildConflictDetection>[0]['modules'];

const noteCreatedApplier: ProjectionApplier<DB> = async (dbh, op) => {
  const p = op.payload as unknown as { title: string; body: string };
  await dbh
    .insertInto('notes')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId as string,
      title: p.title,
      body: p.body,
      archived: false,
      editCount: 0,
      createdBy: op.userId,
      createdAt: BigInt(op.timestamp),
      lastEditedBy: op.userId,
      lastEditedAt: BigInt(op.timestamp),
    })
    .execute();
};
const noteEditedApplier: ProjectionApplier<DB> = async (dbh, op) => {
  const p = op.payload as unknown as { body: string };
  await dbh
    .updateTable('notes')
    .set((eb) => ({
      body: p.body,
      editCount: eb('editCount', '+', 1),
      lastEditedBy: op.userId,
      lastEditedAt: BigInt(op.timestamp),
    }))
    .where('id', '=', op.entityId)
    .execute();
};
const noteArchivedApplier: ProjectionApplier<DB> = async (dbh, op) => {
  await dbh.updateTable('notes').set({ archived: true }).where('id', '=', op.entityId).execute();
};

function threadTestDeps(
  keyStore: SystemKeyStore,
  onConflictSurfaced: (c: SurfacedConflict) => Promise<void>,
): PushDeps {
  const knownTypes = new Set([
    NOTE_CREATED,
    NOTE_EDITED,
    NOTE_ARCHIVED,
    'platform.conflict_detected',
  ]);
  const registry: OpRegistry = {
    scopeOf: testScopeOf((type) => knownTypes.has(type)),
    resolve: (type) =>
      knownTypes.has(type) ? { kind: 'known', validate: () => true } : { kind: 'unknown' },
  };
  const projections = new ProjectionRegistry<DB>();
  projections.register({
    id: 'notes',
    tables: {
      notes: {
        columns: { id: 'text', body: 'text', archived: 'boolean', edit_count: 'integer' },
        primaryKey: ['id'],
        entityType: 'note',
        entityIdColumn: 'id',
        projectionVersion: 1,
      },
    },
    appliers: {
      [NOTE_CREATED]: noteCreatedApplier,
      [NOTE_EDITED]: noteEditedApplier,
      [NOTE_ARCHIVED]: noteArchivedApplier,
    },
  });
  const platform = resolveDeps({ forTenant: appForTenant }).projections;
  for (const m of platform.modules()) {
    // task 25 registered the REAL `notes` module in SERVER_MODULES, so production `projections`
    // now carries it. This Gap-B test provides its OWN controlled `notes` appliers above (its
    // subject is the runPush detector/hook wiring, not the fold), so skip the production one to
    // avoid a duplicate-op-type registration — the stand-in owns `notes` here by construction.
    if (m.id === 'notes') continue;
    projections.register(m);
  }

  // The REAL production builder, over the injected key store — the wiring under test, not a mock.
  const detectConflicts = buildConflictDetection({
    modules: notesModuleList,
    keyStore,
    crypto: serverCryptoPort,
    now: () => 1_726_100_000_000,
    newId: (() => {
      let n = 7000;
      return () => `0198f300-0000-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    })(),
  });

  return {
    forTenant: appForTenant,
    crypto: serverCryptoPort,
    now: () => 1_726_100_000_000,
    newId: (() => {
      let n = 9000;
      return () => `0198f400-0000-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    })(),
    registry,
    projections,
    pokeHub: new InProcessPokeHub(),
    detectConflicts,
    onConflictSurfaced,
  };
}

describe('B. runPush threads the detector + hook to the pipeline', () => {
  test('an edit-after-archive through runPush produces a SURFACED conflict and fires the hook', async () => {
    // The gap: the pipeline suite proved processPushBatch CALLS the detector and fires the hook;
    // nothing proved runPush PASSES either. An edit-after-archive is SIGNIFICANT (03 §11's N2), so
    // it exercises BOTH threads at once — the detector (a conflict lands) and the post-commit hook
    // (it fires exactly once, category `conflict`).
    const { member, devB, mBuilder, bBuilder, keyStore } = await setup(6020);
    const noteId = makeWorld(6021, serverCryptoPort).storeId;
    const fired: SurfacedConflict[] = [];
    const deps = threadTestDeps(keyStore, async (c) => {
      fired.push(c);
    });

    // A creates + archives the note.
    await runPush(
      deps,
      { deviceId: member.deviceId, tenantId: member.tenantId },
      {
        deviceId: member.deviceId,
        ops: [
          mBuilder.append({
            type: NOTE_CREATED,
            entityType: 'note',
            entityId: noteId,
            payload: { title: 't', body: 'a0' },
          }),
          mBuilder.append({
            type: NOTE_ARCHIVED,
            entityType: 'note',
            entityId: noteId,
            payload: {},
          }),
        ],
      },
    );
    expect(await conflictCount()).toBe(0); // no collision yet (control)
    expect(fired).toHaveLength(0);

    // B, offline through the archive (cursor 0), edits the body — edit-after-archive, through runPush.
    const res = await runPush(
      deps,
      { deviceId: devB.deviceId, tenantId: member.tenantId },
      {
        deviceId: devB.deviceId,
        ops: [
          bBuilder.append({
            type: NOTE_EDITED,
            entityType: 'note',
            entityId: noteId,
            payload: { body: 'b1' },
          }),
        ],
      },
    );
    // The server ACCEPTS and flags — never rejects for a business reason (01 §8.2).
    expect(res.results[0]?.status).toBe('accepted');

    // The whole thread fired: route-shaped deps → runPush → pipeline → detector → emission → fold.
    expect(await conflictCount()).toBe(1);
    const conflict = await sql<{
      severity: string;
      status: string;
    }>`SELECT severity, status FROM conflicts`.execute(db);
    expect(conflict.rows[0]?.severity).toBe('significant');
    expect(conflict.rows[0]?.status).toBe('surfaced');

    // … AND the post-commit hook threaded through runPush, exactly once, category `conflict`.
    expect(fired).toHaveLength(1);
    expect(fired[0]?.category).toBe('conflict');
    expect(fired[0]?.storeId).toBe(member.storeId);
  });
});

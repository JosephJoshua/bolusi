// THE AUTH REGISTRATION (task 49's seam, task 43's obligation) — `SERVER_MODULES` in `deps.ts`.
//
// Task 49 built the push transaction's sixth step (apply projections) and the ONE list it folds
// from: `SERVER_MODULES`. `registerModules(SERVER_MODULES)` derives BOTH the op-payload validators
// AND the projection appliers from it, so validation and folding can never name different module
// sets (CLAUDE.md §2.8). Task 43 appends the `auth` module.
//
// THIS FILE IS THE HANDOFF-RING'S WITNESS. `auth_permission_denials` is the FR-1045 audit trail:
// task 09 emits a denial op on every denial, task 10 makes the deny unconditional on the audit
// succeeding — and until the auth module BOTH (a) ships the appliers AND (b) is appended to
// `SERVER_MODULES`, every one of those ops lands in a log NOTHING reads back. A unit test that folds
// through a hand-built engine, or INSERTs its own row, is green with `SERVER_MODULES = []` — exactly
// the state this file detects. So every test here drives the REAL push path (`processPushBatch`,
// behind POST /v1/sync/push) over PRODUCTION deps (`resolveDeps()`, i.e. the real `SERVER_MODULES`).
//
// THE REPRODUCTION (T-11): before task 43, pushing a signed `auth.user_switched` /
// `auth.permission_denied` over production deps was REJECTED `UNKNOWN_TYPE` (no module declared the
// type) and the projection tables stayed EMPTY. Both halves are the same one-line absence.
//
// FALSIFICATION (§2.11): with the module registered, removing the `authModule` line from
// `SERVER_MODULES` turns the HEAD and DENIAL tests RED (`UNKNOWN_TYPE`, and 0 rows) while the
// negative-control test below stays green. Reported in the task's Outcome.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
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

/** The PRODUCTION pipeline deps, composed exactly as `routes/sync.ts` composes them: the registry
 *  and the appliers both come from `resolveDeps()`, i.e. from the real `SERVER_MODULES`. */
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

/**
 * A world whose device is ALREADY ENROLLED — seeded at the genesis op's chain head, so this batch
 * pushes only post-genesis auth ops. `auth.device_enrolled` folds nothing (it is a directory fact,
 * not a projection — see the module), and its structural genesis validation (05 §9) is out of scope
 * for what this file proves: that a REGISTERED auth op TYPE folds its row. Seeding the device at its
 * post-genesis head models the real sequence (a device enrolls, then pushes) without it.
 */
async function setupWorld(seed: number): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis(); // advances the builder's chain; never pushed
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash });
  return { world, builder };
}

describe('SERVER_MODULES registration — the auth module folds through the real push path', () => {
  test('REGISTERED — the production module list carries the auth module', () => {
    // The one-line assertion the whole trap reduces to. Task 49 left this list empty by design and
    // named 17/25/43 as the tasks that fill it; this is task 43's line. Asserted directly as well as
    // behaviourally below, so a regression names ITSELF rather than surfacing as a puzzling
    // UNKNOWN_TYPE three tests down.
    expect(SERVER_MODULES.map((m) => m.id)).toContain('auth');
  });

  test('HEAD (sessions) — a pushed auth.user_switched folds auth_sessions through production deps', async () => {
    // RED before this task: `rejected`/`UNKNOWN_TYPE` and `auth_sessions` EMPTY.
    const { world, builder } = await setupWorld(4301);
    const switched = builder.append({
      type: 'auth.user_switched',
      entityType: 'auth_session',
      // entityId auto = a fresh UUIDv7 (the session id); captured below to assert the row.
      payload: { previousSessionId: null, previousUserId: null },
    });

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [switched],
    );

    // Accepted by the PRODUCTION registry — proves the op type is declared by a registered module.
    expect(result.results.map((r) => r.status)).toEqual(['accepted']);

    // … and folded by the PRODUCTION appliers, in the same transaction. This row is the fix.
    const rows = await db
      .selectFrom('authSessions')
      .select(['id', 'userId', 'storeId', 'endedAt', 'endReason'])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(switched.entityId); // keyed by the session's entityId
    expect(rows[0]?.userId).toBe(world.userId);
    expect(rows[0]?.storeId).toBe(world.storeId);
    expect(rows[0]?.endedAt).toBeNull(); // born open
    expect(rows[0]?.endReason).toBeNull();
  });

  test('DENIAL (audit) — a pushed auth.permission_denied folds the FR-1045 audit trail', async () => {
    // The load-bearing one (02-permissions §7): the denial op the evaluator emits is READABLE from
    // auth_permission_denials only because this fold + this registration both exist. RED before both.
    const { world, builder } = await setupWorld(4302);
    const denied = builder.append({
      type: 'auth.permission_denied',
      entityType: 'permission_denial',
      payload: {
        permissionId: 'auth.role_manage',
        surface: 'command',
        target: 'auth.manageRole',
        reason: 'not_granted',
        scopeStoreId: null, // tenant-scope check — distinct from the envelope's device store
        suppressedRepeats: 2,
      },
    });

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [denied],
    );

    expect(result.results.map((r) => r.status)).toEqual(['accepted']);
    const rows = await db
      .selectFrom('authPermissionDenials')
      .select([
        'id',
        'storeId',
        'scopeStoreId',
        'userId',
        'permissionId',
        'reason',
        'target',
        'suppressedRepeats',
      ])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(denied.entityId); // keyed by the denial's entityId (02 §7)
    expect(rows[0]?.storeId).toBe(world.storeId); // envelope device store
    expect(rows[0]?.scopeStoreId).toBeNull(); // tenant-scope check
    expect(rows[0]?.userId).toBe(world.userId);
    expect(rows[0]?.permissionId).toBe('auth.role_manage');
    expect(rows[0]?.reason).toBe('not_granted');
    expect(rows[0]?.target).toBe('auth.manageRole');
    expect(rows[0]?.suppressedRepeats).toBe(2); // the throttle's flushed count survives the fold
  });

  test('NEGATIVE CONTROL — an undeclared auth-ish type is still UNKNOWN_TYPE and folds nothing', async () => {
    // The control that keeps the two tests above honest (T-17): they assert a row APPEARS, so they
    // could be satisfied by a pipeline that folded everything indiscriminately. This proves the
    // registry is still a closed set — registration adds exactly the declared types and nothing else
    // — and it stays GREEN when the registration line is removed, making the falsification
    // attributable to the registration rather than to a broken harness.
    const { world, builder } = await setupWorld(4303);
    const bogus = builder.append({
      type: 'auth.not_a_real_type',
      entityType: 'auth_session',
      payload: { previousSessionId: null, previousUserId: null },
    });

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [bogus],
    );

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_TYPE' });
    const sessions = await db.selectFrom('authSessions').select('id').execute();
    expect(sessions).toHaveLength(0);
  });
});

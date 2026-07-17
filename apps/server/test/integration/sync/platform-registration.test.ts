// THE REGISTRATION (task 49's seam, task 17's obligation) — `SERVER_MODULES` in `deps.ts`.
//
// Task 49 built the push transaction's sixth step (apply projections) and the ONE list it folds
// from: `SERVER_MODULES`. `registerModules(SERVER_MODULES)` derives BOTH the op-payload validators
// AND the projection appliers from it, so validation and folding can never name different module
// sets (CLAUDE.md §2.8). It shipped EMPTY at v0: 17/25/43 append their module.
//
// THIS FILE IS THE TRAP'S ONLY WITNESS, and the trap is the reason it is written this way.
//
// `user_prefs` folds from `platform.user_locale_changed`, which the platform module owns. Task 21
// composes push-notification locale by READING `user_prefs`. Until the platform module both (a)
// ships the fold AND (b) is appended to `SERVER_MODULES`, every push notification falls back
// forever — and task 21's own locale test stays GREEN, because it seeds the `user_prefs` row
// directly. A fixture asserting a join production never makes (T-14b). Shipping the applier without
// registering it is a half-fix that looks done and folds nothing.
//
// So every test here drives the REAL push path — `processPushBatch`, the production orchestrator
// behind POST /v1/sync/push — over the PRODUCTION deps (`resolveDeps()`, i.e. the real
// `SERVER_MODULES`). A test that INSERTs its own projection row, or that hands the pipeline a
// hand-built registry, proves nothing about the fold: it would be green with `SERVER_MODULES = []`,
// which is exactly the state this file exists to detect.
//
// THE REPRODUCTION (T-11), captured as this file's RED state before the platform module landed:
// pushing a signed `platform.user_locale_changed` through the real pipeline over production deps
// was REJECTED `UNKNOWN_TYPE` (no module declares the type) and `user_prefs` stayed EMPTY. Both
// halves are the same one-line absence.
//
// FALSIFICATION (§2.11): with the module registered, removing the `platformModule` line from
// `SERVER_MODULES` turns the two HEAD tests RED (`UNKNOWN_TYPE`, and 0 rows) while the
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

/**
 * The PRODUCTION pipeline deps, composed exactly as `routes/sync.ts` composes them: the registry
 * and the appliers both come from `resolveDeps()`, i.e. from the real `SERVER_MODULES`. Only
 * `forTenant` (the DB handle) and the clock are swapped — everything this file asserts about is
 * production wiring.
 */
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
  // Real PG16 clone from the pre-migrated template (D16, task 81) — `pg` stays owned by the seam.
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
 * pushes only platform ops.
 *
 * WHY NOT PUSH THE GENESIS OP HERE. `auth.device_enrolled` is the `auth` module's type, and `auth`
 * is **task 43** — it is not in `SERVER_MODULES` yet, so over PRODUCTION deps a pushed genesis is
 * `UNKNOWN_TYPE`, the chain head never advances, and the platform op behind it fails `CHAIN_GAP`.
 * The test would go red for a reason that has nothing to do with the platform fold.
 *
 * That is not a workaround — it is this file's denominator, made concrete (T-14): registering the
 * platform module lights up `platform.*` and NOTHING else. Seeding the device at its post-genesis
 * head models the real sequence (a device enrolls in an earlier batch, then pushes) without
 * borrowing task 43's coverage.
 */
async function setupWorld(seed: number): Promise<{ world: ChainWorld; builder: ChainBuilder }> {
  const world = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis(); // advances the builder's chain; never pushed
  await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash });
  return { world, builder };
}

async function readUserPrefs(): Promise<{ userId: string; locale: string }[]> {
  const rows = await db.selectFrom('userPrefs').select(['userId', 'locale']).execute();
  return rows.map((r) => ({ userId: r.userId, locale: r.locale }));
}

describe('SERVER_MODULES registration — the platform module folds through the real push path', () => {
  test('REGISTERED — the production module list carries the platform module', () => {
    // The one-line assertion the whole trap reduces to. Task 49 left this list empty by design and
    // named 17/25/43 as the tasks that fill it; this is task 17's line. It is asserted directly as
    // well as behaviourally below, so a regression names ITSELF rather than surfacing as a puzzling
    // UNKNOWN_TYPE three tests down.
    expect(SERVER_MODULES.map((m) => m.id)).toContain('platform');
  });

  test('HEAD — a pushed platform.user_locale_changed folds user_prefs through production deps', async () => {
    // RED before this task: `rejected`/`UNKNOWN_TYPE` and `user_prefs` EMPTY. This is task 21's
    // locale join, made real: the row task 21 reads is written HERE, by the fold, or never.
    const { world, builder } = await setupWorld(1701);
    const ops = [
      builder.append({
        type: 'platform.user_locale_changed',
        entityType: 'user_pref',
        entityId: world.userId,
        storeId: null, // tenant-scoped: the preference follows the user to every device (01 §6)
        payload: { locale: 'en' },
      }),
    ];

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      ops,
    );

    // Accepted by the PRODUCTION registry — proves the op type is declared by a registered module.
    expect(result.results.map((r) => r.status)).toEqual(['accepted']);
    // … and folded by the PRODUCTION appliers, in the same transaction. This row is the fix.
    expect(await readUserPrefs()).toEqual([{ userId: world.userId, locale: 'en' }]);
  });

  test('LWW — a later locale change overwrites the earlier one (canonical-order fold)', async () => {
    // The denominator (T-14): two ops in, ONE row out with the LATER value — not two rows, and not
    // the first value frozen. A fold that inserted-only would leave 'en' here and pass a
    // "row exists" assertion.
    const { world, builder } = await setupWorld(1702);
    const ops = [
      builder.append({
        type: 'platform.user_locale_changed',
        entityType: 'user_pref',
        entityId: world.userId,
        storeId: null,
        payload: { locale: 'en' },
      }),
      builder.append({
        type: 'platform.user_locale_changed',
        entityType: 'user_pref',
        entityId: world.userId,
        storeId: null,
        payload: { locale: 'id' },
      }),
    ];

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      ops,
    );

    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
    expect(await readUserPrefs()).toEqual([{ userId: world.userId, locale: 'id' }]);
  });

  test('NEGATIVE CONTROL — an undeclared platform-ish type is still UNKNOWN_TYPE and folds nothing', async () => {
    // The control that keeps the two tests above honest (T-17): they assert a row APPEARS, so they
    // could in principle be satisfied by a pipeline that folded everything indiscriminately. This
    // proves the registry is still a closed set — registration adds exactly the declared types and
    // nothing else — and it stays GREEN when the registration line is removed, which is what makes
    // the falsification attributable to the registration rather than to a broken harness.
    const { world, builder } = await setupWorld(1703);
    const ops = [
      builder.append({
        type: 'platform.not_a_real_type',
        entityType: 'user_pref',
        entityId: world.userId,
        storeId: null,
        payload: { locale: 'en' },
      }),
    ];

    const result = await processPushBatch(
      productionDeps(),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      ops,
    );

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_TYPE' });
    expect(await readUserPrefs()).toEqual([]);
  });
});

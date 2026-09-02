// CHAOS-01's on-device runner (task 181, D24): the multi-device convergence workload (§3.6 / 04 §4.2,
// FR-1118) folded through the REAL `@bolusi/core` engine on the device's Hermes runtime, over op-sqlite
// instead of the Node harness's better-sqlite3. It is the client-only slice D24 landed first — no server
// round-trip (that is CHAOS-03/06/07) — so a single running APK can prove projection order-independence.
//
// ── ONE RIG, TWO BINDINGS (§2.8) ────────────────────────────────────────────────────────────────
// The convergence body — `VirtualDevice`, the canonical-fold oracle, the disorder orchestrator — lives
// in the platform-free shared rig `@bolusi/test-support/chaos` (bundle-safe: no `node:` builtin, proven
// by chaos-bundle-safe.test.ts). The Node harness binds it to better-sqlite3 via `NODE_SEAMS`; THIS file
// is the device binding. Both hand the rig a `ConvergenceSeams` — a DB-engine `openDb` plus the notes
// module trio — so neither the rig nor this file re-implements the fold (T-7).
//
// ── WHY THIS FILE IS PURE (op-sqlite-free) ──────────────────────────────────────────────────────
// The DB engine is INJECTED as `ChaosDbSeams` (a `DbDriverFactory`), exactly as the at-rest env injects
// its driver. run-and-emit.ts — the harness's ONE native-binding site — binds op-sqlite and calls this;
// the host test binds better-sqlite3 (`:memory:`) and proves the runner PASSES on a real fold and REDS on
// its two positive controls (a dropped op → divergence; in-order arrival → INCONCLUSIVE). The only
// emulator-only residual is Hermes-vs-V8 engine behaviour, which the emulator lane exercises.
//
// ── WHY `openDb` MIRRORS packages/harness/src/client-db.ts, NOT the at-rest env ──────────────────
// It opens a BARE client DB (driver → migrations → Kysely → bound `OpAppendStore`), the proven
// convergence setup — deliberately WITHOUT `CLIENT_PRAGMAS`. Convergence is a single-connection,
// digest-only property that does not need WAL or FK enforcement; turning `foreign_keys = ON` would route
// the fold through a path the Node CHAOS-01 suite never exercises. The ~8-line construction is copied
// per-binding ON PURPOSE: `@bolusi/test-support/chaos` is type-only on `@bolusi/db-client` (08 §3.3 — no
// DB *values* in that package), so "open a real driver + bind the store" cannot be hoisted into the
// shared rig; the seam boundary is what keeps the rig platform-free.
import { CamelCasePlugin, Kysely } from 'kysely';

import type { AnyModuleDefinition } from '@bolusi/core';
import {
  createClientDialect,
  createClientOpStore,
  runClientMigrations,
  type ClientDatabase,
  type DbDriverFactory,
} from '@bolusi/db-client';
import { notesModule, notesModuleManifest } from '@bolusi/modules/notes';
import {
  assertBothFoldPaths,
  assertConvergence,
  runConvergence,
  toProjectionManifest,
  type ClientDbHandle,
  type ConvergenceOptions,
  type ConvergenceResult,
  type ConvergenceSeams,
} from '@bolusi/test-support/chaos';

import { failed, passed, type HarnessGateResult } from '../result.js';

/** The gate id this runner reports under — the CHAOS-01 slot in `EMULATOR_CORRECTNESS_GATE_IDS`. */
export const CHAOS01_GATE_ID = 'CHAOS-01';

/**
 * The op-sqlite-free DB seam for the CHAOS-01 runner. On device run-and-emit.ts binds op-sqlite; the
 * host test binds better-sqlite3 (`:memory:`) — same env, two bindings (§2.8). Everything is keyed by
 * the DB's LOGICAL name so this orchestration never touches a raw path (the seam owns path semantics).
 */
export interface ChaosDbSeams {
  /** Opens a DB driver for `{ name, location }` — op-sqlite on device, better-sqlite3 in CI. */
  readonly driverFactory: DbDriverFactory;
  /** The directory handed to `driverFactory` (a dir on device; `undefined` → `:memory:` in CI). */
  readonly location: string | undefined;
  /** Best-effort delete of the DB file `name` + its WAL/SHM sidecars, so each device DB starts clean. */
  removeDb(name: string): Promise<void>;
}

/**
 * CHAOS-01's device workload. Smaller than the Node CI scale (500 ops/device, §3.6) so a single low-end
 * Android finishes within the harness budget, but still 3 devices over a shared pool with enough offline
 * edits that every device hits BOTH §4.2 dispatch paths (head-apply AND re-fold) — the both-fold-paths
 * denominator (`assertBothFoldPaths`). The host test PROVES these numbers exercise both paths for the
 * fixed seed below, so a green here can never mean "the run never re-folded".
 */
export const DEFAULT_CHAOS01_OPTIONS: ConvergenceOptions = {
  opsPerDevice: 100,
  deviceCount: 3,
  sharedNotes: 20,
  delivery: 'shuffled',
};

/** A fixed seed so the on-device run is deterministic and reproducible (the PRNG is fully seeded). */
export const DEFAULT_CHAOS01_SEED = 181;

/** The non-fold `ProjectionStats` fields `assertBothFoldPaths` ignores — spread so the per-device
 * snapshot it receives has the full `ProjectionStatsSnapshot` shape (mirrors the Node scenario). */
const EMPTY_STATS_BASE = {
  unregistered: 0,
  rebuilds: 0,
  rebuildBatches: 0,
  rebuildApplies: 0,
} as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Build the `ConvergenceSeams` for a device run: a fresh, uniquely-named client DB per `openDb` call
 * (the rig opens one per device plus the canonical-fold reference), and the real `@bolusi/modules` notes
 * trio. A per-run counter names the DBs; `removeDb` runs before open AND on close, so a stale file can
 * never masquerade as this run's replica.
 */
function buildConvergenceSeams(dbSeams: ChaosDbSeams): ConvergenceSeams {
  let dbCounter = 0;
  const notes = notesModule as unknown as AnyModuleDefinition<ClientDatabase>;

  const openDb = async (): Promise<ClientDbHandle> => {
    const name = `bolusi-harness-chaos01-${dbCounter}.db`;
    dbCounter += 1;
    await dbSeams.removeDb(name);
    const driver = await dbSeams.driverFactory({ name, location: dbSeams.location });
    await runClientMigrations(driver, { now: () => 1 });
    const db = new Kysely<ClientDatabase>({
      dialect: createClientDialect(driver),
      plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
    });
    const store = createClientOpStore({ db, driver });
    return {
      driver,
      db,
      store,
      close: async () => {
        await db.destroy();
        await driver.close();
        await dbSeams.removeDb(name);
      },
    };
  };

  return {
    openDb,
    module: notes,
    moduleManifest: notesModuleManifest,
    projectionManifest: toProjectionManifest(notes),
  };
}

/**
 * Run the CHAOS-01 convergence workload and return a real verdict (§2.11 — never a silent pass).
 *
 * PASS requires TWO independent guards, exactly as the Node scenario:
 *   1. `assertBothFoldPaths` per device — a run that never re-folded is INCONCLUSIVE, not green (it only
 *      ever saw ops in order, which proves nothing about order-independence);
 *   2. `assertConvergence` — every device's notes-projection digest must equal the canonical-fold
 *      reference, or it throws naming the first differing row.
 * Either guard throwing becomes a RED naming the reason; a throw from the run setup itself is a RED too,
 * never a gap. The host test drives both controls THROUGH this runner (divergence, INCONCLUSIVE) so the
 * reds are watched, not assumed.
 */
export async function runChaos01Gate(
  dbSeams: ChaosDbSeams,
  options: ConvergenceOptions = DEFAULT_CHAOS01_OPTIONS,
  seed: number = DEFAULT_CHAOS01_SEED,
): Promise<HarnessGateResult> {
  const seams = buildConvergenceSeams(dbSeams);

  let result: ConvergenceResult;
  try {
    result = await runConvergence(seed, options, seams);
  } catch (error) {
    return failed(
      CHAOS01_GATE_ID,
      `CHAOS-01 convergence run threw before producing a verdict — a crash, not a gap (§2.11): ${messageOf(error)}`,
    );
  }

  try {
    for (const s of result.stats) {
      assertBothFoldPaths(s.name, {
        ...EMPTY_STATS_BASE,
        headApplies: s.headApplies,
        refolds: s.refolds,
      });
    }
    assertConvergence(result.reference, result.replicas);
  } catch (error) {
    return failed(CHAOS01_GATE_ID, messageOf(error));
  } finally {
    await result.close();
  }

  const headApplies = result.stats.reduce((total, s) => total + s.headApplies, 0);
  const refolds = result.stats.reduce((total, s) => total + s.refolds, 0);
  return passed(
    CHAOS01_GATE_ID,
    `${options.deviceCount} devices converged to the canonical-fold reference under shuffled arrival ` +
      `(${result.replicas.length} replicas, ${options.opsPerDevice} ops/device); both §4.2 fold paths ` +
      `fired on every device (${headApplies} head-applies, ${refolds} re-folds).`,
    {
      devices: options.deviceCount,
      opsPerDevice: options.opsPerDevice,
      headApplies,
      refolds,
    },
  );
}

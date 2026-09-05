// The shared device-binding for the convergence rig's DB seam (task 181/198). BOTH on-device chaos
// runners — CHAOS-01 (client-only, chaos-01-device-env.ts) and CHAOS-03 (server round-trip,
// chaos-03-device-env.ts) — hand `@bolusi/test-support/chaos` the SAME `ConvergenceSeams`: an
// `openDb` plus the real `@bolusi/modules` notes trio. This is that one builder, so the ~30-line
// "open a bare client DB + bind the store" construction lives ONCE, not copied per runner (§2.8).
//
// ── WHY `openDb` MIRRORS packages/harness/src/client-db.ts, NOT the at-rest env ──────────────────
// It opens a BARE client DB (driver → migrations → Kysely → bound `OpAppendStore`), the proven
// convergence setup — deliberately WITHOUT `CLIENT_PRAGMAS`. Convergence is a single-connection,
// digest-only property that does not need WAL or FK enforcement; turning `foreign_keys = ON` would
// route the fold through a path the Node CHAOS suites never exercise. That ~8-line construction is
// still copied per-PLATFORM (the harness's Node `openClientDb` is the better-sqlite3 twin): it
// cannot be hoisted into the shared rig because `@bolusi/test-support/chaos` is type-only on
// `@bolusi/db-client` (08 §3.3 — no DB *values* in that package), so "open a real driver + bind the
// store" needs a DB-value binding. This file IS the mobile side of that boundary — the device DB
// seam every op-sqlite chaos runner shares, keyed by the DB's LOGICAL name so no runner touches a
// raw path.
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
  toProjectionManifest,
  type ClientDbHandle,
  type ConvergenceSeams,
} from '@bolusi/test-support/chaos';

/**
 * The op-sqlite-free DB seam a device chaos runner needs. On device run-and-emit.ts binds op-sqlite;
 * a host test binds better-sqlite3 (`:memory:`) — one seam, two bindings (§2.8). Everything is keyed
 * by the DB's LOGICAL name so orchestration never touches a raw path (the seam owns path semantics).
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
 * Build the `ConvergenceSeams` for a device run: a fresh, uniquely-named client DB per `openDb` call
 * (the rig opens one per device plus the canonical-fold reference), and the real `@bolusi/modules`
 * notes trio. A per-run counter names the DBs under `bolusi-harness-<dbNamePrefix>-N.db`; `removeDb`
 * runs before open AND on close, so a stale file can never masquerade as this run's replica. The
 * prefix is the ONLY thing that differs between runners (`chaos01` vs `chaos03`), so it is the one
 * knob the callers vary.
 */
export function buildConvergenceSeams(
  dbSeams: ChaosDbSeams,
  dbNamePrefix: string,
): ConvergenceSeams {
  let dbCounter = 0;
  const notes = notesModule as unknown as AnyModuleDefinition<ClientDatabase>;

  const openDb = async (): Promise<ClientDbHandle> => {
    const name = `bolusi-harness-${dbNamePrefix}-${dbCounter}.db`;
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

// The app bootstrap (08 §6.3's order; task 24's item 2, completed by task 50).
//
//   SQLCipher key from SecureStore  →  open the encrypted DB  →  run client migrations
//   →  register modules  →  projection engine  →  sync state
//
// ── WHAT IS REAL HERE, AND WHAT IS STILL ABSENT ───────────────────────────────────────────────
// Task 24 left this file's job absent rather than stubbed, and the reason is worth restating because
// it governs every line below: "a fake `open()` returning a working-looking handle is precisely the
// green-for-the-wrong-reason shape". A stub here is the most expensive lie available — the shell
// would boot, screens would render, tests would pass, and nothing would persist.
//
//   REAL:    the SQLCipher key (ports/db-keystore.ts), `openClientDb`, `runClientMigrations`,
//            `registerModules(CLIENT_MODULES)`, the projection engine, and `readSyncState` — the
//            LAST of which is what finally makes the Sync Status screen's freshness a fact read
//            from the database rather than a literal in a component.
//   ABSENT:  the sync LOOP does not start on any device today, and that is a DATA state, not a
//            missing branch — `startSync` is on the live path, gated on a persisted `deviceId`.
//            Nothing enrolls (App.tsx's `onEnroll` is inert), and task 14's enrollment never writes
//            `deviceId`/`storeId` to `meta_kv` even though 10-db §9 names them, so the gate is
//            never satisfied. Both are filed. The gate is REAL: the moment enrollment persists an
//            id, sync starts — no code here changes.
//
// ── ONE CONNECTION, APP-WIDE (08 §2.2) ────────────────────────────────────────────────────────
// op-sqlite's rule is EXACTLY ONE open connection per database, app-wide; concurrency comes from
// WAL, never a second handle. Violating it is data corruption, not a lint nit. This bootstrap does
// not re-implement that rule — `openClientDb` owns it and throws `already_open` on a second call —
// it CONSUMES it, and `bootstrap.test.ts` proves a second bootstrap cannot open a second connection.
//
// ── THE DRIVER IS INJECTED, AND THAT IS WHY THIS FILE IS TESTABLE ─────────────────────────────
// op-sqlite is a JSI native module that cannot load under Node (testing-guide §2.3), so `index.ts`
// — the one file no Node test imports — supplies `openOpSqliteDriver`, and the test lane supplies
// better-sqlite3. This file names neither. That is db-client's own stated design ("the device app
// injects this factory into `openClientDb`; CI injects the better-sqlite3 one"), and it means the
// migrations below run against a REAL SQLite engine in CI rather than a fake handle.
import {
  createProjectionEngine,
  readSyncState,
  registerModules,
  type ClockPort,
  type CryptoPort,
  type ModuleRegistry,
  type ProjectionEngine,
  type SyncState,
} from '@bolusi/core';
import {
  openClientDb,
  runClientMigrations,
  type ClientDb,
  type DbDriverFactory,
} from '@bolusi/db-client';

import type { SecureStoreDbKeyStore } from '../ports/db-keystore.js';

import { CLIENT_MODULES } from './modules.js';

export interface BootstrapDeps {
  /** op-sqlite on device, better-sqlite3 in CI. See the header. */
  readonly driverFactory: DbDriverFactory;
  /** The SQLCipher key surface (security-guide §6.4). */
  readonly keyStore: SecureStoreDbKeyStore;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  /** Overrides the 10-db §9 default (`bolusi.db`). Tests pass `:memory:` through `location`. */
  readonly databaseName?: string | undefined;
  readonly databaseLocation?: string | undefined;
}

/**
 * What a booted app holds. Everything here is REAL — there is deliberately no field whose value is
 * a placeholder, because a placeholder on this object is indistinguishable from a working app.
 */
export interface Bootstrapped {
  readonly db: ClientDb;
  readonly registry: ModuleRegistry<never>;
  readonly engine: ProjectionEngine<never>;
  /** Versions applied by THIS boot — empty on every boot after the first (the runner is idempotent). */
  readonly migrationsApplied: readonly number[];
  /**
   * The device's `SyncState`, READ FROM THE DATABASE (10-db §9.3's seeded singleton row).
   *
   * THIS IS THE LINE THE WHOLE TASK EXISTS FOR. `Root.tsx` used to pass a hand-built record with
   * `lastSuccessfulSyncAt: null` — correct, but correct as a LITERAL. Now it is a fact: a fresh
   * device reads `null` because the column IS null, and 03 §8 maps that to `stale`, so the loud
   * never-connected banner is what the database actually says rather than what a component asserts.
   * The two are indistinguishable on screen today and could not be more different: one keeps telling
   * the truth after the first sync lands, and one does not.
   *
   * There is deliberately no `?? Date.now()` anywhere on this path (T-19): a default on a value we
   * failed to read manufactures a plausible answer, and here that answer would be "your data is
   * fresh" — the one lie this product must never tell (design-system §4 rule 5).
   */
  readonly syncState: SyncState;
  close(): Promise<void>;
}

/**
 * Boot the data layer. Ordered per 08 §6.3; every step's failure is loud.
 *
 * @throws {DbOpenError} `missing_key` (no SQLCipher key — never a plaintext fallback, SEC-DEV-06),
 *   `already_open` (a connection is live — 08 §2.2's one-connection rule), `driver_open_failed`
 *   (wrong key or corrupt file, with the key scrubbed from the message).
 * @throws {ModuleRegistryError | PermissionRegistryError} a registration defect — duplicate module
 *   id, duplicate op type, unresolvable permission. 02 §3.2: "startup failure (not a warning)".
 */
export async function bootstrap(deps: BootstrapDeps): Promise<Bootstrapped> {
  // 1. The SQLCipher key (security-guide §6.4). Generate-once lives in the key store; this call is
  //    what makes a first boot mint one, and every later boot read the same one back. It runs
  //    BEFORE `openClientDb` so a fresh device has a key by the time the driver is asked for it —
  //    `getDatabaseEncryptionKey` deliberately does not generate (see db-keystore.ts).
  await deps.keyStore.ensureDatabaseEncryptionKey();

  // 2. Open the ONE connection. db-client reads the key, passes it straight to the driver, and
  //    applies 10-db §9's pragmas (WAL first — it is what makes one connection sufficient).
  const db = await openClientDb({
    driverFactory: deps.driverFactory,
    keyStore: deps.keyStore,
    name: deps.databaseName,
    location: deps.databaseLocation,
  });

  try {
    // 3. Migrate (10-db §9.1). Each migration runs in its own transaction, and the bookkeeping row
    //    is written inside it — so "recorded" and "applied" cannot drift.
    const { applied } = await runClientMigrations(db.driver, { now: () => deps.clock.now() });

    // 4. Register modules (04 §1/§3/§4; 02 §3.2). ONE list feeds the permission vocabulary, the
    //    op-type→applier map and the operation registry, so the device cannot validate a type it
    //    cannot fold. A defect throws HERE, before the first command — which is the point: 02 §3.2
    //    says "startup failure (not a warning)", because every defect otherwise degrades into
    //    something that looks like normal operation (a permanent `unknown_permission` denial reads
    //    as "you don't have permission", and nobody looks for a registry bug).
    const registry = registerModules<never>(CLIENT_MODULES);

    // 5. The projection engine over the SAME connection and the SAME registry — `applyPulledOp` is
    //    the seam the sync loop folds through (04 §4).
    const engine = createProjectionEngine<never>(db.db as never, registry.projections);

    // 6. The device's sync state, read from the seeded singleton. `readSyncState` THROWS when the
    //    row is missing rather than returning defaults — a missing row is a broken migration, and
    //    substituting `cursor: 0` would silently re-pull the world and look like a sync bug rather
    //    than the schema failure it is. That throw is why this call is also a migration assertion.
    const syncState = await readSyncState(db.db as never);

    return {
      db,
      registry,
      engine,
      migrationsApplied: applied,
      syncState,
      close: () => db.close(),
    };
  } catch (error) {
    // A half-booted app must not keep the connection: the next boot would hit `already_open` and
    // report a one-connection violation for what is really a migration failure — a misleading
    // error is worse than the original one.
    await db.close().catch(() => undefined);
    throw error;
  }
}

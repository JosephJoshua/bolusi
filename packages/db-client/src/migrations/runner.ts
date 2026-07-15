// Versioned client migration runner (10-db §9.1 `migrations` table, §11.4).
import { toDbError, type DbDriver } from '../driver.js';
import { initialSchemaMigration } from './001-initial-schema.js';
import type { ClientMigration } from './types.js';

/** Every client migration, in version order. Append new ones; never rewrite a shipped one. */
export const CLIENT_MIGRATIONS: readonly ClientMigration[] = [initialSchemaMigration];

export interface RunMigrationsOptions {
  /**
   * Injected clock for the `applied_at` stamp. Defaults to wall time; tests pass a fake
   * so the recorded rows are deterministic.
   */
  readonly now?: () => number;
  /** Defaults to {@link CLIENT_MIGRATIONS}. */
  readonly migrations?: readonly ClientMigration[];
}

export interface MigrationRunResult {
  /** Versions applied by THIS call — empty on a re-run (the runner is idempotent). */
  readonly applied: readonly number[];
}

/**
 * The `migrations` table is itself created by migration 1, so "which versions are
 * applied?" cannot start by querying it. sqlite_master is the bootstrap-safe probe: no
 * table means nothing has ever been applied.
 *
 * The alternative — CREATE TABLE IF NOT EXISTS ahead of the run — would fork the DDL
 * away from the verbatim §9.1 text the codegen types are generated from.
 */
async function readAppliedVersions(driver: DbDriver): Promise<Set<number>> {
  const probe = await driver.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'`,
  );
  if (probe.rows.length === 0) return new Set();

  const rows = await driver.execute(`SELECT version FROM migrations`);
  return new Set(rows.rows.map((row) => Number(row['version'])));
}

/**
 * Applies every not-yet-applied migration, each inside its own transaction.
 *
 * Transactional apply is the guarantee that a failing migration leaves NO partial schema
 * (SQLite DDL is transactional). The bookkeeping row is inserted in the same transaction
 * as the statements it describes, so "recorded" and "applied" cannot drift apart.
 */
export async function runClientMigrations(
  driver: DbDriver,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const now = options.now ?? (() => Date.now());
  const migrations = [...(options.migrations ?? CLIENT_MIGRATIONS)].sort(
    (a, b) => a.version - b.version,
  );

  const alreadyApplied = await readAppliedVersions(driver);
  const applied: number[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.version)) continue;

    await driver.begin();
    try {
      for (const statement of migration.statements) {
        await driver.execute(statement);
      }
      await driver.execute(`INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)`, [
        migration.version,
        migration.name,
        now(),
      ]);
      await driver.commit();
    } catch (error) {
      // A failed commit can leave no active transaction, making rollback throw too. The
      // original failure is the one worth reporting — never let cleanup bury it.
      try {
        await driver.rollback();
      } catch {
        /* preserve the original error */
      }
      throw toDbError(error);
    }
    applied.push(migration.version);
  }

  return { applied };
}

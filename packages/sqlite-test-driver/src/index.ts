// The shared better-sqlite3 `DbDriver` adapter (testing-guide §2.3) — the SINGLE home (§2.8) for
// the value/row normalizers + `createDriver`, extracted from the five byte-identical copies the
// 2026-07-26 duplication audit found (harness, core, modules, db-client, apps/mobile test trees).
//
// op-sqlite is a JSI native module that cannot run under Node, so every CI lane drives the ONE
// client dialect (`@bolusi/db-client`) + migrations through better-sqlite3 instead. That needs a
// `DbDriver` wrapping a `better-sqlite3` handle; the wrapper is identical everywhere, so it lives
// here once. Consumers own only their OPENER (how the handle is created — `:memory:`, file-backed,
// keyed, or key-recording); the driver body is imported.
//
// This owns NO protocol logic (T-7): it is a ~40-line shim over the single dialect, not a second
// dialect. Its one value edge is `@bolusi/db-client` (`toDbError` + the `DbDriver` interface it
// owns) — a value import, so this is test-tooling like `harness`, not type-only like `test-support`
// (08 §3.3 rule 9). It is test-only (never imported by shipping packages); the direct
// `better-sqlite3` edge now belongs to exactly three workspaces: this package, `db-client` (its
// keyed opener + the codegen scratch DB), and `apps/mobile` (its key-recording opener).
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';

import {
  toDbError,
  type DbBatchCommand,
  type DbBatchResult,
  type DbDriver,
  type DbPreparedStatement,
  type DbQueryResult,
  type DbRow,
  type DbValue,
} from '@bolusi/db-client';

function normalizeValue(value: unknown): DbValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return String(value);
}

function normalizeRow(row: Record<string, unknown>): DbRow {
  const normalized: DbRow = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized;
}

function runStatement(statement: Statement, params: readonly DbValue[]): DbQueryResult {
  if (statement.reader) {
    const rows = statement.all(...(params as unknown[])) as Record<string, unknown>[];
    return { rows: rows.map(normalizeRow), rowsAffected: 0, insertId: null };
  }
  const info = statement.run(...(params as unknown[]));
  return {
    rows: [],
    rowsAffected: info.changes,
    insertId: info.lastInsertRowid === undefined ? null : Number(info.lastInsertRowid),
  };
}

/**
 * Wraps an already-open better-sqlite3 handle in the canonical `DbDriver`. Callers own the handle's
 * creation (the opener) — this is the shared body every opener returns.
 */
export function createDriver(db: BetterSqlite3Database): DbDriver {
  const driver: DbDriver = {
    execute(sql: string, params?: readonly DbValue[]): Promise<DbQueryResult> {
      try {
        return Promise.resolve(runStatement(db.prepare(sql), params ?? []));
      } catch (error) {
        return Promise.reject(toDbError(error));
      }
    },
    executeBatch(commands: readonly DbBatchCommand[]): Promise<DbBatchResult> {
      try {
        let rowsAffected = 0;
        db.transaction(() => {
          for (const [sql, params] of commands) {
            rowsAffected += runStatement(db.prepare(sql), params ?? []).rowsAffected;
          }
        })();
        return Promise.resolve({ rowsAffected });
      } catch (error) {
        return Promise.reject(toDbError(error));
      }
    },
    prepare(sql: string): DbPreparedStatement {
      const statement = db.prepare(sql);
      return {
        execute(params?: readonly DbValue[]): Promise<DbQueryResult> {
          try {
            return Promise.resolve(runStatement(statement, params ?? []));
          } catch (error) {
            return Promise.reject(toDbError(error));
          }
        },
        finalize(): Promise<void> {
          return Promise.resolve();
        },
      };
    },
    async begin(): Promise<void> {
      await driver.execute('BEGIN');
    },
    async commit(): Promise<void> {
      await driver.execute('COMMIT');
    },
    async rollback(): Promise<void> {
      await driver.execute('ROLLBACK');
    },
    close(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
  return driver;
}

/** Opens a fresh in-memory better-sqlite3 driver — one independent DB per call (§2.3). */
export function openMemoryDriver(): DbDriver {
  return createDriver(new Database(':memory:'));
}

/**
 * Opens a FILE-backed better-sqlite3 driver.
 *
 * `:memory:` cannot answer the at-rest question: proving "the sensitive columns are ciphertext on
 * disk" requires bytes on a disk to read back (D22; security-guide §6.4). This is the driver the
 * at-rest column-encryption probe opens its database through.
 */
export function openFileDriver(path: string): DbDriver {
  return createDriver(new Database(path));
}

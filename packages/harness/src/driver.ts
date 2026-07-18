// The harness-owned better-sqlite3 `DbDriver` adapter (testing-guide §2.3).
//
// Each VirtualDevice owns exactly ONE connection to its own in-memory database (§2.3 single-
// connection rule), reached through the ONE client dialect that lives in `@bolusi/db-client`
// (`createClientDialect`). op-sqlite is a JSI native module that cannot run in Node, so the CI
// lane drives the identical dialect + migrations through better-sqlite3; task 27 injects the
// op-sqlite driver on device by swapping THIS factory (the scenario code stays driver-agnostic).
//
// This is a ~40-line driver shim, not a second dialect: the single dialect is imported. It mirrors
// the shape `core`/`db-client` already keep privately in their own test trees — repeated here only
// because `@bolusi/test-support` is barred from importing a driver (08 §3.3 rule 7) and there is
// nowhere shared to put it. It owns NO protocol logic (T-7).
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

function createDriver(db: BetterSqlite3Database): DbDriver {
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

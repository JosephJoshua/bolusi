// TEST-ONLY better-sqlite3 `DbDriver` adapter for the projection-engine suite.
//
// The projection engine runs against a real SQLite database behind the shim dialect
// (testing-guide §2.3): op-sqlite is a JSI native module that cannot run in Node, so CI drives
// the identical dialect + migrations through better-sqlite3 instead. This file is the CI half
// of that two-adapter design, scoped to core's tests (08 §2.5 — never shipping source; the
// boundary rule allows better-sqlite3 in core test/ files only).
//
// It intentionally MIRRORS `packages/db-client/test/better-sqlite3-adapter.ts`: that copy is
// private to db-client's own suite (not exported), and the shared home `@bolusi/test-support`
// is barred from importing a driver (the driver is injected there, 08 §3.3 rule 7). The
// duplication is the same shape db-client already accepts, not a second implementation of the
// dialect — the ONE dialect lives in `@bolusi/db-client` and is imported, only the ~40-line
// driver shim is repeated because there is nowhere shared to put it.
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

/** Opens a fresh in-memory better-sqlite3 driver — one independent DB per call. */
export function openMemoryDriver(): DbDriver {
  return createDriver(new Database(':memory:'));
}

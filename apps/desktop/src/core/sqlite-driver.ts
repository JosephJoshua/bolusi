// The PC's SQLite driver: Node's built-in `node:sqlite`, which Electron ships, so the counter app
// needs no native module rebuilt per Electron version. It implements the same `DbDriver` the phone's
// op-sqlite adapter does, and passes the same conformance suite (test/sqlite-driver.test.ts).
//
// `node:sqlite` is synchronous. That is fine here: it runs in the core's own process, so a slow
// query holds up other core calls, never the window.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';

import {
  toDbError,
  type DbBatchCommand,
  type DbBatchResult,
  type DbDriver,
  type DbDriverFactory,
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
  for (const [key, value] of Object.entries(row)) normalized[key] = normalizeValue(value);
  return normalized;
}

function run(statement: StatementSync, params: readonly DbValue[]): DbQueryResult {
  const values = params as readonly SQLInputValue[];
  // A statement that returns columns is a read (SELECT, RETURNING, most PRAGMAs).
  if (statement.columns().length > 0) {
    const rows = statement.all(...values) as Record<string, unknown>[];
    return { rows: rows.map(normalizeRow), rowsAffected: 0, insertId: null };
  }
  const info = statement.run(...values);
  return {
    rows: [],
    rowsAffected: Number(info.changes),
    insertId: Number(info.changes) === 0 ? null : Number(info.lastInsertRowid),
  };
}

/** Wraps an open `node:sqlite` handle in the shared driver interface. */
export function createNodeSqliteDriver(db: DatabaseSync): DbDriver {
  const attempt = <T>(body: () => T): Promise<T> => {
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(toDbError(error));
    }
  };
  const driver: DbDriver = {
    execute: (sql, params) => attempt(() => run(db.prepare(sql), params ?? [])),
    executeBatch: (commands: readonly DbBatchCommand[]): Promise<DbBatchResult> =>
      attempt(() => {
        let rowsAffected = 0;
        db.exec('BEGIN');
        try {
          for (const [sql, params] of commands) {
            rowsAffected += run(db.prepare(sql), params ?? []).rowsAffected;
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return { rowsAffected };
      }),
    prepare(sql: string): DbPreparedStatement {
      const statement = db.prepare(sql);
      return {
        execute: (params) => attempt(() => run(statement, params ?? [])),
        finalize: () => Promise.resolve(),
      };
    },
    begin: () => attempt(() => db.exec('BEGIN')),
    commit: () => attempt(() => db.exec('COMMIT')),
    rollback: () => attempt(() => db.exec('ROLLBACK')),
    close: () => attempt(() => db.close()),
  };
  return driver;
}

/** The factory `bootstrap` takes: `location` is the folder (or `:memory:`), `name` the file. */
export const openNodeSqliteDriver: DbDriverFactory = (params) =>
  Promise.resolve().then(() => {
    const path =
      params.location === ':memory:' ? ':memory:' : join(params.location ?? '.', params.name);
    try {
      return createNodeSqliteDriver(new DatabaseSync(path));
    } catch (error) {
      throw toDbError(error);
    }
  });

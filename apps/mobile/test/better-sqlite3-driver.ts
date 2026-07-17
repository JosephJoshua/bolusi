// TEST-ONLY better-sqlite3 driver for the bootstrap suite (08 §2.5; testing-guide §2.3).
//
// op-sqlite is a JSI native module that cannot load under Node, so CI drives the identical
// `openClientDb` + migration + registration code through better-sqlite3 instead. It lives under
// `test/` and is never imported by shipping source — `bolusi/boundaries` enforces that half
// (`{ workspace: 'apps/mobile', testOnly: true }`), `shipping-deps.test.ts` the other.
//
// SQLCIPHER IS OFF HERE, BY DESIGN — say it plainly, because this driver is what the bootstrap suite
// runs against and a reader could otherwise take a green run as evidence of encryption. better-sqlite3
// has no SQLCipher build; `encryptionKey` is accepted and IGNORED. So this lane proves the key is
// READ, DEMANDED, and PASSED (that a missing key refuses to open, that the value reaching the driver
// is the one SecureStore held) — and proves NOTHING about whether the file on disk is ciphertext.
// That is SEC-DEV-06's on-device leg (task 27a) and it is unverifiable here (D12/D13: no physical
// Android or iOS device).
//
// This is a near-copy of `packages/db-client/test/better-sqlite3-adapter.ts` and that is deliberate
// rather than a §2.8 miss: that file lives under another package's `test/` directory, which is not
// on any package's public surface, and db-client is a SHIPPING package whose entry must stay
// Node-safe — exporting a better-sqlite3 adapter from it would put a Node-addon edge on the device
// bundle's dependency graph. The alternative (reaching across into db-client/test/) is the shape
// `test/doubles/react-native.tsx` already had to take for @bolusi/ui and is worse here, because that
// file is not built and has no stable path. If a third copy is ever needed, promote ONE to a
// test-support export instead — test-support's db-client edge is type-only (08 §3.3 rule 7), so the
// driver would live there and the `DbDriver` type would stay injected.
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';

import {
  toDbError,
  type DbBatchCommand,
  type DbBatchResult,
  type DbDriver,
  type DbDriverOpenParams,
  type DbPreparedStatement,
  type DbQueryResult,
  type DbRow,
  type DbValue,
} from '@bolusi/db-client';

/** better-sqlite3 yields Buffer, op-sqlite yields ArrayBuffer — both normalize to Uint8Array. */
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
  // `reader` tells us whether the statement yields rows: better-sqlite3 throws if we call all() on a
  // non-reader (e.g. `PRAGMA foreign_keys = ON`), and which PRAGMAs read vs write is not guessable
  // from the SQL text — ask the statement. The bootstrap applies four pragmas, so this path is live.
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

/** Records every key the bootstrap hands the driver — the SQLCipher-key assertions read this. */
export const openedWith: DbDriverOpenParams[] = [];

export function resetOpenedWith(): void {
  openedWith.length = 0;
}

/**
 * A file-backed or in-memory driver factory.
 *
 * `location: ':memory:'` is the default. A NAMED file is what the persistence test needs: proving
 * "a write survives a restart" requires the bytes to outlive the connection, and `:memory:` dies
 * with it — which would make the reproduction assert nothing (T-14b).
 */
export const openBetterSqlite3Driver = (params: DbDriverOpenParams): Promise<DbDriver> => {
  openedWith.push(params);
  const path = params.location === undefined ? ':memory:' : params.location;
  return Promise.resolve(createDriver(new Database(path)));
};

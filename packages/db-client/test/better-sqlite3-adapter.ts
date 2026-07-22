// TEST-ONLY better-sqlite3 adapter (08 §2.5: never imported by shipping packages; it
// lives under test/ and is excluded from the build, so it cannot reach dist/).
//
// This is the CI half of the two-adapter design (testing-guide §2.3): op-sqlite is a JSI
// native module and cannot run in Node, so CI drives the identical dialect + migration +
// conformance code through better-sqlite3 instead.
//
// SQLCipher is OFF here BY DESIGN — better-sqlite3 has no SQLCipher build. `encryptionKey`
// is accepted and deliberately ignored, so this adapter proves nothing about encryption
// at rest; that is SEC-DEV-06's L6 leg on real hardware (task 27). What it does prove is
// that the SQL, the dialect, and the migrations behave identically on both engines.
import * as nodeCrypto from 'node:crypto';

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';

import { createNodeCompatibleAead } from '../src/crypto/aead.js';
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
} from '../src/driver.js';

/** better-sqlite3 returns blobs as `Buffer`; op-sqlite returns `ArrayBuffer`. Both adapters
 * normalize to a plain `Uint8Array` so conformance compares identical values. */
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
  // `reader` tells us whether the statement yields rows. better-sqlite3 throws if we call
  // all() on a non-reader (e.g. `PRAGMA foreign_keys = ON`) or run() expecting rows, and
  // which PRAGMAs read vs. write is not guessable from the SQL text — ask the statement.
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
      // op-sqlite's executeBatch is atomic; better-sqlite3's transaction() gives the same
      // all-or-nothing semantics, so the conformance suite sees one behaviour.
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

/**
 * Opens a database. `:memory:` (or no location) opens in-memory; any other location is treated as a
 * directory prefix, which is what the raw-file at-rest tests need (they must read the bytes back).
 */
export const openBetterSqlite3Driver = (params: DbDriverOpenParams): Promise<DbDriver> => {
  const path =
    params.location === ':memory:' || params.location === undefined
      ? ':memory:'
      : `${params.location}/${params.name}`;
  return Promise.resolve(createDriver(new Database(path)));
};

/** Opens an in-memory driver — the common shape for tests. */
export const openTestDriver = (): Promise<DbDriver> =>
  openBetterSqlite3Driver({ name: 'test.db', location: ':memory:' });

/**
 * A valid-but-obviously-fake database key: 32 bytes as 64 hex chars (10-db §12).
 *
 * Since D22 the key is decoded to the raw bytes of the AES-256-GCM column cipher, so it MUST be real
 * hex of the right length — an arbitrary string like the old `'test-key'` now fails the open, which is
 * correct behaviour, not a test-only nuisance. A repeating pattern keeps it out of the secret
 * scanner's way (security-guide §10, SEC-SECRET-02).
 */
export const TEST_DB_KEY = 'a'.repeat(64);

/** The Node AES-256-GCM binding for the column cipher in CI. The device binds quick-crypto instead. */
export const testAead = createNodeCompatibleAead(nodeCrypto);

/** The `DbKeyStore` shape every db-client test opens with. */
export const testKeyStore = {
  getDatabaseEncryptionKey: (): Promise<string> => Promise.resolve(TEST_DB_KEY),
};

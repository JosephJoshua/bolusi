// THE op-sqlite adapter — the single `@op-engineering/op-sqlite` import site in the whole
// repo (08 §3.2/§3.3, lint-enforced by bolusi/boundaries). Everything above it speaks
// `DbDriver`, which is what keeps expo-sqlite a swap target (D6).
//
// Reachable only through the `@bolusi/db-client/op-sqlite` subpath, never from the package
// index: op-sqlite is a JSI native module that cannot load in Node (testing-guide §2.3),
// so pulling it in from the index would break every Node test that imports this package.
// The device app injects this factory into `openClientDb`; CI injects the better-sqlite3 one.
import { open, type DB, type Scalar } from '@op-engineering/op-sqlite';

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
} from '../driver.js';

/**
 * op-sqlite hands blobs back as `ArrayBuffer`; better-sqlite3 uses `Buffer`. Both are
 * normalized to a plain `Uint8Array` so the conformance suite compares like with like —
 * an un-normalized blob would make the two adapters differ on a byte-identical row.
 */
function normalizeValue(value: Scalar): DbValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  // op-sqlite maps SQLite INTEGER 0/1 back as-is; a boolean can only arrive if a caller
  // bound one, which `DbValue` forbids. Normalize defensively rather than leak it upward.
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function normalizeRow(row: Record<string, Scalar>): DbRow {
  const normalized: DbRow = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized;
}

function toResult(result: {
  rows: Array<Record<string, Scalar>>;
  rowsAffected: number;
  insertId?: number;
}): DbQueryResult {
  return {
    rows: result.rows.map(normalizeRow),
    rowsAffected: result.rowsAffected,
    insertId: result.insertId ?? null,
  };
}

/** `DbValue` is a subset of op-sqlite's `Scalar`, so this is a widening, not a cast away. */
function toScalars(params: readonly DbValue[] | undefined): Scalar[] {
  return [...(params ?? [])];
}

function createPreparedStatement(db: DB, sql: string): DbPreparedStatement {
  // Prepared once, re-bound per execution — that is the whole point (D6: pull-apply and
  // projection rebuild are the hot paths on a 2 GB device).
  const statement = db.prepareStatement(sql);
  return {
    async execute(params?: readonly DbValue[]): Promise<DbQueryResult> {
      try {
        if (params !== undefined) await statement.bind(toScalars(params));
        return toResult(await statement.execute());
      } catch (error) {
        throw toDbError(error);
      }
    },
    async finalize(): Promise<void> {
      // op-sqlite owns the statement's native lifetime; it is released when the
      // connection closes. Nothing to do, but the contract stays uniform across adapters.
    },
  };
}

function createDriver(db: DB): DbDriver {
  return {
    async execute(sql: string, params?: readonly DbValue[]): Promise<DbQueryResult> {
      try {
        return toResult(await db.execute(sql, toScalars(params)));
      } catch (error) {
        throw toDbError(error);
      }
    },
    async executeBatch(commands: readonly DbBatchCommand[]): Promise<DbBatchResult> {
      try {
        const result = await db.executeBatch(
          commands.map(([sql, params]) =>
            params === undefined ? ([sql] as const) : ([sql, toScalars(params)] as const),
          ) as Parameters<DB['executeBatch']>[0],
        );
        return { rowsAffected: result.rowsAffected ?? 0 };
      } catch (error) {
        throw toDbError(error);
      }
    },
    prepare(sql: string): DbPreparedStatement {
      return createPreparedStatement(db, sql);
    },
    async begin(): Promise<void> {
      await this.execute('BEGIN');
    },
    async commit(): Promise<void> {
      await this.execute('COMMIT');
    },
    async rollback(): Promise<void> {
      await this.execute('ROLLBACK');
    },
    async close(): Promise<void> {
      await db.closeAsync();
    },
  };
}

/**
 * Opens the device database. `encryptionKey` is a first-class `open()` param on op-sqlite
 * (D6's reason for choosing it over expo-sqlite's string-interpolated `PRAGMA key`), and
 * it is always passed — this factory has no unkeyed path.
 */
export const openOpSqliteDriver = async (params: DbDriverOpenParams): Promise<DbDriver> => {
  const db = open({
    name: params.name,
    ...(params.location === undefined ? {} : { location: params.location }),
    encryptionKey: params.encryptionKey,
  });
  return createDriver(db);
};

/**
 * Deletes the client database FILE (and its WAL/SHM sidecars) at op-sqlite's default location —
 * the DB-file leg of the wipe (api/02-auth §7.3 step 2; security-guide §6.6's restore recovery).
 *
 * It lives HERE, and only here, because `@op-engineering/op-sqlite` has exactly one import site in
 * the repo (08 §3.2/§3.3, lint-enforced by bolusi/boundaries) — apps/mobile cannot reach op-sqlite
 * directly, so the boot-recovery wipe injects this from the same binding site as `openOpSqliteDriver`.
 *
 * NO `encryptionKey` IS PASSED, AND THAT IS CORRECT, NOT A SEC-DEV-06 HOLE: `open()` is lazy — it
 * touches no page until the first query — and `delete()` is a filesystem unlink that never decrypts.
 * So a restored old-key file (unreadable ciphertext to us) is removed without ever being opened for
 * reading. There is still no unkeyed path that READS data; this only destroys the file.
 */
export const deleteOpSqliteDatabase = (params: {
  readonly name: string;
  readonly location?: string | undefined;
}): void => {
  const db = open({
    name: params.name,
    ...(params.location === undefined ? {} : { location: params.location }),
  });
  db.delete();
};

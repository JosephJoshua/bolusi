// The ONE driver interface (04-db-client task; 08 §3.2). Everything above this file —
// the Kysely dialect, the migration runner, the connection singleton — talks to SQLite
// exclusively through `DbDriver`. That is what keeps `expo-sqlite` a swap target (D6)
// and what lets the driver-conformance suite (testing-guide §2.3) prove that a green
// better-sqlite3 run in CI says something true about op-sqlite on the device.
//
// Adapters (op-sqlite for device, better-sqlite3 for CI) implement this interface and
// are injected; no module above this one may import a driver package.

/** A value SQLite can bind or return. Booleans are deliberately absent: op-sqlite accepts
 * them but better-sqlite3 rejects them, so allowing one would make the two adapters
 * non-conformant by construction. Store booleans as INTEGER 0/1 (10-db §9 does). */
export type DbValue = string | number | null | Uint8Array;

export type DbRow = Record<string, DbValue>;

export interface DbQueryResult {
  readonly rows: readonly DbRow[];
  readonly rowsAffected: number;
  /** `null` when the statement inserted nothing. */
  readonly insertId: number | null;
}

/** A batch entry: SQL plus its bound parameters (10-db §9 preamble — bulk paths use
 * `executeBatch`). */
export type DbBatchCommand = readonly [sql: string, params?: readonly DbValue[]];

export interface DbBatchResult {
  readonly rowsAffected: number;
}

/**
 * A compiled statement kept alive for reuse. The performance win is in preparing once
 * and re-binding many times (D6: hot paths are pull-apply and projection rebuild), so
 * callers hold the handle and call `execute` repeatedly.
 */
export interface DbPreparedStatement {
  execute(params?: readonly DbValue[]): Promise<DbQueryResult>;
  finalize(): Promise<void>;
}

export interface DbDriver {
  execute(sql: string, params?: readonly DbValue[]): Promise<DbQueryResult>;
  executeBatch(commands: readonly DbBatchCommand[]): Promise<DbBatchResult>;
  prepare(sql: string): DbPreparedStatement;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface DbDriverOpenParams {
  /** File name of the database (10-db §9: `bolusi.db`). */
  readonly name: string;
  /** Directory prefix. `:memory:` opens an in-memory database. */
  readonly location?: string | undefined;
}

/** Adapter entry point. Injected into `openClientDb` so the wrapper never names a driver. */
export type DbDriverFactory = (params: DbDriverOpenParams) => Promise<DbDriver>;

/**
 * Normalized failure codes. Both adapters map their native errors onto this set so the
 * conformance suite can assert *identical* error behaviour across engines — an
 * adapter-specific error shape leaking upward would silently break that guarantee.
 */
export type DbErrorCode =
  /** UNIQUE / CHECK / NOT NULL / FOREIGN KEY constraint violation. */
  | 'constraint'
  /** Malformed SQL. */
  | 'syntax'
  /** Statement referenced a missing table. */
  | 'no_such_table'
  /** Write attempted against a read-only database. */
  | 'readonly'
  /**
   * The file is not a database this connection can read — a corrupt or non-SQLite file.
   * (Under the app-layer AEAD scheme the DB file itself is plaintext SQLite, so a "wrong key"
   * no longer surfaces here — that is now the column cipher's `open` throw; D22.)
   */
  | 'not_a_database'
  | 'unknown';

export class DbError extends Error {
  override readonly name = 'DbError';
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** Ordered most-specific-first; SQLite's own message text is the portable signal, since
 * op-sqlite surfaces strings while better-sqlite3 also carries a `code`. */
const ERROR_PATTERNS: readonly (readonly [RegExp, DbErrorCode])[] = [
  [/file is (?:not a database|encrypted or is not a database)/i, 'not_a_database'],
  [/constraint failed/i, 'constraint'],
  [/no such table/i, 'no_such_table'],
  [/(?:syntax error|incomplete input|unrecognized token)/i, 'syntax'],
  [/(?:readonly database|read-only database)/i, 'readonly'],
];

export function classifyDbError(error: unknown): DbErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, code] of ERROR_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return 'unknown';
}

/** Wraps an adapter's native error as a `DbError`, preserving the original as `cause`. */
export function toDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DbError(classifyDbError(error), message, { cause: error });
}

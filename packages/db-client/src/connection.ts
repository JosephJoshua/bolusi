// The module-singleton client connection (10-db §9 preamble; 08 §2.2; security-guide §6.4).
//
// op-sqlite's hard rule is EXACTLY ONE open connection per database, app-wide —
// concurrency comes from WAL, never from a second handle. This module is where that rule
// is enforced, and it is the only place the SQLCipher key is ever read.
import { CamelCasePlugin, Kysely } from 'kysely';

import { createClientDialect } from './dialect/index.js';
import { toDbError, type DbDriver, type DbDriverFactory } from './driver.js';
import type { ClientDatabase } from './generated/index.js';

/** 10-db §9: the database file name. */
export const DEFAULT_DATABASE_NAME = 'bolusi.db';

/**
 * The ONE CamelCasePlugin configuration for the client (10-db §11.4).
 *
 * `underscoreBetweenUppercaseLetters: true` is REQUIRED, not a preference. kysely-codegen
 * and CamelCasePlugin are **not inverses at default options**: codegen turns the column
 * `op_a_id` into the property `opAId`, but the plugin's DEFAULT `snakeCase('opAId')` is
 * `'op_aid'` — a column that does not exist. Such a query typechecks and dies at runtime
 * ("no such column"). The shape that triggers it is a single-letter segment between camel
 * humps; `conflicts.op_a_id` / `op_b_id` (10-db §9.6) are the live cases.
 *
 * Changing this MUST stay in lockstep with `--camel-case` in scripts/codegen.ts, and
 * `test/codegen-camel-case.test.ts` re-derives every generated property against the real
 * migrated schema so a regression fails there rather than in the first applier that
 * touches `conflicts`.
 *
 * db-server carries its own copy (`packages/db-server/src/camel-case.ts`) by necessity:
 * 08 §3.3 hard rule 2 forbids db-client and db-server importing each other, and the
 * shared normative source is the 10-db §11.4 spec line, guarded by a property-by-property
 * test on each side.
 */
export const CLIENT_CAMEL_CASE_OPTIONS = { underscoreBetweenUppercaseLetters: true } as const;

/**
 * Applied post-open, in this exact order (10-db §9 preamble). Order is part of the spec,
 * not incidental: `journal_mode = WAL` is what makes a single connection sufficient.
 */
export const CLIENT_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
];

/**
 * The DB-key surface of `@bolusi/core`'s `KeyStorePort` (08 §3.2), declared structurally
 * and ON PURPOSE:
 *
 *  - `@bolusi/core` is contended and owned by other tasks — this package does not edit it.
 *  - Structural typing means the real SecureStore-backed `KeyStorePort` (tasks 14/24)
 *    satisfies this without db-client importing core's port module at all.
 *
 * The key is 32 CSPRNG bytes as hex, generated once at enrollment and stored in
 * expo-secure-store — encrypted-at-rest storage that app code can read back, NOT a
 * hardware enclave (security-guide §6.2: qualified claims only).
 */
export interface DbKeyStore {
  getDatabaseEncryptionKey(): Promise<string | null>;
}

export type DbOpenErrorCode =
  /** The key store returned nothing. Fails before any driver call — never a plaintext open. */
  | 'missing_key'
  /** A connection is already live (op-sqlite's one-connection-per-DB rule). */
  | 'already_open'
  /** A caller asked for the connection before `openClientDb` ran. */
  | 'not_open'
  /** The driver refused to open — wrong key, corrupt file, or I/O failure (SEC-DEV-06). */
  | 'driver_open_failed';

export class DbOpenError extends Error {
  override readonly name = 'DbOpenError';
  readonly code: DbOpenErrorCode;

  constructor(code: DbOpenErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export interface OpenClientDbOptions {
  /** Adapter injection: op-sqlite on device, better-sqlite3 in CI. */
  readonly driverFactory: DbDriverFactory;
  readonly keyStore: DbKeyStore;
  readonly name?: string | undefined;
  readonly location?: string | undefined;
}

export interface ClientDb {
  /** Typed query builder over the one connection. */
  readonly db: Kysely<ClientDatabase>;
  /** Raw helpers (prepared statements, executeBatch) over that SAME connection. */
  readonly driver: DbDriver;
  /** Runs `fn` between begin/commit, rolling back on any throw. */
  transaction<T>(fn: (driver: DbDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let current: ClientDb | null = null;

/**
 * Scrubs the key out of text before it can reach an error message or a log line.
 *
 * A driver is free to echo its open params in an error string; without this, the key
 * would ride out inside `error.message` and into logcat. security-guide §6.4: the key is
 * never logged.
 */
function redactKey(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join('[redacted]') : text;
}

/**
 * Re-wraps a driver failure with the key scrubbed from both message and cause.
 *
 * The native error is NOT attached verbatim: anything holding the key in `.message`
 * leaks the moment someone logs `error.cause`. The redacted copy keeps the diagnostic
 * text; the key is what we refuse to carry.
 */
function sanitizeOpenFailure(error: unknown, key: string): DbOpenError {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactKey(raw, key);
  const cause = new Error(redacted);
  cause.name = error instanceof Error ? error.name : 'Error';
  return new DbOpenError('driver_open_failed', `failed to open the client database: ${redacted}`, {
    cause,
  });
}

/**
 * Opens the one client connection: read key → open keyed → apply pragmas → build Kysely.
 *
 * There is deliberately no unkeyed fallback anywhere in this function. A wrong or missing
 * key fails loudly; it never degrades into opening a plaintext database (SEC-DEV-06).
 */
export async function openClientDb(options: OpenClientDbOptions): Promise<ClientDb> {
  if (current !== null) {
    throw new DbOpenError(
      'already_open',
      'a client database connection is already open — op-sqlite allows exactly one connection per database app-wide (08 §2.2); close it first',
    );
  }

  const encryptionKey = await options.keyStore.getDatabaseEncryptionKey();
  if (encryptionKey === null || encryptionKey === '') {
    // Before any driver call: there is no such thing as "open it unencrypted and see".
    throw new DbOpenError(
      'missing_key',
      'no SQLCipher key available from the key store — refusing to open the client database (security-guide §6.4)',
    );
  }

  let driver: DbDriver;
  try {
    driver = await options.driverFactory({
      name: options.name ?? DEFAULT_DATABASE_NAME,
      location: options.location,
      encryptionKey,
    });
  } catch (error) {
    throw sanitizeOpenFailure(error, encryptionKey);
  }

  try {
    for (const pragma of CLIENT_PRAGMAS) {
      await driver.execute(pragma);
    }
  } catch (error) {
    await driver.close().catch(() => undefined);
    throw sanitizeOpenFailure(error, encryptionKey);
  }

  // CamelCasePlugin is the runtime half of the client codegen contract (10-db §11.4): it
  // maps camelCase identifiers down to the snake_case DDL and maps result keys back up.
  // The server does the same over the same column names, so a module's appliers see ONE
  // set of identifiers on both engines and can be written once against `ProjectionDb`
  // (04 §2). It must stay in lockstep with `--camel-case` in scripts/codegen.ts.
  //
  // Only the Kysely surface is affected. `driver` stays raw: `driver.execute` speaks the
  // verbatim snake_case SQL of 10-db §9, which is what the migration runner needs.
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin(CLIENT_CAMEL_CASE_OPTIONS)],
  });

  const connection: ClientDb = {
    db,
    driver,
    async transaction<T>(fn: (handle: DbDriver) => Promise<T>): Promise<T> {
      await driver.begin();
      try {
        const result = await fn(driver);
        await driver.commit();
        return result;
      } catch (error) {
        try {
          await driver.rollback();
        } catch {
          /* preserve the original error */
        }
        throw toDbError(error);
      }
    },
    async close(): Promise<void> {
      // Kysely first (its dialect close is inert — see dialect/index.ts), then the driver
      // exactly once. The connection owns the handle's lifecycle.
      await db.destroy();
      await driver.close();
      if (current === connection) current = null;
    },
  };

  current = connection;
  return connection;
}

/** The live connection. Throws when nothing is open — callers must not get a null handle. */
export function getClientDb(): ClientDb {
  if (current === null) {
    throw new DbOpenError('not_open', 'no client database connection is open');
  }
  return current;
}

export function isClientDbOpen(): boolean {
  return current !== null;
}

/** Closes the live connection, if any. Safe to call when nothing is open. */
export async function closeClientDb(): Promise<void> {
  await current?.close();
  current = null;
}

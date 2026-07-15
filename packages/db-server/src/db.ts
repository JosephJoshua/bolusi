// The pool + Kysely instance. INTERNAL — never re-exported from src/index.ts (D7, FR-1039):
// exporting this handle would be the escape hatch that forTenant + RLS exist to close.
// `bolusi/boundaries` additionally forbids deep-importing this module from outside the package.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { createCamelCasePlugin } from './camel-case.js';
import type { DB } from './generated/db.js';

let db: Kysely<DB> | undefined;

/**
 * Lazily builds the singleton Kysely instance from `DATABASE_URL`.
 *
 * Lazy on purpose: importing this package (e.g. for its types, or for the migration runner)
 * must not require a database, and must not open sockets as an import side effect.
 *
 * Connects as `bolusi_app` in production (§6.3) — that role is NOSUPERUSER/NOBYPASSRLS, which
 * is what makes the RLS policies undefeatable from a request handler.
 */
export function getDb(): Kysely<DB> {
  if (db === undefined) {
    const connectionString = process.env['DATABASE_URL'];
    if (connectionString === undefined || connectionString === '') {
      throw new Error('DATABASE_URL is not set — @bolusi/db-server cannot open a connection');
    }

    db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
      // TS names are camelCase over the snake_case DDL (10-db-schema §1, codegen --camel-case).
      plugins: [createCamelCasePlugin()],
    });
  }

  return db;
}

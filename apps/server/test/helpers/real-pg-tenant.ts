// A real-PG16-backed `forTenant` whose every statement is captured, so a spy can witness the
// ordering of `select set_config('app.tenant_id', $1, true)` (id bound as a parameter, never
// interpolated) against real Postgres GUC semantics (testing-guide §2.1 L3, D16 task 81).
//
// NOTE (reviewer): this is a thin test double. db-server's real forTenant (the app's PRODUCTION
// default, and the transaction-local set_config guarantee itself) is proven in
// packages/db-server/test/for-tenant.test.ts; this file exists so the APP helper's
// context-derivation + delegation is exercised end-to-end against a real engine. It clones its own
// database from the pre-migrated template via `@bolusi/db-server/testing` — the seam owns `pg`, so
// this file never opens a driver connection itself. (Was PGlite; the file/function were renamed
// from `pglite-*` because a "pglite" harness running real PG16 is the misleading-name class T-15
// exists to catch.)
import { sql } from 'kysely';
import { expect, inject } from 'vitest';

import { type ForTenant } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';

export interface RealPgTenant {
  readonly forTenant: ForTenant;
  readonly statements: string[];
  close(): Promise<void>;
}

export async function makeRealPgForTenant(): Promise<RealPgTenant> {
  const statements: string[] = [];
  const { db, close } = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
    {
      // Record only DATA statements, not transaction framing. The real `pg` PostgresDialect logs
      // `begin`/`commit` through Kysely's query log (PGlite's dialect did not), so without this
      // filter `statements[0]` would be `'begin'`, not the set_config the spy exists to witness.
      // The assertion is about the ORDER of real statements — set_config before any tenant query —
      // and BEGIN/COMMIT are framing, not statements the tenant-scoping contract is about.
      onQuery: (statement) => {
        if (!/^\s*(begin|commit|rollback|start transaction)\b/i.test(statement)) {
          statements.push(statement);
        }
      },
    },
  );

  const forTenant: ForTenant = (tenantId, fn) =>
    db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });

  return { forTenant, statements, close };
}

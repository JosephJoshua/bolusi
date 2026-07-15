// A PGlite-backed `forTenant` for the fast L3 loop (testing-guide §2.1 L3). It runs the SAME
// production statement db-server's forTenant runs — `select set_config('app.tenant_id', $1,
// true)` as the transaction's first statement, id bound as a parameter — so a statement spy can
// witness the ordering against real Postgres (PGlite) GUC semantics.
//
// NOTE (reviewer): this is a thin test double. db-server's real forTenant (the app's PRODUCTION
// default, and the transaction-local set_config guarantee itself) is proven in
// packages/db-server/test/for-tenant.test.ts; this file exists so the APP helper's
// context-derivation + delegation is exercised end-to-end against a real engine without docker.
import { Kysely, PGliteDialect, sql, type LogEvent } from 'kysely';

import type { DB, ForTenant } from '@bolusi/db-server';

export interface PgliteTenant {
  readonly forTenant: ForTenant;
  readonly statements: string[];
  close(): Promise<void>;
}

export async function makePgliteForTenant(): Promise<PgliteTenant> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;

  const statements: string[] = [];
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    log: (event: LogEvent) => {
      statements.push(event.query.sql);
    },
  });

  const forTenant: ForTenant = (tenantId, fn) =>
    db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });

  return { forTenant, statements, close: () => db.destroy() };
}

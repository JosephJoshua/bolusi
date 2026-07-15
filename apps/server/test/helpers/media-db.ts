// A migrated PGlite database + RLS-aware forTenant handles for the media integration suite.
//
// WHY PGLITE-ONLY (and not the db-server test:rls Postgres lane): the `pg` driver is boundary-locked
// to packages/db-server (tooling/eslint boundaries — DB_DRIVER_OWNERS), so apps/server test code
// cannot open a real-Postgres connection. PGlite embeds a real PostgreSQL, so `set_config`,
// `SET LOCAL ROLE`, RLS `FORCE`/policies, and `bytea`/`jsonb` all behave as production. The media
// TABLE's RLS on real PG16 is separately witnessed by db-server SEC-TENANT-01 (the RLS coverage
// sweep enumerates every app table, media included) under `pnpm test:rls`. This helper mirrors
// db-server/test/helpers/test-db.ts's appForTenant/ownerForTenant split so the RLS probes here are
// non-vacuous: seeding uses the owner (bypasses RLS), probing uses `SET LOCAL ROLE bolusi_app`.
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';

import { migrateToLatest, type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';

/** §6.3 request-handler role (NOBYPASSRLS) — what makes RLS undefeatable from a handler. Mirrors
 *  db-server's APP_ROLE constant; separate copy only because deep-importing db-server internals is
 *  boundary-forbidden. */
export const APP_ROLE = 'bolusi_app';

/** The same `{ underscoreBetweenUppercaseLetters: true }` config as db-server's camel-case.ts —
 *  10-db-schema §11.4 is the shared source of truth; a test handle must match production's mapping. */
const CAMEL_CASE_OPTIONS = { underscoreBetweenUppercaseLetters: true } as const;

export interface MediaTestDb {
  /** Owner/superuser handle (PGlite connects as superuser → bypasses RLS). Seeding goes here. */
  readonly db: Kysely<DB>;
  /** Probe path: `forTenant` that runs `SET LOCAL ROLE bolusi_app` first → RLS enforced. The app
   *  under test uses THIS as deps.forTenant. */
  readonly appForTenant: ForTenant;
  /** `forTenant` WITHOUT the role switch — production statement shape, but superuser (RLS bypassed).
   *  The non-vacuous control: it CAN see across tenants where appForTenant cannot. */
  readonly ownerForTenant: ForTenant;
  readonly close: () => Promise<void>;
}

function forTenantOn(db: Kysely<DB>, role?: string): ForTenant {
  return <T>(tenantId: string, fn: (db: TenantDb) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      if (role !== undefined) {
        await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
      }
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

export async function makeMediaTestDb(): Promise<MediaTestDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;

  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ ...CAMEL_CASE_OPTIONS })],
  });
  await migrateToLatest(db);

  return {
    db,
    appForTenant: forTenantOn(db, APP_ROLE),
    ownerForTenant: forTenantOn(db),
    close: () => db.destroy(),
  };
}

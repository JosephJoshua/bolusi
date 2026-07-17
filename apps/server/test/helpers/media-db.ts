// A real PostgreSQL 16 database (cloned per test from the pre-migrated template) + RLS-aware
// forTenant handles for the media integration suite (D16, task 81).
//
// WHY NOT PGlite ANY MORE: the old header claimed `pg` was boundary-locked "so apps/server test
// code cannot open a real-Postgres connection." That was false — apps/server never needed `pg`, it
// needed a `Kysely<DB>` over a real database, and `@bolusi/db-server/testing`'s `createTestDatabase`
// hands it one with the `pg.Pool` owned inside db-server (so `pg` still never crosses the boundary,
// tooling/eslint DB_DRIVER_OWNERS untouched). The media table's `bytea`/`jsonb`/`int8 byteSize` and
// its RLS now run over the SAME driver production uses. This helper mirrors db-server's
// test-db.ts appForTenant/ownerForTenant split so the RLS probes here are non-vacuous: seeding uses
// the owner (the container's `postgres` superuser bypasses RLS — what a fixture needs), probing uses
// `SET LOCAL ROLE bolusi_app` (NOBYPASSRLS — what closes the superuser bypass, T-14b).
import { sql, type Kysely } from 'kysely';
import { expect, inject } from 'vitest';

import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';

/** §6.3 request-handler role (NOBYPASSRLS) — what makes RLS undefeatable from a handler. Mirrors
 *  db-server's APP_ROLE constant; separate copy only because deep-importing db-server internals is
 *  boundary-forbidden. */
export const APP_ROLE = 'bolusi_app';

export interface MediaTestDb {
  /** Owner handle (the container's `postgres` user is a superuser → bypasses RLS). Seeding goes here. */
  readonly db: Kysely<DB>;
  /** Probe path: `forTenant` that runs `SET LOCAL ROLE bolusi_app` first → RLS enforced. The app
   *  under test uses THIS as deps.forTenant. */
  readonly appForTenant: ForTenant;
  /** `forTenant` WITHOUT the role switch — production statement shape, but superuser (RLS bypassed).
   *  The non-vacuous control: it CAN see across tenants where appForTenant cannot. */
  readonly ownerForTenant: ForTenant;
  /** Provenance: which real PostgreSQL database answered (T-14d). */
  readonly provenance: string;
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
  const { db, provenance, close } = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );

  return {
    db,
    appForTenant: forTenantOn(db, APP_ROLE),
    ownerForTenant: forTenantOn(db),
    provenance,
    close,
  };
}

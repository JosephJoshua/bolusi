// The server's boot check on WHO it connects as (10-db-schema §6.3).
//
// RLS is the tenant-isolation guarantee, and a superuser or BYPASSRLS role skips every policy even
// under FORCE ROW LEVEL SECURITY. `getDb` connects as whatever DATABASE_URL names, so a server
// started with the owner/superuser URL would serve every tenant to every request. This refuses
// that before the server listens. Tests and CLIs that deliberately use other roles never call it.
import { sql, type Kysely } from 'kysely';

import { getDb } from './db.js';
import type { DB } from './generated/db.js';

/** Throws unless `db`'s login role is bound by row-level security. Internal: tests pass a handle. */
export async function assertRowSecurityRoleOn(db: Kysely<DB>): Promise<void> {
  const { rows } = await sql<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>`
    SELECT rolname::text AS "role", rolsuper AS "rolsuper", rolbypassrls AS "rolbypassrls"
      FROM pg_roles WHERE rolname = current_user
  `.execute(db);
  const row = rows[0];
  if (row === undefined)
    throw new Error('could not read the database role DATABASE_URL connects as');
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `DATABASE_URL connects as '${row.role}', which ${row.rolsuper ? 'is a superuser' : 'has BYPASSRLS'} ` +
        'and would skip every tenant-isolation policy. Start the server as bolusi_app ' +
        '(locally: DATABASE_URL="$(pnpm -s db:app-url)"); keep the owner URL for migrations and CLIs.',
    );
  }
}

/** Boot check for the server's own pool (`getDb`). */
export function assertRowSecurityRole(): Promise<void> {
  return assertRowSecurityRoleOn(getDb());
}

// The customer's status link (product-scope.md, "Customers follow their repair online"). Mirrors
// client migration 24.
//
// A servisan records the code of the link printed on its slip. The customer's page arrives with
// only that code, before any tenant is known, so it resolves the code through one SECURITY DEFINER
// lookup, as token verification does (0006): the function's fixed body reads one ticket by its code
// and returns where it lives, nothing else, and the app role stays NOBYPASSRLS for everything else.
//
// The index is not UNIQUE: codes are random and made offline on devices, so two tenants could in
// theory draw the same one, and a unique violation would make the server refuse a whole sync batch.
// The lookup instead fails closed when a code names more than one servisan.
import { sql, type Kysely } from 'kysely';

const AUTH_ROLE = 'bolusi_auth';
const APP_ROLE = 'bolusi_app';
const FUNCTION = 'public_find_status_link(text)';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE repair_tickets ADD COLUMN status_code text`.execute(db);
  await sql`
    CREATE INDEX idx_repair_tickets_status_code ON repair_tickets (status_code)
    WHERE status_code IS NOT NULL
  `.execute(db);

  // Only the columns the lookup reads: the definer role never sees a servisan's contents.
  await sql`
    GRANT SELECT (tenant_id, store_id, id, status_code) ON repair_tickets TO ${sql.id(AUTH_ROLE)}
  `.execute(db);
  await sql`
    CREATE FUNCTION public_find_status_link(p_code text)
      RETURNS TABLE (tenant_id uuid, store_id uuid, ticket_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT t.tenant_id, t.store_id, t.id
          FROM repair_tickets t
         WHERE t.status_code = p_code
         LIMIT 2
    $$
  `.execute(db);
  await sql`ALTER FUNCTION ${sql.raw(FUNCTION)} OWNER TO ${sql.id(AUTH_ROLE)}`.execute(db);
  await sql`REVOKE ALL ON FUNCTION ${sql.raw(FUNCTION)} FROM PUBLIC`.execute(db);
  await sql`GRANT EXECUTE ON FUNCTION ${sql.raw(FUNCTION)} TO ${sql.id(APP_ROLE)}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(FUNCTION)}`.execute(db);
  await sql`
    REVOKE SELECT (tenant_id, store_id, id, status_code) ON repair_tickets FROM ${sql.id(AUTH_ROLE)}
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_repair_tickets_status_code`.execute(db);
  await sql`ALTER TABLE repair_tickets DROP COLUMN IF EXISTS status_code`.execute(db);
}

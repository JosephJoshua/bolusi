// Integrated QRIS (0026): a counter can cancel a QR it showed, and the server checks unpaid QRs
// with Xendit on its own (qris/service.ts). Server only, no client mirror.
//
// Cancelling: Xendit cannot withdraw a dynamic QR, so a cancelled QR stays payable until its time
// runs out. `cancelled_at` only says the counter gave up on it, so it may take the bill another
// way. A payment that still comes is recorded like any other and shows as money to give back.
//
// One open QR per bill: `document_id` (copied out of `document_json`) finds a bill's open QRs.
//
// The sweep: a payment must be recorded even when Xendit's webhook never arrives and no device is
// asking any more. Which tenants have unpaid QRs cannot be asked through forTenant, so one SECURITY
// DEFINER lookup (as 0006 and 0028) lists them. It reads ids and times only, never a key, an amount
// or a document. Merge after 0037: the migrator refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

const AUTH_ROLE = 'bolusi_auth';
const APP_ROLE = 'bolusi_app';
const FUNCTION = 'qris_find_unpaid_charges(bigint, bigint)';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE qris_charges
      ADD COLUMN cancelled_at bigint,
      ADD COLUMN cancelled_by uuid,
      ADD COLUMN document_id uuid
  `.execute(db);
  await sql`UPDATE qris_charges SET document_id = (document_json::json->>'id')::uuid`.execute(db);
  await sql`ALTER TABLE qris_charges ALTER COLUMN document_id SET NOT NULL`.execute(db);
  await sql`
    CREATE INDEX idx_qris_charges_unpaid_document ON qris_charges (document_id)
    WHERE paid_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX idx_qris_charges_unpaid ON qris_charges (expires_at) WHERE paid_at IS NULL
  `.execute(db);

  await sql`
    GRANT SELECT (tenant_id, id, expires_at, paid_at, checked_at) ON qris_charges TO ${sql.id(AUTH_ROLE)}
  `.execute(db);
  await sql`
    CREATE FUNCTION qris_find_unpaid_charges(p_expires_after bigint, p_settle_ms bigint)
      RETURNS TABLE (tenant_id uuid, charge_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT c.tenant_id, c.id
          FROM qris_charges c
         WHERE c.paid_at IS NULL
           AND c.expires_at > p_expires_after
           -- Settled: looked at after its last second and not paid; a callback still records it.
           AND (c.checked_at IS NULL OR c.checked_at < c.expires_at + p_settle_ms)
         -- The longest unchecked first, so a busy minute never starves the rest.
         ORDER BY c.checked_at NULLS FIRST
         LIMIT 500
    $$
  `.execute(db);
  await sql`ALTER FUNCTION ${sql.raw(FUNCTION)} OWNER TO ${sql.id(AUTH_ROLE)}`.execute(db);
  await sql`REVOKE ALL ON FUNCTION ${sql.raw(FUNCTION)} FROM PUBLIC`.execute(db);
  await sql`GRANT EXECUTE ON FUNCTION ${sql.raw(FUNCTION)} TO ${sql.id(APP_ROLE)}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(FUNCTION)}`.execute(db);
  await sql`
    REVOKE SELECT (tenant_id, id, expires_at, paid_at, checked_at) ON qris_charges FROM ${sql.id(AUTH_ROLE)}
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_qris_charges_unpaid`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_qris_charges_unpaid_document`.execute(db);
  await sql`
    ALTER TABLE qris_charges
      DROP COLUMN IF EXISTS document_id,
      DROP COLUMN IF EXISTS cancelled_by,
      DROP COLUMN IF EXISTS cancelled_at
  `.execute(db);
}

// Refused operations: pushed ops the server verified as genuinely signed and in chain order, then
// refused (no permission, wrong scope, invalid payload, unknown type).
//
// A refused op still takes its place in the device's hash chain: the server advances the device's
// chain head past it, so the device's later ops, which link to it, keep syncing. Without this one
// refusal stalled the device forever, because every later op arrived after a missing position.
//
// The row also makes a re-push answer the same: a retried batch whose response was lost would
// otherwise see the refused op as new, behind the advanced head, and read it as tampering. It keeps
// what the refusal was about (who, which op type, which entity, why) for the audit trail, not the
// payload: the op is not part of the business history.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE refused_operations (
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      id          uuid NOT NULL,
      device_id   uuid NOT NULL REFERENCES devices(id),
      seq         bigint NOT NULL CHECK (seq >= 1),
      hash        char(64) NOT NULL,
      user_id     uuid NOT NULL,
      type        text NOT NULL,
      entity_type text NOT NULL,
      entity_id   uuid NOT NULL,
      code        text NOT NULL,
      reason      text NOT NULL,
      received_at bigint NOT NULL,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (device_id, seq)
    )
  `.execute(db);
  // Append-only like the log it sits beside: a refusal is a fact about what a device sent.
  await sql`
    CREATE TRIGGER refused_operations_no_update BEFORE UPDATE ON refused_operations
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER refused_operations_no_delete BEFORE DELETE ON refused_operations
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation()
  `.execute(db);
  await secureTenantTable(db, 'refused_operations', { grant: 'read-append' });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE refused_operations`.execute(db);
}

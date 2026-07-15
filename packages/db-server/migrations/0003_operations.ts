// 10-db-schema §5 — the operation log. DDL verbatim from the doc.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE operations (
      -- signed core (05-operation-log §2.1); NEVER updated
      id                    uuid PRIMARY KEY,
      tenant_id             uuid NOT NULL REFERENCES tenants(id),
      store_id              uuid REFERENCES stores(id),
      user_id               uuid NOT NULL,          -- no FK: validated in code at push against the
                                                    -- users directory (05 §9); the append-only log
                                                    -- must not couple to directory row lifecycle
      device_id             uuid NOT NULL REFERENCES devices(id),
      seq                   bigint NOT NULL CHECK (seq >= 1),
      type                  text NOT NULL,
      entity_type           text NOT NULL,
      entity_id             uuid NOT NULL,
      schema_version        integer NOT NULL CHECK (schema_version >= 1),
      payload               jsonb NOT NULL,
      timestamp_ms          bigint NOT NULL,
      location              jsonb,                  -- {lat,lng,accuracyMeters} | NULL
      source                text NOT NULL CHECK (source IN ('ui','agent','api','system')),
      agent_initiated       boolean NOT NULL DEFAULT false,
      agent_conversation_id text,
      previous_hash         char(64) NOT NULL,
      -- derived, immutable (05 §2.2)
      hash                  char(64) NOT NULL,
      signature             text NOT NULL,          -- base64 Ed25519 over the raw 32-byte hash
      -- wire truth (this doc §2.1)
      signed_core_jcs       text NOT NULL,          -- verbatim RFC 8785 bytes of the signed core
      -- server bookkeeping (05 §2.4); set once at acceptance, then immutable
      server_seq            bigint NOT NULL,
      received_at           bigint NOT NULL,
      clock_skew_flagged    boolean NOT NULL DEFAULT false,

      UNIQUE (tenant_id, server_seq),               -- pull-cursor integrity + pull index
      UNIQUE (device_id, seq)                       -- chain integrity + chain-validation index
    )
  `.execute(db);

  // Per-entity canonical re-fold (04-module-contract §4.2) and rebuild:
  await sql`
    CREATE INDEX idx_operations_entity_canonical
      ON operations (tenant_id, entity_type, entity_id, timestamp_ms, device_id, seq)
  `.execute(db);

  // ============ append-only enforcement (05-operation-log §1) ============
  await sql`
    CREATE FUNCTION forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'operations are append-only (05-operation-log §1)';
    END $$
  `.execute(db);

  await sql`
    CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation()
  `.execute(db);

  await sql`ALTER FUNCTION forbid_mutation() OWNER TO bolusi_provision`.execute(db);

  // Belt: the app role is additionally GRANTed only SELECT, INSERT on operations (§6.3).
  // The trigger is the braces — it survives a future role misconfiguration (security-guide §3.1).
  await secureTenantTable(db, 'operations', { grant: 'read-append' });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE operations`.execute(db); // triggers drop with the table
  await sql`DROP FUNCTION forbid_mutation()`.execute(db);
}

// 10-db-schema §4 — platform & directory tables. DDL copied verbatim from the doc (§11.1:
// "Raw SQL from this doc goes through `sql` template literals verbatim").
import { sql, type Kysely } from 'kysely';

import { grantToApp, ownTable, secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============ tenants (directory; platform plane) ============
  await sql`
    CREATE TABLE tenants (
      id              uuid PRIMARY KEY,
      name            text NOT NULL,
      -- NO status column in v0: tenant suspension is deferred (03-state-machines §13;
      -- roadmap). Tenants are implicitly active; adding the column (and its CHECK)
      -- later is a migration.
      active_modules  jsonb NOT NULL DEFAULT '[]',
      configuration   jsonb NOT NULL DEFAULT '{}',
      created_at      bigint NOT NULL
    )
  `.execute(db);
  // §6.2: tenants itself — the app may see only its own row (predicate on `id`, not tenant_id).
  await secureTenantTable(db, 'tenants', { column: 'id', policy: 'tenant_self' });

  await sql`
    CREATE TABLE tenant_op_counters (
      tenant_id       uuid PRIMARY KEY REFERENCES tenants(id),
      next_server_seq bigint NOT NULL DEFAULT 1
    )
  `.execute(db);
  await secureTenantTable(db, 'tenant_op_counters');

  // ============ stores (directory) ============
  await sql`
    CREATE TABLE stores (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      name       text NOT NULL,
      created_at bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_stores_tenant ON stores (tenant_id)`.execute(db);
  await secureTenantTable(db, 'stores');

  // ============ devices (directory; validated BEFORE ops exist) ============
  await sql`
    CREATE TABLE devices (
      id                 uuid PRIMARY KEY,
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      store_id           uuid REFERENCES stores(id),      -- NULL only for kind='system'
      kind               text NOT NULL DEFAULT 'member'
                           CHECK (kind IN ('member', 'system')),  -- matches the DeviceInfo wire enum (api/01-sync §4)
      name               text,
      signing_key_public text NOT NULL,                   -- base64 raw 32-byte Ed25519
      token_hash         text,                            -- device bearer token digest; format owned by api/02-auth
      enrolled_at        bigint NOT NULL,
      enrolled_by        uuid,                            -- user id; NULL for system device
      last_sync_at       bigint,
      last_pull_cursor   bigint NOT NULL DEFAULT 0,       -- conflict detection + skew window
      last_seq           bigint NOT NULL DEFAULT 0,       -- chain head cache (derived from operations; rebuildable)
      last_hash          char(64),                        -- chain head cache
      status             text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'revoked')),
      revoked_at         bigint,
      revoked_by         uuid,
      CHECK (kind = 'system' OR store_id IS NOT NULL),
      CHECK (status = 'active' OR revoked_at IS NOT NULL)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_devices_tenant ON devices (tenant_id)`.execute(db);
  await secureTenantTable(db, 'devices');

  // ============ system-device chain state (§3: server-built conflict ops) ============
  await sql`
    CREATE TABLE system_device_chain_state (
      tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
      device_id uuid NOT NULL REFERENCES devices(id), -- the tenant's system device (devices.kind='system')
      last_seq  bigint NOT NULL DEFAULT 0,
      last_hash char(64)                              -- NULL until the first system op; genesis
                                                      -- previousHash rule per 05-operation-log §2.2
    )
  `.execute(db);
  await secureTenantTable(db, 'system_device_chain_state');

  // ============ permissions (global registry mirror; code-defined, deploy-seeded) ============
  await sql`
    CREATE TABLE permissions (
      id           text PRIMARY KEY,        -- 'notes.create' — <module>.<action> (02-permissions §2)
      module       text NOT NULL,
      action       text NOT NULL,
      scope        text NOT NULL CHECK (scope IN ('tenant', 'store')),  -- bound to the permission (02-permissions §3.1)
      description  text NOT NULL,           -- canonical EN string; label keys are DERIVED:
                                            -- permission.<module>.<action>.name/.description (07-i18n)
      is_dangerous boolean NOT NULL DEFAULT false
    )
  `.execute(db);
  // No tenant_id, no RLS: global read-only reference data. App role gets SELECT only;
  // rows are upserted at deploy from the module manifests (02-permissions §3.1, §11).
  // This is the ONLY table exempt from the SEC-TENANT-01 sweep's RLS requirement.
  await ownTable(db, 'permissions');
  await grantToApp(db, 'permissions', 'read-only');

  // ============ device_anomalies (tamper alarm; FR-829) ============
  await sql`
    CREATE TABLE device_anomalies (
      id        uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      device_id uuid NOT NULL REFERENCES devices(id),
      kind      text NOT NULL CHECK (kind IN ('BAD_SIGNATURE','CHAIN_BROKEN','SCOPE_VIOLATION','CLOCK_SKEW')),
      at        bigint NOT NULL,
      detail    jsonb                       -- op id + rejection context; NEVER the rejected op itself
    )
  `.execute(db);
  await sql`CREATE INDEX idx_device_anomalies_device ON device_anomalies (device_id, at)`.execute(
    db,
  );
  await secureTenantTable(db, 'device_anomalies');

  // ============ idempotency_keys (api/00-conventions §8.2) ============
  await sql`
    CREATE TABLE idempotency_keys (
      key             text NOT NULL,
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      endpoint        text NOT NULL,
      request_hash    char(64) NOT NULL,    -- sha256 of the request body; reuse with a
                                            -- different hash → 409 IDEMPOTENCY_CONFLICT
      response_status integer NOT NULL,
      response_body   jsonb NOT NULL,       -- replayed verbatim on key reuse with same body
      created_at      bigint NOT NULL,      -- rows older than 24h are purged (api/00 §8.2)
      PRIMARY KEY (tenant_id, key)
    )
  `.execute(db);
  await secureTenantTable(db, 'idempotency_keys');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse dependency order. Policies and indexes drop with their table.
  for (const table of [
    'idempotency_keys',
    'device_anomalies',
    'permissions',
    'system_device_chain_state',
    'devices',
    'stores',
    'tenant_op_counters',
    'tenants',
  ]) {
    await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  }
}

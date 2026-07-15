// 10-db-schema §8 — media, push, platform & module projections. DDL verbatim from the doc.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============ media (row created at init — api/03-media §3.1) ============
  await sql`
    CREATE TABLE media (
      id                    uuid PRIMARY KEY,
      tenant_id             uuid NOT NULL REFERENCES tenants(id),
      store_id              uuid REFERENCES stores(id),  -- NULL for store-less devices (api/03-media §2)
      captured_by_user_id   uuid NOT NULL,
      device_id             uuid NOT NULL REFERENCES devices(id),
      type                  text NOT NULL CHECK (type IN ('image', 'video', 'signature')),
      mime_type             text NOT NULL,
      byte_size             bigint NOT NULL CHECK (byte_size > 0),
      sha256                char(64) NOT NULL,       -- whole-file hash; verified at complete
                                                     -- (api/03-media §3.4); immutability anchor (I-6)
      captured_at           bigint NOT NULL,
      location              jsonb,
      chunk_size            integer NOT NULL CHECK (chunk_size > 0),    -- server-dictated at init
      chunks_total          integer NOT NULL CHECK (chunks_total > 0),
      storage_key           text,                    -- assembled object; NULL until status = 'complete'
      status                text NOT NULL DEFAULT 'receiving'
                              CHECK (status IN ('receiving', 'complete')),
                              -- SERVER wire states (api/03-media). The client upload machine
                              -- pending/uploading/uploaded/failed is NOT this enum and lives
                              -- ONLY client-side (§9.4; 03-state-machines §4).
      attached_operation_id uuid,                    -- backlink; set when a referencing op is accepted (06-media-pipeline)
      completed_at          bigint,
      created_at            bigint NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX idx_media_tenant_status ON media (tenant_id, status)
      WHERE status <> 'complete'
  `.execute(db);
  await secureTenantTable(db, 'media');

  // In-flight chunk storage; GET /v1/media/:id/status reads this — resume is
  // SERVER-authoritative (api/03-media §3.3; 06-media-pipeline §4)
  await sql`
    CREATE TABLE media_chunks (
      media_id    uuid NOT NULL REFERENCES media(id),
      chunk_index integer NOT NULL CHECK (chunk_index >= 0),
      tenant_id   uuid NOT NULL,
      byte_size   integer NOT NULL CHECK (byte_size > 0),
      bytes       bytea NOT NULL,                    -- chunk body (api/03-media §6); rows deleted
                                                     -- after assembly at complete
      received_at bigint NOT NULL,
      PRIMARY KEY (media_id, chunk_index)
    )
  `.execute(db);
  // NO per-chunk sha256: per-chunk hashes are deliberately not part of the protocol
  // (api/03-media §5). Integrity = exact chunk size per PUT + whole-file sha256 at
  // complete (plus the jpeg/png magic-byte check at finalize, api/03-media §3.4).
  await secureTenantTable(db, 'media_chunks');

  // ============ push_tokens (registered via POST /v1/push/tokens — api/04-push) ============
  await sql`
    CREATE TABLE push_tokens (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      device_id       uuid NOT NULL REFERENCES devices(id),
      user_id         uuid,                          -- user who last registered/refreshed on this device;
                                                     -- NULL before first PIN login (api/04-push §2) —
                                                     -- such devices get no 'device'-category pushes
      expo_push_token text NOT NULL UNIQUE,          -- from getExpoPushTokenAsync (expo-notifications, FCM v1)
      platform        text NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
      updated_at      bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX idx_push_tokens_device ON push_tokens (device_id)`.execute(db);
  // One token per device install; pushes address DEVICES (shared-device reality).
  await secureTenantTable(db, 'push_tokens');

  // ============ conflicts (projection of platform.conflict_* ops) ============
  await sql`
    CREATE TABLE conflicts (
      id                    uuid PRIMARY KEY,
      tenant_id             uuid NOT NULL REFERENCES tenants(id),
      store_id              uuid REFERENCES stores(id),
      entity_type           text NOT NULL,
      entity_id             uuid NOT NULL,
      conflict_key          text NOT NULL,
      severity              text NOT NULL CHECK (severity IN ('minor', 'significant')),
      status                text NOT NULL
                              CHECK (status IN ('detected','auto_resolved','surfaced','acknowledged')),
                              -- 'detected' is transient, never at rest (01-domain-model §5.4)
      op_a_id               uuid NOT NULL,
      op_b_id               uuid NOT NULL,
      detected_at           bigint NOT NULL,
      acknowledged_by       uuid,
      acknowledged_at       bigint,
      acknowledgement_op_id uuid,
      UNIQUE (op_a_id, op_b_id)                      -- dedupe per op pair (§8.2 rule 1)
    )
  `.execute(db);
  await sql`
    CREATE INDEX idx_conflicts_surfaced ON conflicts (tenant_id, store_id)
      WHERE status = 'surfaced'
  `.execute(db);
  await secureTenantTable(db, 'conflicts');

  // ============ auth_sessions (projection of auth.user_switched / auth.session_ended — api/02-auth §6.2) ============
  // user_switched inserts; session_ended sets ended_at/end_reason on its own entityId.
  // The PRD-011 §5 UserSession record.
  await sql`
    CREATE TABLE auth_sessions (
      id         uuid PRIMARY KEY,                   -- = the session's entityId
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      store_id   uuid REFERENCES stores(id),
      user_id    uuid NOT NULL,
      device_id  uuid NOT NULL,
      started_at bigint NOT NULL,
      ended_at   bigint,                             -- NULL while the session is open
      end_reason text                                -- 'switch' | 'idle_lock' | 'manual_lock'
    )
  `.execute(db);
  await secureTenantTable(db, 'auth_sessions');

  // ============ pin_lockout_events (projection of auth.pin_locked_out / auth.pin_lockout_cleared — api/02-auth §6.2) ============
  // Append-only audit rows — owner-visible brute-force evidence.
  await sql`
    CREATE TABLE pin_lockout_events (
      id            uuid PRIMARY KEY,                -- = op id
      tenant_id     uuid NOT NULL REFERENCES tenants(id),
      store_id      uuid REFERENCES stores(id),
      user_id       uuid NOT NULL,                   -- targeted user (op entityId)
      device_id     uuid NOT NULL,                   -- from the envelope
      kind          text NOT NULL CHECK (kind IN ('pin_locked_out', 'pin_lockout_cleared')),
      failure_count integer,                         -- consecutiveFailures; NULL for cleared events
      at            bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'pin_lockout_events');

  // ============ auth_permission_denials (projection of auth.permission_denied — 02-permissions §7) ============
  await sql`
    CREATE TABLE auth_permission_denials (
      id                 uuid PRIMARY KEY,            -- = op id
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      store_id           uuid REFERENCES stores(id),  -- the envelope's device store
      scope_store_id     uuid REFERENCES stores(id),  -- evaluation scope from the payload;
                                                      -- NULL = tenant-scope check (02-permissions §7)
      user_id            uuid NOT NULL,
      device_id          uuid NOT NULL,
      timestamp_ms       bigint NOT NULL,
      permission_id      text NOT NULL,
      surface            text NOT NULL,
      target             text,
      reason             text NOT NULL,
      suppressed_repeats integer NOT NULL DEFAULT 0
    )
  `.execute(db);
  await sql`
    CREATE INDEX idx_auth_permission_denials_tenant
      ON auth_permission_denials (tenant_id, timestamp_ms)
  `.execute(db); // listPermissionDenials (auth.audit_view)
  await secureTenantTable(db, 'auth_permission_denials');

  // ============ user_prefs (projection of platform.user_locale_changed — 07-i18n §1.1) ============
  await sql`
    CREATE TABLE user_prefs (
      user_id    uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      locale     text NOT NULL DEFAULT 'id-ID',
      updated_at bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'user_prefs');

  // ============ notes (reference-module projection) ============
  await sql`
    CREATE TABLE notes (
      id             uuid PRIMARY KEY,
      tenant_id      uuid NOT NULL REFERENCES tenants(id),
      store_id       uuid NOT NULL REFERENCES stores(id),
      title          text NOT NULL,
      body           text NOT NULL,
      media_id       uuid,                           -- schemaVersion 2 payloads (01-domain-model §9)
      archived       boolean NOT NULL DEFAULT false,
      edit_count     integer NOT NULL DEFAULT 0,     -- +1 per notes.note_body_edited fold; testability
                                                     -- column (01-domain-model §9; testing-guide §3.2)
      created_by     uuid NOT NULL,
      created_at     bigint NOT NULL,
      last_edited_by uuid NOT NULL,
      last_edited_at bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_notes_store_created ON notes (tenant_id, store_id, created_at)`.execute(
    db,
  ); // listNotes cursor
  await secureTenantTable(db, 'notes');

  // ============ projection watermarks (04-module-contract §4.3) ============
  await sql`
    CREATE TABLE projection_watermarks (
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      module_id          text NOT NULL,
      applied_server_seq bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, module_id)
    )
  `.execute(db);
  // Server-side: rebuild bookkeeping ONLY — the server applies projections
  // synchronously inside the push transaction (§3; 04-module-contract §4.3).
  await secureTenantTable(db, 'projection_watermarks');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'projection_watermarks',
    'notes',
    'user_prefs',
    'auth_permission_denials',
    'pin_lockout_events',
    'auth_sessions',
    'conflicts',
    'push_tokens',
    'media_chunks',
    'media',
  ]) {
    await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  }
}

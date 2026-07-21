// Client schema, migration 1 — DDL transcribed VERBATIM from 10-db-schema.md §9.1–§9.6.
// The spec doc is the source of truth (10-db §11.1: a schema change is a spec change,
// edited there first). Do not "tidy" a statement here: the CHECK constraints and partial
// indexes are load-bearing, and the committed codegen types (src/generated) are derived
// from exactly these statements.
import type { ClientMigration } from './types.js';

// §9.1 Infrastructure
const INFRASTRUCTURE = [
  `CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`,
  `CREATE TABLE meta_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE projection_watermarks (
  module_id          TEXT PRIMARY KEY,
  applied_server_seq INTEGER NOT NULL DEFAULT 0,
  applied_local_seq  INTEGER NOT NULL DEFAULT 0
)`,
];

// §9.2 Operation log. Append-only by construction: this package exports no UPDATE/DELETE
// for `operations` (the single bookkeeping mutator is task 06's, per 05 §1).
const OPERATION_LOG = [
  `CREATE TABLE operations (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  store_id              TEXT,
  user_id               TEXT NOT NULL,
  device_id             TEXT NOT NULL,
  seq                   INTEGER NOT NULL CHECK (seq >= 1),
  type                  TEXT NOT NULL,
  entity_type           TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  schema_version        INTEGER NOT NULL CHECK (schema_version >= 1),
  payload               TEXT NOT NULL,
  timestamp_ms          INTEGER NOT NULL,
  location              TEXT,
  source                TEXT NOT NULL CHECK (source IN ('ui','agent','api','system')),
  agent_initiated       INTEGER NOT NULL DEFAULT 0,
  agent_conversation_id TEXT,
  previous_hash         TEXT NOT NULL,
  hash                  TEXT NOT NULL,
  signature             TEXT NOT NULL,
  signed_core_jcs       TEXT NOT NULL,
  sync_status           TEXT NOT NULL DEFAULT 'local'
                          CHECK (sync_status IN ('local','synced','rejected')),
  synced_at             INTEGER,
  server_seq            INTEGER,
  rejection_code        TEXT,
  rejection_reason      TEXT
)`,
  `CREATE UNIQUE INDEX idx_operations_device_seq ON operations (device_id, seq)`,
  `CREATE INDEX idx_operations_entity_canonical
  ON operations (entity_type, entity_id, timestamp_ms, device_id, seq)`,
  `CREATE INDEX idx_operations_push_queue ON operations (seq)
  WHERE sync_status = 'local'`,
  `CREATE INDEX idx_operations_rejected ON operations (id)
  WHERE sync_status = 'rejected'`,
];

// §9.3 Sync state (singleton). The `id = 1` CHECK plus the seed row are the mechanism:
// there is exactly one row, forever.
const SYNC_STATE = [
  `CREATE TABLE sync_state (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  pull_cursor                  INTEGER NOT NULL DEFAULT 0,
  devices_directory_version    INTEGER NOT NULL DEFAULT 0,
  last_successful_sync_at      INTEGER,
  last_push_at                 INTEGER,
  last_pull_at                 INTEGER,
  last_server_time             INTEGER,
  last_server_time_received_at INTEGER,
  last_sync_error              TEXT,
  backoff_until                INTEGER,
  push_halted                  INTEGER NOT NULL DEFAULT 0,
  sync_disabled                INTEGER NOT NULL DEFAULT 0,
  sync_disabled_reason         TEXT
)`,
  `INSERT INTO sync_state (id) VALUES (1)`,
];

// §9.4 Media queue. No `pruned` column by design — "pruned" is derived
// (local_path IS NULL AND upload_status = 'uploaded'; 06-media-pipeline §7).
const MEDIA_QUEUE = [
  `CREATE TABLE media_items (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  store_id                  TEXT,
  captured_by_user_id       TEXT NOT NULL,
  device_id                 TEXT NOT NULL,
  type                      TEXT NOT NULL CHECK (type IN ('image','video','signature')),
  mime_type                 TEXT NOT NULL,
  byte_size                 INTEGER NOT NULL,
  sha256                    TEXT NOT NULL,
  captured_at               INTEGER NOT NULL,
  location                  TEXT,
  local_path                TEXT,
  attached_to_operation_id  TEXT,
  upload_status             TEXT NOT NULL DEFAULT 'pending'
                              CHECK (upload_status IN ('pending','uploading','uploaded','failed')),
  chunk_size                INTEGER,
  chunks_total              INTEGER,
  upload_attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at           INTEGER,
  last_error_code           TEXT,
  last_error_message        TEXT,
  uploaded_at               INTEGER
)`,
  `CREATE INDEX idx_media_items_queue ON media_items (upload_status)
  WHERE upload_status <> 'uploaded'`,
];

// §9.5 Directory mirrors + device registry + PIN attempt state + quarantine.
// Written ONLY from the enrollment bundle / bundle refreshes, never from ops. The device
// DB is single-tenant (tenantId lives in meta_kv), so the mirrors carry no tenant_id.
const DIRECTORY_MIRRORS = [
  `CREATE TABLE users_directory (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  photo_media_id TEXT,
  status         TEXT NOT NULL CHECK (status IN ('active','deactivated'))
)`,
  `CREATE TABLE roles_directory (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  scope_type        TEXT NOT NULL CHECK (scope_type IN ('tenant','store')),
  is_system_default INTEGER NOT NULL DEFAULT 0,
  permission_ids    TEXT NOT NULL
)`,
  `CREATE TABLE user_roles_directory (
  user_id  TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  store_id TEXT,
  UNIQUE (user_id, role_id, store_id)
)`,
  `CREATE TABLE user_pin_verifiers (
  user_id         TEXT PRIMARY KEY,
  algo            TEXT NOT NULL CHECK (algo = 'argon2id'),
  salt            TEXT NOT NULL,
  params          TEXT NOT NULL,
  hash            TEXT NOT NULL,
  as_of_timestamp INTEGER NOT NULL,
  as_of_device_id TEXT NOT NULL,
  as_of_seq       INTEGER NOT NULL
)`,
  `CREATE TABLE device_registry (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('member','system')),
  signing_key_public TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','revoked')),
  revoked_at         INTEGER
)`,
  `CREATE TABLE pin_attempt_state (
  user_id              TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  window_started_at    INTEGER,
  not_before           INTEGER,
  PRIMARY KEY (user_id, device_id)
)`,
  `CREATE TABLE quarantined_ops (
  id              TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL,
  server_seq      INTEGER NOT NULL,
  signed_core_jcs TEXT NOT NULL,
  hash            TEXT NOT NULL,
  signature       TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('bad_signature','unknown_pubkey')),
  quarantined_at  INTEGER NOT NULL
)`,
];

// §9.6 Module projections (notes) + conflicts + platform/auth projections.
const PROJECTIONS = [
  `CREATE TABLE conflicts (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  store_id              TEXT,
  entity_type           TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  conflict_key          TEXT NOT NULL,
  severity              TEXT NOT NULL CHECK (severity IN ('minor','significant')),
  status                TEXT NOT NULL
                          CHECK (status IN ('detected','auto_resolved','surfaced','acknowledged')),
  op_a_id               TEXT NOT NULL,
  op_b_id               TEXT NOT NULL,
  detected_at           INTEGER NOT NULL,
  acknowledged_by       TEXT,
  acknowledged_at       INTEGER,
  acknowledgement_op_id TEXT
)`,
  `CREATE INDEX idx_conflicts_surfaced ON conflicts (status) WHERE status = 'surfaced'`,
  `CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  media_id       TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  edit_count     INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_edited_by TEXT NOT NULL,
  last_edited_at INTEGER NOT NULL
)`,
  `CREATE INDEX idx_notes_created ON notes (created_at)`,
  `CREATE TABLE auth_sessions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  store_id   TEXT,
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  end_reason TEXT
)`,
  `CREATE TABLE pin_lockout_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  store_id      TEXT,
  user_id       TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('pin_locked_out', 'pin_lockout_cleared')),
  failure_count INTEGER,
  at            INTEGER NOT NULL
)`,
  `CREATE TABLE auth_permission_denials (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  store_id           TEXT,
  scope_store_id     TEXT,
  user_id            TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  timestamp_ms       INTEGER NOT NULL,
  permission_id      TEXT NOT NULL,
  surface            TEXT NOT NULL,
  target             TEXT,
  reason             TEXT NOT NULL,
  suppressed_repeats INTEGER NOT NULL DEFAULT 0
)`,
  // locale holds a Locale ('id' | 'en'), the z.enum(['id','en']) payload the platform applier writes
  // verbatim — NOT an Intl tag. No column default (task 76): the applier always supplies locale, and
  // the read-side "default id when the row is absent" fallback belongs to the reader (resolveLocale),
  // which a column default cannot express. Edited in place — SQLite has no ALTER COLUMN DROP DEFAULT
  // and this is the initial schema (pre-v0, no deployed client DB).
  `CREATE TABLE user_prefs (
  user_id    TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  locale     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
];

export const initialSchemaMigration: ClientMigration = {
  version: 1,
  name: 'initial_schema',
  statements: [
    ...INFRASTRUCTURE,
    ...OPERATION_LOG,
    ...SYNC_STATE,
    ...MEDIA_QUEUE,
    ...DIRECTORY_MIRRORS,
    ...PROJECTIONS,
  ],
};

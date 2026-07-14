# 10 — DB Schema (v0) — THE DDL

> **Owns:** the physical schema, both sides — Postgres server DDL (tables, indexes, RLS policies, append-only enforcement, the per-tenant `serverSeq` mechanism) and the client SQLite DDL (op-sqlite). Types are generated FROM this DDL via migrations + kysely-codegen; hand-written table types are forbidden. Entity semantics live in `01-domain-model.md`; the envelope in `05-operation-log.md`; the sync protocol in `api/01-sync.md`; identity mutation/distribution semantics in `api/02-auth.md` (the tables in §7 are control-plane directory data, not projections).
> **Change control:** change this doc first, then write the migration, then regenerate types, then the code.

## 1. Toolchain (pinned)

| Concern | Pin |
| ------- | --- |
| Server DB | PostgreSQL **16+** (required: `UNIQUE NULLS NOT DISTINCT`) |
| Query builder | `kysely` **0.29.3 EXACT** (no caret — 0.x minors break; `Migrator`/`FileMigrationProvider` import from `'kysely/migration'`), `pg` + built-in `PostgresDialect`, Node 22 LTS (kysely engines `>=22`) |
| Migrations | `kysely-ctl` **0.21.0**; TS migrations in `packages/db-server/migrations`, ordered `NNNN_name.ts`, each exporting `up`/`down`. Raw SQL from this doc goes through `sql` template literals verbatim. |
| Server types | `kysely-codegen` **0.20.0** with `--camel-case` against the migrated dev DB; output committed to `packages/db-server/src/generated/db.d.ts`. Runtime uses `CamelCasePlugin` so TS names are camelCase over the snake_case DDL below. CI re-runs codegen and fails on diff. |
| Client DB | `@op-engineering/op-sqlite` **17.1.2**, package.json flags `{"op-sqlite": {"sqlcipher": true, "performanceMode": true}}`, EAS dev builds (never Expo Go). **Single connection app-wide** (op-sqlite hard rule). All access behind a thin wrapper in `packages/db-client` (`@bolusi/db-client`) so expo-sqlite remains a swap target. |
| Client Kysely dialect | custom shim over `kysely-generic-sqlite` **2.0.0** (no official op-sqlite dialect exists) wrapping the single shared connection. |
| Client types | same kysely-codegen 0.20.0, run in CI against a scratch SQLite file built by applying the client migrations via `better-sqlite3` (dev-only dep); output committed to `packages/db-client/src/generated/db.d.ts`. |
| Client migrations | embedded, ordered, run inside one exclusive transaction at DB open, tracked in `migrations` table (client §9.1). Projection-table changes additionally bump the module's projection version → triggers rebuild (04-module-contract §4.3). |

## 2. Conventions (both sides)

- Ids: UUIDv7, **lowercase canonical text**. Postgres `uuid` column type; SQLite `TEXT`. Postgres `uuid` comparison is bytewise, which equals lexicographic order of lowercase hex text — so `deviceId ASC` in the canonical order (05-operation-log §4) sorts identically on both engines. Zod enforces lowercase on every id at the boundary.
- Timestamps: ms-epoch integers. Postgres `bigint`, SQLite `INTEGER`. Never `timestamptz`, never ISO strings. Column suffix `_at`; the envelope's `timestamp` field maps to column `timestamp_ms` (`timestamp` is a Postgres type name — avoided).
- Money: integer IDR. No `real`, `double precision`, `float`, or `numeric`-with-scale columns anywhere, ever. (v0 has no money columns; the rule binds all future migrations.) The only floats in the system are inside the envelope's `location` JSON (lat/lng/accuracyMeters per 05-operation-log §2.1) — they are never stored as SQL float columns.
- Naming: snake_case tables/columns, singular-noun-free plural table names, `<table>_pkey`/`idx_<table>_<cols>` index names.
- JSON: Postgres `jsonb`, SQLite `TEXT` holding JSON.
- Booleans: Postgres `boolean`; SQLite `INTEGER` 0/1.
- Enum-ish columns: `text` + `CHECK`, using the exact state names from 03-state-machines. No Postgres `CREATE TYPE` enums (migration pain, no SQLite analogue).

### 2.1 The `signed_core_jcs` column (why it exists — read before touching ops)

Verification requires byte-exact RFC 8785 (JCS) serialization of the signed core (05-operation-log §3). `jsonb` does **not** round-trip bytes: it re-serializes numerics as Postgres `numeric` (e.g. `1e-7` becomes `0.0000001`, trailing-zero scale is preserved), which can differ from ES shortest-repr output — so an op reconstructed from `jsonb` columns can fail client-side signature verification on pull even though it is genuine. Therefore the server stores, and pull responses are served from, the **verbatim JCS text of the signed core** (`signed_core_jcs`). JCS is a fixpoint under `JSON.parse ∘ canonicalize` in JS, so the client can parse, re-canonicalize, and get the same bytes. The envelope columns exist for querying and projections and are CI-checked consistent with the blob; the blob is the wire truth. The client stores the same blob for its own ops (created at append) and for pulled ops.

## 3. Per-tenant `serverSeq` — chosen mechanism

`serverSeq` is a per-tenant monotonic bigint assigned on acceptance (05-operation-log §2.4) and it is the pull cursor. **Mechanism: a per-tenant counter row, locked at transaction start, incremented once per ACCEPTED op inside the validation loop:**

```sql
-- Taken at transaction start: serializes pushes per tenant, allocates nothing yet.
SELECT next_server_seq FROM tenant_op_counters WHERE tenant_id = $1 FOR UPDATE;

-- Per ACCEPTED op (and per server-built platform.conflict_detected op), inside the loop:
UPDATE tenant_op_counters
   SET next_server_seq = next_server_seq + 1
 WHERE tenant_id = $1
RETURNING next_server_seq - 1 AS server_seq;
-- next_server_seq is "the next value to assign". Duplicates and rejected ops never
-- reach this statement — they consume nothing, so per-tenant serverSeq is gapless
-- by construction. No up-front block allocation, ever.
```

Why not `bigserial` / a global sequence: sequence values become visible **out of commit order** — a puller could observe `serverSeq = 105` while an uncommitted transaction still holds 103, advance its cursor past 103, and permanently miss that op. The row lock serializes pushes per tenant, so within a tenant `serverSeq` is gapless and commit-ordered, which is exactly what makes `WHERE server_seq > cursor` safe with no visibility tricks. Cost: pushes serialize per tenant — acceptable at v0 scale (~10 stores) and consistent with chain validation already serializing per device. Cross-tenant pushes don't contend (separate rows). The counter lives in its own table to keep the hot lock off tenant metadata reads.

Push transaction shape (protocol in api/01-sync §3; schema-relevant order here):

```
BEGIN;
  SELECT set_config('app.tenant_id', $tenant, true);       -- §6, transaction-local ALWAYS
  SELECT ... FROM tenant_op_counters ... FOR UPDATE;        -- lock only; no allocation
  -- per op, in batch order:
  --   dedupe(id) → verify sig → chain check vs devices.last_seq/last_hash
  --   → scope check (05 §9, incl. the push-time permission validation of
  --     auth.pin_changed|auth.pin_reset|auth.pin_lockout_cleared against the
  --     directory — api/02-auth) → zod
  --   → IF accepted: UPDATE tenant_op_counters ... RETURNING  (this op's serverSeq)
  --                  → INSERT operations → apply projections
  --   → duplicates/rejected ops: no allocation, no INSERT; tamper-class rejections
  --     are recorded in device_anomalies (§4)
  -- conflict detection (01-domain-model §8.2) — SAME transaction, AFTER the
  -- acceptance loop, over the just-accepted ops:
  --   for each detected pair: build the platform.conflict_detected op
  --     (actor = the tenant system user; device = the tenant system device),
  --   chain it via system_device_chain_state (seq = last_seq + 1,
  --     previousHash = last_hash),
  --   sign its JCS core with the tenant system-device Ed25519 key
  --     (server secret store, §12 — never in Postgres),
  --   allocate its serverSeq with the same per-op UPDATE ... RETURNING,
  --   INSERT operations → apply the conflicts projection,
  --   UPDATE system_device_chain_state SET last_seq, last_hash
  UPDATE devices SET last_seq = ..., last_hash = ..., last_sync_at = ...;
COMMIT;
```

System-device ops therefore ride the same per-tenant gapless `serverSeq` stream as pushed ops, are pulled and signature-verified by clients like any other op, and are the ONLY ops the system device signs (01-domain-model §3.6).

## 4. Server DDL — platform & directory

```sql
-- ============ tenants (directory; platform plane) ============
CREATE TABLE tenants (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  -- NO status column in v0: tenant suspension is deferred (03-state-machines §13;
  -- roadmap). Tenants are implicitly active; adding the column (and its CHECK)
  -- later is a migration.
  active_modules  jsonb NOT NULL DEFAULT '[]',
  configuration   jsonb NOT NULL DEFAULT '{}',
  created_at      bigint NOT NULL
);

CREATE TABLE tenant_op_counters (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id),
  next_server_seq bigint NOT NULL DEFAULT 1
);

-- ============ stores (directory) ============
CREATE TABLE stores (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX idx_stores_tenant ON stores (tenant_id);

-- ============ devices (directory; validated BEFORE ops exist) ============
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
);
CREATE INDEX idx_devices_tenant ON devices (tenant_id);

-- ============ system-device chain state (§3: server-built conflict ops) ============
CREATE TABLE system_device_chain_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  device_id uuid NOT NULL REFERENCES devices(id), -- the tenant's system device (devices.kind='system')
  last_seq  bigint NOT NULL DEFAULT 0,
  last_hash char(64)                              -- NULL until the first system op; genesis
                                                  -- previousHash rule per 05-operation-log §2.2
);
-- Advanced only inside the push transaction (§3), under the same tenant_op_counters
-- row lock — the system device's chain never forks.

-- ============ permissions (global registry mirror; code-defined, deploy-seeded) ============
CREATE TABLE permissions (
  id           text PRIMARY KEY,        -- 'notes.create' — <module>.<action> (02-permissions §2)
  module       text NOT NULL,
  action       text NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('tenant', 'store')),  -- bound to the permission (02-permissions §3.1)
  description  text NOT NULL,           -- canonical EN string; label keys are DERIVED:
                                        -- permission.<module>.<action>.name/.description (07-i18n)
  is_dangerous boolean NOT NULL DEFAULT false
);
-- No tenant_id, no RLS: global read-only reference data. App role gets SELECT only;
-- rows are upserted at deploy from the module manifests (02-permissions §3.1, §11).

-- ============ device_anomalies (tamper alarm; FR-829) ============
CREATE TABLE device_anomalies (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  kind      text NOT NULL CHECK (kind IN ('BAD_SIGNATURE','CHAIN_BROKEN','SCOPE_VIOLATION','CLOCK_SKEW')),
  at        bigint NOT NULL,
  detail    jsonb                       -- op id + rejection context; NEVER the rejected op itself
);
CREATE INDEX idx_device_anomalies_device ON device_anomalies (device_id, at);
-- Written inside the push transaction when a tamper-class rejection or clock-skew
-- flag occurs (§3). Feeds the per-device anomaly counts in GET /v1/devices
-- (api/02-auth §7.1) — owner-visible surfacing, not just the (potentially hostile)
-- rejected device. Rejected ops themselves are still never stored (§5).

-- ============ idempotency_keys (api/00-conventions §8.2) ============
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
);
```

## 5. Server DDL — the operation log

```sql
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
);

-- Pull query: WHERE tenant_id = $1 AND server_seq > $2
--             AND (store_id = $3 OR store_id IS NULL)
--             ORDER BY server_seq LIMIT $4
--   → served by the (tenant_id, server_seq) unique index (ordered scan, filter on store_id).

-- Per-entity canonical re-fold (04-module-contract §4.2) and rebuild:
CREATE INDEX idx_operations_entity_canonical
  ON operations (tenant_id, entity_type, entity_id, timestamp_ms, device_id, seq);

-- Conflict rule 1 lookup (same entity+key, other devices — 01-domain-model §8.2):
-- served by idx_operations_entity_canonical (type filter applied on the heap rows).

-- ============ append-only enforcement (05-operation-log §1) ============
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operations are append-only (05-operation-log §1)';
END $$;

CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Belt: the app role is additionally GRANTed only SELECT, INSERT on operations (§6.3).
-- Server never stores rejected ops — rejection happens before INSERT; only the client
-- keeps its rejected ops (05 §8). Tamper-class rejections ARE recorded as anomaly
-- records (never the op) in device_anomalies (§4) for owner-visible surfacing (FR-829).
```

## 6. Server DDL — tenancy enforcement (RLS)

Two mandatory layers (decision Q2, pinned):

1. **Ergonomics/testability:** `forTenant(tenantId)` wrapper factory in `packages/db-server` returning a tenant-bound Kysely handle — **the only exported way to query tenant tables**. It opens the transaction and runs `set_config` first; raw `db` is not exported. This satisfies FR-1039's "impossible to express" at the API level.
2. **Enforcement:** Postgres RLS below — a forgotten filter returns zero rows / fails on write, never another tenant's data.

```sql
-- 6.1 Session GUC: transaction-local ONLY. Top of every request transaction:
--   SELECT set_config('app.tenant_id', $1, true);
-- Session-level SET on pooled connections is FORBIDDEN (leaks tenant context across
-- requests). Kysely transactions pin one pooled connection, so is_local=true is safe.

-- 6.2 Policy template — applied to EVERY tenant-scoped table:
--   operations, stores, devices, users, roles, role_permissions, user_roles,
--   user_stores, user_pin_verifiers, identity_audit, control_sessions,
--   idempotency_keys, device_anomalies, system_device_chain_state,
--   auth_sessions, pin_lockout_events, auth_permission_denials, user_prefs,
--   media, media_chunks, push_tokens, conflicts, notes, projection_watermarks,
--   tenant_op_counters
-- (loop this in the migration; written out once here)
ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operations
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- tenants itself: the app may see only its own row
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  FOR ALL
  USING      (id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (id = current_setting('app.tenant_id')::uuid);

-- 6.3 Roles:
--   bolusi_app       — request handlers. NOT the table owner, NOSUPERUSER, no BYPASSRLS.
--                      GRANT SELECT/INSERT/UPDATE/DELETE per table; operations: SELECT,
--                      INSERT only. current_setting with no GUC set → error → fail closed.
--   bolusi_provision — provisioning CLI + migrations only. Table owner. Never used by
--                      request handlers; never reachable from Hono code paths.
-- `permissions` (global registry): no RLS; bolusi_app gets SELECT only.
```

## 7. Server DDL — identity directory (control plane)

These are **directory rows, not projections**. They shall be mutated ONLY by the online control-plane endpoints (api/02-auth: `/v1/users*`, `/v1/users/:id/pin-verifier`, role management) and by server-side provisioning (`bolusi_provision`). They are never written by the projection engine and never sourced from ops — no `auth.user_*`/`auth.role_*` op types exist (api/02-auth §6.2 is the auth op registry). Every control-plane mutation is recorded in `identity_audit`. Devices receive their slice via the enrollment bundle and conditional `GET /v1/devices/me/bundle` (api/02-auth §5); the client mirrors are §9.5.

```sql
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  employee_id      uuid,                        -- forward ref; ALWAYS NULL in v0, FK lands in v1 (PRD-007)
  name             text NOT NULL,
  login_identifier text UNIQUE,                 -- GLOBALLY unique (across tenants); enforced
                                                -- server-side at creation (api/02-auth §5) —
                                                -- unique indexes are not subject to RLS.
                                                -- NULL for PIN-only users and the system actor
                                                -- (Postgres UNIQUE permits multiple NULLs)
  photo_media_id   uuid,                        -- media object id; in the bundle from day one;
                                                -- photo-upload UI is v1 (roadmap) — clients
                                                -- render an initials fallback when NULL
  is_system        boolean NOT NULL DEFAULT false,  -- the tenant system user: actor for
                                                    -- platform.conflict_detected ops only (§3)
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'deactivated')),
  created_at       bigint NOT NULL,
  created_by       uuid                         -- creating actor; NULL for provisioning-created
                                                -- rows (first owner, system user)
);
CREATE INDEX idx_users_tenant ON users (tenant_id);
-- NO pin_hash column: PIN verifiers live in user_pin_verifiers below. PIN material
-- never appears in the operation log (api/02-auth §6) and never on the users row.

-- ============ user_pin_verifiers (structured verifier; api/02-auth §6.1) ============
CREATE TABLE user_pin_verifiers (
  user_id         uuid PRIMARY KEY REFERENCES users(id),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  algo            text NOT NULL DEFAULT 'argon2id' CHECK (algo = 'argon2id'),
  salt            text NOT NULL,               -- base64
  params          jsonb NOT NULL,              -- {m, t, p}
  hash            text NOT NULL,               -- base64 argon2id output
  as_of_timestamp bigint NOT NULL,             -- CanonicalRef triple (api/02-auth §5.2):
  as_of_device_id uuid NOT NULL,               -- merge = greatest asOf under canonical order
  as_of_seq       bigint NOT NULL              -- (timestamp, deviceId, seq) — api/02-auth §5.3
);
-- System users have NO row here. Written by POST /v1/users (initial PIN) and
-- POST /v1/users/:id/pin-verifier (change/reset — the verifier travels over TLS,
-- never inside an op payload). Distributed to devices per-store only (verifier
-- minimization, api/02-auth §5.2).

CREATE TABLE roles (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  name              text NOT NULL,
  scope_type        text NOT NULL CHECK (scope_type IN ('tenant', 'store')),  -- 02-permissions §5.1
  is_system_default boolean NOT NULL DEFAULT false,   -- main_owner | store_owner | staff
  created_at        bigint NOT NULL
);
CREATE INDEX idx_roles_tenant ON roles (tenant_id);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id),
  permission_id text NOT NULL REFERENCES permissions(id),
  tenant_id     uuid NOT NULL,                   -- denormalized for RLS
  PRIMARY KEY (role_id, permission_id)
);

-- Composite grant — no id column (02-permissions §5.1)
CREATE TABLE user_roles (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL REFERENCES users(id),
  role_id   uuid NOT NULL REFERENCES roles(id),
  store_id  uuid REFERENCES stores(id),          -- NULL iff role.scope_type = 'tenant'
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, role_id, store_id)   -- PG16+
);
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

CREATE TABLE user_stores (
  user_id   uuid NOT NULL REFERENCES users(id),
  store_id  uuid NOT NULL REFERENCES stores(id),
  tenant_id uuid NOT NULL,
  PRIMARY KEY (user_id, store_id)
);
CREATE INDEX idx_user_stores_store ON user_stores (store_id);  -- bundle build: this store's users

-- ============ identity_audit (control-plane mutation log) ============
CREATE TABLE identity_audit (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid,                           -- from control session / X-Acting-User;
                                                -- NULL for provisioning
  action        text NOT NULL,                  -- 'user.created','user.deactivated','role.updated',
                                                -- 'pin_verifier.replaced','tenant_settings.changed',...
  entity_type   text NOT NULL,                  -- 'user'|'role'|'user_role'|'pin_verifier'|'tenant_settings'
  entity_id     uuid,
  before        jsonb,                          -- NULL on create; verifier salt/hash NEVER included
  after         jsonb,                          -- ditto — secret material is redacted to as_of only
  at            bigint NOT NULL
);
CREATE INDEX idx_identity_audit_tenant_at ON identity_audit (tenant_id, at);
-- This is the audit surface for online identity mutations: the op log never sees
-- them, so this table does. Append-only by convention; app role gets SELECT, INSERT.

-- ============ control_sessions (bcs_… bearer tokens; api/02-auth §3) ============
CREATE TABLE control_sessions (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,              -- digest of the bcs_… token; format owned by api/02-auth
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint
);
```

## 8. Server DDL — media, push, platform & module projections

```sql
-- ============ media (row created at init — api/03-media §3.1) ============
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
);
CREATE INDEX idx_media_tenant_status ON media (tenant_id, status)
  WHERE status <> 'complete';

-- In-flight chunk storage; GET /v1/media/:id/status reads this — resume is
-- SERVER-authoritative (api/03-media §3.3; 06-media-pipeline §4)
CREATE TABLE media_chunks (
  media_id    uuid NOT NULL REFERENCES media(id),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  tenant_id   uuid NOT NULL,
  byte_size   integer NOT NULL CHECK (byte_size > 0),
  bytes       bytea NOT NULL,                    -- chunk body (api/03-media §6); rows deleted
                                                 -- after assembly at complete
  received_at bigint NOT NULL,
  PRIMARY KEY (media_id, chunk_index)
);
-- NO per-chunk sha256: per-chunk hashes are deliberately not part of the protocol
-- (api/03-media §5). Integrity = exact chunk size per PUT + whole-file sha256 at
-- complete (plus the jpeg/png magic-byte check at finalize, api/03-media §3.4).

-- ============ push_tokens (registered via POST /v1/push/tokens — api/04-push) ============
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
);
CREATE UNIQUE INDEX idx_push_tokens_device ON push_tokens (device_id);
-- One token per device install; pushes address DEVICES (shared-device reality).
-- Categories, payload rules, and revocation cleanup are owned by api/04-push;
-- per-user preference entities are v1 (roadmap).

-- ============ conflicts (projection of platform.conflict_* ops) ============
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
);
CREATE INDEX idx_conflicts_surfaced ON conflicts (tenant_id, store_id)
  WHERE status = 'surfaced';

-- ============ auth_sessions (projection of auth.user_switched / auth.session_ended — api/02-auth §6.2) ============
-- user_switched inserts; session_ended sets ended_at/end_reason on its own entityId.
-- The PRD-011 §5 UserSession record.
CREATE TABLE auth_sessions (
  id         uuid PRIMARY KEY,                   -- = the session's entityId
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  store_id   uuid REFERENCES stores(id),
  user_id    uuid NOT NULL,
  device_id  uuid NOT NULL,
  started_at bigint NOT NULL,
  ended_at   bigint,                             -- NULL while the session is open
  end_reason text                                -- 'switch' | 'idle_lock' | 'manual_lock'
);

-- ============ pin_lockout_events (projection of auth.pin_locked_out / auth.pin_lockout_cleared — api/02-auth §6.2) ============
-- Append-only audit rows — owner-visible brute-force evidence.
CREATE TABLE pin_lockout_events (
  id            uuid PRIMARY KEY,                -- = op id
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  store_id      uuid REFERENCES stores(id),
  user_id       uuid NOT NULL,                   -- targeted user (op entityId)
  device_id     uuid NOT NULL,                   -- from the envelope
  kind          text NOT NULL CHECK (kind IN ('pin_locked_out', 'pin_lockout_cleared')),
  failure_count integer,                         -- consecutiveFailures; NULL for cleared events
  at            bigint NOT NULL
);

-- ============ auth_permission_denials (projection of auth.permission_denied — 02-permissions §7) ============
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
);
CREATE INDEX idx_auth_permission_denials_tenant
  ON auth_permission_denials (tenant_id, timestamp_ms);  -- listPermissionDenials (auth.audit_view)

-- ============ user_prefs (projection of platform.user_locale_changed — 07-i18n §1.1) ============
CREATE TABLE user_prefs (
  user_id    uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  locale     text NOT NULL DEFAULT 'id-ID',
  updated_at bigint NOT NULL
);

-- ============ notes (reference-module projection) ============
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
);
CREATE INDEX idx_notes_store_created ON notes (tenant_id, store_id, created_at);  -- listNotes cursor

-- ============ projection watermarks (04-module-contract §4.3) ============
CREATE TABLE projection_watermarks (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  module_id          text NOT NULL,
  applied_server_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, module_id)
);
-- Server-side: rebuild bookkeeping ONLY — the server applies projections
-- synchronously inside the push transaction (§3; 04-module-contract §4.3).
```

## 9. Client SQLite DDL (op-sqlite 17.1.2 + SQLCipher)

Open sequence (in `packages/db-client`, the single wrapper): `open({name: 'bolusi.db', encryptionKey})` where `encryptionKey` is a random 32-byte hex string generated at first launch and stored in `expo-secure-store` (< 2 KB; encrypted-at-rest storage, **not** a hardware enclave — qualify all claims). Then pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`. One connection for the whole app; concurrency comes from WAL, never from extra connections. The device's Ed25519 private key and device token also live in `expo-secure-store` — **never** in SQLite. Bulk paths (pull apply, rebuild) use prepared statements + `executeBatch`.

### 9.1 Infrastructure

```sql
CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE meta_kv (             -- device identity + misc scalars
  key   TEXT PRIMARY KEY,          -- 'deviceId','tenantId','storeId','appSchemaVersion',...
  value TEXT NOT NULL
);

CREATE TABLE projection_watermarks (
  module_id          TEXT PRIMARY KEY,
  applied_server_seq INTEGER NOT NULL DEFAULT 0,   -- pulled ops
  applied_local_seq  INTEGER NOT NULL DEFAULT 0    -- own-device ops
);
```

### 9.2 Operation log

```sql
CREATE TABLE operations (
  -- signed core (05-operation-log §2.1)
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
  payload               TEXT NOT NULL,             -- JSON
  timestamp_ms          INTEGER NOT NULL,
  location              TEXT,                      -- JSON | NULL
  source                TEXT NOT NULL CHECK (source IN ('ui','agent','api','system')),
  agent_initiated       INTEGER NOT NULL DEFAULT 0,
  agent_conversation_id TEXT,
  previous_hash         TEXT NOT NULL,
  hash                  TEXT NOT NULL,
  signature             TEXT NOT NULL,
  signed_core_jcs       TEXT NOT NULL,             -- §2.1: byte truth for push + re-verification
  -- client bookkeeping (05 §2.3) — the ONLY mutable columns
  sync_status           TEXT NOT NULL DEFAULT 'local'
                          CHECK (sync_status IN ('local','synced','rejected')),
  synced_at             INTEGER,
  server_seq            INTEGER,                   -- from push ack / pull; NULL while local
  rejection_code        TEXT,
  rejection_reason      TEXT
);

CREATE UNIQUE INDEX idx_operations_device_seq ON operations (device_id, seq);
CREATE INDEX idx_operations_entity_canonical
  ON operations (entity_type, entity_id, timestamp_ms, device_id, seq);  -- re-fold/rebuild
CREATE INDEX idx_operations_push_queue ON operations (seq)
  WHERE sync_status = 'local';                     -- push batching in seq order
CREATE INDEX idx_operations_rejected ON operations (id)
  WHERE sync_status = 'rejected';                  -- surfacing (never silent — 05 §8)
```

Append-only holds by construction: `packages/db-client` exports no UPDATE/DELETE for `operations` except the single `markSyncResult()` mutator touching bookkeeping columns only (lint-enforced per 05-operation-log §1).

### 9.3 Sync state (singleton)

```sql
CREATE TABLE sync_state (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  pull_cursor                  INTEGER NOT NULL DEFAULT 0,
  devices_directory_version    INTEGER NOT NULL DEFAULT 0,  -- last-seen devices-sidecar version (api/01-sync §4)
  last_successful_sync_at      INTEGER,
  last_push_at                 INTEGER,
  last_pull_at                 INTEGER,
  last_server_time             INTEGER,
  last_server_time_received_at INTEGER,
  last_sync_error              TEXT,
  backoff_until                INTEGER,
  push_halted                  INTEGER NOT NULL DEFAULT 0,  -- set by CHAIN_BROKEN (03-state-machines §10)
  sync_disabled                INTEGER NOT NULL DEFAULT 0,  -- set by DEVICE_REVOKED
  sync_disabled_reason         TEXT
);
INSERT INTO sync_state (id) VALUES (1);
-- pull_cursor advances only in the same transaction that inserts the pulled batch
-- and applies projections (api/01-sync §4). pendingOperationCount/pendingMediaCount
-- are DERIVED queries, recomputed and never stored (01 §5.2; media formula is
-- 06-media-pipeline §4's — orphans excluded).
```

### 9.4 Media queue

```sql
CREATE TABLE media_items (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  store_id                  TEXT,                -- NULL for store-less devices (api/03-media §2)
  captured_by_user_id       TEXT NOT NULL,
  device_id                 TEXT NOT NULL,
  type                      TEXT NOT NULL CHECK (type IN ('image','video','signature')),
  mime_type                 TEXT NOT NULL,
  byte_size                 INTEGER NOT NULL,
  sha256                    TEXT NOT NULL,
  captured_at               INTEGER NOT NULL,
  location                  TEXT,
  local_path                TEXT,                    -- document dir (moved from cache at capture);
                                                     -- NULL after pruning (06-media-pipeline §7)
  attached_to_operation_id  TEXT,
  upload_status             TEXT NOT NULL DEFAULT 'pending'
                              CHECK (upload_status IN ('pending','uploading','uploaded','failed')),
                              -- CLIENT machine; the server's receiving/complete states
                              -- are a different enum (§8; 03-state-machines §4)
  chunk_size                INTEGER,                 -- server-dictated; NULL until set from the
  chunks_total              INTEGER,                 -- init response (api/03-media §3.1)
  upload_attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at           INTEGER,                 -- backoff schedule owned by 03-state-machines §4.1
  last_error_code           TEXT,
  last_error_message        TEXT,
  uploaded_at               INTEGER
);
CREATE INDEX idx_media_items_queue ON media_items (upload_status)
  WHERE upload_status <> 'uploaded';
-- NO pruned column: "pruned" is DERIVED, never stored — local_path IS NULL AND
-- upload_status = 'uploaded' (06-media-pipeline §7). Bytes are deleted post-upload;
-- the row and metadata stay.
-- Field list mirrors MediaItem (01-domain-model §5.3) exactly. Resume is
-- SERVER-authoritative: GET /v1/media/:id/status receivedChunks is ground truth;
-- local progress is display-only and never persisted (06-media-pipeline §4).
-- Drain loop: foreground-driven; chunks read via FileHandle offset+readBytes (no native
-- resumable upload exists in expo-file-system SDK 57); expo-background-task is
-- opportunistic retry only. Mechanics: 06-media-pipeline / api/03-media.
```

### 9.5 Identity directory mirrors + device registry + PIN attempt state + quarantine

The directory mirrors are written ONLY from the enrollment bundle and conditional `GET /v1/devices/me/bundle` refreshes (api/02-auth §5) — each refresh replaces the affected tables atomically. They are NEVER written from ops. Bootstrap rule: the enrollment bundle is written into these tables BEFORE any command executes, so the permission evaluator (02-permissions §5.2) always has directory rows to read. The device DB is single-tenant (`tenantId` lives in `meta_kv`), so the mirrors carry no `tenant_id` column.

```sql
-- Bundle mirror: the device's store's users ONLY (bundle minimization, api/02-auth §5.2)
CREATE TABLE users_directory (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  photo_media_id TEXT,                             -- NULL → initials fallback in the switcher
  status         TEXT NOT NULL CHECK (status IN ('active','deactivated'))
);

-- Bundle mirror: rolesSnapshot + permissionsSnapshot for the WHOLE tenant (api/02-auth §5.2)
CREATE TABLE roles_directory (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  scope_type        TEXT NOT NULL CHECK (scope_type IN ('tenant','store')),
  is_system_default INTEGER NOT NULL DEFAULT 0,
  permission_ids    TEXT NOT NULL                  -- JSON array: the role's permissionsSnapshot;
                                                   -- read by the evaluator (02-permissions §5.2)
);

-- Bundle mirror: composite grants — no id column (02-permissions §5.1). Rows come from
-- the bundle's per-user grant tuples {roleId, storeId|null} (api/02-auth §5.2):
-- tenant-wide grants carry store_id NULL; store-scoped grants carry the bundle's store.
CREATE TABLE user_roles_directory (
  user_id  TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  store_id TEXT,                                   -- NULL = tenant-wide grant; else the bundle's store
  UNIQUE (user_id, role_id, store_id)              -- SQLite treats NULLs as distinct; the bundle
                                                   -- apply replaces the table wholesale
);

-- Bundle mirror: verifiers for THIS store's users only (verifier minimization,
-- api/02-auth §5.2). Never synced, never in ops. An offline owner PIN reset
-- (auth.pin_reset) replaces the row locally and takes effect immediately on this
-- device; the new verifier is POSTed to /v1/users/:id/pin-verifier on next online
-- contact and reaches other devices via bundle refresh (api/02-auth §6).
CREATE TABLE user_pin_verifiers (
  user_id         TEXT PRIMARY KEY,
  algo            TEXT NOT NULL CHECK (algo = 'argon2id'),
  salt            TEXT NOT NULL,                   -- base64
  params          TEXT NOT NULL,                   -- JSON {m,t,p}
  hash            TEXT NOT NULL,                   -- base64 argon2id output
  as_of_timestamp INTEGER NOT NULL,                -- CanonicalRef triple (api/02-auth §5.2):
  as_of_device_id TEXT NOT NULL,                   -- merge = greatest asOf under canonical order
  as_of_seq       INTEGER NOT NULL                 -- (timestamp, deviceId, seq) — api/02-auth §5.3
);

-- Mirror of the pull `devices` sidecar (api/01-sync §4): pubkeys for verifying pulled
-- ops. Replaced atomically whenever the pull response carries a devices snapshot
-- (devicesDirectoryVersion changed). Revoked devices REMAIN listed so their
-- historical ops keep verifying (api/02-auth §7.2).
CREATE TABLE device_registry (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('member','system')),
  signing_key_public TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','revoked')),
  revoked_at         INTEGER
);

-- PIN rate limiting (FR-1011; machine owned by api/02-auth §6.5): client-local, never synced
CREATE TABLE pin_attempt_state (
  user_id              TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  window_started_at    INTEGER,
  not_before           INTEGER,                    -- attempts before this instant are not
                                                   -- evaluated (PIN_RATE_LIMITED / PIN_LOCKED)
  PRIMARY KEY (user_id, device_id)
);

-- Pulled ops that failed signature verification (api/01-sync §4): never applied to
-- projections; the pull cursor still ADVANCES past them; surfaced loudly
-- (sync.quarantine.* labels). Re-checked whenever a devices-sidecar update lands
-- in device_registry.
CREATE TABLE quarantined_ops (
  id              TEXT PRIMARY KEY,                -- op id
  device_id       TEXT NOT NULL,                   -- claimed signer
  server_seq      INTEGER NOT NULL,
  signed_core_jcs TEXT NOT NULL,                   -- verbatim wire bytes for re-verification
  hash            TEXT NOT NULL,
  signature       TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('bad_signature','unknown_pubkey')),
  quarantined_at  INTEGER NOT NULL
);
```

### 9.6 Module projections (notes) + conflicts + platform/auth projections

```sql
CREATE TABLE conflicts (
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
);
CREATE INDEX idx_conflicts_surfaced ON conflicts (status) WHERE status = 'surfaced';

CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  media_id       TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  edit_count     INTEGER NOT NULL DEFAULT 0,     -- +1 per notes.note_body_edited fold; testability
                                                 -- column (01-domain-model §9; testing-guide §3.2)
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_edited_by TEXT NOT NULL,
  last_edited_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_created ON notes (created_at);   -- listNotes cursor pagination

-- Projection of auth.user_switched / auth.session_ended ops (api/02-auth §6.2);
-- same fold as server §8
CREATE TABLE auth_sessions (
  id         TEXT PRIMARY KEY,                   -- = the session's entityId
  tenant_id  TEXT NOT NULL,
  store_id   TEXT,
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,                            -- NULL while the session is open
  end_reason TEXT                                -- 'switch' | 'idle_lock' | 'manual_lock'
);

-- Projection of auth.pin_locked_out / auth.pin_lockout_cleared ops (api/02-auth §6.2);
-- same fold as server §8. Append-only audit rows.
CREATE TABLE pin_lockout_events (
  id            TEXT PRIMARY KEY,                -- = op id
  tenant_id     TEXT NOT NULL,
  store_id      TEXT,
  user_id       TEXT NOT NULL,                   -- targeted user (op entityId)
  device_id     TEXT NOT NULL,                   -- from the envelope
  kind          TEXT NOT NULL CHECK (kind IN ('pin_locked_out', 'pin_lockout_cleared')),
  failure_count INTEGER,                         -- consecutiveFailures; NULL for cleared events
  at            INTEGER NOT NULL
);

-- Projection of auth.permission_denied ops (02-permissions §7); same fold as server §8
CREATE TABLE auth_permission_denials (
  id                 TEXT PRIMARY KEY,            -- = op id
  tenant_id          TEXT NOT NULL,
  store_id           TEXT,                        -- the envelope's device store
  scope_store_id     TEXT,                        -- evaluation scope from the payload;
                                                  -- NULL = tenant-scope check (02-permissions §7)
  user_id            TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  timestamp_ms       INTEGER NOT NULL,
  permission_id      TEXT NOT NULL,
  surface            TEXT NOT NULL,
  target             TEXT,
  reason             TEXT NOT NULL,
  suppressed_repeats INTEGER NOT NULL DEFAULT 0
);

-- Projection of platform.user_locale_changed ops (07-i18n §1.1); same fold as server §8
CREATE TABLE user_prefs (
  user_id    TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  locale     TEXT NOT NULL DEFAULT 'id-ID',
  updated_at INTEGER NOT NULL
);
```

## 10. Query patterns the indexes serve (do not add indexes without a row here)

| Query | Side | Index |
| ----- | ---- | ----- |
| Pull batch: tenant + `server_seq > cursor`, store-scoped, ordered | server | `UNIQUE (tenant_id, server_seq)` |
| Chain validation: last accepted (seq, hash) per device | server | `devices.last_seq/last_hash` cache; `UNIQUE (device_id, seq)` as ground truth |
| Idempotent dedupe by op id | both | PK on `operations.id` |
| Entity re-fold / full rebuild in canonical order | both | `idx_operations_entity_canonical` |
| Push queue: local ops in seq order | client | `idx_operations_push_queue` (partial) |
| Rejected-op surfacing | client | `idx_operations_rejected` (partial) |
| Conflict rule 1: prior ops on (entity, key) | server | `idx_operations_entity_canonical` |
| Surfaced conflicts for owner UI | both | `idx_conflicts_surfaced` (partial) |
| Media drain queue | client | `idx_media_items_queue` (partial) |
| Incomplete-media monitoring | server | `idx_media_tenant_status` (partial) |
| Switcher: users at this store | client | `users_directory` full scan (row set = this store's users by construction; no index) |
| Bundle build: users at a store | server | `idx_user_stores_store` |
| Login by loginIdentifier (`/v1/auth/login`) | server | `UNIQUE` on `users.login_identifier` |
| Control-session bearer lookup (`bcs_…`) | server | `UNIQUE` on `control_sessions.token_hash` |
| Idempotency replay lookup | server | PK `(tenant_id, key)` on `idempotency_keys` |
| Device anomaly counts (GET /v1/devices) | server | `idx_device_anomalies_device` |
| Identity-audit listing | server | `idx_identity_audit_tenant_at` |
| listPermissionDenials (auth.audit_view) | both | `idx_auth_permission_denials_tenant` (server) / table scan (client) |
| listNotes pagination | both | `idx_notes_store_created` / `idx_notes_created` |

## 11. Codegen & migration workflow (normative)

1. Edit **this doc** (schema change = spec change).
2. Server: write the migration in `packages/db-server/migrations` (kysely-ctl 0.21.0; programmatic use imports `Migrator` from `'kysely/migration'`). Projection-table migrations may also be expressed as drop-and-rebuild via the projection engine — the log is the source of truth (05-operation-log §1), so projection DDL changes never need data migrations, only a rebuild.
3. Run `kysely-ctl migrate:latest` against the dev DB → run kysely-codegen 0.20.0 (`--camel-case`) → commit generated types. CI regenerates and diffs.
4. Client: add the embedded migration; CI builds a scratch SQLite DB from all client migrations, runs kysely-codegen against it, diffs committed types.
5. Never edit generated type files by hand; never define a table interface manually.
6. DB migrations serialize globally across parallel agents (CLAUDE.md §4).

## 12. Explicitly NOT in any database

| Item | Where it lives |
| ---- | -------------- |
| Device Ed25519 private key | `expo-secure-store` (per-device; < 2 KB; extractable-by-app-code caveat applies) |
| Device bearer token | `expo-secure-store`; server stores only `devices.token_hash` (api/02-auth) |
| SQLCipher database key | `expo-secure-store`, random 32 bytes hex, generated at first launch |
| System-device private keys | server secret store (deployment doc), never in Postgres — used only to sign `platform.conflict_detected` ops inside the push transaction (§3) |
| PIN verifier material inside op payloads | nowhere — FORBIDDEN (api/02-auth §6): verifiers travel only over TLS control-plane calls and land in `user_pin_verifiers` (server §7; client §9.5, own store only) |
| Media bytes | client: document directory files; server: in-flight chunks in `media_chunks.bytes`, assembled object storage under `media.storage_key` |
| Derived counters (pending ops/media, effective permissions) | computed queries — never persisted |

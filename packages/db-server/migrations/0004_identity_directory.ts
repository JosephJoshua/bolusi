// 10-db-schema §7 — identity directory (control plane). DDL verbatim from the doc.
// These are directory rows, not projections: mutated ONLY by the api/02-auth control-plane
// endpoints and by server-side provisioning. Never written by the projection engine.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
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
    )
  `.execute(db);
  await sql`CREATE INDEX idx_users_tenant ON users (tenant_id)`.execute(db);
  // NO pin_hash column: PIN verifiers live in user_pin_verifiers below. PIN material
  // never appears in the operation log (api/02-auth §6) and never on the users row.
  await secureTenantTable(db, 'users');

  // ============ user_pin_verifiers (structured verifier; api/02-auth §6.1) ============
  await sql`
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
    )
  `.execute(db);
  await secureTenantTable(db, 'user_pin_verifiers');

  await sql`
    CREATE TABLE roles (
      id                uuid PRIMARY KEY,
      tenant_id         uuid NOT NULL REFERENCES tenants(id),
      name              text NOT NULL,
      scope_type        text NOT NULL CHECK (scope_type IN ('tenant', 'store')),  -- 02-permissions §5.1
      is_system_default boolean NOT NULL DEFAULT false,   -- main_owner | store_owner | staff
      created_at        bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_roles_tenant ON roles (tenant_id)`.execute(db);
  await secureTenantTable(db, 'roles');

  await sql`
    CREATE TABLE role_permissions (
      role_id       uuid NOT NULL REFERENCES roles(id),
      permission_id text NOT NULL REFERENCES permissions(id),
      tenant_id     uuid NOT NULL,                   -- denormalized for RLS
      PRIMARY KEY (role_id, permission_id)
    )
  `.execute(db);
  await secureTenantTable(db, 'role_permissions');

  // Composite grant — no id column (02-permissions §5.1)
  await sql`
    CREATE TABLE user_roles (
      tenant_id uuid NOT NULL,
      user_id   uuid NOT NULL REFERENCES users(id),
      role_id   uuid NOT NULL REFERENCES roles(id),
      store_id  uuid REFERENCES stores(id),          -- NULL iff role.scope_type = 'tenant'
      UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, role_id, store_id)   -- PG16+
    )
  `.execute(db);
  await sql`CREATE INDEX idx_user_roles_user ON user_roles (user_id)`.execute(db);
  await secureTenantTable(db, 'user_roles');

  await sql`
    CREATE TABLE user_stores (
      user_id   uuid NOT NULL REFERENCES users(id),
      store_id  uuid NOT NULL REFERENCES stores(id),
      tenant_id uuid NOT NULL,
      PRIMARY KEY (user_id, store_id)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_user_stores_store ON user_stores (store_id)`.execute(db); // bundle build: this store's users
  await secureTenantTable(db, 'user_stores');

  // ============ identity_audit (control-plane mutation log) ============
  await sql`
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
    )
  `.execute(db);
  await sql`CREATE INDEX idx_identity_audit_tenant_at ON identity_audit (tenant_id, at)`.execute(
    db,
  );
  // Append-only by convention; app role gets SELECT, INSERT (§7).
  await secureTenantTable(db, 'identity_audit', { grant: 'read-append' });

  // ============ control_sessions (bcs_… bearer tokens; api/02-auth §3) ============
  await sql`
    CREATE TABLE control_sessions (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      user_id    uuid NOT NULL REFERENCES users(id),
      token_hash text NOT NULL UNIQUE,              -- digest of the bcs_… token; format owned by api/02-auth
      created_at bigint NOT NULL,
      expires_at bigint NOT NULL,
      revoked_at bigint
    )
  `.execute(db);
  await secureTenantTable(db, 'control_sessions');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'control_sessions',
    'identity_audit',
    'user_stores',
    'user_roles',
    'role_permissions',
    'roles',
    'user_pin_verifiers',
    'users',
  ]) {
    await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  }
}

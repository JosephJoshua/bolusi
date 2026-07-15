// 10-db-schema §6.4 (D14) — the auth-entry cross-tenant read path, and users.password_verifier.
//
// Token verification (every request) and login resolve the tenant FROM an opaque credential, so
// they must read a devices / control_sessions / users row BEFORE the tenant is known. forTenant
// cannot express that and bolusi_app is NOBYPASSRLS (§6.3) — under §6.2 those reads fail closed.
// D14 resolves it with THREE SECURITY DEFINER functions (not a BYPASSRLS app role): a definer
// function does only what its fixed body says, so the cross-tenant surface is three auditable
// bodies, not an open connection. bolusi_app keeps NOBYPASSRLS — FORCE-RLS and the SEC-TENANT
// sweep for every normal handler are untouched.
import { sql, type Kysely } from 'kysely';

const AUTH_ROLE = 'bolusi_auth';
const APP_ROLE = 'bolusi_app';

const FUNCTIONS = [
  'auth_find_device_by_token_hash(text)',
  'auth_find_control_session_by_token_hash(text)',
  'auth_find_login_credential(text)',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // bolusi_auth — owner of the definer functions ONLY. BYPASSRLS so the function bodies read
  // across tenants; NOLOGIN because it never connects (it is a definer identity, not a
  // connection role). Idempotent DO block: roles are CLUSTER-wide (matches 0001's rationale —
  // a re-created database on an existing cluster re-runs this against a pre-existing role).
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(AUTH_ROLE)}) THEN
        CREATE ROLE ${sql.id(AUTH_ROLE)} NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $$
  `.execute(db);

  // The definer functions read only these three tables; BYPASSRLS bypasses the RLS POLICY but
  // not table-level privileges, so bolusi_auth needs an explicit SELECT grant on each.
  for (const table of ['devices', 'control_sessions', 'users']) {
    await sql`GRANT SELECT ON ${sql.table(table)} TO ${sql.id(AUTH_ROLE)}`.execute(db);
  }

  // ============ users.password_verifier (§7; §3 credential inventory) ============
  // argon2id verifier JSON — server-side ONLY, never on device. NULL for PIN-only users. Read
  // cross-tenant at login via auth_find_login_credential; written under forTenant at
  // provisioning / user-create / POST /v1/auth/password.
  await sql`ALTER TABLE users ADD COLUMN password_verifier text`.execute(db);

  // ============ the three SECURITY DEFINER lookups (§6.4) ============
  // Each returns the minimal fields of the SINGLE matched row, nothing on no-match (fail closed);
  // parameterized on the hash/identifier only; table columns qualified to avoid any ambiguity
  // with the RETURNS TABLE column names; search_path pinned (definer-function hardening).
  await sql`
    CREATE FUNCTION auth_find_device_by_token_hash(p_token_hash text)
      RETURNS TABLE (tenant_id uuid, store_id uuid, device_id uuid, status text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT d.tenant_id, d.store_id, d.id, d.status
          FROM devices d
         WHERE d.token_hash = p_token_hash
    $$
  `.execute(db);
  await sql`
    CREATE FUNCTION auth_find_control_session_by_token_hash(p_token_hash text)
      RETURNS TABLE (tenant_id uuid, user_id uuid, session_id uuid, expires_at bigint, revoked_at bigint)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT c.tenant_id, c.user_id, c.id, c.expires_at, c.revoked_at
          FROM control_sessions c
         WHERE c.token_hash = p_token_hash
    $$
  `.execute(db);
  await sql`
    CREATE FUNCTION auth_find_login_credential(p_login_identifier text)
      RETURNS TABLE (tenant_id uuid, user_id uuid, password_verifier text, status text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT u.tenant_id, u.id, u.password_verifier, u.status
          FROM users u
         WHERE u.login_identifier = p_login_identifier
    $$
  `.execute(db);

  // Owner → bolusi_auth (definer identity). Lock EXECUTE down: revoke the PUBLIC default, grant
  // only bolusi_app. No other role can invoke the cross-tenant read.
  for (const fn of FUNCTIONS) {
    await sql`ALTER FUNCTION ${sql.raw(fn)} OWNER TO ${sql.id(AUTH_ROLE)}`.execute(db);
    await sql`REVOKE ALL ON FUNCTION ${sql.raw(fn)} FROM PUBLIC`.execute(db);
    await sql`GRANT EXECUTE ON FUNCTION ${sql.raw(fn)} TO ${sql.id(APP_ROLE)}`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const fn of FUNCTIONS) {
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(fn)}`.execute(db);
  }
  await sql`ALTER TABLE users DROP COLUMN IF EXISTS password_verifier`.execute(db);

  // Release this database's grants/ownerships from bolusi_auth, then drop the role only when
  // nothing else in the (cluster-wide) role depends on it — same defensive shape as 0001's down,
  // for the shared dev cluster hosting several databases.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(AUTH_ROLE)}) THEN
        EXECUTE format('DROP OWNED BY %I', ${sql.lit(AUTH_ROLE)});
        BEGIN
          EXECUTE format('DROP ROLE %I', ${sql.lit(AUTH_ROLE)});
        EXCEPTION WHEN dependent_objects_still_exist THEN
          RAISE NOTICE 'role % still owns objects in another database; left in place', ${sql.lit(AUTH_ROLE)};
        END;
      END IF;
    END $$
  `.execute(db);
}

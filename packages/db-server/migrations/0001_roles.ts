// 10-db-schema §6.3 — the two server roles.
//
// Idempotent DO blocks: roles are CLUSTER-wide, not database-wide, so a re-created database on
// an existing cluster (exactly what the test harness does between runs) re-runs this migration
// against roles that already exist. CREATE ROLE has no IF NOT EXISTS in PG16.
//
// Neither role gets a password here: passwords are deployment configuration, never migration
// content (security-guide §10 — no secrets in the repo). A LOGIN role with no password cannot
// authenticate under scram-sha-256, so these roles are inert until a deployment sets one.
import { sql, type Kysely } from 'kysely';

import { APP_ROLE, PROVISION_ROLE } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  // bolusi_app — request handlers. NOT the table owner, NOSUPERUSER, no BYPASSRLS.
  // NOBYPASSRLS is the load-bearing attribute: it is what makes the RLS policies in §6.2
  // undefeatable from the app's connection (testing-guide §2.5).
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(APP_ROLE)}) THEN
        CREATE ROLE ${sql.id(APP_ROLE)}
          LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
      END IF;
    END $$
  `.execute(db);

  // bolusi_provision — provisioning CLI + migrations only. Table owner.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(PROVISION_ROLE)}) THEN
        CREATE ROLE ${sql.id(PROVISION_ROLE)}
          LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
      END IF;
    END $$
  `.execute(db);

  // Schema visibility. Table-level grants are per-table (§6.3 matrix, applied by each table's
  // own migration) — this only opens the schema so those grants are reachable.
  await sql`GRANT USAGE ON SCHEMA public TO ${sql.id(APP_ROLE)}`.execute(db);
  await sql`GRANT USAGE, CREATE ON SCHEMA public TO ${sql.id(PROVISION_ROLE)}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Roles are CLUSTER-wide but a migration only ever runs against ONE database, and
  // `DROP OWNED BY` only clears the current database's ownerships/privileges. On the dev
  // cluster that hosts both bolusi_dev and bolusi_rls_test (docker-compose.yml), reverting one
  // database while the other is still migrated leaves the role owning objects elsewhere, and
  // `DROP ROLE` then fails with 2BP01 dependent_objects_still_exist.
  //
  // So: always release THIS database's claims, and drop the role only when nothing else in the
  // cluster depends on it. Reverting the last database still removes the roles entirely (the
  // clean-volume case); reverting one of several leaves them for the others, which is correct
  // rather than a compromise — a per-database down has no business deleting a cluster object
  // another database is actively using.
  for (const role of [APP_ROLE, PROVISION_ROLE]) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(role)}) THEN
          EXECUTE format('DROP OWNED BY %I', ${sql.lit(role)});
          BEGIN
            EXECUTE format('DROP ROLE %I', ${sql.lit(role)});
          EXCEPTION WHEN dependent_objects_still_exist THEN
            RAISE NOTICE 'role % still owns objects in another database; left in place', ${sql.lit(role)};
          END;
        END IF;
      END $$
    `.execute(db);
  }
}

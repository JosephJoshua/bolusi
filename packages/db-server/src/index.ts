// @bolusi/db-server — the public surface. Deliberately tiny (08-stack-and-repo §3.2, D7).
//
// What is exported: forTenant, the generated types, the migration-runner entry.
// What is NOT, and must never be: the pool, the raw Kysely handle, `createForTenant`, or
// anything else that lets a caller reach a tenant table without going through forTenant
// (FR-1039: an unscoped query must be impossible to express).
//
// `test/export-surface.test.ts` asserts this list exactly — adding an export fails that test
// on purpose, so growing this surface is a decision, never an accident.
import { getDb } from './db.js';
import { createForTenant, type ForTenant, type TenantDb } from './for-tenant.js';

export type { DB } from './generated/db.js';
export type { TenantDb, ForTenant };
export { InvalidTenantIdError } from './tenant-id.js';
export {
  createMigrator,
  migrateToLatest,
  migrateDownToStart,
  MIGRATION_FOLDER,
} from './migrator.js';

// D14 (10-db-schema §6.4) — the auth-entry cross-tenant lookups. These are the ONLY exported
// paths that read across tenants; each is a fixed, keyed, definer-gated lookup (never a raw
// handle, never an arbitrary query). Token verification and login need them because they resolve
// the tenant FROM an opaque credential before the tenant is known (api/02-auth §4.2/§8).
export {
  findDeviceByTokenHash,
  findControlSessionByTokenHash,
  findLoginCredential,
  type DeviceAuthRecord,
  type ControlSessionAuthRecord,
  type LoginCredentialRecord,
} from './auth-entry.js';

/**
 * Runs `fn` inside a transaction bound to `tenantId`.
 *
 * The transaction sets `app.tenant_id` (transaction-local) before `fn` sees the handle, so
 * every statement inside is filtered by the RLS policies of 10-db-schema §6.2. The handle is
 * only valid for the duration of `fn`.
 *
 * ```ts
 * const rows = await forTenant(tenantId, (db) => db.selectFrom('notes').selectAll().execute());
 * ```
 *
 * Do not add a `WHERE tenant_id = ...` filter — RLS applies it, and a hand-written filter that
 * disagrees with the GUC is a bug waiting to happen.
 */
export const forTenant: ForTenant = (tenantId, fn) => createForTenant(getDb())(tenantId, fn);

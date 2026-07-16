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

// Task 47 — the SERVER projection watermark store (10-db §8, 04 §4.3), moved here from
// apps/server so the real-PG16 lane executes it rather than a hand-copied mirror (watermarks.ts
// header). A deliberate surface addition, weighed against D7/FR-1039 rather than waved through:
// it does not hand back a handle, it REQUIRES one the caller already holds from `forTenant`, and
// it returns a three-method store with no `selectFrom` — so "forTenant is the only exported way
// to reach a tenant table" is untouched, and export-surface.test.ts's `queryish` assertion still
// holds. Its consumer is apps/server's push transaction (task 49).
export { createServerWatermarkStore } from './watermarks.js';

// Task 49 — the SERVER projection engine factory (10-db §3 step 6, 04 §4). Same D7 weighing as
// the watermark store: it CONSUMES a `forTenant` handle rather than producing one, and returns a
// `ProjectionEngine` (apply/rebuild methods, no `selectFrom`), so the export-surface `queryish`
// assertion still holds. Homing the ONE construction here — not inline in the pipeline — is what
// lets `pnpm test:rls` execute the exact engine the push path runs (projection-apply.ts header).
export { createServerProjectionEngine } from './projection-apply.js';

// Task 17 — Rule 1's candidate query (01 §8.2), homed here for the third time for the same reason
// (conflict-candidates.ts header): `pnpm test:rls` is `--project db-server`, so this is the only
// package whose code the attributed real-PG16 lane can execute, and D16 forbids a substitute from
// being the sole witness for a claim about the production driver. Rule 1 is an `int8` comparison
// (`server_seq > last_pull_cursor`) — the exact class PGlite is measurably blind to (T-14f: 14/14
// green vs 4 red on real `pg`). Same D7 weighing as the two above: it CONSUMES a tenant-bound
// handle rather than producing one, and returns plain records with no `selectFrom`, so the
// `queryish` assertion in export-surface.test.ts still holds.
export {
  findRule1Candidates,
  type Rule1Candidate,
  type Rule1Probe,
} from './conflict-candidates.js';

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

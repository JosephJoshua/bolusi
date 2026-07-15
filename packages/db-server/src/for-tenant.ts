// forTenant(tenantId) — the ONLY exported way to query tenant tables (decision D7, FR-1039).
//
// Two mandatory layers (10-db-schema §6, security-guide §8):
//   1. THIS wrapper — ergonomics/testability. The raw Kysely handle is not exported, so an
//      unscoped query is not expressible at the API level.
//   2. Postgres RLS — enforcement. A forgotten WHERE returns zero rows / fails on write
//      instead of another tenant's data. This wrapper is NOT the guarantee; RLS is.
//
// Anything here that looks redundant with RLS is deliberate: the layers are independent.
import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from './generated/db.js';
import { assertTenantId } from './tenant-id.js';

/** A tenant-bound Kysely handle. It is a transaction: it lives only inside `forTenant`'s callback. */
export type TenantDb = Transaction<DB>;

export type ForTenant = <T>(tenantId: string, fn: (db: TenantDb) => Promise<T>) => Promise<T>;

export interface TenantScopeOptions {
  /**
   * TEST-ONLY. `SET LOCAL ROLE <role>` immediately after BEGIN.
   *
   * Production connects AS `bolusi_app` (§6.3), so production never needs this. Tests connect
   * as the owner/superuser — and owners/superusers bypass RLS, which makes an RLS suite pass
   * VACUOUSLY (testing-guide §2.5, the PGlite owner-bypass trap). The RLS harness therefore
   * sets the role inside the transaction so the policies are actually exercised.
   *
   * Not reachable from the package entry point: `src/index.ts` exports only the bound
   * `forTenant`, so no caller outside this package can pass a role.
   */
  role?: string;
}

/**
 * Builds a `forTenant` bound to a specific Kysely instance.
 *
 * Internal: exported for the RLS harness and unit tests inside this package only — it is NOT
 * re-exported from `src/index.ts`, because taking a `Kysely` argument would hand callers the
 * raw-handle escape hatch that D7 exists to close.
 */
export function createForTenant(db: Kysely<DB>, options: TenantScopeOptions = {}): ForTenant {
  return async function forTenant<T>(tenantId: string, fn: (db: TenantDb) => Promise<T>) {
    // Validate BEFORE opening a transaction: a bad id must not reach set_config or burn a
    // pooled connection.
    const validTenantId = assertTenantId(tenantId);

    return db.transaction().execute(async (trx) => {
      if (options.role !== undefined) {
        await sql`SET LOCAL ROLE ${sql.id(options.role)}`.execute(trx);
      }

      // §6.1: transaction-local ONLY (is_local = true). Session-level SET is FORBIDDEN — it
      // leaks tenant context to whatever request gets this pooled connection next. Kysely
      // transactions pin one connection, so is_local is both safe and sufficient.
      // The id is a bound parameter, never interpolated.
      await sql`SELECT set_config('app.tenant_id', ${validTenantId}, true)`.execute(trx);

      return fn(trx);
    });
  };
}

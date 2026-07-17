// Request-scoped tenant helper (api/00 §3.1, 10-db-schema §6). `tenantId` is derived
// EXCLUSIVELY from the bearer principal — never a body, path, or header (a body tenant claim is
// validated against the token elsewhere and rejected on mismatch, 05-operation-log §9). The
// helper opens the @bolusi/db-server `forTenant` transaction, whose first statement is
// `select set_config('app.tenant_id', $1, true)` (transaction-local; RLS backstops it).
//
// This is the ONLY way a handler reaches tenant tables: apps/server imports no raw pg handle and
// no deep db-server path (bolusi/boundaries enforces it), so an unscoped query is inexpressible.
import type { ForTenant, TenantDb } from '@bolusi/db-server';
import type { Context } from 'hono';

import type { AppEnv } from './env.js';
import { ApiError } from './errors.js';

/** The request's tenant id, from the bearer context only (§3.1). */
export function tenantIdFromContext(c: Context<AppEnv>): string {
  const device = c.get('device');
  if (device !== undefined) return device.tenantId;
  const control = c.get('controlSession');
  if (control !== undefined) return control.tenantId;
  // Reaching a tenant-scoped handler with no principal is a middleware/routing bug, not a
  // client error — fail as INTERNAL rather than silently querying tenant 'undefined'.
  throw new ApiError('INTERNAL');
}

export type WithTenant = <T>(c: Context<AppEnv>, fn: (db: TenantDb) => Promise<T>) => Promise<T>;

/** Binds a `withTenant(c, fn)` to a `forTenant` (db-server's in production; a real-PG16-backed one
 *  in the L3 test lane). It derives the tenant id from context and runs `fn` inside the tx. */
export function createWithTenant(forTenant: ForTenant): WithTenant {
  return (c, fn) => forTenant(tenantIdFromContext(c), fn);
}

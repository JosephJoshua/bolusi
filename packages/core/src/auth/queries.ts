// The `auth` module's queries (04 §6). One: `listPermissionDenials` — the read path 02-permissions
// §7 / FR-1045 names for the denial audit trail, gated by `auth.audit_view`, cursor-paginated.
//
// WHY THIS LIVES HERE AT ALL. Everything AROUND this query shipped — the permission was seeded
// (db-server 0008), registered (the `auth` module manifest; the server projects it via
// identity/permissions.ts), and an index was built
// specifically to serve it (db-server 0005, trailing comment `listPermissionDenials`) — but the
// query itself existed only in a test fixture. Without it, the write-only audit had no reader, and
// this task's own falsification ("break the applier, watch the audit go empty") had nothing to run
// against. Shipping it makes the fold observable through the seam it is meant to be read from.
//
// THE GATE DECIDES WHAT IS SELECTED (02 §9). `auth.audit_view` is checked at the single enforcement
// point (02 §4) BEFORE the handler runs — a caller without it gets `PERMISSION_DENIED`, never an
// empty page. Rows are then scoped to `qctx.tenantId`/`qctx.storeId` (minted by the runtime, never
// from the input or cursor), so a hand-crafted cursor can name a position but not a tenant/store.
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../query/cursor.js';
import type { QueryContext, QueryPage } from '../query/qctx.js';
import { AUTH_PERMISSION } from './operations.js';
import type { AuthDatabase } from './schema.js';

/** Sort options (04 §6). The id tiebreaker is implicit — see `cursor.ts`. Newest-first by default:
 *  an audit reader wants the most recent denials, and a total order needs the id tiebreak. */
export type DenialSort = 'timestampMs.desc' | 'timestampMs.asc';

/**
 * `listPermissionDenials` input (04 §6). `limit`'s `.max(100)` is the SCHEMA's job: an over-large
 * limit is `VALIDATION_FAILED` at execute step 1 and the handler never runs, so a caller cannot ask
 * for 10,000 rows and have the handler quietly clamp it. `.strict()` rejects unknown keys.
 */
export const listPermissionDenialsInput = z
  .object({
    permissionId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    sort: z.enum(['timestampMs.desc', 'timestampMs.asc']).default('timestampMs.desc'),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ListPermissionDenialsInput = z.infer<typeof listPermissionDenialsInput>;

/**
 * A `listPermissionDenials` row (02-permissions §7 payload projection). NO gated fields: `audit_view`
 * is a plain access check — you may read the audit trail in your scope, or you get a
 * `PERMISSION_DENIED` error, never a partially-blanked row (02 §9's field-gating vocabulary pins its
 * one v0 data-gating case elsewhere).
 */
export interface PermissionDenialRow {
  readonly id: string;
  readonly storeId: string | null;
  readonly scopeStoreId: string | null;
  readonly userId: string;
  readonly deviceId: string;
  readonly timestampMs: number;
  readonly permissionId: string;
  readonly surface: string;
  readonly target: string | null;
  readonly reason: string;
  readonly suppressedRepeats: number;
}

export async function listPermissionDenialsHandler(
  input: ListPermissionDenialsInput,
  qctx: QueryContext<AuthDatabase>,
): Promise<QueryPage<PermissionDenialRow>> {
  const descending = input.sort === 'timestampMs.desc';

  let query = qctx.db
    .selectFrom('authPermissionDenials')
    .select([
      'id',
      'storeId',
      'scopeStoreId',
      'userId',
      'deviceId',
      'timestampMs',
      'permissionId',
      'surface',
      'target',
      'reason',
      'suppressedRepeats',
    ])
    // Scope comes from `qctx` (runtime-minted), NEVER the input/cursor — what makes an unsigned
    // cursor safe (query/cursor.ts). Denials are store-scoped (all auth ops are, api/02-auth §6.2);
    // the `store_id IS NULL` arm mirrors listConflicts for tenant-scoped rows should any ever exist.
    // Tenant-wide audit rows requiring a tenant-wide grant (02 §9.4) is a finer v1 refinement.
    .where('tenantId', '=', qctx.tenantId)
    .where((eb) => eb.or([eb('storeId', '=', qctx.storeId), eb('storeId', 'is', null)]))
    .orderBy('timestampMs', descending ? 'desc' : 'asc')
    // The id tiebreaker makes the order TOTAL — without it two denials sharing a timestamp have no
    // defined relative order, and a page boundary between them drops or repeats one.
    .orderBy('id', descending ? 'desc' : 'asc');

  if (input.permissionId !== undefined) {
    query = query.where('permissionId', '=', input.permissionId);
  }
  if (input.reason !== undefined) {
    query = query.where('reason', '=', input.reason);
  }

  if (input.cursor !== undefined) {
    const position = decodeCursor(input.cursor, input.sort);
    const [lastTimestamp, lastId] = position.values as [number, string];
    query = query.where((eb) =>
      eb.or([
        eb('timestampMs', descending ? '<' : '>', lastTimestamp),
        eb.and([eb('timestampMs', '=', lastTimestamp), eb('id', descending ? '<' : '>', lastId)]),
      ]),
    );
  }

  // One MORE than asked: how "is there a next page?" is answered without a second COUNT, and what
  // makes the last page's `nextCursor` null rather than a cursor yielding an empty page (04 §6).
  const found = await query.limit(input.limit + 1).execute();
  const hasMore = found.length > input.limit;
  const page = hasMore ? found.slice(0, input.limit) : found;

  const rows: PermissionDenialRow[] = page.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    scopeStoreId: row.scopeStoreId,
    userId: row.userId,
    deviceId: row.deviceId,
    timestampMs: row.timestampMs,
    permissionId: row.permissionId,
    surface: row.surface,
    target: row.target,
    reason: row.reason,
    suppressedRepeats: row.suppressedRepeats,
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ sort: input.sort, values: [last.timestampMs, last.id] })
      : null;

  return { rows, nextCursor };
}

/**
 * The `listPermissionDenials` declaration (04 §6) — permission + input + handler, exactly a
 * `QueryHandle`. `auth.audit_view` (02-permissions §11.1) gates it at the single enforcement point.
 */
export const listPermissionDenialsQuery = {
  permission: AUTH_PERMISSION.auditView,
  input: listPermissionDenialsInput,
  handler: listPermissionDenialsHandler,
} as const;

// The `platform` module's queries (04 §6). One: `listConflicts`, gated by `platform.conflict_view`.
import { z } from 'zod';

import { decodeCursor } from '../query/cursor.js';
import { fetchKeysetPage, keysetPredicate } from '../query/paginate.js';
import type { QueryContext, QueryPage } from '../query/qctx.js';
import { PLATFORM_PERMISSION, type ConflictSeverity, type ConflictStatus } from './constants.js';
import type { PlatformDatabase } from './schema.js';

/** Sort options (04 §6). The id tiebreaker is implicit — see `cursor.ts`. */
export type ConflictSort = 'detectedAt.desc' | 'detectedAt.asc';

/**
 * `listConflicts` input (04 §6).
 *
 * `limit`'s `.max(100)` is the SCHEMA's job, not the handler's: an over-large limit is
 * `VALIDATION_FAILED` at execute step 1 and the handler never runs, so a caller cannot ask the
 * database for 10,000 rows and have the handler quietly clamp it.
 *
 * `conflictId` exists so `acknowledgeConflict` can read one conflict's status through the query
 * layer — 04 §5.2 gives a handler no other read seam ("Reads only via `ctx.query`"). It is a filter
 * on the same gated query the UI uses, not a second read path (CLAUDE.md §2.8).
 */
export const listConflictsInput = z
  .object({
    conflictId: z.string().min(1).optional(),
    status: z.enum(['detected', 'auto_resolved', 'surfaced', 'acknowledged']).optional(),
    sort: z.enum(['detectedAt.desc', 'detectedAt.asc']).default('detectedAt.desc'),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ListConflictsInput = z.infer<typeof listConflictsInput>;

/**
 * A `listConflicts` row (01 §5.4).
 *
 * NO GATED FIELDS. 02 §9's field-gating vocabulary does not apply here: §9 item 4 pins the v0
 * registry's ONE data-gating case as `auth_permission_denials`, and `platform.conflict_view` is a
 * plain permission check — you see every column of every conflict in scope, or you see none of it
 * (a `PERMISSION_DENIED` error, never an empty page).
 */
export interface ConflictRow {
  readonly id: string;
  readonly storeId: string | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly conflictKey: string;
  readonly severity: ConflictSeverity;
  readonly status: ConflictStatus;
  readonly opAId: string;
  readonly opBId: string;
  readonly detectedAt: number;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: number | null;
  readonly acknowledgementOpId: string | null;
}

export async function listConflictsHandler(
  input: ListConflictsInput,
  qctx: QueryContext<PlatformDatabase>,
): Promise<QueryPage<ConflictRow>> {
  const descending = input.sort === 'detectedAt.desc';

  let query = qctx.db
    .selectFrom('conflicts')
    .select([
      'id',
      'storeId',
      'entityType',
      'entityId',
      'conflictKey',
      'severity',
      'status',
      'opAId',
      'opBId',
      'detectedAt',
      'acknowledgedBy',
      'acknowledgedAt',
      'acknowledgementOpId',
    ])
    // Scope comes from `qctx` — which the runtime minted — and NEVER from the input or the cursor.
    // This is what makes an unsigned cursor safe (query/cursor.ts).
    .where('tenantId', '=', qctx.tenantId)
    // A conflict's `storeId` is the CONFLICTED ENTITY's store, null for a tenant-scoped entity
    // (01 §5.4) — and a tenant-scoped conflict belongs to every device in the tenant, which is the
    // same routing the pull scope gives it. So: this device's store, OR tenant-scoped. Filtering
    // on `storeId = qctx.storeId` alone would silently hide every tenant-scoped conflict.
    .where((eb) => eb.or([eb('storeId', '=', qctx.storeId), eb('storeId', 'is', null)]))
    .orderBy('detectedAt', descending ? 'desc' : 'asc')
    // The id tiebreaker makes the order TOTAL. Without it two conflicts sharing a detectedAt have
    // no defined relative order, and a page boundary between them drops or repeats one.
    .orderBy('id', descending ? 'desc' : 'asc');

  if (input.conflictId !== undefined) {
    query = query.where('id', '=', input.conflictId);
  }
  if (input.status !== undefined) {
    query = query.where('status', '=', input.status);
  }

  if (input.cursor !== undefined) {
    const position = decodeCursor(input.cursor, input.sort);
    query = query.where((eb) =>
      keysetPredicate(eb, { column: 'detectedAt', idColumn: 'id', position, descending }),
    );
  }

  // The "One MORE than asked" page contract lives in fetchKeysetPage (04 §6, CLAUDE.md §2.8).
  const { rows: page, nextCursor } = await fetchKeysetPage({
    fetch: (limitPlusOne) => query.limit(limitPlusOne).execute(),
    limit: input.limit,
    sort: input.sort,
    cursorValues: (last) => [last.detectedAt, last.id],
  });

  const rows: ConflictRow[] = page.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    entityType: row.entityType,
    entityId: row.entityId,
    conflictKey: row.conflictKey,
    severity: row.severity as ConflictSeverity,
    status: row.status as ConflictStatus,
    opAId: row.opAId,
    opBId: row.opBId,
    detectedAt: row.detectedAt,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgementOpId: row.acknowledgementOpId,
  }));

  return { rows, nextCursor };
}

/**
 * The `listConflicts` declaration (04 §6) — the manifest entry AND the `QueryHandle` that
 * `acknowledgeConflict` reads through.
 *
 * ONE object, referenced twice, because a `QueryHandle` is structurally `{permission, input,
 * handler}` and a manifest query declaration already is one. A separate hand-written handle for the
 * command's read would be a second statement of "which permission gates this read" — free to drift
 * from the one the query layer actually enforces (CLAUDE.md §2.8).
 *
 * Carries its own `name` so `acknowledgeConflict` can read through it via `ctx.query` — the query
 * runtime rejects a nameless handle with `VALIDATION_FAILED` (query/execute.ts; a denial op needs it
 * for `target`, 02 §7), so without this the command is DEAD on every real invocation. `defineModule`
 * re-attaches the SAME name from the manifest key (`listConflicts`), so the two agree by
 * construction. Same pattern as notes' `getNoteQuery`.
 */
export const listConflictsQuery = {
  name: 'listConflicts',
  permission: PLATFORM_PERMISSION.conflictView,
  input: listConflictsInput,
  handler: listConflictsHandler,
} as const;

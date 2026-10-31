// Dropping what a device may no longer read (permission-scoped sync). When the server's read set
// for this device shrinks (a role lost a permission, or the device changed hands), the ops of the
// types it no longer covers come out of the local log and the records they built are re-folded
// from what remains, so neither the log nor a screen keeps them.
//
// Only PULLED ops are dropped (`arrival_seq` set). The device's own ops stay: its people wrote them,
// and its signing chain runs through them, so removing one would break every later push.
import { sql, type Kysely } from 'kysely';

/** The record an op belongs to, enough for the projection engine to re-fold it. */
export interface PurgedRecord {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface PurgeDeps<DB> {
  readonly db: Kysely<DB>;
  /** Re-fold the record from its remaining log (`ProjectionEngine.refoldEntityOf`). */
  readonly refold: (record: PurgedRecord) => Promise<void>;
  /** Keep pulled watermarks from pinning on the holes (`ProjectionEngine.catchUpPulledWatermarks`). */
  readonly catchUpWatermarks: () => Promise<void>;
}

/** Remove the pulled ops of these types and re-fold their records. Returns how many were removed. */
export async function purgePulledOps<DB>(
  deps: PurgeDeps<DB>,
  types: readonly string[],
): Promise<number> {
  if (types.length === 0) return 0;
  const found = await sql<{ type: string; entityType: string; entityId: string; n: number }>`
    SELECT type AS "type", entity_type AS "entityType", entity_id AS "entityId", COUNT(*) AS "n"
    FROM operations
    WHERE arrival_seq IS NOT NULL AND type IN (${sql.join(types)})
    GROUP BY type, entity_type, entity_id
  `.execute(deps.db);
  if (found.rows.length === 0) return 0;
  await sql`
    DELETE FROM operations WHERE arrival_seq IS NOT NULL AND type IN (${sql.join(types)})
  `.execute(deps.db);
  // One re-fold per record and module: a record touched by several dropped types of one module
  // needs it once, but the engine picks the module from the type, so key on both.
  const seen = new Set<string>();
  let removed = 0;
  for (const row of found.rows) {
    removed += Number(row.n);
    const key = `${row.type.split('.')[0] ?? ''}:${row.entityType}:${row.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await deps.refold(row);
  }
  await deps.catchUpWatermarks();
  return removed;
}

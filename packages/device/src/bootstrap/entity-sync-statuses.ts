// Per-entity op sync statuses for module screens (design-system §3.5), read from the op log: the
// projection rows carry no op status. One reader for every module; each passes its entity type.
// Node-safe (Kysely only), so the composed tests run it against the same client schema.
import type { ClientDatabase } from '@bolusi/db-client';
import type { OperationSyncStatus } from '@bolusi/ui';
import type { Kysely } from 'kysely';

/** SQLite's default bound-parameter cap is 999; stay well under it per statement. */
const ID_CHUNK = 500;

/**
 * Each entity's op statuses, as `viewerId` should see them. An entity with no rows is absent, which
 * reads as all-`synced`. A refusal counts only for the person who made it and only until they mark
 * it checked, as on the Status data screen (`readSyncStatusRows`): a colleague has nothing to redo,
 * and the refused change was already undone here.
 */
export async function readEntitySyncStatuses(
  db: Kysely<ClientDatabase>,
  entityType: string,
  entityIds: readonly string[],
  viewerId: string,
): Promise<Readonly<Record<string, readonly OperationSyncStatus[]>>> {
  const out: Record<string, OperationSyncStatus[]> = {};
  for (let start = 0; start < entityIds.length; start += ID_CHUNK) {
    const rows = await db
      .selectFrom('operations')
      .select(['entityId', 'syncStatus', 'userId', 'rejectionHandledAt'])
      .where('entityType', '=', entityType)
      .where('entityId', 'in', entityIds.slice(start, start + ID_CHUNK))
      .execute();
    for (const row of rows) {
      const refusal = row.syncStatus === 'rejected';
      if (refusal && (row.userId !== viewerId || row.rejectionHandledAt !== null)) continue;
      (out[row.entityId] ??= []).push(row.syncStatus as OperationSyncStatus);
    }
  }
  return out;
}

/**
 * Refusals of `viewerId`'s own changes to another entity type that belong to one of these entities,
 * counted per entity: a charge or payment on a servisan is a money entry whose payload names the
 * servisan. Only the unhandled refusals of the viewer, as above, so the read stays small.
 */
export async function readLinkedRefusals(
  db: Kysely<ClientDatabase>,
  entityType: string,
  viewerId: string,
  linkOf: (payload: unknown) => string | null,
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .selectFrom('operations')
    .select('signedCoreJcs')
    .where('entityType', '=', entityType)
    .where('syncStatus', '=', 'rejected')
    .where('userId', '=', viewerId)
    .where('rejectionHandledAt', 'is', null)
    .execute();
  const counts = new Map<string, number>();
  for (const row of rows) {
    // The signed core carries the payload (05 §2.1); the plugin has already opened the sealed cell.
    let payload: unknown;
    try {
      payload = (JSON.parse(row.signedCoreJcs) as { readonly payload?: unknown }).payload;
    } catch {
      continue;
    }
    const link = linkOf(payload);
    if (link !== null) counts.set(link, (counts.get(link) ?? 0) + 1);
  }
  return counts;
}

// Per-entity op sync statuses for module screens (design-system §3.5), read from the op log: the
// projection rows carry no op status. One reader for every module; each passes its entity type.
// Node-safe (Kysely only), so the composed tests run it against the same client schema.
import type { ClientDatabase } from '@bolusi/db-client';
import type { OperationSyncStatus } from '@bolusi/ui';
import type { Kysely } from 'kysely';

/** SQLite's default bound-parameter cap is 999; stay well under it per statement. */
const ID_CHUNK = 500;

/** Each entity's op statuses. An entity with no rows is absent, which reads as all-`synced`. */
export async function readEntitySyncStatuses(
  db: Kysely<ClientDatabase>,
  entityType: string,
  entityIds: readonly string[],
): Promise<Readonly<Record<string, readonly OperationSyncStatus[]>>> {
  const out: Record<string, OperationSyncStatus[]> = {};
  for (let start = 0; start < entityIds.length; start += ID_CHUNK) {
    const rows = await db
      .selectFrom('operations')
      .select(['entityId', 'syncStatus'])
      .where('entityType', '=', entityType)
      .where('entityId', 'in', entityIds.slice(start, start + ID_CHUNK))
      .execute();
    for (const row of rows) (out[row.entityId] ??= []).push(row.syncStatus as OperationSyncStatus);
  }
  return out;
}

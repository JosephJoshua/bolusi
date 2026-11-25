// Per-entity op sync statuses (design-system §3.5). The projection rows carry no op status, so the
// platform reads them from the op log and screens show a chip per row from this map.
import type { OperationSyncStatus } from '@bolusi/ui';

/** The `Operation.syncStatus` of every op backing an entity, keyed by entity id. */
export type EntitySyncStatuses = Readonly<Record<string, readonly OperationSyncStatus[]>>;

/** The op statuses backing one entity; an entity absent from the map is all-`synced`. */
export function statusesFor(
  map: EntitySyncStatuses,
  entityId: string,
): readonly OperationSyncStatus[] {
  return map[entityId] ?? [];
}

/**
 * How many of an entity's changes the server refused. A rejected op is loud and never silent
 * (05-operation-log §8): any at all drives the danger banner, which says how many.
 */
export function rejectedCount(statuses: readonly OperationSyncStatus[]): number {
  return statuses.filter((status) => status === 'rejected').length;
}

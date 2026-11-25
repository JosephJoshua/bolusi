// Clearing uploads a device started and never finished. A photo or clip whose upload stopped half
// way keeps its row and received chunks in Postgres until `complete`, which may never come: the
// phone was wiped, lost, or captured the item again. Nothing reads such a row except the device
// resuming it, and a device that returns after the sweep gets MEDIA_NOT_FOUND and starts the upload
// over from `init` (core media/drain.ts), so clearing it loses nothing.
//
// It runs inside a store's own upload `init`, not on a timer: rows only pile up while devices
// upload, so the tenant that adds new uploads is the one that clears its old ones.
import type { TenantDb } from '@bolusi/db-server';

/** An upload with no new chunk for this long is abandoned. */
export const ABANDONED_UPLOAD_MS = 48 * 60 * 60 * 1000;

/** At most this many uploads are cleared per call, so one call stays short. */
const SWEEP_BATCH = 200;

/**
 * Delete this tenant's uploads that are still `receiving` and saw neither their `init` nor any
 * chunk in the last {@link ABANDONED_UPLOAD_MS}. Returns how many were cleared.
 */
export async function sweepAbandonedUploads(
  db: TenantDb,
  tenantId: string,
  now: number,
): Promise<number> {
  const cutoff = String(now - ABANDONED_UPLOAD_MS);
  const stale = await db
    .selectFrom('media')
    .leftJoin('mediaChunks', (join) =>
      join
        .onRef('mediaChunks.tenantId', '=', 'media.tenantId')
        .onRef('mediaChunks.mediaId', '=', 'media.id'),
    )
    .select('media.id as id')
    .where('media.tenantId', '=', tenantId)
    .where('media.status', '=', 'receiving')
    .where('media.createdAt', '<', cutoff)
    .groupBy('media.id')
    .having((eb) =>
      eb.or([
        eb(eb.fn.max('mediaChunks.receivedAt'), 'is', null),
        eb(eb.fn.max('mediaChunks.receivedAt'), '<', cutoff),
      ]),
    )
    .limit(SWEEP_BATCH)
    .execute();
  if (stale.length === 0) return 0;
  const ids = stale.map((row) => row.id);
  await db
    .deleteFrom('mediaChunks')
    .where('tenantId', '=', tenantId)
    .where('mediaId', 'in', ids)
    .execute();
  const deleted = await db
    .deleteFrom('media')
    .where('tenantId', '=', tenantId)
    .where('id', 'in', ids)
    .where('status', '=', 'receiving')
    .executeTakeFirst();
  return Number(deleted.numDeletedRows);
}

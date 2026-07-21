// The PRUNING ACTOR — 06-media-pipeline §7.
//
// Core's `pruning.ts` decides and this file acts; that split is task 18's and it is why every
// threshold in §7 is already tested under a FakeClock with no filesystem. What was missing is the
// half that touches the disk, and its absence had a specific shape worth naming: `prunePlanFor` had
// eleven sound tests and ZERO callers, so a green suite proved that a correct decision was being
// computed and thrown away. Nothing about that is visible in a test run (§2.11's newest class).
//
// ── THE LOAD-BEARING NEGATIVE ───────────────────────────────────────────────────────────────────
// `pending` / `uploading` / `failed` media is NEVER pruned, at any storage level (§7). This file
// does not re-implement that rule and must not: every row goes through `prunePlanFor`, which owns
// it, and nothing below branches on `uploadStatus` at all. A future "free up space" feature that
// wants to drop a failed item has to change that function, in the open — it cannot be done by
// tuning a threshold here. The suite next to this file proves it by driving a `failed` item through
// the actor at 10 MB free (below every band, including capture-refused) and asserting the file
// survives; break the rule in core and it goes red HERE too, which is the point of routing through it.
//
// ── ORDER: FILE FIRST, THEN ROW ─────────────────────────────────────────────────────────────────
// For `delete_row_and_file` the file goes first and the row second. If the process dies between
// them, the survivor is a row whose `local_path` points at a deleted file — which the next pass
// re-evaluates and re-deletes idempotently (`deleteFile` treats a missing file as success, per
// `MediaFilePort`'s contract). The other order leaves an ORPHANED FILE with no row naming it,
// which nothing in this system will ever look at again: unreclaimable bytes on a 32 GB device.
import {
  bandFor,
  prunePlanFor,
  remoteCacheEvictions,
  type ClockPort,
  type MediaFilePort,
  type StorageBand,
} from '@bolusi/core';
import type { Kysely } from 'kysely';

import { clearLocalPath, deleteMediaRow, selectPrunable } from './queue.js';

/** §7: "at most once per hour". */
export const PRUNE_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** One entry in the remote render cache (06 §6). */
export interface RemoteCacheEntry {
  readonly id: string;
  /**
   * Last-used timestamp, for §7's "evicted oldest-first".
   *
   * The adapter derives this from the cache file's `modificationTime`, which SDK 57 types as
   * `number | null`. A null is carried as `0` HERE, at the adapter boundary and nowhere else,
   * because the meaning is exact rather than invented: this is an eviction ordering over a cache
   * every part of the spec calls "evictable any time … they are re-fetchable", so an entry of
   * unknown age sorting first costs one re-download and never a byte of evidence. That is the one
   * shape T-19 permits — a defaulted value whose wrongness cannot produce a plausible-looking lie.
   */
  readonly lastUsedAt: number;
}

/** §7 runs the pass on these occasions. Named so the throttle can be reasoned about per source. */
export type PruneReason = 'app_start' | 'after_drain' | 'periodic';

export interface PruneReport {
  readonly band: StorageBand;
  /** §7's `delete_file`: file gone, row kept with `localPath = null`. */
  readonly filesDeleted: number;
  /** §7's orphan rule: file AND row gone. */
  readonly rowsDeleted: number;
  readonly cacheEvicted: number;
  readonly at: number;
}

export interface PruningDeps<DB> {
  readonly db: Kysely<DB>;
  readonly files: MediaFilePort;
  readonly clock: ClockPort;
  /** `Paths.availableDiskSpace` (files.ts), never the throwing legacy `getFreeDiskStorageAsync`. */
  readonly freeSpaceBytes: () => number;
  /** The remote render cache's current contents (06 §6). */
  readonly listRemoteCache: () => readonly RemoteCacheEntry[];
  readonly evictRemoteCache: (id: string) => Promise<void>;
}

export interface PruningPass {
  /**
   * Run the pass, unless the throttle says otherwise.
   *
   * @returns the report, or `null` when the run was throttled — `null` is "did not run", which a
   * caller must be able to tell from "ran and deleted nothing". Returning a zeroed report for both
   * would make a throttled pass indistinguishable from a clean one in any diagnostic.
   */
  run(reason: PruneReason): Promise<PruneReport | null>;
  /** The band from the most recent run, for the storage banners (§7). `null` before the first run. */
  lastBand(): StorageBand | null;
}

export function createPruningPass<DB>(deps: PruningDeps<DB>): PruningPass {
  let lastRunAt: number | null = null;
  let band: StorageBand | null = null;

  return {
    lastBand: () => band,

    async run(reason): Promise<PruneReport | null> {
      const now = deps.clock.now();
      const freeBytes = deps.freeSpaceBytes();
      const currentBand = bandFor(freeBytes);

      // §7's throttle, with the two exemptions the spec itself states. `app_start` is one of the
      // three named occasions and cannot be throttled by a timestamp from the PREVIOUS process (the
      // clock is wall time, not uptime — a phone restarted after 5 minutes would otherwise skip its
      // boot pass). And any band below `normal` says "immediate pruning pass" in so many words, so
      // a device filling up is not made to wait out an hour it does not have.
      const throttled =
        reason !== 'app_start' &&
        currentBand === 'normal' &&
        lastRunAt !== null &&
        now - lastRunAt < PRUNE_MIN_INTERVAL_MS;
      if (throttled) return null;

      lastRunAt = now;
      band = currentBand;

      let filesDeleted = 0;
      let rowsDeleted = 0;
      for (const item of await selectPrunable(deps.db)) {
        // EVERY row goes through core's decision. No `if` on status lives in this file.
        const action = prunePlanFor(item, now, freeBytes);
        if (action === 'keep') continue;
        if (item.localPath !== null) {
          await deps.files.deleteFile(item.localPath);
        }
        if (action === 'delete_file') {
          await clearLocalPath(deps.db, item.id);
          filesDeleted += 1;
        } else {
          // File first, row second — see the header.
          await deleteMediaRow(deps.db, item.id);
          rowsDeleted += 1;
        }
      }

      // §6/§7: the remote cache is evictable any time, oldest-first, and fully evicted below 200 MB.
      // Core sorts and selects; this loop only deletes.
      const evictions = remoteCacheEvictions(deps.listRemoteCache(), freeBytes);
      for (const id of evictions) await deps.evictRemoteCache(id);

      return {
        band: currentBand,
        filesDeleted,
        rowsDeleted,
        cacheEvicted: evictions.length,
        at: now,
      };
    },
  };
}

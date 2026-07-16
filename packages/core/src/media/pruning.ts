// Storage management (06-media-pipeline §7) — eligibility computation, platform-free.
//
// This module DECIDES; the mobile adapter ACTS (deletes files, reads free space). The split is
// what lets every threshold below be tested under a FakeClock with no filesystem — and 06 §7's
// rules are exactly the kind that rot silently if they can only be tested on a device.

/** 06 §7's pinned retention: the local file is deleted 7 days after `uploadedAt`. */
export const UPLOADED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 06 §4/§7: an unattached capture is debris — file AND row deleted 24 h after `capturedAt`. */
export const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 06 §7's low-storage thresholds, in bytes. MB here is 10^6, matching how devices report free space. */
export const STORAGE_WARNING_BYTES = 500 * 1_000_000;
export const STORAGE_LOUD_BYTES = 200 * 1_000_000;
export const STORAGE_CAPTURE_REFUSED_BYTES = 50 * 1_000_000;

/**
 * 06 §7's free-space bands. Ordered worst-first; `bandFor` returns the first match, so the bands
 * cannot overlap-by-accident the way a chain of independent `if (free < X)` checks can.
 */
export type StorageBand = 'capture_refused' | 'loud' | 'warning' | 'normal';

export function bandFor(freeBytes: number): StorageBand {
  if (freeBytes < STORAGE_CAPTURE_REFUSED_BYTES) return 'capture_refused';
  if (freeBytes < STORAGE_LOUD_BYTES) return 'loud';
  if (freeBytes < STORAGE_WARNING_BYTES) return 'warning';
  return 'normal';
}

/**
 * 06 §7: "< 50 MB ⇒ capture is **refused with an explicit error dialog** — never a silent camera
 * failure". PRD-012 §6's reasoning is quoted in the spec and worth keeping in front of the next
 * reader: a silent camera death "will be discovered at the worst moment".
 */
export function isCaptureRefused(freeBytes: number): boolean {
  return bandFor(freeBytes) === 'capture_refused';
}

/**
 * 06 §7: "< 200 MB ⇒ uploaded-media retention window drops to 0 (prune all uploaded now)".
 * Every other band keeps the 7-day window.
 */
export function retentionWindowMs(freeBytes: number): number {
  return bandFor(freeBytes) === 'loud' || bandFor(freeBytes) === 'capture_refused'
    ? 0
    : UPLOADED_RETENTION_MS;
}

/** The subset of a `media_items` row pruning needs. */
export interface PrunableItem {
  readonly id: string;
  readonly localPath: string | null;
  readonly uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  readonly attachedToOperationId: string | null;
  readonly capturedAt: number;
  readonly uploadedAt: number | null;
}

/**
 * What the pruning pass should do with one row.
 *  - `delete_file` — 06 §7: the file goes, "the `MediaItem` row is kept forever with
 *    `localPath = null` (the record is the index into server media; deleting rows would orphan
 *    `mediaRef`s)". This is the "pruned" state, which 10-db §9.4 stores NOWHERE: it is DERIVED as
 *    `local_path IS NULL AND upload_status = 'uploaded'`.
 *  - `delete_row_and_file` — the orphan rule (§4/§7). Only ever an unattached capture.
 *  - `keep` — everything else.
 */
export type PruneAction = 'keep' | 'delete_file' | 'delete_row_and_file';

/**
 * 06 §7's eligibility rules, as one total function over a row.
 *
 * THE LOAD-BEARING NEGATIVE: `pending`/`uploading`/`failed` media is "**never pruned
 * automatically**, regardless of storage pressure — it is un-uploaded evidence". `freeBytes` is
 * accepted here and deliberately does NOT gate that: no band, however desperate, deletes evidence
 * that has not reached the server. The parameter exists only to collapse the uploaded-retention
 * window to 0 (§7's < 200 MB row). A future "free some space" feature that wants to drop a
 * `failed` item has to change this function, in the open, rather than tune a threshold.
 *
 * Ordering matters: the orphan rule is checked BEFORE the status rules, because an orphan is
 * `pending` (never attached, so never uploaded) and the "never prune pending" rule would otherwise
 * keep every abandoned capture forever.
 */
export function prunePlanFor(item: PrunableItem, now: number, freeBytes: number): PruneAction {
  // Orphan (06 §4): attachedToOperationId still null 24 h after capture ⇒ row AND file.
  if (item.attachedToOperationId === null) {
    return now - item.capturedAt >= ORPHAN_RETENTION_MS ? 'delete_row_and_file' : 'keep';
  }
  // Un-uploaded evidence is never pruned, at any storage level (§7).
  if (item.uploadStatus !== 'uploaded') return 'keep';
  // Already pruned — idempotent.
  if (item.localPath === null) return 'keep';
  // 03 §4: `uploadedAt` is set only on `complete` success. A null here with status `uploaded`
  // would be a bug; treat it as not-yet-eligible rather than deleting on an unknown clock.
  if (item.uploadedAt === null) return 'keep';
  return now - item.uploadedAt >= retentionWindowMs(freeBytes) ? 'delete_file' : 'keep';
}

/**
 * 06 §6/§7: the remote cache is "evictable any time; evicted **oldest-first** when any threshold
 * below trips", and fully evicted below 200 MB.
 *
 * Returns the ids to evict, oldest-first. `entries` need not be sorted — sorting here rather than
 * trusting the caller is what makes "oldest-first" a property of this function and not of five
 * call sites.
 */
export function remoteCacheEvictions(
  entries: readonly { readonly id: string; readonly lastUsedAt: number }[],
  freeBytes: number,
): readonly string[] {
  const band = bandFor(freeBytes);
  if (band === 'normal') return [];
  const oldestFirst = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  // < 200 MB (and the < 50 MB band below it): "remote cache fully evicted" (§7).
  if (band === 'loud' || band === 'capture_refused') return oldestFirst.map((e) => e.id);
  // < 500 MB: "immediate pruning pass" — the cache is evictable, oldest-first. Half is a
  // proportional response that keeps recently-viewed evidence renderable while freeing space.
  return oldestFirst.slice(0, Math.ceil(oldestFirst.length / 2)).map((e) => e.id);
}

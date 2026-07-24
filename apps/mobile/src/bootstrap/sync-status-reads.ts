/**
 * The Sync Status screen's DERIVED READS (01-domain-model §5.2; design-system §8.4 items 2/4/5).
 *
 * ── WHY THIS FILE EXISTS (task 130) ─────────────────────────────────────────────────────────────
 * `shell-inputs.ts` handed the screen `pendingOperationCount: 0`, `rejected: []` and `media: []` as
 * LITERALS, with a comment promising they "become real reads alongside the notes module (task 25)
 * that first produces ops to count". Notes landed (96/119) and this did not, so the shipping app has
 * a Sync Status screen whose §8.4 item 4 (rejected list) and item 5 (media queue) CANNOT RENDER — not
 * because the device has nothing to show, but because the input says it has nothing to show.
 *
 * That is what made `onOpenRejected` / `onRetryMedia` unfalsifiable as well as unwired: a composed
 * test cannot press a row that no input can produce, so wiring the callbacks alone would have
 * shipped two more controls whose green proves nothing (CLAUDE.md §2.11). The rows had to become
 * real before the controls could be watched working.
 *
 * ── NODE-SAFE ───────────────────────────────────────────────────────────────────────────────────
 * Kysely + generated types only. No native import, so the composed test lane runs it against the
 * same better-sqlite3 client DB the app runs against op-sqlite.
 */
import { pendingMediaCount, pendingOperationCount } from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import type { Kysely } from 'kysely';

import type { MediaRow, MediaUploadStatus, RejectedOpRow } from '../screens/sync-status/model.js';

/**
 * Cap on the rejected list. §8.4 item 4 renders one `ListRow` per rejected op, and 05 §8 makes a
 * rejection permanent — a device that spent a week rejecting would otherwise read its whole history
 * into memory to draw a list nobody scrolls past the top of. Newest first, so the cap drops the
 * oldest rather than hiding what just happened.
 */
export const REJECTED_LIST_LIMIT = 50;

/**
 * Cap on the media queue, for the reason the rejected list has one.
 *
 * Oldest FIRST, because the drain is oldest-evidence-first (06 §5.1) — so the head of this list is
 * the work the device is about to do next, and the cap drops the tail rather than the next item.
 */
export const MEDIA_LIST_LIMIT = 50;

/** What the screen reads from the database, as one round trip's worth of answers. */
export interface SyncStatusReads {
  readonly pendingOperationCount: number;
  readonly pendingMediaCount: number;
  readonly rejected: readonly RejectedOpRow[];
  readonly media: readonly MediaRow[];
}

/** A device with nothing read yet — the honest pre-first-read value, never a fabricated zero state. */
export const NO_SYNC_STATUS_READS: SyncStatusReads = {
  pendingOperationCount: 0,
  pendingMediaCount: 0,
  rejected: [],
  media: [],
};

/**
 * Read the four derived values §8.4 renders, from the op log and the media queue.
 *
 * DERIVED, NEVER STORED (01 §5.2): every number below is a `COUNT`/`SELECT` at read time. There is
 * no counter column to drift, which is the property that doc is protecting.
 *
 * THE COUNTERS ARE CORE'S. `pendingOperationCount`/`pendingMediaCount` are imported, not re-derived
 * — the media formula is CANONICAL (06 §4, 01 §5.2) and getting it wrong here lies to the user (see
 * the call site). The two LIST queries are this file's, because core has no list reader, only counts.
 *
 * THE MEDIA LIST IS DELIBERATELY NOT "EVERY ROW". `media_items` keeps an `uploaded` row FOREVER (06
 * §7: "the row is kept forever with `localPath = null`") and keeps ORPHAN rows for 24 h, so both are
 * filtered in the SQL to exactly the queue the counter counts. `mediaQueue`'s own `uploaded` filter
 * (model.ts) stays where it is — it is the screen's guarantee against an input that forgot, not a
 * duplicate of this.
 */
export async function readSyncStatusRows(db: Kysely<ClientDatabase>): Promise<SyncStatusReads> {
  const [operationCount, mediaCount, mediaRows, rejectedRows] = await Promise.all([
    // ── THE COUNTERS ARE CORE'S, NOT THIS FILE'S (CLAUDE.md §2.8) ────────────────────────────────
    // 06 §4 calls `pendingMediaCount`'s predicate CANONICAL and 01 §5.2 restates it verbatim, and
    // core already implements both (`packages/core/src/sync/state.ts:143,155`). This file re-derived
    // them once and got the media one WRONG in the direction that lies to the user: it counted every
    // non-`uploaded` row, so ORPHANS — captures whose command was abandoned, `attachedToOperationId`
    // still null — were reported as pending work. 06 §4: "Orphans do not count."
    //
    // That was not a theoretical drift, because THIS TASK is the orphan factory: `CaptureHost`'s
    // `onRetake` deliberately leaves the discarded row for the 24 h pruning pass. A user who retook
    // twice before keeping a shot would have seen the header chip read "Foto Belum Terkirim" on every
    // screen for up to 24 h on a device where everything was sent (`sync-status/model.ts` branches
    // the chip AND the headline on `pendingMediaCount > 0`). Telling someone work is queued when it
    // is debris is precisely the class this task exists to remove.
    pendingOperationCount(db),
    pendingMediaCount(db),
    db
      .selectFrom('mediaItems')
      .select(['id', 'uploadStatus'])
      // THE SAME PREDICATE AS THE COUNTER, so the list and the number can never disagree — a queue
      // showing rows the counter does not count is its own kind of lie. `attachedToOperationId IS
      // NOT NULL` is also what the DRAIN selects on
      // (`packages/core/src/media/repository.ts:119`, which calls it "load-bearing security, not
      // tidiness"), so an unattached row is one the drain will never touch: listing it under §8.4
      // item 5 would promise an upload that cannot happen. The partial index `idx_media_items_queue`
      // serves this, so the clause costs nothing.
      .where('attachedToOperationId', 'is not', null)
      .where('uploadStatus', '!=', 'uploaded')
      .orderBy('capturedAt', 'asc')
      .limit(MEDIA_LIST_LIMIT)
      .execute(),
    db
      .selectFrom('operations')
      .select(['id', 'type', 'timestampMs', 'rejectionCode', 'rejectionReason'])
      .where('syncStatus', '=', 'rejected')
      .orderBy('timestampMs', 'desc')
      .limit(REJECTED_LIST_LIMIT)
      .execute(),
  ]);

  const media: MediaRow[] = [];
  for (const row of mediaRows) {
    if (row.id === null) continue; // A PK is never null in practice; the generated type says it can be.
    media.push({
      mediaId: row.id,
      uploadStatus: row.uploadStatus as MediaUploadStatus,
      // 06 §5.1 (`ai-docs/06-media-pipeline.md:126`) makes the SERVER the ground truth for received
      // chunks — "local progress is display-only" — and this client persists no received-count
      // column at all (`packages/db-client/src/generated/db.ts:64-85` has `chunkSize`/`chunksTotal`
      // and nothing counting arrivals), so there is no honest percentage to render. `null` is the model's
      // "no progress to show" and the screen omits the secondary line — a fabricated percentage on
      // an evidence upload is exactly the plausible-looking number T-19 forbids.
      progressPercent: null,
    });
  }

  const rejected: RejectedOpRow[] = [];
  for (const row of rejectedRows) {
    if (row.id === null) continue;
    rejected.push({
      opId: row.id,
      type: row.type,
      at: row.timestampMs,
      // 05 §8's closed set. A rejected op with no code is a server that broke its own contract; the
      // screen keys `core.rejection.<CODE>` off this and `translateRejectionCode` already falls back
      // to `core.errors.UNEXPECTED` for an unknown one, so `UNEXPECTED` here is the SAME answer by
      // the same path rather than a second, private fallback (§2.8).
      rejectionCode: row.rejectionCode ?? 'UNEXPECTED',
      rejectionReason: row.rejectionReason,
    });
  }

  return {
    // NOT `media.length` — that was the same bug one layer up. The list is CAPPED
    // (`MEDIA_LIST_LIMIT`) and the counter is not, so a device with 60 queued photos must report 60
    // and render 50. Deriving the count from the rendered array would silently cap the truth at the
    // page size, which is the reporting equivalent of the orphan bug: a number the user believes,
    // that is not the number.
    pendingOperationCount: operationCount,
    pendingMediaCount: mediaCount,
    rejected,
    media,
  };
}

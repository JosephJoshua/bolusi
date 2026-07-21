// The CAPTURE-SIDE writes to `media_items` (06-media-pipeline §2.2 step 7, §4, §7) — the INSERT,
// the attach, and the two deletes the pruning pass performs.
//
// ── WHY THIS IS NOT IN `@bolusi/core/media/repository.ts` ───────────────────────────────────────
// That file's header calls itself "the ONLY writer of `media_items` BOOKKEEPING" and it is: every
// mutation the DRAIN LOOP performs (uploading/uploaded/failed, attempts, backoff, chunk geometry)
// lives there and nowhere else, and this file adds none of them. What it does not contain — because
// task 18 shipped the engine and deliberately not the capture half — is the row's BIRTH, its attach,
// and its death. Those are exactly the statements the capture pipeline and the pruning actor need,
// and task 82 may not edit `packages/core/src/media/**` (task 18 owns the engine). So they land
// here, beside their only callers, rather than being smuggled into the engine by a task that is not
// allowed to touch it.
//
// This is a SPLIT, not a fork (§2.8): no statement below duplicates one in core's repository, and
// the `MediaQueueItem`/`PrunableItem` shapes are IMPORTED from core rather than restated. The
// honest next step, for whoever owns 06 next, is to move these four functions into core's
// repository so `media_items` has one writer file again — recorded here so it is a decision someone
// makes rather than a drift nobody notices.
//
// IMMUTABILITY: `bolusi/no-media-column-update` bans assigning the eight frozen columns in any
// `UPDATE media_items SET`. Nothing here does: the INSERT writes them once at birth (which is what
// "frozen at capture" means), and the only UPDATE below assigns `attached_to_operation_id` and
// `local_path`, both on the rule's legitimate-to-change list. The rule was read, not assumed —
// its `rawSqlViolation` inspects the SET list of raw-`sql` templates, which is what these are.
import { sql, type Kysely } from 'kysely';

import type { PrunableItem } from '@bolusi/core';

/** The row as capture writes it (06 §2.2 step 7). Everything here is frozen from this moment on. */
export interface NewMediaItem {
  /** UUIDv7, client-generated at capture (06 §3.2). */
  readonly id: string;
  readonly tenantId: string;
  /** Null for store-less devices (api/03-media §2). */
  readonly storeId: string | null;
  readonly userId: string;
  readonly deviceId: string;
  readonly type: 'image' | 'signature';
  readonly mime: 'image/jpeg' | 'image/png';
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly capturedAt: number;
  /** The envelope's `{lat,lng,accuracyMeters}` or null, stored as JSON TEXT (10-db §9.4). */
  readonly location: { lat: number; lng: number; accuracyMeters: number } | null;
  /** Document-dir path. NEVER a cache path — 06 §2.2 step 5 moves the file first. */
  readonly localPath: string;
}

/**
 * 06 §2.2 step 7: insert the row with `uploadStatus = 'pending'`, `attachedToOperationId = null`.
 *
 * Called ONLY after the cache→document move has resolved (§2.2 step 5: "immediately, before
 * anything else references the file"). A row inserted before the move points into the OS-purgeable
 * cache directory, and §10's checklist names the failure by name: "crash between capture and move
 * loses the photo cleanly, never a dangling row". The ordering is enforced at the call site
 * (`capture.ts`), where it is also asserted.
 */
export async function insertMediaItem<DB>(db: Kysely<DB>, item: NewMediaItem): Promise<void> {
  await sql`
    INSERT INTO media_items (
      id, tenant_id, store_id, captured_by_user_id, device_id, type, mime_type, byte_size,
      sha256, captured_at, location, local_path, attached_to_operation_id, upload_status,
      upload_attempts
    ) VALUES (
      ${item.id}, ${item.tenantId}, ${item.storeId}, ${item.userId}, ${item.deviceId},
      ${item.type}, ${item.mime}, ${item.sizeBytes}, ${item.sha256}, ${item.capturedAt},
      ${item.location === null ? null : JSON.stringify(item.location)}, ${item.localPath},
      NULL, 'pending', 0
    )
  `.execute(db);
}

/**
 * 06 §4: "`attachedToOperationId` — set once when the referencing op is appended; never changed
 * afterwards." The `WHERE attached_to_operation_id IS NULL` clause is what makes "once" structural
 * rather than a convention — a second attach touches zero rows instead of re-pointing evidence at a
 * different operation.
 *
 * This is the command runtime's step (04 §5.1 step 5). It is EXPORTED and, as of this task, called
 * only by the media client's `attach` seam — the notes module's attach (task 25) is what will drive
 * it from a real command. Stated plainly rather than implied: until 25 lands, nothing in a shipping
 * user flow calls this, so nothing a user captures becomes drainable in production yet (the drain
 * selects `attached_to_operation_id IS NOT NULL`, core/repository.ts). The capture, compression,
 * move, hash, insert, prune and download halves ARE live.
 */
export async function attachMediaToOperation<DB>(
  db: Kysely<DB>,
  mediaId: string,
  operationId: string,
): Promise<void> {
  await sql`
    UPDATE media_items SET attached_to_operation_id = ${operationId}
    WHERE id = ${mediaId} AND attached_to_operation_id IS NULL
  `.execute(db);
}

/** The rows the pruning pass reasons over (06 §7). Shape imported from core, never restated. */
interface PrunableRow {
  id: string;
  localPath: string | null;
  uploadStatus: string;
  attachedToOperationId: string | null;
  capturedAt: number;
  uploadedAt: number | null;
}

/**
 * Every row with a decision to make. Rows already pruned (`local_path IS NULL`) are excluded for
 * the `uploaded` case only — an ORPHAN with a null path still owes a row deletion, so it must stay
 * in the set. Getting that backwards would leave abandoned captures in the table forever.
 *
 * Aliased to camelCase explicitly, for the reason core's `ITEM_COLUMNS` gives: `CamelCasePlugin`
 * rewrites raw-`sql` RESULT keys in the production client but not in a bare test Kysely, so a bare
 * `SELECT local_path` would arrive under two different names depending on the wiring.
 */
export async function selectPrunable<DB>(db: Kysely<DB>): Promise<readonly PrunableItem[]> {
  const result = await sql<PrunableRow>`
    SELECT id, local_path AS "localPath", upload_status AS "uploadStatus",
           attached_to_operation_id AS "attachedToOperationId",
           captured_at AS "capturedAt", uploaded_at AS "uploadedAt"
    FROM media_items
    WHERE local_path IS NOT NULL OR attached_to_operation_id IS NULL
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    localPath: row.localPath,
    uploadStatus: row.uploadStatus as PrunableItem['uploadStatus'],
    attachedToOperationId: row.attachedToOperationId,
    capturedAt: Number(row.capturedAt),
    uploadedAt: row.uploadedAt === null ? null : Number(row.uploadedAt),
  }));
}

/**
 * 06 §7's `delete_file` half: "the local file deleted 7 days after `uploadedAt`; the `MediaItem`
 * row is kept forever with `localPath = null` (the record is the index into server media; deleting
 * rows would orphan `mediaRef`s)."
 *
 * The null path is not a tombstone column — 10-db §9.4 stores no "pruned" flag — so the pruned
 * state is DERIVED as `local_path IS NULL AND upload_status = 'uploaded'` (core's `prunePlanFor`
 * says so). This statement is the only thing that produces it.
 */
export async function clearLocalPath<DB>(db: Kysely<DB>, id: string): Promise<void> {
  await sql`UPDATE media_items SET local_path = NULL WHERE id = ${id}`.execute(db);
}

/**
 * 06 §4/§7's orphan rule: row AND file deleted 24 h after `capturedAt` when never attached.
 *
 * `AND attached_to_operation_id IS NULL` is re-asserted in the statement even though
 * `prunePlanFor` already decided it. That is not belt-and-braces politeness: this is the ONLY
 * DELETE against a table whose rows are "the index into server media", and a caller bug that
 * passed an attached id would silently orphan a signed `mediaRef` with no way to find the bytes
 * again. The predicate makes that particular mistake delete nothing.
 */
export async function deleteMediaRow<DB>(db: Kysely<DB>, id: string): Promise<void> {
  await sql`
    DELETE FROM media_items WHERE id = ${id} AND attached_to_operation_id IS NULL
  `.execute(db);
}

// The ONLY writer of `media_items` bookkeeping (06 §4; 10-db §9.4).
//
// IMMUTABILITY IS STRUCTURAL, NOT POLITE. 06 §4 says of `capturedAt`/`location`/`userId`/
// `deviceId` (and §3.2's frozen `type`/`mime`/`sizeBytes`/`sha256`): "**no UPDATE path exists**
// for these columns". This file is what makes that sentence true — every mutator below names its
// columns as literals, so there is no code path that writes an immutable one, and
// `bolusi/no-media-column-update` (column-scoped, allowlisted to THIS file) makes a future one
// fail lint. The lint rule is the backstop; the absence of the code is the guarantee.
//
// Ops sync independently of media (FR-1138): every query here reads `media_items` and NOTHING
// else. There is no join to `operations`, no read of `sync_state`, and no import from `../sync/`.
// The drain loop's selection is a `media_items`-only predicate by construction.
import { sql, type Kysely } from 'kysely';

import type { MediaUploadStatus } from './upload-status.js';

/**
 * A drainable row, as the loop needs it. Deliberately NOT the whole row: the loop has no business
 * reading `location`/`userId` — it uploads bytes. `sizeBytes`/`sha256` are here because the init
 * body needs them and because `HASH_MISMATCH` re-hashing compares against `sha256`.
 */
export interface MediaQueueItem {
  readonly id: string;
  readonly localPath: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mime: string;
  readonly type: string;
  readonly capturedAt: number;
  readonly location: string | null;
  readonly userId: string;
  readonly deviceId: string;
  readonly uploadStatus: MediaUploadStatus;
  readonly uploadAttempts: number;
  readonly chunkSize: number | null;
  readonly chunksTotal: number | null;
  readonly lastErrorCode: string | null;
}

/**
 * The result shape, keyed camelCase — see `ITEM_COLUMNS` for why the aliases are explicit.
 *
 * NOTE THE TYPE IS AN ASSERTION, NOT A DERIVATION. `sql<MediaRow>` tells tsc what to believe; it
 * checks nothing. This bit me during development and it is worth the warning: the first version of
 * this file selected bare `byte_size` and typed the row `{ byte_size: number }`. It compiled, it
 * lint-passed, and every read was `undefined` at runtime (→ `Number(undefined)` = `NaN` → an init
 * body claiming `sizeBytes: NaN`). Same family as task 39's `DB`-is-`any` and task 46's int8
 * `sql<{serverSeq: number}>` over a column that returns a string: a raw-`sql<T>` is the one place
 * TypeScript will confidently describe bytes it has never seen. Only the test caught it.
 */
interface MediaRow {
  id: string;
  localPath: string | null;
  byteSize: number;
  sha256: string;
  mimeType: string;
  type: string;
  capturedAt: number;
  location: string | null;
  capturedByUserId: string;
  deviceId: string;
  uploadStatus: string;
  uploadAttempts: number;
  chunkSize: number | null;
  chunksTotal: number | null;
  lastErrorCode: string | null;
}

function toItem(row: MediaRow): MediaQueueItem {
  return {
    id: row.id,
    localPath: row.localPath,
    // 10-db §9.4's columns are INTEGER and both client engines marshal them as JS numbers, so
    // these coercions are belt-and-braces. Kept because T-14f's rule is that the DRIVER decides
    // the JS type: `Number()` costs nothing here, while an un-coerced string would break the
    // `index * chunkSize` offset arithmetic silently — exactly how the int8 watermark bug (task
    // 46) produced a wrong answer with no error and no red test.
    sizeBytes: Number(row.byteSize),
    sha256: row.sha256,
    mime: row.mimeType,
    type: row.type,
    capturedAt: Number(row.capturedAt),
    location: row.location,
    userId: row.capturedByUserId,
    deviceId: row.deviceId,
    uploadStatus: row.uploadStatus as MediaUploadStatus,
    uploadAttempts: Number(row.uploadAttempts),
    chunkSize: row.chunkSize === null ? null : Number(row.chunkSize),
    chunksTotal: row.chunksTotal === null ? null : Number(row.chunksTotal),
    lastErrorCode: row.lastErrorCode,
  };
}

/**
 * Columns ALIASED to camelCase explicitly, rather than relying on `CamelCasePlugin` to rewrite the
 * result keys — the same choice, for the same reason, as `authz/directory.ts:81`.
 *
 * The plugin is wired into the production client (`db-client/src/connection.ts:185`) and it DOES
 * rewrite raw-`sql` RESULT keys (it does not rewrite identifiers inside the SQL text — the two
 * halves of that sentence are easy to conflate and `db-client/test/dialect.test.ts:208` pins it).
 * So a bare `SELECT byte_size` arrives as `byteSize` WITH the plugin and `byte_size` WITHOUT it,
 * and this module would be correct only against whichever wiring its tests happened to use.
 * Explicit aliases are inert under both: `"byteSize"` has no underscore, so the plugin leaves it
 * alone, and the same key arrives either way. `sync/state.ts` never hit this only because its
 * aliases (`c`) are casing-neutral by luck.
 */
const ITEM_COLUMNS = sql`id, local_path AS "localPath", byte_size AS "byteSize", sha256,
  mime_type AS "mimeType", type, captured_at AS "capturedAt", location,
  captured_by_user_id AS "capturedByUserId", device_id AS "deviceId",
  upload_status AS "uploadStatus", upload_attempts AS "uploadAttempts",
  chunk_size AS "chunkSize", chunks_total AS "chunksTotal",
  last_error_code AS "lastErrorCode"`;

/**
 * The drain selection (06 §5.1), verbatim as a predicate:
 *   attachedToOperationId != null AND uploadStatus in ('pending','failed')
 *   AND (nextAttemptAt is null or nextAttemptAt <= now)  ORDER BY capturedAt ASC
 *
 * `attached_to_operation_id IS NOT NULL` is the ORPHAN EXCLUSION and it is load-bearing security,
 * not tidiness: an orphan is a capture whose command was abandoned (06 §4). Uploading one would
 * push bytes the user never committed to an operation — evidence with no signed claim attached.
 * Orphans are deleted by the pruning pass, never uploaded.
 *
 * The `nextAttemptAt <= now` gate takes `now` as an argument rather than reading a clock: core
 * owns no clock (08 §3.3 rule 3), and a backoff you cannot pin is a backoff you cannot test (T-6).
 */
export async function selectDrainable<DB>(
  db: Kysely<DB>,
  now: number,
  options: { readonly ignoreBackoff?: boolean } = {},
): Promise<readonly MediaQueueItem[]> {
  // `ignoreBackoff` serves 03 §4's MANUAL-RETRY arm. That row gives `failed → uploading` three
  // distinct triggers — "nextAttemptAt reached · manual retry · connectivity regained" — and a
  // manual retry that still waited out a 5-minute window would make the sync-status screen's retry
  // button (06 §5.2(e)) do nothing visible, which is the one thing a button must never do. The
  // connectivity arm reaches the same end by CLEARING `nextAttemptAt` (03 §4.1 says so
  // explicitly); manual has no such instruction, so it bypasses the gate for this pass instead of
  // rewriting the row — the backoff state survives, in case the manual attempt fails too.
  //
  // It does NOT bypass the exempt-code check: that lives in the drain loop and applies to every
  // trigger (06 §8 — the only remedies for LOCAL_CORRUPT/DEVICE_REVOKED are re-capture and
  // re-enrollment, so a retry button must not pretend otherwise).
  const backoffGate = options.ignoreBackoff
    ? sql`1 = 1`
    : sql`(next_attempt_at IS NULL OR next_attempt_at <= ${now})`;
  const result = await sql<MediaRow>`
    SELECT ${ITEM_COLUMNS} FROM media_items
    WHERE attached_to_operation_id IS NOT NULL
      AND upload_status IN ('pending', 'failed')
      AND ${backoffGate}
    ORDER BY captured_at ASC
  `.execute(db);
  return result.rows.map(toItem);
}

/** One row by id, or null. */
export async function findMediaItem<DB>(
  db: Kysely<DB>,
  id: string,
): Promise<MediaQueueItem | null> {
  const result = await sql<MediaRow>`
    SELECT ${ITEM_COLUMNS} FROM media_items WHERE id = ${id}
  `.execute(db);
  const row = result.rows[0];
  return row === undefined ? null : toItem(row);
}

/** `pending|failed → uploading` (03 §4). Also pins the server-dictated chunk geometry (06 §4). */
export async function markUploading<DB>(
  db: Kysely<DB>,
  id: string,
  geometry: { chunkSize: number; chunksTotal: number },
): Promise<void> {
  await sql`
    UPDATE media_items
    SET upload_status = 'uploading', chunk_size = ${geometry.chunkSize},
        chunks_total = ${geometry.chunksTotal}
    WHERE id = ${id}
  `.execute(db);
}

/**
 * `uploading → uploaded` (03 §4): `uploadAttempts` cleared, `uploadedAt` set — and `uploadedAt` is
 * set ONLY here, on a server `complete` success, because it is the prune clock (06 §7). Error
 * fields are cleared: an item that succeeded has no last error to surface.
 */
export async function markUploaded<DB>(db: Kysely<DB>, id: string, at: number): Promise<void> {
  await sql`
    UPDATE media_items
    SET upload_status = 'uploaded', uploaded_at = ${at}, upload_attempts = 0,
        next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL
    WHERE id = ${id}
  `.execute(db);
}

/**
 * `uploading → failed` (03 §4): `uploadAttempts += 1`, error recorded, `nextAttemptAt` set.
 *
 * `nextAttemptAt = null` for a non-retryable code (api/03 §8) means "no pickup" ONLY in
 * combination with `isAutoRetryable(lastErrorCode)` at selection time — null alone reads as
 * "eligible now".
 *
 * An earlier version of this comment claimed the double condition existed so that "a manual retry
 * MUST still be able to reach a LOCAL_CORRUPT item". That was false in two directions at once —
 * the code never implemented it (`pass()` applies the exemption to every trigger), and 06 §8 does
 * not want it ("the only remedies are re-capture + new op, or re-enrollment"). It is recorded here
 * rather than quietly deleted because it is this repo's most expensive failure shape: an
 * authoritative, spec-citing comment that the code below does not do, which supplies the
 * confidence that stops the next reader checking (CLAUDE.md §2.11 — "the comment was the guard").
 * It was caught by a test, not by review.
 */
export async function markFailed<DB>(
  db: Kysely<DB>,
  id: string,
  failure: { code: string; message: string | null; nextAttemptAt: number | null },
): Promise<void> {
  await sql`
    UPDATE media_items
    SET upload_status = 'failed', upload_attempts = upload_attempts + 1,
        last_error_code = ${failure.code}, last_error_message = ${failure.message},
        next_attempt_at = ${failure.nextAttemptAt}
    WHERE id = ${id}
  `.execute(db);
}

/**
 * Crash recovery (03 §4, `uploading --app restart finds no live upload task--> pending`).
 *
 * Runs at startup ONLY. An `uploading` row with no live task is by definition a process that died
 * mid-upload: there is no in-memory task to adopt, so the row is walked back to `pending` and the
 * next drain re-fetches `receivedChunks` from the server — resume, never restart (06 §5.1). Note
 * what is deliberately NOT reset: `uploadAttempts` (the surfacing counter survives a crash) and
 * the pinned `chunk_size`/`chunks_total` (re-`init` returns the same geometry; keeping it means a
 * crash loses no server facts).
 *
 * @returns the number of rows recovered, or `null` when the driver does not report a count.
 *
 * NEVER GATE ON THIS BEING > 0, and note that an earlier version of this comment invited exactly
 * that: it said "the caller asserts it rather than trusting a silent 0 (T-14b)" while the line
 * below laundered an unreported count into `0` with `?? 0` — three lines apart, same author, same
 * sitting. The comment promised the count distinguished real-zero from nothing-happened; the code
 * guaranteed it could not (§2.11: the comment was the guard).
 *
 * `null` is now that distinction, and it is load-bearing because of T-14f: `numAffectedRows` is a
 * DRIVER fact. better-sqlite3 (the test lane) reports it — the suite asserts `1` and would go red
 * if it stopped. **op-sqlite, the production driver, is unverified: no lane runs it (no device —
 * D12/D13).** So a caller writing `if (recovered > 0) requestDrain()` would work in every test and
 * could silently never fire on a real phone, leaving crash-recovered uploads sitting until some
 * other trigger happened by. `null` makes that caller's mistake a type error instead of a
 * production ghost.
 *
 * The recovery itself does NOT depend on the count: the UPDATE runs regardless, so an unreported
 * count costs a return value, never the reconciliation. That is why this returns `null` rather
 * than throwing — a driver quirk must not stop the app booting.
 */
export async function recoverInterruptedUploads<DB>(db: Kysely<DB>): Promise<number | null> {
  const result = await sql`
    UPDATE media_items SET upload_status = 'pending' WHERE upload_status = 'uploading'
  `.execute(db);
  return result.numAffectedRows === undefined ? null : Number(result.numAffectedRows);
}

/**
 * Connectivity regained (03 §4.1): every `failed` item becomes immediately eligible —
 * `nextAttemptAt` cleared, `uploadAttempts` RETAINED for the surfacing threshold.
 *
 * The non-retryable exemption is honoured here rather than left to selection: an item whose
 * `lastErrorCode` is LOCAL_CORRUPT/DEVICE_REVOKED/INIT_MISMATCH/MIME_MISMATCH is not made
 * eligible by a network coming back — the network was never its problem (api/03 §8).
 */
/** @returns rows made eligible, or `null` when the driver reports no count (see
 * `recoverInterruptedUploads` — same T-14f caveat; the UPDATE runs either way and `drain.ts`
 * discards this value). */
export async function clearBackoffForRetry<DB>(
  db: Kysely<DB>,
  nonRetryableCodes: readonly string[],
): Promise<number | null> {
  const result = await sql`
    UPDATE media_items SET next_attempt_at = NULL
    WHERE upload_status = 'failed'
      AND (last_error_code IS NULL OR last_error_code NOT IN (${sql.join(
        nonRetryableCodes.map((c) => sql`${c}`),
      )}))
  `.execute(db);
  return result.numAffectedRows === undefined ? null : Number(result.numAffectedRows);
}

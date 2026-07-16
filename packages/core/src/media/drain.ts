// The upload drain loop (06-media-pipeline §5.1–§5.3), the applier of 03 §4's machine.
//
// SINGLE-FLIGHT IS CLAIMED SYNCHRONOUSLY — the same trick, and the same reason, as sync/loop.ts.
// `requestDrain` checks `running` and sets it with NO `await` in between. JS concurrency is
// interleaving at await points, so a guard that awaited anything before claiming the slot would
// let N triggers all pass the check and start N cycles. That is not a rare race: 06 §5.2 has five
// trigger sources, and the 60 s periodic firing while a connectivity event lands is the NORMAL
// case, not the unlucky one. Two concurrent passes would upload the same item twice.
//
// FR-1138 — OPS SYNC INDEPENDENTLY OF MEDIA. This file imports nothing from `../sync/`, reads no
// op table, and is never awaited by the op push path. The coupling this invariant forbids would be
// invisible in a green test suite (both loops would still work — one would just be blocked behind
// the other on a 3G uplink), so it is enforced structurally: the selection predicate is
// `media_items`-only (repository.ts), and the import graph is asserted — with its own denominators
// and a positive control — in `test/media/sync-independence.test.ts`. (That test exists because
// this comment claimed it did before it was written; review-18 caught the claim.)
import type { ClockPort } from '../runtime/ports.js';
import { runTransition } from '../state-machines/executor.js';
import { isPersistentlyFailing, mediaBackoffDelayMs } from './backoff.js';
import {
  DRAIN_HALTING_CODES,
  LOCAL_CORRUPT_ERROR_CODE,
  MEDIA_ERROR_CODES,
  MediaTransportError,
  isAutoRetryable,
  type MediaFilePort,
  type MediaTransportPort,
} from './ports.js';
import {
  clearBackoffForRetry,
  markFailed,
  markUploaded,
  markUploading,
  selectDrainable,
  type MediaQueueItem,
} from './repository.js';
import {
  MEDIA_UPLOAD_STATUS_MACHINE,
  type MediaUploadEvent,
  type MediaUploadStatus,
} from './upload-status.js';
import type { Kysely } from 'kysely';

/** 06 §5.2's trigger sources. Named so a test asserts the coalescing per source, not per call. */
export type MediaDrainTrigger =
  'connectivity' | 'capture' | 'periodic' | 'background_task' | 'manual';

/**
 * What the loop surfaces (06 §8: "Silent failure is unacceptable"). Label KEYS, never copy — core
 * cannot import @bolusi/i18n (08 §3.3) and T-4 asserts keys anyway.
 *
 * The key is DERIVED (`core.errors.<CODE>`), never mapped: 07-i18n §4.3 makes the final segment
 * the SCREAMING_SNAKE code verbatim precisely "so the key is mechanically derivable from the code
 * — no hand-written mapping table may exist". That is also what lets an UNKNOWN server code
 * (api/00 §4) surface at all instead of falling off a `switch`.
 */
export interface MediaSurfacing {
  readonly kind: 'media_failed';
  readonly mediaId: string;
  /** The api/03 §8 code verbatim, or the client-originated `LOCAL_CORRUPT`. */
  readonly code: string;
  /** `core.errors.<CODE>` (07-i18n §4.3). */
  readonly labelKey: string;
  /** 03 §4.1 / 06 §8: `uploadAttempts >= 5`. Escalates visibility; retries continue at the cap. */
  readonly persistentlyFailing: boolean;
  /** api/03 §8: no automatic trigger will pick this up. Only re-capture or re-enrollment. */
  readonly autoRetryExempt: boolean;
}

export interface MediaSurfacePort {
  /** Fire-and-forget and SYNCHRONOUS: the loop never awaits the UI and never throws to it. */
  emit(event: MediaSurfacing): void;
}

export function mediaErrorLabelKey(code: string): string {
  return `core.errors.${code}`;
}

export interface MediaDrainOptions<DB> {
  readonly db: Kysely<DB>;
  readonly transport: MediaTransportPort;
  readonly files: MediaFilePort;
  readonly clock: ClockPort;
  readonly surface: MediaSurfacePort;
}

/** How one item's attempt ended. `uploaded` and `restart` are both non-failures. */
type Disposition =
  | { readonly kind: 'uploaded' }
  // No `retryable` flag: whether a code retries is decided ONCE by `isAutoRetryable`, which
  // selection and the connectivity reset also consult. A per-disposition flag would be a second
  // opinion that can disagree with the predicate the selection filter actually uses.
  | { readonly kind: 'failed'; readonly code: string; readonly message: string | null }
  | { readonly kind: 'halt'; readonly code: string; readonly message: string | null };

export class MediaDrainLoop<DB> {
  private running = false;
  private rerun = false;
  /** 03 §4's manual-retry arm: this pass ignores the backoff window (never the exempt list). */
  private manualPending = false;
  /** Set by a halting code (api/03 §8). No automatic exit — mirrors `syncDisabled` (03 §10). */
  private halted = false;
  private cycle: Promise<void> | null = null;

  constructor(private readonly options: MediaDrainOptions<DB>) {}

  get isHalted(): boolean {
    return this.halted;
  }

  /**
   * 06 §5.2: "Single-flight; a trigger during a run is coalesced into one immediate re-run."
   *
   * Coalescing is a FLAG, not a counter — five triggers during one pass produce exactly one
   * re-run, which is the whole point: a counter would queue five redundant passes over the same
   * rows.
   */
  requestDrain(reason: MediaDrainTrigger): void {
    if (this.halted) return;
    if (this.running) {
      this.rerun = true;
      // A manual retry arriving mid-pass must not be downgraded to an ordinary re-run: the user
      // pressed a button, and the coalesced pass has to honour 03 §4's manual arm.
      if (reason === 'manual') this.manualPending = true;
      return;
    }
    if (reason === 'manual') this.manualPending = true;
    // Claim the slot with NO await in between (see the header).
    this.running = true;
    this.cycle = this.runCycle();
  }

  /** Resolves when the in-flight cycle (and any coalesced re-run) has settled. Tests only. */
  async settle(): Promise<void> {
    while (this.cycle !== null) {
      const inFlight = this.cycle;
      await inFlight;
      if (this.cycle === inFlight) this.cycle = null;
    }
  }

  /**
   * 03 §4.1's connectivity-regained reset: clears `nextAttemptAt` on all `failed` items, RETAINS
   * `uploadAttempts`, and skips the auto-retry-exempt codes. Then triggers a pass.
   */
  async onConnectivityRegained(): Promise<void> {
    if (this.halted) return;
    await clearBackoffForRetry(this.options.db, [...nonRetryableCodeList()]);
    this.requestDrain('connectivity');
  }

  private async runCycle(): Promise<void> {
    try {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun && !this.halted);
    } finally {
      this.running = false;
    }
  }

  /** One pass: every eligible item, oldest `capturedAt` first, strictly sequential (06 §5.1). */
  private async pass(): Promise<void> {
    const { db, clock } = this.options;
    const manual = this.manualPending;
    this.manualPending = false;
    const items = await selectDrainable(db, clock.now(), { ignoreBackoff: manual });
    for (const item of items) {
      if (this.halted) return;
      // An exempt item IS still selected by the SQL — its `nextAttemptAt` is null, which the
      // predicate reads as "eligible now" (there is no exempt column; 10-db §9.4). So the
      // exemption is enforced here, for EVERY trigger including manual: 06 §8 says the only
      // remedies for LOCAL_CORRUPT / DEVICE_REVOKED are re-capture + new op, or re-enrollment.
      // Without this line the drain would spin on a rotted file forever.
      if (!isAutoRetryable(item.lastErrorCode)) continue;
      await this.drainItem(item);
    }
  }

  private async drainItem(item: MediaQueueItem): Promise<void> {
    const disposition = await this.attemptUpload(item);
    switch (disposition.kind) {
      case 'uploaded':
        await markUploaded(this.options.db, item.id, this.options.clock.now());
        return;
      case 'halt':
        this.halted = true;
        await this.recordFailure(item, disposition.code, disposition.message);
        return;
      case 'failed':
        await this.recordFailure(item, disposition.code, disposition.message);
        return;
    }
  }

  /**
   * Records `uploading → failed` and its surfacing.
   *
   * THE EXEMPTION IS DERIVED FROM `isAutoRetryable`, NOT FROM THE CALLER'S OPINION — and that is a
   * correctness requirement, not tidiness. `isAutoRetryable` is what SELECTION and the
   * connectivity reset consult; if this method wrote `nextAttemptAt = null` for a code that
   * predicate considers retryable, selection would immediately re-pick the row (a null
   * `nextAttemptAt` reads as "eligible now") and the drain would spin in a tight loop, hammering
   * the server with no backoff. That is precisely what happened for UNKNOWN codes when the two
   * mechanisms were allowed to disagree. One predicate, three call sites, no possible drift.
   *
   * The consequence for an unknown code (api/00 §4) is therefore: surfaced, and retried under the
   * normal capped backoff. That is a forced choice worth naming — api/00 §4 calls unknown codes
   * "non-retryable", but the only mechanism that can express "never retry" is this closed code
   * list (10-db §9.4 has no exempt column, and adding one is a migration + spec change). Backoff
   * is the safe direction: it costs one capped request per 5 min and 03 §4.1 explicitly endorses
   * retrying forever while surfacing loudly, whereas exempting an unknown code would silently
   * strand evidence over a code the server may have added last week.
   *
   * `uploadAttempts` is incremented by the SQL itself (`upload_attempts + 1`) rather than by
   * reading-then-writing: two triggers racing on the same row would both read N and both write
   * N+1, and the surfacing threshold (>= 5) would drift below the real attempt count.
   */
  private async recordFailure(
    item: MediaQueueItem,
    code: string,
    message: string | null,
  ): Promise<void> {
    const attempts = item.uploadAttempts + 1;
    const exempt = !isAutoRetryable(code);
    const nextAttemptAt = exempt ? null : this.options.clock.now() + mediaBackoffDelayMs(attempts);
    await markFailed(this.options.db, item.id, { code, message, nextAttemptAt });
    this.emit({
      kind: 'media_failed',
      mediaId: item.id,
      code,
      labelKey: mediaErrorLabelKey(code),
      persistentlyFailing: isPersistentlyFailing(attempts),
      autoRetryExempt: exempt,
    });
  }

  /** Guarded: 06 §8's surfacing must never itself become a failure (the sync loop's rule). */
  private emit(event: MediaSurfacing): void {
    try {
      this.options.surface.emit(event);
    } catch {
      // A UI sink that throws must not turn "we reported a problem" into "we have a new problem".
    }
  }

  private async attemptUpload(item: MediaQueueItem): Promise<Disposition> {
    if (item.localPath === null) {
      // Pruned or never moved. Not retryable: the bytes are gone, and 06 §7 never prunes a
      // non-uploaded item, so reaching here means a bug or a hostile filesystem, not a race.
      return { kind: 'failed', code: LOCAL_CORRUPT_ERROR_CODE, message: 'no local file' };
    }
    try {
      // 1. init (idempotent — api/03 §3.1). The geometry is SERVER-DICTATED: `chunkSize` comes
      //    from this response and is never assumed (06 §4; api/03 §4).
      const init = await this.options.transport.init(item.id, {
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        mime: item.mime,
        type: item.type,
        metadata: {
          capturedAt: item.capturedAt,
          location: item.location === null ? null : JSON.parse(item.location),
          userId: item.userId,
          deviceId: item.deviceId,
        },
      });

      // 03 §4 gives the two entries into `uploading` DIFFERENT events, and the distinction is
      // real rather than cosmetic: `pending --select-->` is the drain picking up fresh work,
      // `failed --retry-->` is "nextAttemptAt reached · manual retry · connectivity regained".
      // Firing `select` at a `failed` row throws INVALID_TRANSITION — which is exactly what the
      // machine is for, and exactly how this bug was caught: every retry path in the suite went
      // red at once. The event is derived from the row's own status so it cannot drift again.
      this.transition(item.uploadStatus, item.uploadStatus === 'failed' ? 'retry' : 'select');
      await markUploading(this.options.db, item.id, {
        chunkSize: init.chunkSize,
        chunksTotal: init.totalChunks,
      });

      return await this.sendChunksAndComplete(item, init.chunkSize, init.totalChunks);
    } catch (error) {
      return await this.classify(item, error);
    }
  }

  /**
   * Steps 2–4 of 06 §5.1. Split out because `CHUNKS_MISSING` re-enters it: api/03 §8 calls that
   * "the normal resume path", so it must not consume a backoff attempt.
   */
  private async sendChunksAndComplete(
    item: MediaQueueItem,
    chunkSize: number,
    totalChunks: number,
  ): Promise<Disposition> {
    const { transport } = this.options;

    // 2. GET status — the SERVER is ground truth for resume (06 §5.1 step 2; 03 §4). Local
    //    progress is display-only and is never read here; there is nothing to read, because it is
    //    never persisted. That is what makes "local progress lies, server wins" structural rather
    //    than a rule someone has to follow.
    const status = await transport.status(item.id);
    if (status.status === 'complete') return { kind: 'uploaded' };

    let missing = missingChunks(totalChunks, status.receivedChunks);

    // Bounded: one `complete` retry per `CHUNKS_MISSING`, which the server answers with the exact
    // list. Unbounded would spin forever against a server that always reports one missing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // 3. Sequential, ascending — one chunk at a time (06 §5.1: no parallel uploads).
      for (const index of missing) {
        if (this.halted) return { kind: 'failed', code: 'HALTED', message: null };
        const bytes = await this.readChunkStrict(item, chunkSize, totalChunks, index);
        await transport.putChunk(item.id, index, bytes);
        // Self-loop (03 §4): advances a progress display, nothing persisted.
        this.transition('uploading', 'chunk_ack');
      }
      // 4. complete
      try {
        await transport.complete(item.id);
        this.transition('uploading', 'complete');
        return { kind: 'uploaded' };
      } catch (error) {
        if (
          error instanceof MediaTransportError &&
          error.code === MEDIA_ERROR_CODES.CHUNKS_MISSING &&
          error.missingChunks !== null &&
          error.missingChunks.length > 0
        ) {
          missing = [...error.missingChunks].sort((a, b) => a - b);
          continue;
        }
        throw error;
      }
    }
    return {
      kind: 'failed',
      code: MEDIA_ERROR_CODES.CHUNKS_MISSING,
      message: 'server still reports missing chunks after resend',
    };
  }

  /**
   * Reads exactly the bytes api/03 §3.2 demands for `index`: `chunkSize`, except the last chunk
   * which is `sizeBytes − (totalChunks−1)*chunkSize`.
   *
   * FAILS CLOSED on a short read. A truncated local file would otherwise PUT a short body, which
   * the server answers with `422 CHUNK_SIZE_INVALID` — a "Bug; surface" code that tells the user
   * nothing about the real problem (their file rotted). Detecting it here names it correctly.
   */
  private async readChunkStrict(
    item: MediaQueueItem,
    chunkSize: number,
    totalChunks: number,
    index: number,
  ): Promise<Uint8Array> {
    const offset = index * chunkSize;
    const expected = index === totalChunks - 1 ? item.sizeBytes - offset : chunkSize;
    const bytes = await this.options.files.readChunk(item.localPath as string, offset, expected);
    if (bytes.byteLength !== expected) {
      throw new MediaTransportError(
        `local read for chunk ${index} returned ${bytes.byteLength} bytes, expected ${expected}`,
        { code: LOCAL_CORRUPT_ERROR_CODE, status: null },
      );
    }
    return bytes;
  }

  /** Maps a thrown error onto api/03 §8's "Client behavior" column. */
  private async classify(item: MediaQueueItem, error: unknown): Promise<Disposition> {
    if (!(error instanceof MediaTransportError)) throw error;
    const code = error.code;

    // Network/pre-response failure (api/03 §8 has no row for it; 06 §5.3 backs the whole loop off).
    if (code === null) {
      return { kind: 'failed', code: 'NETWORK', message: error.message };
    }
    if (DRAIN_HALTING_CODES.has(code)) {
      return { kind: 'halt', code, message: error.message };
    }
    switch (code) {
      case MEDIA_ERROR_CODES.MEDIA_IMMUTABLE:
        return await this.classifyImmutable(item, error);
      case MEDIA_ERROR_CODES.HASH_MISMATCH:
        return await this.classifyHashMismatch(item, error);
      case MEDIA_ERROR_CODES.MEDIA_NOT_FOUND:
        // api/03 §8: "Upload: re-run `init`" — the next pass does exactly that.
        return { kind: 'failed', code, message: error.message };
      case MEDIA_ERROR_CODES.RATE_LIMITED:
      case MEDIA_ERROR_CODES.STORAGE_ERROR:
        return { kind: 'failed', code, message: error.message };
      default:
        // Every remaining api/03 §8 row is "Bug; surface" / "no auto-retry" — AND so is an
        // unknown code (api/00 §4: unknown codes are non-retryable and surfaced, never dropped).
        return { kind: 'failed', code, message: error.message };
    }
  }

  /**
   * api/03 §8's `MEDIA_IMMUTABLE` row: "Treat as success if own sha256 matches server's (item is
   * uploaded); else LOCAL_CORRUPT-class surfacing — never overwrite."
   *
   * This is the ONLY path that marks an item `uploaded` without our own `complete` succeeding, so
   * it FAILS CLOSED: any inability to confirm the match (network, 404, a server that will not
   * answer) is LOCAL_CORRUPT-class, never an assumed match. Marking evidence "uploaded" when it
   * is not is the worst outcome available here — the pruning pass would then delete the local file
   * 7 days later (06 §7) and the evidence would be gone for good.
   */
  private async classifyImmutable(
    item: MediaQueueItem,
    error: MediaTransportError,
  ): Promise<Disposition> {
    try {
      const matches = await this.options.transport.matchesServerHash(item.id, item.sha256);
      if (matches) return { kind: 'uploaded' };
      return {
        kind: 'failed',
        code: LOCAL_CORRUPT_ERROR_CODE,
        message: `server holds different bytes for this media id (${error.message})`,
      };
    } catch {
      return {
        kind: 'failed',
        code: LOCAL_CORRUPT_ERROR_CODE,
        message: 'MEDIA_IMMUTABLE and the server hash could not be confirmed',
      };
    }
  }

  /**
   * api/03 §8 / 06 §5.1's `HASH_MISMATCH` fork — the one place the client's own bytes are the
   * suspect. Re-hash the local file:
   *  - still matches `MediaItem.sha256` ⇒ the server discarded its chunks (api/03 §3.4 step 3);
   *    retry from chunk 0 under normal backoff.
   *  - no longer matches ⇒ the local copy rotted. It is "unrecoverable as evidence" (06 §5.1) —
   *    the signed op pinned the ORIGINAL hash, so re-uploading the new bytes would produce a file
   *    that does not match its own signed reference. Mark LOCAL_CORRUPT, stop auto-retrying,
   *    surface. The only remedy is a new capture + new op (FR-819).
   */
  private async classifyHashMismatch(
    item: MediaQueueItem,
    error: MediaTransportError,
  ): Promise<Disposition> {
    const actual = await this.options.files.hashFile(item.localPath as string);
    if (actual === item.sha256) {
      return { kind: 'failed', code: MEDIA_ERROR_CODES.HASH_MISMATCH, message: error.message };
    }
    return {
      kind: 'failed',
      code: LOCAL_CORRUPT_ERROR_CODE,
      message: `local file hash ${actual} no longer matches the signed ${item.sha256}`,
    };
  }

  /**
   * Routes through the shared executor so an illegal walk throws INVALID_TRANSITION rather than
   * being written to the DB. The loop never invents a status string.
   */
  private transition(from: MediaUploadStatus, event: MediaUploadEvent): void {
    runTransition(MEDIA_UPLOAD_STATUS_MACHINE, from, event);
  }
}

/**
 * The chunks the server does NOT have, ascending (06 §5.1 step 3).
 *
 * Computed from `receivedChunks` ALONE — there is no local-progress input to this function, by
 * design. It ignores server-reported indices outside `[0, totalChunks)`: a hostile or buggy server
 * reporting `receivedChunks: [99]` for a 3-chunk file must not shrink the set we send, and one
 * reporting `[-1]` must not corrupt the arithmetic. The set is derived from OUR `totalChunks`,
 * with the server's list used only to subtract.
 */
export function missingChunks(
  totalChunks: number,
  receivedChunks: readonly number[],
): readonly number[] {
  const received = new Set(receivedChunks);
  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i += 1) {
    if (!received.has(i)) missing.push(i);
  }
  return missing;
}

function nonRetryableCodeList(): readonly string[] {
  return [
    LOCAL_CORRUPT_ERROR_CODE,
    MEDIA_ERROR_CODES.DEVICE_REVOKED,
    MEDIA_ERROR_CODES.INIT_MISMATCH,
    MEDIA_ERROR_CODES.MIME_MISMATCH,
  ];
}

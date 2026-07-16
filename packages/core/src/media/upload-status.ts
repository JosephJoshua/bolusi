// `MediaItem.uploadStatus` — the CLIENT machine, canonically owned by 03-state-machines §4.
//
// Const data only; the shared executor throws INVALID_TRANSITION (state-machines/executor.ts).
// Terminal is EXPRESSED, never asserted: `uploaded: {}` is what makes 03 §4's "uploaded → *"
// invalid, rather than an `if (state === 'uploaded') throw` that a caller could forget.
//
// NOT the server's enum. api/03-media §3.3 owns a DIFFERENT two-value wire vocabulary
// (`receiving` | `complete`) for the server's chunk-session bookkeeping. 10-db §9.4's CHECK
// comment and 03 §4's preamble both say so explicitly. They map client-side (drain.ts) and must
// never be merged: `complete` is a server fact about chunk inventory, `uploaded` is a client fact
// about a confirmed round-trip, and the prune clock hangs off the latter.
import type { StateMachineDefinition } from '../state-machines/executor.js';

export type MediaUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

/**
 * 03 §4's trigger column, named as events.
 *
 * `recover` is the crash-recovery arm ("app restart finds no live upload task"): startup
 * reconciliation walks `uploading` rows back to `pending`. It is an event and not a repair-write
 * so that the illegal shapes (`uploaded → pending`) throw like any other.
 */
export type MediaUploadEvent =
  'select' | 'chunk_ack' | 'complete' | 'failure' | 'recover' | 'retry';

export const MEDIA_UPLOAD_STATUS_MACHINE: StateMachineDefinition<
  MediaUploadStatus,
  MediaUploadEvent
> = {
  id: 'media_upload_status',
  states: ['pending', 'uploading', 'uploaded', 'failed'],
  // 03 §4 "Birth: `pending`, at capture-commit — AFTER the captured file is moved from the cache
  // dir to the document dir". The move ordering is 06 §2.2 step 5 and is the capture pipeline's
  // job; the machine only records that no other state is a legal entry point.
  initial: ['pending'],
  terminal: ['uploaded'],
  transitions: {
    pending: { select: 'uploading' },
    uploading: {
      // Self-loop on chunk success: `changed: false`, a legal idempotent no-op. Local progress
      // is DISPLAY-ONLY (03 §4) — this advances a bar, never a resume position.
      chunk_ack: 'uploading',
      complete: 'uploaded',
      failure: 'failed',
      recover: 'pending',
    },
    // Terminal (03 §4). Pruning does NOT leave this state — it nulls `localPath` and the status
    // stays `uploaded` (06 §7).
    uploaded: {},
    failed: { retry: 'uploading' },
  },
};

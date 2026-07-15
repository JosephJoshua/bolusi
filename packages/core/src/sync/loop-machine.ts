// The sync-loop machine (03-state-machines §10), encoded ONCE as const data and transitioned
// ONLY through the shared executor (03 §1) — same discipline as `OP_SYNC_STATUS_MACHINE`. The
// parity test asserts this table equals 03 §10's; drift fails CI.
//
// IN-MEMORY, ONE INSTANCE PER PROCESS (03 §10). The states are not persisted — only the guards
// (`pushHalted`, `syncDisabled`) and `lastSuccessfulSyncAt` live on `SyncState`. `failureCount`
// is in-memory too, so a restart retries immediately rather than resuming a backoff: deliberate,
// and 03 §10's "birth: `idle` at app start" says so.
//
// WHY `trigger` IS NOT AN EVENT ON `pushing`/`pulling`. 03 §10's "any trigger arrives → (no
// transition), rerun flag set" is a NON-transition: the row exists to say the loop coalesces
// rather than re-entering. Encoding it as a self-loop would make `runTransition` report
// `changed: false` and be indistinguishable from a real no-op, so the coalescing lives in
// `loop.ts` where the rerun flag does, and this table stays exactly the set of REAL moves. The
// same reasoning keeps `idle + trigger` guarded on `!syncDisabled` in the caller: a guard is not
// a transition, and a table that silently encoded it would be a second place to change it.
import type { StateMachineDefinition } from '../state-machines/executor.js';

/** The four loop states (03 §10 / §2 enum registry). */
export type SyncLoopState = 'idle' | 'pushing' | 'pulling' | 'backoff';

/**
 * Events driving the machine (03 §10's "Event / trigger" column):
 *  - `trigger`: any api/01-sync §5 trigger — from `idle` or `backoff` only (see the table).
 *  - `push_drained`: all `local` ops pushed · nothing to push · `pushHalted` set mid-push.
 *  - `pull_drained`: `hasMore = false`, error-free.
 *  - `transport_failure`: network error, timeout, 5xx. Op-level rejections are NOT this (03 §10).
 *  - `timer_elapsed`: the backoff timer fired.
 *  - `device_revoked`: 401 `DEVICE_REVOKED` — from ANY state, to `idle`.
 */
export type SyncLoopEvent =
  | 'trigger'
  | 'push_drained'
  | 'pull_drained'
  | 'transport_failure'
  | 'timer_elapsed'
  | 'device_revoked';

/**
 * The transition table, verbatim from 03 §10.
 *
 * `device_revoked` is on EVERY state including `idle` (03 §10's "any" row) — a revoked 401 can
 * land on a cycle that is already unwinding, and `idle + device_revoked` must be expressible or
 * the terminal disable would throw INVALID_TRANSITION exactly when it matters. `idle → idle` is a
 * self-loop (`changed: false`); the `syncDisabled` write is the caller's side effect either way.
 */
export const SYNC_LOOP_MACHINE: StateMachineDefinition<SyncLoopState, SyncLoopEvent> = {
  id: 'sync_loop',
  states: ['idle', 'pushing', 'pulling', 'backoff'],
  initial: ['idle'],
  // No terminal state: the loop is cyclic. `syncDisabled` stops it via the trigger GUARD, not by
  // making `idle` terminal — the machine stays re-enterable after re-enrollment (03 §10).
  terminal: [],
  transitions: {
    idle: {
      trigger: 'pushing',
      device_revoked: 'idle',
    },
    pushing: {
      push_drained: 'pulling',
      transport_failure: 'backoff',
      device_revoked: 'idle',
    },
    pulling: {
      pull_drained: 'idle',
      transport_failure: 'backoff',
      device_revoked: 'idle',
    },
    backoff: {
      timer_elapsed: 'pushing',
      // Manual trigger or connectivity-regained: the two early exits that cancel the timer
      // (03 §10). Automatic triggers are absorbed BEFORE reaching the machine (loop.ts) — the
      // machine cannot tell them apart, so the absorb decision lives with the trigger reason.
      trigger: 'pushing',
      device_revoked: 'idle',
    },
  },
};

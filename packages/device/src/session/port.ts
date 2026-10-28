/**
 * The shell's view of task 14's `SessionManager` (api/02-auth §6.3/§6.4).
 *
 * WHY A NARROW PORT AND NOT THE CLASS. Two reasons, both load-bearing:
 *
 *  1. It states what the SHELL is allowed to do with the session — end it, switch it, retain work —
 *     and nothing else. The shell cannot reach into auth logic it does not own, because the type
 *     does not offer it. That is CLAUDE.md §2.8 enforced by the compiler rather than by review.
 *  2. It makes the shell testable without standing up a real command runtime, op store, and crypto
 *     port. Task 14's suite already drives `SessionManager` against the REAL runtime and real op log
 *     (its `session.test.ts` covers SEC-AUTH-07 and the SessionManager half of SEC-AUTH-08). Doing
 *     that again here would duplicate its tests — which this task's brief forbids: the shell RENDERS
 *     14's states, it never re-tests them.
 *
 * THE SEAM CANNOT DRIFT. `assertSessionManagerSatisfiesPort` below is a compile-time witness that
 * the real `SessionManager` still satisfies this shape. If task 14 renames or re-signatures a method,
 * `pnpm typecheck` fails here — rather than the fake staying happily green against a port that no
 * longer describes anything real. A test double whose interface has quietly stopped matching
 * production is the classic green-for-the-wrong-reason guard (CLAUDE.md §2.11).
 */

import type { SessionManager } from '@bolusi/core';

/** An open control session on this device (api/02-auth §6.3). */
export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * The subset of `SessionManager` the shell drives. Every member mirrors task 14's signature exactly;
 * the doc comments here say what the SHELL uses it for, not what it does (that is 14's to document).
 */
export interface SessionPort<TWork> {
  /** Null ⇒ the device is at the switcher; the gate (navigation/zone.ts) reads this. */
  readonly current: ActiveSession | null;

  /** The effective, clamped idle timeout (api/02-auth §6.4) — the shell's tick budget. */
  readonly idleLockSeconds: number;

  /**
   * Unlock: emits `session_ended('switch')` + `user_switched` and returns the incoming user's
   * RETAINED work (SEC-AUTH-08). The shell restores exactly what comes back and nothing else.
   */
  switchTo(userId: string): Promise<{
    readonly session: ActiveSession;
    readonly work: TWork | undefined;
    readonly ops: readonly unknown[];
  }>;

  /** Manual lock (§6.4): `reason: 'manual_lock'`, `source: 'ui'`. */
  manualLock(): Promise<readonly unknown[]>;

  /**
   * Idle lock (§6.4): ends the session with `reason: 'idle_lock'` IF the deadline has passed.
   * 14's class runs no timer of its own — the shell's tick calls this, which is what keeps the
   * transition testable without a real clock (T-6).
   */
  checkIdle(): Promise<readonly unknown[]>;

  /** Reset the idle deadline. */
  recordActivity(): void;

  /** Retain this user's work (SEC-AUTH-08). Keyed by `userId` — never "the last one saved". */
  saveWork(userId: string, work: TWork): void;

  /** This user's retained work, or undefined. NEVER another user's — the key is the userId. */
  work(userId: string): TWork | undefined;
}

/**
 * Compile-time witness: the real `SessionManager<T>` satisfies `SessionPort<T>`.
 *
 * Never called. Its only job is to fail `tsc` the moment task 14's surface and this port disagree,
 * so the fake in the shell's tests can never describe a `SessionManager` that no longer exists.
 */
export function assertSessionManagerSatisfiesPort<T>(manager: SessionManager<T>): SessionPort<T> {
  return manager;
}

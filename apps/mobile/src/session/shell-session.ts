/**
 * The shell's session controller — SEC-AUTH-08's UI half (api/02-auth §6.4; design-system §8.2).
 *
 * It owns three things and delegates everything else to task 14's `SessionManager` (via `SessionPort`):
 *   1. WHEN the idle check runs (14's class runs no timer by design — the transition is tested, not
 *      the timer, so the shell supplies the tick).
 *   2. Keeping each user's workspace retained CONTINUOUSLY, so a lock can never lose work.
 *   3. Restoring a workspace on unlock, with the owner check (state/user-workspaces.ts).
 *
 * WHY RETENTION IS CONTINUOUS AND NOT LOCK-TRIGGERED — the one real design decision in this file.
 * The obvious implementation saves the workspace when the lock fires. It has a race that loses
 * exactly the work SEC-AUTH-08 exists to protect: `checkIdle()` ends the session, after which
 * `current` is null and the shell no longer knows WHOSE work was on screen. Any save that has not
 * already happened by then has lost its key. So `updateWorkspace` writes through to
 * `saveWork(userId, …)` on every edit — an in-memory map write, free on the 2 GB target — and the
 * lock becomes a pure identity-clearing event that cannot drop anything. The lock is then safe to
 * fire from anywhere, at any time, including mid-keystroke.
 *
 * This is a security control, not ergonomics (api/02-auth §6.4 states it outright): a 300 s lock
 * that discards a half-typed repair note gets raised to its 3600 s ceiling by the shop, or switched
 * off. Preserving work is what keeps a short lock survivable, and therefore what keeps it real.
 */

import type { ClockPort } from '@bolusi/core';

import { restoreWorkspace, type UserWorkspace } from '../state/user-workspaces.js';

import type { SessionPort } from './port.js';

/** Why the shell is showing the lock. Mirrors api/02-auth §6.2's `session_ended` reasons. */
export type LockReason = 'idle_lock' | 'manual_lock';

export interface ShellSessionDeps {
  readonly session: SessionPort<UserWorkspace>;
  /** Injected — never `Date.now()`. The idle transition must be drivable from a FakeClock (T-6). */
  readonly clock: ClockPort;
}

/** What the shell renders from. Plain data so the gate (navigation/zone.ts) stays pure. */
export interface ShellSessionSnapshot {
  readonly userId: string | null;
  readonly locked: boolean;
  readonly lockReason: LockReason | null;
  /** The ACTIVE user's workspace. Null when nobody is signed in — never a stale one. */
  readonly workspace: UserWorkspace | null;
}

export class ShellSession {
  readonly #deps: ShellSessionDeps;
  #locked = false;
  #lockReason: LockReason | null = null;
  #workspace: UserWorkspace | null = null;
  #listeners = new Set<() => void>();

  constructor(deps: ShellSessionDeps) {
    this.#deps = deps;
  }

  snapshot(): ShellSessionSnapshot {
    const userId = this.#deps.session.current?.userId ?? null;
    return {
      userId,
      locked: this.#locked,
      lockReason: this.#lockReason,
      // Belt and braces: if the session is gone the workspace is not the shell's to show, whatever
      // is cached here. The gate already routes a null session to the switcher; this makes a
      // rendering bug incapable of leaking the previous user's screen behind it.
      workspace: userId === null ? null : this.#workspace,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The idle tick. Delegates the DECISION to 14's `checkIdle()` — the shell never re-derives the
   * deadline, which is why a change to §6.4's clamp cannot leave the UI out of step.
   *
   * Returns true iff this tick locked the session.
   */
  async tick(): Promise<boolean> {
    if (this.#locked || this.#deps.session.current === null) return false;
    const ops = await this.#deps.session.checkIdle();
    if (ops.length === 0) return false;
    this.#applyLock('idle_lock');
    return true;
  }

  /** Manual lock (§6.4) — identical handling to idle, only the reason differs. */
  async lockNow(): Promise<void> {
    if (this.#locked || this.#deps.session.current === null) return;
    await this.#deps.session.manualLock();
    this.#applyLock('manual_lock');
  }

  /**
   * Unlock after a successful PIN verify. The incoming user's retained work comes back from 14's
   * `switchTo`; `restoreWorkspace` checks it actually belongs to them before the shell renders it.
   */
  async unlock(userId: string): Promise<UserWorkspace> {
    const { work } = await this.#deps.session.switchTo(userId);
    const workspace = restoreWorkspace(userId, work);
    this.#workspace = workspace;
    this.#locked = false;
    this.#lockReason = null;
    this.#deps.session.recordActivity();
    this.#emit();
    return workspace;
  }

  /**
   * Write through to retention on EVERY edit — see the header for why this is not lock-triggered.
   * Ignores a write for anyone but the active user: a screen holding a stale closure must not be
   * able to overwrite the person who is actually signed in.
   */
  updateWorkspace(next: UserWorkspace): void {
    const active = this.#deps.session.current?.userId;
    if (active === undefined || next.ownerUserId !== active) return;
    this.#workspace = next;
    this.#deps.session.saveWork(active, next);
    this.#emit();
  }

  /** Any interaction resets the idle deadline (§6.4). */
  recordActivity(): void {
    this.#deps.session.recordActivity();
  }

  #applyLock(reason: LockReason): void {
    this.#locked = true;
    this.#lockReason = reason;
    // The active identity context is cleared; the WORK is not (§6.4 — "only the active-identity
    // context is cleared"). It already lives in 14's per-user map, keyed by userId.
    this.#workspace = null;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

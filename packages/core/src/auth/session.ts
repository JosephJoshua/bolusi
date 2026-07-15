// The user switcher + session lifecycle (api/02-auth §6.3, §6.4; SEC-AUTH-07/08).
//
// Every session transition is an OP, emitted THROUGH the command runtime's sanctioned channel
// (`emitRuntimeOp`) — this file invents no emission path (04-module-contract §5.1). Authentication
// precedes authorization (FR-1014): switching in carries no permission; the incoming user has
// already PIN-verified locally (pin-verify.ts), and their switch is what ends the previous session
// (§6.3 — the envelope `userId` on BOTH the session-end and the switch is the incoming user).
//
// In-progress work SURVIVES a lock (SEC-AUTH-08, PRD-011 §6.2): draft state is retained keyed by
// userId and handed back on that user's next unlock — and NEVER to a different user. A lock that
// lost work would get disabled by whoever can disable it, so preserving it is a security control.
import type { AppendedOp } from '../oplog/append.js';
import type { CommandRuntime } from '../runtime/execute.js';
import type { ClockPort, IdSource } from '../runtime/ports.js';
import { clampIdleLockSeconds } from './constants.js';
import { AUTH_ENTITY, AUTH_OP } from './operations.js';
import type { LockedOutEmitter } from './pin-verify.js';

/** The permission-memo invalidation seam (02-permissions §6) — `PermissionEvaluator` satisfies it. */
export interface PermissionMemo {
  /** §6 invalidation (b): the active user switched. */
  onUserSwitch(): Promise<void>;
}

/** An open control session on this device. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
}

/** Why a session ended (api/02-auth §6.2). */
export type SessionEndReason = 'switch' | 'idle_lock' | 'manual_lock';

export interface SessionManagerDeps {
  readonly runtime: CommandRuntime;
  readonly idSource: IdSource;
  readonly clock: ClockPort;
  readonly memo: PermissionMemo;
  /** Bundle `idleLockSeconds` (api/02-auth §6.4). Clamped to [60, 3600]; default 300. */
  readonly idleLockSeconds?: number;
}

/**
 * The switcher/session state machine (api/02-auth §6.3/§6.4). One instance per device. Holds the
 * open session, the per-user work-state retention (SEC-AUTH-08), and the idle deadline — all in
 * memory; the durable facts are the ops it emits.
 */
export class SessionManager<TWork = unknown> {
  readonly #runtime: CommandRuntime;
  readonly #idSource: IdSource;
  readonly #clock: ClockPort;
  readonly #memo: PermissionMemo;
  #idleLockSeconds: number;

  #current: ActiveSession | null = null;
  #lastActivityAt: number;
  /** Per-user in-progress work, keyed by userId — survives locks; never shared across users. */
  readonly #workByUser = new Map<string, TWork>();

  constructor(deps: SessionManagerDeps) {
    this.#runtime = deps.runtime;
    this.#idSource = deps.idSource;
    this.#clock = deps.clock;
    this.#memo = deps.memo;
    this.#idleLockSeconds = clampIdleLockSeconds(deps.idleLockSeconds ?? Number.NaN);
    this.#lastActivityAt = deps.clock.now();
  }

  /** The open session, or null when the device is at the switcher. */
  get current(): ActiveSession | null {
    return this.#current;
  }

  /** The effective idle-lock timeout in seconds (clamped, api/02-auth §6.4). */
  get idleLockSeconds(): number {
    return this.#idleLockSeconds;
  }

  /** Update the idle timeout from a bundle refresh (clamped, §6.4). */
  setIdleLockSeconds(seconds: number): void {
    this.#idleLockSeconds = clampIdleLockSeconds(seconds);
  }

  /**
   * Switch the active identity to `userId` after their local PIN verify (api/02-auth §6.3).
   *
   * Emits, IN ORDER: `auth.session_ended` (`reason: 'switch'`, only if a session was open) for the
   * OUTGOING session, then `auth.user_switched` for the new one — BOTH with envelope `userId` = the
   * incoming user. Invalidates the permission memo (§6). Restores and returns the incoming user's
   * retained work state, if any.
   */
  async switchTo(
    userId: string,
  ): Promise<{
    readonly session: ActiveSession;
    readonly work: TWork | undefined;
    readonly ops: readonly AppendedOp[];
  }> {
    const previous = this.#current;
    const emitted: AppendedOp[] = [];

    if (previous !== null) {
      // The incoming user's switch ends the previous session (§6.3): envelope userId = incoming.
      emitted.push(
        ...(await this.#runtime.emitRuntimeOp({
          type: AUTH_OP.sessionEnded,
          entityType: AUTH_ENTITY.authSession,
          entityId: previous.sessionId,
          payload: { reason: 'switch' satisfies SessionEndReason },
          userId,
          source: 'ui',
        })),
      );
    }

    const sessionId = this.#idSource();
    emitted.push(
      ...(await this.#runtime.emitRuntimeOp({
        type: AUTH_OP.userSwitched,
        entityType: AUTH_ENTITY.authSession,
        entityId: sessionId,
        payload: {
          previousSessionId: previous?.sessionId ?? null,
          previousUserId: previous?.userId ?? null,
        },
        userId,
        source: 'ui',
      })),
    );

    this.#current = { sessionId, userId };
    this.#lastActivityAt = this.#clock.now();
    // §6: the active user changed — drop the effective-set memo so the new user is evaluated fresh.
    await this.#memo.onUserSwitch();

    return { session: this.#current, work: this.#workByUser.get(userId), ops: emitted };
  }

  /** Manual lock (switcher button, §6.4): `reason: 'manual_lock'`, `source: 'ui'`. */
  manualLock(): Promise<readonly AppendedOp[]> {
    return this.#lock('manual_lock', 'ui');
  }

  /**
   * Idle lock (api/02-auth §6.4): if a session is open and the idle deadline has passed, end it with
   * `reason: 'idle_lock'`, `source: 'system'`. Called by the app's timer with the current clock — this
   * class runs no timer of its own (the transition is tested, not the timer). Returns the emitted
   * ops, or an empty array when nothing was due.
   */
  async checkIdle(): Promise<readonly AppendedOp[]> {
    if (this.#current === null) return [];
    const idleMs = this.#idleLockSeconds * 1000;
    if (this.#clock.now() - this.#lastActivityAt < idleMs) return [];
    return this.#lock('idle_lock', 'system');
  }

  /** Record user activity — resets the idle deadline. */
  recordActivity(): void {
    this.#lastActivityAt = this.#clock.now();
  }

  /** Retain in-progress work for `userId` (SEC-AUTH-08) — survives a lock, restored on next unlock. */
  saveWork(userId: string, work: TWork): void {
    this.#workByUser.set(userId, work);
  }

  /** The retained work for `userId`, or undefined. NEVER another user's — the key is the userId. */
  work(userId: string): TWork | undefined {
    return this.#workByUser.get(userId);
  }

  async #lock(
    reason: Exclude<SessionEndReason, 'switch'>,
    source: 'ui' | 'system',
  ): Promise<readonly AppendedOp[]> {
    const current = this.#current;
    if (current === null) return [];
    const ops = await this.#runtime.emitRuntimeOp({
      type: AUTH_OP.sessionEnded,
      entityType: AUTH_ENTITY.authSession,
      entityId: current.sessionId,
      payload: { reason },
      userId: current.userId,
      source,
    });
    // Only the active-identity context is cleared; #workByUser is retained (SEC-AUTH-08).
    this.#current = null;
    return ops;
  }
}

// ── runtime-backed emitter factories ──────────────────────────────────────────────────────────────

/**
 * The `auth.pin_locked_out` emitter (api/02-auth §6.3), wired to the runtime for pin-verify.ts. At
 * the 10th failure there is no authenticated user to run a command as, so this is a sanctioned direct
 * append with `source: 'system'` and `userId` = the targeted user.
 */
export function createLockedOutEmitter(runtime: CommandRuntime): LockedOutEmitter {
  return {
    async emitLockedOut({ userId, consecutiveFailures, windowStartedAt }): Promise<void> {
      await runtime.emitRuntimeOp({
        type: AUTH_OP.pinLockedOut,
        entityType: AUTH_ENTITY.userCredential,
        entityId: userId,
        payload: { consecutiveFailures, windowStartedAt },
        userId,
        source: 'system',
      });
    },
  };
}

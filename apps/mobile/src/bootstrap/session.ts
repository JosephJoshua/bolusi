/**
 * The MINIMAL live session construction (task 119) — what turns a PIN keypress into an open session,
 * which is what the notes runtime needs to exist at all.
 *
 * ── WHY THIS FILE HAD TO BE WRITTEN FOR A NOTES TASK ────────────────────────────────────────────
 * Task 119's job is to make the notes screens reachable in the running app. They are gated behind
 * `resolveZone`'s shell arm, which needs a non-null session — and `Root` hardcoded `session: null`,
 * `users: null` and `onSubmitPin: () => undefined`. So the notes runtime could be composed perfectly
 * and still never mount: there was no way for a real device to be in a post-session state. Wiring the
 * runtime without wiring this would have re-created the exact inert-mechanism bug the task exists to
 * close, one layer up.
 *
 * ── IT COMPOSES TASK 14, IT DOES NOT RE-IMPLEMENT IT (§2.8) ─────────────────────────────────────
 * Every auth DECISION here belongs to core and is tested there: `verifyPin` owns the gate ordering,
 * the KDF, the lockout counter and SEC-AUTH-02/05; `SessionManager` owns the session lifecycle and
 * SEC-AUTH-07/08; `listSwitcherUsers` owns §5.1's active-only filter. This file contains no `if`
 * that decides whether a PIN is correct and no arithmetic on an attempt counter. What it contributes
 * is the wiring those pieces were built for and had never been given: a runtime to emit through, a
 * device identity to scope to, and one place holding "who is signed in".
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────
 * The idle-lock TICK (`ShellSession.tick`) and the §6.6 first-PIN SETUP screen. Both are real gaps
 * and both predate this task: `ShellSession` ships with no caller, and no first-PIN screen exists.
 * `submitPin` therefore REPORTS `needs_first_pin` for a user with no verifier rather than inventing a
 * setup flow — an honest dead end the switcher already signals (`needsFirstPin` on the roster row),
 * not a silent failure. Neither is faked; see the task report.
 *
 * NODE-SAFE: core + types only. Ports arrive injected.
 */
import {
  createLockedOutEmitter,
  DomainError,
  listSwitcherUsers,
  readPinAttempt,
  readVerifier,
  SessionManager,
  verifyPin,
  type ActiveSession,
  type ClockPort,
  type CryptoPort,
  type IdSource,
  type PinAttemptRow,
  type PinAuthState,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { sql, type Kysely } from 'kysely';

import type { SwitcherUser } from '../screens/switcher/model.js';

import type { Bootstrapped } from './bootstrap.js';
import { readDeviceIdentity } from './notes.js';
import type { AppRuntime } from './runtime.js';

/** What a PIN submission produced. Every arm is a state the shell already knows how to render. */
export type PinOutcome =
  /** Verified — a session is open and `current` now holds it. */
  | { readonly kind: 'opened'; readonly session: ActiveSession }
  /** Wrong PIN. `state` is 14's own `PinAuthState`, rendered as-is (task 24 renders, never re-derives). */
  | { readonly kind: 'wrong'; readonly state: PinAuthState; readonly lockedOut: boolean }
  /** api/02-auth §6.6: this user has no verifier yet. No setup screen exists — see the file header. */
  | { readonly kind: 'needs_first_pin' }
  /** The attempt was refused BEFORE the KDF ran (SEC-AUTH-02): `PIN_LOCKED` / `PIN_RATE_LIMITED`. */
  | { readonly kind: 'gated'; readonly code: string };

/** What the shell reads. Plain data, so the gate (navigation/zone.ts) stays pure. */
export interface AppSessionSnapshot {
  readonly session: ActiveSession | null;
  readonly users: readonly SwitcherUser[] | null;
  readonly usersError: string | null;
}

export interface AppSessionController {
  snapshot(): AppSessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Load the switcher roster (api/02-auth §5.1) + each user's attempt row. Safe to call repeatedly. */
  refresh(): Promise<void>;
  /** The cached attempt row — SYNCHRONOUS because `App`'s `pinRow` prop is. Refreshed by `refresh`
   *  and after every attempt, so the pad's lockout view reflects the row the last attempt wrote. */
  pinRow(userId: string): PinAttemptRow | null;
  submitPin(userId: string, pin: string): Promise<PinOutcome>;
}

export interface AppSessionDeps {
  readonly app: Bootstrapped;
  /** THE app runtime — shared with enrollment, so session ops and note writes share one op store. */
  readonly runtime: AppRuntime;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly idSource: IdSource;
}

/**
 * Compose the session controller over a booted, ENROLLED app. Returns `null` for a device with no
 * persisted identity — there is nobody to sign in as, and a controller scoped to a placeholder
 * identity would emit session ops into a tenant that does not exist.
 */
export async function createAppSession(deps: AppSessionDeps): Promise<AppSessionController | null> {
  const device = await readDeviceIdentity(deps.app);
  if (device === null) return null;

  const db = deps.app.db.db;
  // The command runtime session ops are emitted through — the SAME composition the genesis and every
  // note write use, so a session op joins the one hash chain rather than a second one.
  const commands = deps.runtime.runtimeFor(device);
  const manager = new SessionManager({
    runtime: commands,
    idSource: deps.idSource,
    clock: deps.clock,
    // 02-permissions §6 (b): the active user changed ⇒ drop the effective-set memo. This is the SAME
    // evaluator the query runtime enforces reads against, so a switch cannot leave the incoming user
    // reading through the outgoing user's cached grants.
    memo: deps.runtime.evaluator,
  });
  const lockedOut = createLockedOutEmitter(commands);

  let users: readonly SwitcherUser[] | null = null;
  let usersError: string | null = null;
  const rows = new Map<string, PinAttemptRow | null>();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const loadRow = async (userId: string): Promise<void> => {
    rows.set(userId, await readPinAttempt(db, userId, device.deviceId));
  };

  return {
    snapshot: () => ({ session: manager.current, users, usersError }),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async refresh(): Promise<void> {
      try {
        const directory = await listSwitcherUsers(db);
        users = await Promise.all(
          directory.map(async (user) => {
            const [verifier, lastActiveAt] = await Promise.all([
              readVerifier(db, user.id),
              lastActiveOnThisDevice(db, user.id, device.deviceId),
            ]);
            return {
              id: user.id,
              name: user.name,
              photoMediaId: user.photoMediaId,
              lastActiveAt,
              // §6.6: a bundle row with no verifier is a user who has never set a PIN here.
              needsFirstPin: verifier === null,
            } satisfies SwitcherUser;
          }),
        );
        usersError = null;
        await Promise.all(directory.map((user) => loadRow(user.id)));
      } catch (error: unknown) {
        // The switcher's `error` state (design-system §5). A closed CODE, never a raw server string.
        users = null;
        usersError = error instanceof DomainError ? error.code : 'UNEXPECTED';
      }
      emit();
    },

    pinRow: (userId) => rows.get(userId) ?? null,

    async submitPin(userId, pin): Promise<PinOutcome> {
      let outcome: PinOutcome;
      try {
        const result = await verifyPin(
          {
            db,
            crypto: deps.crypto,
            clock: deps.clock,
            deviceId: device.deviceId,
            emitter: lockedOut,
          },
          { userId, pin },
        );
        if (result.ok) {
          // AUTHENTICATED. Only now does a session exist — and only now can a notes runtime be
          // scoped to this user. `switchTo` emits `session_ended`/`user_switched` (api/02-auth §6.3)
          // and invalidates the permission memo.
          const { session } = await manager.switchTo(userId);
          outcome = { kind: 'opened', session };
        } else {
          outcome = { kind: 'wrong', state: result.state, lockedOut: result.lockedOut };
        }
      } catch (error: unknown) {
        if (error instanceof DomainError && error.code === 'ENTITY_NOT_FOUND') {
          outcome = { kind: 'needs_first_pin' };
        } else if (error instanceof DomainError) {
          // `PIN_LOCKED` / `PIN_RATE_LIMITED` — refused before the KDF ran (SEC-AUTH-02).
          outcome = { kind: 'gated', code: error.code };
        } else {
          throw error;
        }
      }
      // Re-read the row REGARDLESS of the arm: a failed attempt is what moves the counter, and the
      // pad renders its lockout view from this row. Reading it only on success would leave the pad
      // showing a clean slate for a user who is one attempt from a lockout.
      await loadRow(userId);
      emit();
      return outcome;
    },
  };
}

/**
 * ms epoch of this user's most recent session ON THIS DEVICE, or null if they have never used it
 * here (§8.2's ordering input). Read from the `auth_sessions` projection — the same rows
 * `userSwitchedApplier` writes, so the switcher's ordering is a fact about the op log rather than a
 * separate bookkeeping table that could disagree with it.
 */
async function lastActiveOnThisDevice(
  db: Kysely<ClientDatabase>,
  userId: string,
  deviceId: string,
): Promise<number | null> {
  const result = await sql<{ startedAt: number | null }>`
    SELECT MAX(started_at) AS "startedAt" FROM auth_sessions
    WHERE user_id = ${userId} AND device_id = ${deviceId}
  `.execute(db);
  const value = result.rows[0]?.startedAt;
  return value === null || value === undefined ? null : Number(value);
}

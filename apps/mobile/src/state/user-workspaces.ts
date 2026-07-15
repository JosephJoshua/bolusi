/**
 * SEC-AUTH-08 — per-user draft/navigation state on a shared terminal (api/02-auth §6.4;
 * design-system §8.2).
 *
 * WHAT THIS FILE IS *NOT*. It is not a retention map. Task 14's `SessionManager<TWork>` already owns
 * one — `saveWork(userId, work)` / `work(userId)`, keyed by `userId`, cleared with the identity
 * context — and CLAUDE.md §2.8 says that lives once. Re-implementing it here is exactly how two maps
 * end up disagreeing about whose draft is whose, which for THIS control is the whole risk: the bug
 * SEC-AUTH-08 guards against is user B unlocking into user A's half-typed work.
 *
 * What this file DOES own is the app's answer to `TWork` — the shape of a workspace — plus the
 * spelling of the two rules the shape must satisfy. The security property is bought by the KEY
 * (`SessionManager` looks up strictly by `userId`, never "the last one saved"); this file makes the
 * VALUE typed so a screen cannot stuff an unrelated user's id inside it and smuggle state across.
 *
 * WHY WORK IS PRESERVED AT ALL — this is a security control, not a convenience (api/02-auth §6.4
 * says so outright): "A lock that loses work gets disabled by whoever can disable it." A 300 s idle
 * lock that discards a half-written repair note trains the shop to raise `idleLockSeconds` to its
 * 3600 s ceiling, or to stop locking. Preserving the draft is what makes the short lock survivable,
 * and therefore what makes it real.
 */

import type { ShellRoute } from '../navigation/zone.js';

/**
 * One user's in-progress state, retained across a lock and restored on THEIR next unlock.
 *
 * `ownerUserId` is redundant with the map key by construction — and that redundancy is the point.
 * It is the assertable witness that a restored workspace belongs to the user who unlocked: the test
 * (and `assertOwnedBy` below) can check identity rather than trusting that the lookup key was right.
 * A control whose correctness cannot be witnessed is a control nobody can review.
 */
export interface UserWorkspace {
  readonly ownerUserId: string;
  /** Where this user was in the shell when the lock fired — restored so the lock is invisible. */
  readonly route: ShellRoute;
  /**
   * Module draft state, keyed by module id (task 25's notes editor is the first tenant). Opaque
   * here on purpose: the shell must not know what a module's draft contains, only whose it is.
   */
  readonly drafts: Readonly<Record<string, unknown>>;
}

/** A fresh workspace for a user with nothing retained — the shell's landing state. */
export function emptyWorkspace(userId: string): UserWorkspace {
  return { ownerUserId: userId, route: 'home', drafts: {} };
}

/**
 * The restore-time check (SEC-AUTH-08). `SessionManager.work(userId)` already keys by user, so this
 * cannot fire in correct code — which is precisely why it is here: it converts "we key by userId,
 * trust us" into an assertion that runs on every unlock. If a future refactor ever hands back
 * another user's workspace, the shell fails loudly at the boundary instead of silently rendering
 * A's draft under B's name.
 *
 * A mismatch returns a FRESH workspace rather than throwing: the failure mode must be "B sees an
 * empty screen" (annoying, safe), never "B sees A's work" (a data leak) and never a crash loop that
 * bricks the terminal mid-shift.
 */
export function restoreWorkspace(
  userId: string,
  retained: UserWorkspace | undefined,
): UserWorkspace {
  if (retained === undefined) return emptyWorkspace(userId);
  if (retained.ownerUserId !== userId) return emptyWorkspace(userId);
  return retained;
}

/** Record a module's draft into a workspace, preserving ownership. */
export function withDraft(
  workspace: UserWorkspace,
  moduleId: string,
  draft: unknown,
): UserWorkspace {
  return { ...workspace, drafts: { ...workspace.drafts, [moduleId]: draft } };
}

/** Record where the user is in the shell, so a lock restores them to the same place. */
export function withRoute(workspace: UserWorkspace, route: ShellRoute): UserWorkspace {
  return { ...workspace, route };
}

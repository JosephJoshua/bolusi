/**
 * The shell's gating model (design-system §8.1; api/02-auth §4/§6/§7).
 *
 * WHY THERE IS NO NAVIGATION LIBRARY HERE. 08 §2.2 pins no navigation library, and this task's file
 * list says adding one is a spec-table addition requiring a stop-and-ask (CLAUDE.md §4/§6). It also
 * turns out not to be needed: v0's shell is not a URL-addressable graph, it is a GATE. Which surface
 * shows is a pure function of device status + session + lock — never of history — and the two
 * genuinely stacked surfaces (Sync Status, Settings) are one level deep off a single root. A router
 * would add a dependency, a bundle, and a second source of truth for "where am I" that could
 * DISAGREE with the auth state. It cannot disagree here: `resolveZone` recomputes from auth truth on
 * every render, so an idle lock cannot leave a screen stranded behind a stale route.
 *
 * That is a v0 judgement scoped to v0's surfaces, and it is the reason this file is a pure model:
 * when the module screens arrive and the graph outgrows a gate, the router swaps in underneath
 * `resolveZone` without the auth rules moving.
 *
 * EVERYTHING HERE IS PURE. No React, no clock, no navigation state hidden in a closure — so the
 * gating rules are tested directly (T-6) rather than through a rendered tree.
 */

/** Device lifecycle (03-state-machines §Device; api/02-auth §7). `revoked` is terminal. */
export type DeviceStatus = 'unenrolled' | 'active' | 'revoked';

/** Why the switcher is showing. `lock` renders no back (design-system §8.2). */
export type SwitcherMode = 'lock' | 'choose';

/** The in-shell surfaces this task ships. Module screens (task 25) extend this union. */
export type ShellRoute = 'home' | 'syncStatus' | 'settings';

/**
 * The one surface the app is showing. A discriminated union so a renderer must handle every case —
 * `assertNever` in the screen switch turns a new zone into a COMPILE error rather than a blank
 * screen. "No state maps to a blank screen" is this task's acceptance, and this is how it is bought
 * structurally rather than by remembering to test it.
 *
 * The switcher carries `origin`: the shell route it was opened FROM, so an abandoned voluntary switch
 * returns THERE and not unconditionally home (task 143). Pre-session that origin is `home` (there is
 * no shell behind it); reached from a live session it is wherever the avatar was tapped.
 */
export type Zone =
  | { readonly kind: 'enrollment'; readonly revoked: boolean }
  | { readonly kind: 'switcher'; readonly mode: SwitcherMode; readonly origin: ShellRoute }
  | { readonly kind: 'pin'; readonly userId: string; readonly mode: SwitcherMode }
  | { readonly kind: 'shell'; readonly route: ShellRoute };

/** The auth/nav truth `resolveZone` reads. Every field is owned elsewhere; this is a view of it. */
export interface ZoneInput {
  readonly device: DeviceStatus;
  /** The open session (api/02-auth §6.3) — `SessionManager.current`. Null ⇒ at the switcher. */
  readonly session: { readonly userId: string } | null;
  /** Set when a lock ended the session (api/02-auth §6.4). Cleared on unlock. */
  readonly locked: boolean;
  /** The user tapped on the switcher, awaiting PIN. Null ⇒ the switcher itself. */
  readonly pinFor: string | null;
  /**
   * A session is open and the user asked for the switcher — the voluntary quick-switch (PRD-011 §6.1;
   * api/02-auth §6.2/§6.3). This is the field task 124 could not add without redesigning the model:
   * without it no input reachable from a live session produces the switcher zone, so `resolveZone`
   * returned the shell for every session-open render and the avatar was a dead control (task 143). The
   * op behind the switch is still emitted downstream, at the incoming user's PIN verify (§6.3) — this
   * flag only reaches the roster; it never stands in for the op. Ignored when no session is open (the
   * switcher is then reached by `session === null`) and while `pinFor` is set (the PIN pad wins).
   */
  readonly switching: boolean;
  /** Where the user navigated inside the shell. Ignored unless the shell zone is reached. */
  readonly route: ShellRoute;
}

/**
 * The gate (task 24 acceptance): unenrolled → wizard; revoked → wizard with the danger banner;
 * enrolled + no session / idle-locked → switcher; else the shell.
 *
 * ORDER IS THE SECURITY PROPERTY, not a style choice. Device status is checked FIRST and
 * unconditionally, so a revoked device cannot stay in the shell just because a session object is
 * still in memory: revocation is terminal (03 §Device) and must win over every other input. A gate
 * that checked the session first would leave a revoked device usable until someone happened to lock
 * it. The tests drive exactly that combination.
 */
export function resolveZone(input: ZoneInput): Zone {
  // 1. Device status is terminal and beats everything, including an open session.
  if (input.device === 'unenrolled') return { kind: 'enrollment', revoked: false };
  if (input.device === 'revoked') return { kind: 'enrollment', revoked: true };

  // 2. No session (or a lock ended it) ⇒ the switcher, which doubles as the lock screen (§8.2).
  if (input.session === null) {
    const mode: SwitcherMode = input.locked ? 'lock' : 'choose';
    if (input.pinFor !== null) return { kind: 'pin', userId: input.pinFor, mode };
    return { kind: 'switcher', mode, origin: input.route };
  }

  // 3. A session is open, but the user may still be switching to someone else voluntarily (§6.2):
  //    they tapped a face (→ the PIN pad) or asked for the switcher itself (→ the roster). The
  //    switcher carries `input.route` as `origin`, so abandoning the switch returns to the surface
  //    the avatar was tapped from rather than unconditionally home (task 143). The PIN pad wins over a
  //    pending `switching` — a picked face is a later step than "open the switcher".
  if (input.pinFor !== null) return { kind: 'pin', userId: input.pinFor, mode: 'choose' };
  if (input.switching) return { kind: 'switcher', mode: 'choose', origin: input.route };

  return { kind: 'shell', route: input.route };
}

/**
 * What Android's hardware back does — which, per design-system §8.1, is exactly what the header back
 * does. One function, so the two can never drift: the header renders `backTarget(zone) !== null` and
 * the hardware handler calls the same thing.
 *
 * `null` ⇒ there is nothing to go back to and the header shows no back control. For the LOCK
 * switcher that is a security property, not an omission (§8.2 "No header back when acting as lock"):
 * a back button on the lock screen would walk straight into the previous user's session.
 */
export type BackTarget =
  | { readonly kind: 'shellRoute'; readonly route: ShellRoute }
  | { readonly kind: 'switcher' }
  | { readonly kind: 'exitApp' };

export function backTarget(zone: Zone): BackTarget | null {
  switch (zone.kind) {
    case 'enrollment':
      // Nothing behind the wizard: the device is unusable until it enrolls. Step-to-step back is
      // the wizard's own state (see enrollment/model.ts), not the shell's.
      return null;
    case 'switcher':
      // A voluntary switch can be abandoned; a LOCK cannot (§8.2). Abandoning returns to the surface
      // the switch was opened FROM (`origin`) — pre-session that is `home`, from a live-session switch
      // it is wherever the avatar was tapped (task 143), never unconditionally home.
      return zone.mode === 'lock' ? null : { kind: 'shellRoute', route: zone.origin };
    case 'pin':
      // Back from the PIN pad returns to the user list in BOTH modes — picking the wrong face on a
      // shared terminal is the likely mistake, and it must not cost a lockout attempt.
      return { kind: 'switcher' };
    case 'shell':
      return zone.route === 'home' ? { kind: 'exitApp' } : { kind: 'shellRoute', route: 'home' };
  }
}

/**
 * The User Switcher (design-system §8.2; api/02-auth §5.1; PRD-011 §6.1).
 *
 * ── THE USE CASE IS A SHARED COUNTER, AND THE BUDGET IS 5 SECONDS ───────────────────────────────
 * One phone, several staff, all day, every handover mid-conversation with a customer. NFR-1003 caps
 * the whole switch at 5 s, which rules out anything clever: no animation, no confirmation screen, and
 * a search box only once the list outgrows a screen (`SWITCHER_SEARCH_MIN`). Speed here is not polish — a switcher slower than the task makes staff share one login
 * instead, and then every op in the log is attributed to the wrong person and the entire audit trail
 * (PRD-011 §5) is fiction. The switcher's speed IS the attribution control.
 *
 * ── WHY THE LIST IS SORTED BY RECENCY AND NOT ALPHABETICALLY ────────────────────────────────────
 * Alphabetical is stable, which sounds like a virtue and is not. The people who use this device are
 * the same two or three people all day; recency puts them in the first row, every time, so the
 * switch is a single glance and one tap. §8.2 says "sorted by most-recently-active" for exactly this.
 * Ties break on name so the order is deterministic (a list that reshuffles between renders defeats
 * the muscle memory it exists to build).
 *
 * ── AND WHY DEACTIVATED USERS ARE ABSENT, NOT GREYED ────────────────────────────────────────────
 * api/02-auth §5.1: only `active` users are switcher-usable. Task 14's `listSwitcherUsers` already
 * filters them, and this model does NOT re-filter — one implementation (CLAUDE.md §2.8). A greyed
 * row would advertise a colleague's deactivation to the whole shop and invite tapping something that
 * cannot work; absence is both kinder and correct. Their name still resolves on historical ops
 * (14's `resolveUserName`) — authentication is gated on status, name resolution is not.
 */
import { FuzzyIndex } from '@bolusi/core';

/** A switcher card. Shape mirrors 14's `listSwitcherUsers` plus the shell's ordering input. */
export interface SwitcherUser {
  readonly id: string;
  readonly name: string;
  /** Carried from day one (api/02-auth §5.2); v0 renders initials — a photo slots in unchanged. */
  readonly photoMediaId: string | null;
  /** ms epoch of this user's last session on this device; null ⇒ never used it here. */
  readonly lastActiveAt: number | null;
  /** True when the bundle row has `pinVerifier: null` — the §6.6 first-PIN flow. */
  readonly needsFirstPin: boolean;
  /**
   * True only for the owner who enrolled this device and still has no PIN: the one person who may
   * make their own first PIN (core's `firstPinUserOnThisDevice`). Everyone else gets theirs from an owner.
   */
  readonly canMakeOwnPin?: boolean | undefined;
  /**
   * The user's TOP-PRIVILEGE role(s) as roleKeys (design-system §8.2), from 14's
   * `resolveDisplayRoleKeys`. Usually one; more than one only when roles tie on privilege (the
   * owner ruling's "parallel at the top ⇒ list all"). Empty ⇒ no role grant, so the card shows no
   * role line. The card localizes each key via `role.<roleKey>.name` — the model stays copy-free.
   */
  readonly roleKeys: readonly string[];
}

/**
 * The four mandatory states (design-system §5), as a discriminated union so the screen cannot render
 * items-while-meaning-denied (FR-1036) and cannot forget one.
 *
 * `unauthorized` is present and deliberately unreachable in v0: §8.2 says this pre-auth surface has
 * no unauthorized case and renders `error` instead — there is no signed-in user to deny. Keeping the
 * arm in the union costs nothing and means the notes screens (task 25), which DO have one, inherit
 * the same shape rather than inventing a second one.
 */
export type SwitcherState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'ready'; readonly users: readonly SwitcherUser[] };

/**
 * §8.2's ordering: most-recently-active first, never-used last, ties by name.
 *
 * Pure and total — a copy is sorted, never the caller's array, so a re-render cannot mutate the
 * query result underneath a virtualized list mid-scroll.
 */
export function sortByRecency(users: readonly SwitcherUser[]): readonly SwitcherUser[] {
  return [...users].sort((a, b) => {
    const left = a.lastActiveAt ?? -1;
    const right = b.lastActiveAt ?? -1;
    if (left !== right) return right - left;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Build the screen state from a query result. `null` users ⇒ still loading; an empty array is EMPTY
 * and is a real, meaningful state — a device enrolled against a store with no active users, which is
 * why §8.2 gives it a CTA to enrollment rather than an apology.
 */
export function switcherState(
  users: readonly SwitcherUser[] | null,
  error: string | null,
): SwitcherState {
  if (error !== null) return { kind: 'error', code: error };
  if (users === null) return { kind: 'loading' };
  if (users.length === 0) return { kind: 'empty' };
  return { kind: 'ready', users: sortByRecency(users) };
}

/**
 * A search box appears once a store has more staff than fit on one screen. Below this, a glance at
 * the recency-sorted list is faster than typing, so the box would only be in the way.
 */
export const SWITCHER_SEARCH_MIN = 8;

/**
 * The users matching what was typed, best match first, typo-tolerant (the project's shared fuzzy
 * search: "yosua" finds "Yosua Wonda", "jhon" finds "John"). An empty query keeps the recency order.
 */
export function filterUsers<T extends { readonly id: string; readonly name: string }>(
  users: readonly T[],
  query: string,
): readonly T[] {
  if (query.trim() === '') return users;
  const index = new FuzzyIndex(
    users.map((user, position) => ({ id: user.id, text: [user.name], rank: -position })),
  );
  const byId = new Map(users.map((user) => [user.id, user]));
  return index
    .search(query, users.length)
    .map((hit) => byId.get(hit.id))
    .filter((user): user is T => user !== undefined);
}

/** Initials for the Avatar (design-system §3.12) — 1–2 characters, uppercased. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0]![0] ?? '?').toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/**
 * What tapping a card does. A user whose verifier is null never gets a PIN pad they cannot satisfy
 * (§6.6 first-PIN): guesses against a verifier that does not exist would still burn attempts. The
 * enrolling owner makes their own first PIN; anyone else is told to ask an owner, because a phone that
 * is behind may show "no PIN" for someone who already has one (core's `setFirstPin`).
 */
export type SwitcherTap =
  | { readonly kind: 'pin'; readonly userId: string }
  | { readonly kind: 'firstPinSetup'; readonly userId: string }
  | { readonly kind: 'askOwnerForPin'; readonly userId: string };

export function tapTarget(user: SwitcherUser): SwitcherTap {
  if (!user.needsFirstPin) return { kind: 'pin', userId: user.id };
  return user.canMakeOwnPin === true
    ? { kind: 'firstPinSetup', userId: user.id }
    : { kind: 'askOwnerForPin', userId: user.id };
}

// NO per-state headline label map here (task 65). A `SWITCHER_KEY` mirror once existed and was a
// decoy: `SwitcherScreen` renders each state's headline at its own site — `ListState.empty.title`,
// `.error.title`, `.unauthorized.title`, and the always-present AppShell title — never from a map,
// so the map shipped nowhere while its tests asserted it (the `canAttempt` shape, task 60). It also
// fit the UI badly: `loading` has no headline (a spinner) and `ready`'s "headline" is the screen
// title shown in every state. The one property worth guarding — empty ≠ error, so `[]` never reads
// as "we could not ask" (FR-1036) — lives in `switcherState`'s `kind` (its test), which is the
// shipping path the screen renders from; that is where the guard belongs (§2.8).

/** §8.2: the empty state's CTA goes to Device Enrollment. */
/**
 * The empty roster's GUIDANCE line (design-system §5).
 *
 * It accompanies the CTA rather than replacing it. History, because the reversal matters: this key
 * was once `SWITCHER_EMPTY_CTA_KEY = 'auth.switcher.addUser'` — a create-CTA whose `onCreate` the
 * composition root wired to `noop`, so the one control on the one screen a shop sees when its roster
 * empties rendered, took a press, and did nothing (task 130). D23 §3 ruled it OUT of v0 rather than
 * wiring it, because the flow behind it was unbuilt.
 *
 * **Task 168 / D27 built that flow, and the CTA is back** (`auth.switcher.reenroll`): `resolveZone`
 * gained the `reenrolling` input, and enrolment carries `replacesDeviceId` so the server revokes the
 * outgoing registration in the same transaction. The hint still reads true — asking the owner is the
 * normal path; the button is for when the owner IS the person who can no longer sign in.
 *
 * (This docblock previously ended "Task 168 carries that to v1" and described the CTA as removed.
 * That went stale the moment 168 shipped in the same delta, and it contradicted the one-line comment
 * directly above it. Found by a QA sweep; corrected rather than deleted, because a comment asserting
 * removed behaviour as current is the drift this codebase keeps paying for.)
 */
export const SWITCHER_EMPTY_HINT_KEY = 'auth.switcher.emptyUsers';

/** §8.2 / §6.4: the lock's explanation — "Layar terkunci… Pekerjaanmu aman." (your work is safe). */
export const SWITCHER_LOCK_KEY = 'auth.switcher.idleLocked';

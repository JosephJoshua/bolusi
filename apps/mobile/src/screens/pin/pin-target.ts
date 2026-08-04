/**
 * The target-user list the two OWNER PIN screens pick from (api/02-auth §6.5–§6.6; 02-permissions
 * §5.4.6). Owner reset and owner unlock both start by choosing a user from this device's directory,
 * so the row shape and the "who is locked" filter live here once (CLAUDE.md §2.8), not copied into
 * each screen's model.
 *
 * `lockedOut` is computed by the CALLER from task 14's `derivePinAuthState` over the target's
 * `pin_attempt_state` row — this module never re-derives the lockout machine (a second copy could
 * disagree with the one that actually gates entry, and the disagreement always favours the attacker).
 * It carries only the already-decided flag.
 */

/** A user the owner can act on: identity for the row, plus whether they are currently locked out. */
export interface PinTargetUser {
  readonly id: string;
  readonly name: string;
  /** True iff task 14's machine reads `locked_out` for this user on this device (caller-derived). */
  readonly lockedOut: boolean;
}

/**
 * The locked-out subset — the only users `auth.clearPinLockout` can act on (the flow throws
 * `INVALID_TRANSITION` for an unlocked target, api/02-auth §6.5). A copy is returned, never the
 * caller's array, so a re-render cannot mutate a query result underneath a list.
 */
export function lockedTargets(users: readonly PinTargetUser[]): readonly PinTargetUser[] {
  return users.filter((user) => user.lockedOut);
}

/**
 * The simple target-list state both owner screens derive — the screen turns it into a `<List>`
 * `ListState` by filling in localized copy + callbacks. Copy- and React-free so the §5 mapping is
 * unit-tested directly (T-6). A `ready` list may be empty, which each screen renders as its own
 * reassuring Empty ("no other users" / "no one is locked out").
 */
export type OwnerListState =
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'ready'; readonly targets: readonly PinTargetUser[] };

/** What both owner screens read to decide their target list. */
export interface OwnerListInput {
  /** Does the acting user hold the screen's owner permission (reset / unlock)? */
  readonly permitted: boolean;
  readonly loading: boolean;
  /** A DomainError code if the directory read failed, else null. */
  readonly error: string | null;
}

/**
 * The one §5 precedence both owner screens share (CLAUDE.md §2.8): PERMISSION is checked FIRST and
 * unconditionally, so a caller who lacks it sees Unauthorized — never Empty — even when the eventual
 * target list would be empty. Empty-when-denied is the FR-1036 trap (it reads as "nothing here",
 * hiding the denial AND leaking that there is nothing to act on); checking the permission before the
 * list is what forecloses it. `select` is applied only once we know the caller may see the list.
 */
export function ownerListState(
  input: OwnerListInput,
  select: () => readonly PinTargetUser[],
): OwnerListState {
  if (!input.permitted) return { kind: 'unauthorized' };
  if (input.loading) return { kind: 'loading' };
  if (input.error !== null) return { kind: 'error', code: input.error };
  return { kind: 'ready', targets: select() };
}

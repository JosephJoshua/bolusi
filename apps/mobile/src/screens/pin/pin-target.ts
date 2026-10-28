/**
 * The target-user list the owner's staff PIN screen picks from (api/02-auth §6.5–§6.6; 02-permissions
 * §5.4.6): a user from this device's directory with whether their PIN is locked.
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
  /** Top-privilege role keys for the row's role line; empty or absent ⇒ no role line. */
  readonly roleKeys?: readonly string[] | undefined;
  /** True when this device has no PIN for them yet (api/02-auth §6.6): the owner makes the first. */
  readonly needsFirstPin?: boolean | undefined;
  /** True iff task 14's machine reads `locked_out` for this user on this device (caller-derived). */
  readonly lockedOut: boolean;
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

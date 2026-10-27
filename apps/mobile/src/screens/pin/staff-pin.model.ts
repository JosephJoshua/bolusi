/**
 * The owner's "PIN karyawan" list: everyone else on this device, locked PINs first (that is usually
 * why the owner is here), then by name. One place for both owner PIN actions, unlock and reset; the
 * list shows if the owner may do either, and each action is offered only if they may do that one.
 * An owner who may only unlock sees only locked colleagues: nobody else has anything to offer.
 */
import { ownerListState, type OwnerListState, type PinTargetUser } from './pin-target.js';

export interface StaffListInput {
  readonly canUnlock: boolean;
  readonly canReset: boolean;
  readonly loading: boolean;
  /** A DomainError code if the directory read failed, else null. */
  readonly error: string | null;
  readonly users: readonly PinTargetUser[];
  /** The acting owner, left out: their own PIN is changed under "Ganti PIN". */
  readonly actorUserId: string;
}

export function staffListState(input: StaffListInput): OwnerListState {
  return ownerListState(
    { permitted: input.canUnlock || input.canReset, loading: input.loading, error: input.error },
    () =>
      input.users
        .filter((user) => user.id !== input.actorUserId)
        .filter((user) => input.canReset || user.lockedOut)
        .sort((a, b) =>
          a.lockedOut !== b.lockedOut ? (a.lockedOut ? -1 : 1) : a.name.localeCompare(b.name),
        ),
  );
}

/** What the person's page offers, in order of importance: the first is the primary action. */
export type StaffPinAction = 'unlock' | 'reset';

export function staffPinActions(
  user: PinTargetUser,
  can: { readonly canUnlock: boolean; readonly canReset: boolean },
): readonly StaffPinAction[] {
  const actions: StaffPinAction[] = [];
  if (user.lockedOut && can.canUnlock) actions.push('unlock');
  if (can.canReset) actions.push('reset');
  return actions;
}

/**
 * The line under the person, only where it adds something the chip and buttons do not: a locked
 * PIN the owner may either unlock or replace. Everywhere else the chip and the button say it all.
 */
export function staffPinBodyKey(
  user: PinTargetUser,
  actions: readonly StaffPinAction[],
): 'auth.pin.staff.lockedBody' | null {
  return user.lockedOut && actions.includes('unlock') && actions.includes('reset')
    ? 'auth.pin.staff.lockedBody'
    : null;
}

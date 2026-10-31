/**
 * "Karyawan": the owner's staff list and the steps behind it (owner decision 2026-10-27). The rules of
 * who may change whom live in core (`staff.ts`) so the counter PC offers the same; this is only the
 * phone's step machine and its copy keys.
 */
import {
  canManageMember,
  grantableRoles,
  staffDraftProblem,
  type StaffActor,
  type StaffAdminFailure,
  type StaffDirectory,
  type StaffDraft,
  type StaffDraftProblem,
  type StaffMember,
  type StaffRole,
  type StaffRoleKey,
} from '@bolusi/core';

/** Where the owner is in the flow. */
export type StaffStep =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  /** An active person's page: change name or roles, make a PIN, deactivate. */
  | { readonly kind: 'edit'; readonly id: string }
  /** A deactivated person's page: reactivate. */
  | { readonly kind: 'inactive'; readonly id: string }
  /** Just added: hand the phone over for their PIN, or later. */
  | { readonly kind: 'added'; readonly id: string; readonly name: string };

/** The page a tap on a person opens, or null when this owner may not change them. */
export function stepForMember(member: StaffMember, actor: StaffActor): StaffStep | null {
  if (!canManageMember(member, actor)) return null;
  return member.active ? { kind: 'edit', id: member.id } : { kind: 'inactive', id: member.id };
}

/** One row of the list: a person, or the heading over the deactivated ones. */
export type StaffListItem =
  | {
      readonly kind: 'member';
      readonly member: StaffMember;
      readonly self: boolean;
      /** Null: shown, but not this owner's to change (themselves, or another owner). */
      readonly open: StaffStep | null;
    }
  | { readonly kind: 'inactiveHeading' };

/** Active people, then a heading and the deactivated ones (only when there are any). */
export function staffListItems(
  directory: StaffDirectory,
  actor: StaffActor,
): readonly StaffListItem[] {
  const row = (member: StaffMember): StaffListItem => ({
    kind: 'member',
    member,
    self: member.id === actor.userId,
    open: stepForMember(member, actor),
  });
  const active = directory.members.filter((m) => m.active).map(row);
  const inactive = directory.members.filter((m) => !m.active).map(row);
  return inactive.length === 0 ? active : [...active, { kind: 'inactiveHeading' }, ...inactive];
}

/** Nobody but the owner themselves: the list shows its empty state and the add action. */
export function hasOtherStaff(directory: StaffDirectory, actor: StaffActor): boolean {
  return directory.members.some((member) => member.id !== actor.userId);
}

/** The roles offered on the form. A role the person already holds stays visible, even if not
 *  grantable, so editing a name never silently drops a role the owner could not have given. */
export function formRoles(
  directory: StaffDirectory,
  actor: StaffActor,
  heldRoleIds: readonly string[],
): readonly StaffRole[] {
  const grantable = grantableRoles(directory.roles, actor);
  return directory.roles.filter(
    (role) => grantable.includes(role) || heldRoleIds.includes(role.id),
  );
}

export function toggleRole(roleIds: readonly string[], roleId: string): readonly string[] {
  return roleIds.includes(roleId) ? roleIds.filter((id) => id !== roleId) : [...roleIds, roleId];
}

/** What changed against the saved person, as the update call's body; null when nothing did. */
export function staffChange(
  member: StaffMember,
  draft: StaffDraft,
): { readonly name?: string; readonly roleIds?: readonly string[] } | null {
  const name = draft.name.trim();
  const nameChanged = name !== member.name;
  const rolesChanged =
    draft.roleIds.length !== member.roleIds.length ||
    draft.roleIds.some((id) => !member.roleIds.includes(id));
  if (!nameChanged && !rolesChanged) return null;
  return {
    ...(nameChanged ? { name } : {}),
    ...(rolesChanged ? { roleIds: draft.roleIds } : {}),
  };
}

/** The draft check, re-exported so the screen reads one module. */
export { staffDraftProblem };

export const PROBLEM_KEY = {
  nameMissing: 'auth.staff.problem.nameMissing',
  nameTooLong: 'auth.staff.problem.nameTooLong',
  nameTaken: 'auth.staff.problem.nameTaken',
  roleMissing: 'auth.staff.problem.roleMissing',
} as const satisfies Record<StaffDraftProblem, string>;

export const FAILURE_KEY = {
  offline: 'auth.staff.failure.offline',
  denied: 'auth.staff.failure.denied',
  lastOwner: 'auth.staff.failure.lastOwner',
  rateLimited: 'auth.staff.failure.rateLimited',
  unexpected: 'auth.staff.failure.unexpected',
} as const satisfies Record<StaffAdminFailure, string>;

export const ROLE_HINT_KEY = {
  cashier: 'auth.staff.roleHint.cashier',
  technician: 'auth.staff.roleHint.technician',
  manager: 'auth.staff.roleHint.manager',
  staff: 'auth.staff.roleHint.staff',
  store_owner: 'auth.staff.roleHint.storeOwner',
} as const satisfies Record<StaffRoleKey, string>;

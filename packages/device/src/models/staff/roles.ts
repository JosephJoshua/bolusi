/**
 * "Tugas karyawan": the main owner's role editor (product-scope.md, "Managers, limits, approvals and roles").
 * Shared by the phone and the counter PC: which roles are offered, how each reads, and the draft a
 * role's page edits. The switches and what they stand for are `@bolusi/modules` role-abilities, which
 * the server checks again.
 */
import type { StaffDirectory, StaffRole } from '@bolusi/core';
import { t, translateRoleKey, type TranslationKey } from '@bolusi/i18n';
import {
  abilitiesOf,
  LIMITED_ABILITIES,
  permissionsFor,
  RISKY_ABILITIES,
  ROLE_ABILITY_GROUPS,
  toggleAbility,
  type RoleAbilityGroup,
} from '@bolusi/modules/roles';
import { ROLE_NAME_MAX } from '@bolusi/schemas';

import { ROLE_HINT_KEY } from './model.js';

/** A role's display name: a preset's copy, or the name the main owner gave it. */
export function roleName(role: Pick<StaffRole, 'key'>): string {
  return translateRoleKey(role.key);
}

/**
 * What a role is for, in a line: a preset's own hint, or a made role's areas ("Servisan · Uang").
 */
export function roleHint(role: Pick<StaffRole, 'key' | 'custom' | 'permissionIds'>): string {
  if (!role.custom && role.key in ROLE_HINT_KEY) {
    return t(ROLE_HINT_KEY[role.key as keyof typeof ROLE_HINT_KEY]);
  }
  const on = abilitiesOf(role.permissionIds);
  const areas = (ROLE_ABILITY_GROUPS as readonly RoleAbilityGroup[])
    .filter((group) => group.abilities.some((ability) => on.has(ability.id)))
    .map((group) => groupTitle(group.id));
  return areas.length === 0 ? t('auth.roles.nothing') : areas.join(' · ');
}

export function groupTitle(groupId: string): string {
  return t(`auth.roles.group.${groupId}` as TranslationKey);
}

export function abilityLabel(abilityId: string): string {
  return t(`auth.roles.ability.${abilityId}` as TranslationKey);
}

export function abilityHint(abilityId: string): string {
  return t(`auth.roles.ability.${abilityId}Hint` as TranslationKey);
}

/** A switch's caption: its hint, marked first when it hands out a risky power. */
export function abilityCaption(abilityId: string): string {
  const hint = abilityHint(abilityId);
  return RISKY_ABILITIES.has(abilityId) ? t('auth.roles.risky', { hint }) : hint;
}

/** The roles the editor offers: every store role but the owners'. */
export function editableRoles(directory: StaffDirectory): readonly StaffRole[] {
  return directory.roles.filter((role) => !role.ownerRole);
}

/** How many active people hold this role, shown beside it. */
export function roleHolders(directory: StaffDirectory, roleId: string): number {
  return directory.members.filter((member) => member.active && member.roleIds.includes(roleId))
    .length;
}

/** Whether anyone here holds this role, so it cannot be deleted yet. */
export function roleInUse(directory: StaffDirectory, roleId: string): boolean {
  return directory.members.some((member) => member.roleIds.includes(roleId));
}

export type RoleNameProblem = 'missing' | 'tooLong' | 'taken';

/**
 * What is wrong with a role name, or null. Compared without case against every role's shown name,
 * so a made "Kasir" cannot sit beside the preset Kasir.
 */
export function roleNameProblem(
  name: string,
  roles: readonly StaffRole[],
  editingId: string | null,
): RoleNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'missing';
  if (trimmed.length > ROLE_NAME_MAX) return 'tooLong';
  const folded = trimmed.toLocaleLowerCase('id');
  const taken = roles.some(
    (role) =>
      role.id !== editingId &&
      (roleName(role).toLocaleLowerCase('id') === folded ||
        role.key.toLocaleLowerCase('id') === folded),
  );
  return taken ? 'taken' : null;
}

/** What a role's page edits: its name (made roles), its switches, and whether it is limited. */
export interface RoleDraft {
  readonly name: string;
  readonly on: ReadonlySet<string>;
  readonly limited: boolean;
}

export function roleDraftOf(role: StaffRole): RoleDraft {
  return {
    name: role.custom ? role.key : roleName(role),
    on: abilitiesOf(role.permissionIds),
    limited: role.limits !== null,
  };
}

/** The change a draft makes to its role, or null when it makes none. */
export function roleChangeOf(
  role: StaffRole,
  draft: RoleDraft,
): { name?: string; permissionIds?: readonly string[]; limited?: boolean } | null {
  const change: { name?: string; permissionIds?: readonly string[]; limited?: boolean } = {};
  const name = draft.name.trim();
  if (role.custom && name !== role.key) change.name = name;
  const permissionIds = permissionsFor(draft.on);
  const current = permissionsFor(abilitiesOf(role.permissionIds));
  if (permissionIds.join() !== current.join()) change.permissionIds = permissionIds;
  if (draft.limited !== (role.limits !== null)) change.limited = draft.limited;
  return Object.keys(change).length === 0 ? null : change;
}

/** Whether a role holds a decision an owner's limit covers (discount, cancel, refund, credit…). */
export function hasLimitableAbility(on: ReadonlySet<string>): boolean {
  return LIMITED_ABILITIES.some((id) => on.has(id));
}

/**
 * A draft with one switch flipped (with what it needs, or without what needs it). A role that gets
 * its first decision a limit covers becomes limited, so it starts at Rp 0 until the owner sets its
 * limits rather than unlimited; the main owner can still switch that off.
 */
export function switchAbility(draft: RoleDraft, abilityId: string, value: boolean): RoleDraft {
  const on = toggleAbility(draft.on, abilityId, value);
  const firstLimitable = !hasLimitableAbility(draft.on) && hasLimitableAbility(on);
  return { ...draft, on, limited: draft.limited || firstLimitable };
}

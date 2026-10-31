// What a role may do, as the role editor offers it (product-scope.md, "Managers, limits, approvals
// and roles"): plain-language switches, each standing for one or more permission ids. The main owner
// edits every store role except the owners' own; the phone, the counter PC and the server all read
// this one list, so a switch means the same thing everywhere and the server takes no permission a
// switch does not offer.
//
// Every store permission is either behind a switch, held by every role, or kept for the owners
// (`role-abilities.test.ts` checks the registry against this file, so a new permission has to be
// placed here before it ships).
import { AUTH_PERMISSION, PLATFORM_PERMISSION } from '@bolusi/core';

import { APPROVAL_PERMISSION } from './approvals/constants.js';
import { INVENTORY_PERMISSION } from './inventory/constants.js';
import { MONEY_PERMISSION } from './money/constants.js';
import { NOTES_PERMISSION } from './notes/constants.js';
import { REPAIR_PERMISSION } from './repair/constants.js';

const R = REPAIR_PERMISSION;
const M = MONEY_PERMISSION;
const I = INVENTORY_PERMISSION;
const N = NOTES_PERMISSION;

export interface RoleAbility {
  /** Its copy: `auth.roles.ability.<id>` and `…<id>Hint`. */
  readonly id: string;
  readonly permissionIds: readonly string[];
  /** Abilities this one needs (seeing what it acts on): switched on with it, off without them. */
  readonly requires?: readonly string[];
}

export interface RoleAbilityGroup {
  /** Its heading: `auth.roles.group.<id>`. */
  readonly id: string;
  readonly abilities: readonly RoleAbility[];
}

export const ROLE_ABILITY_GROUPS = [
  {
    id: 'repair',
    abilities: [
      { id: 'repairView', permissionIds: [R.read] },
      { id: 'repairIntake', permissionIds: [R.intake, R.assign], requires: ['repairView'] },
      { id: 'repairWork', permissionIds: [R.work], requires: ['repairView'] },
      { id: 'repairPrice', permissionIds: [R.quoteChange], requires: ['repairView'] },
      { id: 'repairHandover', permissionIds: [R.handover], requires: ['repairView'] },
      { id: 'repairDiscount', permissionIds: [R.discount], requires: ['repairPrice'] },
      { id: 'repairCancel', permissionIds: [R.cancel], requires: ['repairView'] },
      { id: 'repairDownPayment', permissionIds: [R.correctDownPayment], requires: ['repairView'] },
      { id: 'repairWarranty', permissionIds: [R.warrantyException], requires: ['repairView'] },
      {
        id: 'repairSettings',
        permissionIds: [
          R.hideIntakeOptions,
          R.setCancelFees,
          R.setPrintSettings,
          R.setUncollectedDays,
        ],
        requires: ['repairView'],
      },
    ],
  },
  {
    id: 'money',
    abilities: [
      { id: 'moneyView', permissionIds: [M.read] },
      { id: 'moneyReceive', permissionIds: [M.receive], requires: ['moneyView'] },
      { id: 'moneyCash', permissionIds: [M.moveCash, M.countCash], requires: ['moneyView'] },
      { id: 'moneyRefund', permissionIds: [M.refund], requires: ['moneyView'] },
      { id: 'moneyVoid', permissionIds: [M.voidPayment], requires: ['moneyView'] },
      { id: 'moneyCredit', permissionIds: [M.extendCredit], requires: ['moneyView'] },
      { id: 'moneyAdjust', permissionIds: [M.adjustCash], requires: ['moneyCash'] },
      { id: 'moneyAccounts', permissionIds: [M.manageAccounts], requires: ['moneyView'] },
    ],
  },
  {
    id: 'stock',
    abilities: [
      { id: 'stockView', permissionIds: [I.read] },
      { id: 'stockUse', permissionIds: [I.useParts], requires: ['stockView'] },
      { id: 'stockCount', permissionIds: [I.count], requires: ['stockView'] },
      { id: 'stockCorrect', permissionIds: [I.correctUse], requires: ['stockView'] },
      { id: 'stockManage', permissionIds: [I.manageItems], requires: ['stockView'] },
    ],
  },
  {
    id: 'other',
    abilities: [
      { id: 'notes', permissionIds: [N.read, N.create, N.edit, N.archive] },
      {
        id: 'syncProblems',
        permissionIds: [PLATFORM_PERMISSION.conflictView, PLATFORM_PERMISSION.conflictAcknowledge],
      },
    ],
  },
] as const satisfies readonly RoleAbilityGroup[];

export type RoleAbilityId = (typeof ROLE_ABILITY_GROUPS)[number]['abilities'][number]['id'];

export const ROLE_ABILITIES: readonly RoleAbility[] = (
  ROLE_ABILITY_GROUPS as readonly RoleAbilityGroup[]
).flatMap((group) => group.abilities);

/**
 * The preset roles' switches (owner decision 2026-10-26 and 2026-10-28): what a new business starts
 * with, and the server's seed. The main owner can change each one afterwards.
 */
export const PRESET_ROLE_ABILITIES = {
  // The counter takes phones in, prices, hands back, and runs the cash drawer. Discounts, cancels,
  // refunds and voids are the owners' (how counter staff kept customers' cash).
  cashier: [
    'repairView',
    'repairIntake',
    'repairPrice',
    'repairHandover',
    'stockView',
    'stockUse',
    'moneyView',
    'moneyReceive',
    'moneyCash',
  ],
  technician: ['repairView', 'repairWork', 'stockView', 'stockUse'],
  // The counter's and the technician's work, plus the owners' daily decisions within limits.
  // Settling a drawer shortage (adjust cash, which has no limit) stays with the owners.
  manager: [
    'repairView',
    'repairIntake',
    'repairWork',
    'repairPrice',
    'repairHandover',
    'repairDiscount',
    'repairCancel',
    'repairDownPayment',
    'repairWarranty',
    'stockView',
    'stockUse',
    'stockCount',
    'stockCorrect',
    'moneyView',
    'moneyReceive',
    'moneyCash',
    'moneyRefund',
    'moneyVoid',
    'moneyCredit',
  ],
  staff: ['notes'],
} as const satisfies Record<string, readonly RoleAbilityId[]>;

/**
 * The switches an owner's limit covers (a permission with a `limit` kind behind them): a role
 * holding one is unlimited unless it is a limited role, so the editor offers that choice with them.
 */
export const LIMITED_ABILITIES = [
  'repairCancel',
  'repairDiscount',
  'repairDownPayment',
  'moneyRefund',
  'moneyVoid',
  'moneyCredit',
] as const satisfies readonly RoleAbilityId[];

/**
 * Held by every role: each person's own PIN and language, and approval requests (what someone may
 * ask for and decide is the decision's own permission).
 */
export const ROLE_BASE_PERMISSIONS: readonly string[] = [
  AUTH_PERMISSION.pinChange,
  PLATFORM_PERMISSION.setLocale,
  APPROVAL_PERMISSION.use,
];

/**
 * Store permissions no switch offers: power over people and devices, limits, and the business's
 * records of who did what. They stay with the owner roles, which the editor does not change.
 */
export const OWNER_ONLY_PERMISSIONS: readonly string[] = [
  AUTH_PERMISSION.userCreate,
  AUTH_PERMISSION.userEdit,
  AUTH_PERMISSION.userDeactivate,
  AUTH_PERMISSION.userResetPin,
  // Clearing a lockout lets PIN guessing start over on a phone that may be offline.
  AUTH_PERMISSION.pinUnlock,
  AUTH_PERMISSION.limitManage,
  AUTH_PERMISSION.deviceEnroll,
  AUTH_PERMISSION.deviceRevoke,
  AUTH_PERMISSION.deviceRead,
  AUTH_PERMISSION.auditView,
];

const BY_ID = new Map(ROLE_ABILITIES.map((ability) => [ability.id, ability]));

/** Whether a role holding these permissions has this switch on: every permission behind it. */
export function hasAbility(permissionIds: readonly string[], abilityId: string): boolean {
  const ability = BY_ID.get(abilityId);
  return ability !== undefined && ability.permissionIds.every((id) => permissionIds.includes(id));
}

/**
 * The switches a role holding these permissions has on: each held whole, with what it needs. A
 * switch whose needs are off reads as off, so a preset holding a stray permission opens clean.
 */
export function abilitiesOf(permissionIds: readonly string[]): ReadonlySet<string> {
  const on = new Set(
    ROLE_ABILITIES.filter((ability) => hasAbility(permissionIds, ability.id)).map((a) => a.id),
  );
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const id of on) {
      if ((BY_ID.get(id)?.requires ?? []).some((required) => !on.has(required))) {
        on.delete(id);
        dropped = true;
      }
    }
  }
  return on;
}

/**
 * Switch one on or off. On brings what it needs along; off takes down whatever needs it, so a set
 * never holds a switch without what it acts on.
 */
export function toggleAbility(
  on: ReadonlySet<string>,
  abilityId: string,
  value: boolean,
): ReadonlySet<string> {
  const next = new Set(on);
  const visit = (id: string): void => {
    if (value) {
      if (next.has(id)) return;
      next.add(id);
      for (const required of BY_ID.get(id)?.requires ?? []) visit(required);
    } else {
      if (!next.has(id)) return;
      next.delete(id);
      for (const ability of ROLE_ABILITIES) {
        if (ability.requires?.includes(id)) visit(ability.id);
      }
    }
  };
  visit(abilityId);
  return next;
}

/** The permission ids a role gets for these switches, sorted, the base ones included. */
export function permissionsFor(on: ReadonlySet<string>): readonly string[] {
  const ids = new Set(ROLE_BASE_PERMISSIONS);
  for (const id of on)
    for (const permission of BY_ID.get(id)?.permissionIds ?? []) ids.add(permission);
  return [...ids].sort();
}

/**
 * A role's permission list as the server takes it: only what the switches offer and the base ones,
 * with every switch whole and its needs met. Null when the list is anything else.
 */
export function normalizeRolePermissions(
  permissionIds: readonly string[],
): readonly string[] | null {
  const offered = new Set([
    ...ROLE_BASE_PERMISSIONS,
    ...ROLE_ABILITIES.flatMap((a) => a.permissionIds),
  ]);
  if (permissionIds.some((id) => !offered.has(id))) return null;
  const normalized = permissionsFor(abilitiesOf(permissionIds));
  // A switch held only in part, or without what it needs, is not a list the editor makes.
  return permissionIds.every((id) => normalized.includes(id)) ? normalized : null;
}

/**
 * The switches the editor marks so they are not flipped lightly: each hands out a power a module
 * declares dangerous (cash, prices, refunds, stock corrections). Written out so a device reads it
 * without every module; `riskyAbilities(ALL_MODULES)` must give exactly these (role-abilities.test).
 */
export const RISKY_ABILITIES: ReadonlySet<string> = new Set<RoleAbilityId>([
  'repairPrice',
  'repairDiscount',
  'repairCancel',
  'repairDownPayment',
  'repairWarranty',
  'moneyCash',
  'moneyRefund',
  'moneyVoid',
  'moneyCredit',
  'moneyAdjust',
  'moneyAccounts',
  'stockCount',
  'stockCorrect',
]);

/** The switches behind which some module declares a dangerous permission. */
export function riskyAbilities(
  modules: readonly {
    readonly permissions?: Readonly<Record<string, { readonly isDangerous: boolean }>>;
  }[],
): ReadonlySet<string> {
  const dangerous = new Set(
    modules.flatMap((module) =>
      Object.entries(module.permissions ?? {})
        .filter(([, declaration]) => declaration.isDangerous)
        .map(([id]) => id),
    ),
  );
  return new Set(
    ROLE_ABILITIES.filter((ability) => ability.permissionIds.some((id) => dangerous.has(id))).map(
      (ability) => ability.id,
    ),
  );
}

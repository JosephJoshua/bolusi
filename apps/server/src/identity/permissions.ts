// The server's view of the ONE canonical permission registry (02-permissions §11 registry, §12
// matrix, §10 default roles). This is the vocabulary the §4.5 permission checks resolve against and
// the data the provisioning CLI seeds (a tenant's three default roles).
//
// SINGLE SOURCE (CLAUDE.md §2.8). The permission vocabulary — ids, scopes, `isDangerous`, canonical
// EN descriptions — is declared exactly once, in the module manifests (`@bolusi/core`'s `auth` +
// `platform` modules, `@bolusi/modules`' `notes` module) and assembled by task 09's
// `assemblePermissionRegistry`. This file does NOT re-declare it. It assembles the SAME `ALL_MODULES`
// source `deps.ts` registers for the push pipeline (`registerModules(SERVER_MODULES)`) and projects
// it into the shapes the seed / bundle / §4.5 checks consume. Assembling that one source twice is a
// pure function of one vocabulary, not a second copy of it — the copy this task deleted was
// `permission-registry.ts`, a hand transcription of §11 that agreed with the registry only until it
// drifted (task 33 closed it; CLAUDE.md §2.8).
//
// The DEFAULT_ROLES matrix (§12) is NOT permission vocabulary — it is the role→permission mapping the
// provisioning CLI seeds. Core owns the vocabulary, not the v0 role set, so the matrix has no home
// there; it lives here alone and is DERIVED from the assembled ids, so it can never name a permission
// the registry does not define.
import {
  assemblePermissionRegistry,
  AUTH_PERMISSION,
  type PermissionEntry,
  type PermissionRegistry,
} from '@bolusi/core';
import { ALL_MODULES } from '@bolusi/modules';

/**
 * The assembled v0 permission registry — the ONE vocabulary (02 §3/§11), from the module manifests.
 * The permission-facing slice `assemblePermissionRegistry` reads (id + `permissions`/`commands`/
 * `queries`) is DB-independent, so the `AnyModuleDefinition<never>` element type erases cleanly.
 */
export const permissionRegistry: PermissionRegistry = assemblePermissionRegistry(
  ALL_MODULES.map((m) => ({
    id: m.id,
    ...(m.permissions === undefined ? {} : { permissions: m.permissions }),
    ...(m.commands === undefined ? {} : { commands: m.commands }),
    ...(m.queries === undefined ? {} : { queries: m.queries }),
  })),
);

/** 02 §11 — every v0 permission entry, in id order. `permissionsSnapshot` + the drift guard read this. */
export const PERMISSIONS: readonly PermissionEntry[] = permissionRegistry.all();

/** id → entry (02 §5.2 step 1 resolution). An id absent here does not exist in v0 → DENY. */
export const PERMISSION_BY_ID: ReadonlyMap<string, PermissionEntry> = new Map(
  PERMISSIONS.map((p) => [p.id, p]),
);

/**
 * The §4.5 permission-id strings the server checks require — sourced from core's `AUTH_PERMISSION`,
 * never re-spelled here (CLAUDE.md §2.8): a typo would be a compile error, not a silent allow.
 */
export const PERM = AUTH_PERMISSION;

/**
 * The tenant-administration permission for the LAST_ADMIN_PROTECTED guard (02 §5.4.4): a tenant admin
 * is an active user holding `auth.role_manage` via a TENANT-WIDE grant.
 */
export const TENANT_ADMIN_PERMISSION = AUTH_PERMISSION.roleManage;

export type RoleKey = 'main_owner' | 'store_owner' | 'staff' | 'cashier' | 'technician' | 'manager';

export interface DefaultRoleDef {
  readonly key: RoleKey;
  readonly scopeType: 'tenant' | 'store';
  readonly permissionIds: readonly string[];
  /** Its money decisions go only as far as each store sets (core authz/limits.ts). */
  readonly limited?: boolean;
}

const ALL_IDS = PERMISSIONS.map((p) => p.id);

// §12 matrix. main_owner holds every permission (via a tenant-wide grant); store_owner holds every
// store-scoped one (a store grant can never satisfy a tenant permission such as role_manage,
// tenant_configure or repair.manage_intake_options); staff holds pin_change, notes.*, set_locale.
const STORE_OWNER_PERMS = PERMISSIONS.filter((p) => p.scope === 'store').map((p) => p.id);
const STAFF_PERMS = [
  AUTH_PERMISSION.pinChange,
  'notes.create',
  'notes.edit',
  'notes.archive',
  'notes.read',
  'platform.set_locale',
];

// Repair presets (product-scope.md slice 1): the cashier takes devices in, prices, assigns and hands
// back; the technician works tickets and may only propose price changes. Cancelling and discounts are
// the owners' alone ("Cancelling a servisan"): both are how counter staff kept customers' cash.
const PERSONAL_PERMS = [AUTH_PERMISSION.pinChange, 'platform.set_locale'];
// Parts (owner decision, 2026-10-28): technicians and the counter see stock and take parts for a
// servisan in work. Editing the list, counting and correcting a finished servisan are the owners'.
const PARTS_USER_PERMS = ['inventory.read', 'inventory.use_parts'];
const CASHIER_PERMS = [
  ...PERSONAL_PERMS,
  'repair.read',
  'repair.intake',
  'repair.assign',
  'repair.quote_change',
  'repair.handover',
  ...PARTS_USER_PERMS,
  // Money (product-scope.md, "Repair payments"): the counter takes payments, gives back overpayments,
  // moves and counts cash. Bigger refunds, lower bills, voids and cash adjustments are owners'.
  'money.read',
  'money.receive',
  'money.move_cash',
  'money.count_cash',
];
const TECHNICIAN_PERMS = [...PERSONAL_PERMS, 'repair.read', 'repair.work', ...PARTS_USER_PERMS];
// Managers (product-scope.md, "Managers, limits, approvals and roles"): the counter's and the
// technician's work, plus the owners' daily decisions, each money decision within the limits the
// store owner sets. Settings, staff and payment methods stay with the owners. Migration 0027 seeds
// the same list for businesses that existed before.
const MANAGER_PERMS = [
  ...new Set([
    ...CASHIER_PERMS,
    ...TECHNICIAN_PERMS,
    'repair.cancel',
    'repair.discount',
    'repair.correct_down_payment',
    'repair.warranty_exception',
    'inventory.correct_use',
    'inventory.count',
    'money.adjust_cash',
    'money.refund',
    'money.void_payment',
    'money.extend_credit',
  ]),
];

/** 02 §10 — the system-default roles, seeded at provisioning. Store owners can edit grants later. */
export const DEFAULT_ROLES: readonly DefaultRoleDef[] = [
  { key: 'main_owner', scopeType: 'tenant', permissionIds: ALL_IDS },
  { key: 'store_owner', scopeType: 'store', permissionIds: STORE_OWNER_PERMS },
  { key: 'staff', scopeType: 'store', permissionIds: STAFF_PERMS },
  { key: 'cashier', scopeType: 'store', permissionIds: CASHIER_PERMS },
  { key: 'technician', scopeType: 'store', permissionIds: TECHNICIAN_PERMS },
  { key: 'manager', scopeType: 'store', permissionIds: MANAGER_PERMS, limited: true },
];

// The v0 permission registry + default-role grant matrix (02-permissions §11 registry, §12 matrix,
// §10 default roles). This is the vocabulary the §4.5 permission checks resolve against and the
// data the provisioning CLI seeds (the `permissions` global table + a tenant's three default roles).
//
// OWNERSHIP NOTE (flagged for task 09/31 reconciliation): 02-permissions is authoritative and
// task 09 (permission-evaluator, still `todo`) owns the shared registry / defineModule
// `permissions` blocks. This task depends on 05/12 only — not 09 — and needs the ids NOW for the
// server-side §4.5 checks and the provisioning seed, so the v0 registry is transcribed here from
// 02-permissions §11/§12 verbatim. When task 09/11 land the shared registry, this must reconcile
// to it (same ids, same scopes, same matrix) rather than diverge — CLAUDE.md §2.8.

export interface PermissionDef {
  readonly id: string;
  readonly module: string;
  readonly action: string;
  readonly scope: 'tenant' | 'store';
  readonly isDangerous: boolean;
  readonly description: string;
}

/** 02-permissions §11 — the complete v0 registry. An id not here does not exist in v0. */
export const PERMISSIONS: readonly PermissionDef[] = [
  // §11.1 auth
  {
    id: 'auth.user_create',
    module: 'auth',
    action: 'user_create',
    scope: 'store',
    isDangerous: false,
    description: 'Can create employee accounts for the store.',
  },
  {
    id: 'auth.user_edit',
    module: 'auth',
    action: 'user_edit',
    scope: 'store',
    isDangerous: false,
    description: "Can edit an employee's name, photo, and store membership.",
  },
  {
    id: 'auth.user_deactivate',
    module: 'auth',
    action: 'user_deactivate',
    scope: 'store',
    isDangerous: true,
    description:
      "Can deactivate an employee's account, removing their access everywhere. Their history is kept.",
  },
  {
    id: 'auth.user_reset_pin',
    module: 'auth',
    action: 'user_reset_pin',
    scope: 'store',
    isDangerous: true,
    description:
      "Can reset another employee's PIN. Whoever holds this can take over that person's identity until they change it.",
  },
  {
    id: 'auth.pin_change',
    module: 'auth',
    action: 'pin_change',
    scope: 'store',
    isDangerous: false,
    description: 'Can change their own PIN.',
  },
  {
    id: 'auth.pin_unlock',
    module: 'auth',
    action: 'pin_unlock',
    scope: 'store',
    isDangerous: false,
    description: "Can clear an employee's PIN lockout so they can try again.",
  },
  {
    id: 'auth.role_manage',
    module: 'auth',
    action: 'role_manage',
    scope: 'tenant',
    isDangerous: true,
    description:
      'Can create, rename, edit, and delete roles, and give them to employees or take them away.',
  },
  {
    id: 'auth.device_enroll',
    module: 'auth',
    action: 'device_enroll',
    scope: 'store',
    isDangerous: true,
    description:
      'Can approve a new device for the store. An approved device can record and sign business actions.',
  },
  {
    id: 'auth.device_revoke',
    module: 'auth',
    action: 'device_revoke',
    scope: 'store',
    isDangerous: true,
    description:
      'Can block a device (lost, stolen, retired). Anything not yet synced from it will be rejected.',
  },
  {
    id: 'auth.device_read',
    module: 'auth',
    action: 'device_read',
    scope: 'store',
    isDangerous: false,
    description: "Can see the store's devices, who is enrolled on them, and when each last synced.",
  },
  {
    id: 'auth.tenant_configure',
    module: 'auth',
    action: 'tenant_configure',
    scope: 'tenant',
    isDangerous: true,
    description: 'Can change business-wide settings that apply to every store.',
  },
  {
    id: 'auth.audit_view',
    module: 'auth',
    action: 'audit_view',
    scope: 'store',
    isDangerous: false,
    description:
      'Can view the audit trail: denied attempts, PIN resets, user switches, and device events.',
  },
  // §11.2 notes
  {
    id: 'notes.create',
    module: 'notes',
    action: 'create',
    scope: 'store',
    isDangerous: false,
    description: 'Can create a note in the store.',
  },
  {
    id: 'notes.edit',
    module: 'notes',
    action: 'edit',
    scope: 'store',
    isDangerous: false,
    description: 'Can edit the body of an existing note.',
  },
  {
    id: 'notes.archive',
    module: 'notes',
    action: 'archive',
    scope: 'store',
    isDangerous: false,
    description: "Can archive a note, removing it from the store's active list.",
  },
  {
    id: 'notes.read',
    module: 'notes',
    action: 'read',
    scope: 'store',
    isDangerous: false,
    description: "Can read the store's notes.",
  },
  // §11.3 platform
  {
    id: 'platform.conflict_view',
    module: 'platform',
    action: 'conflict_view',
    scope: 'store',
    isDangerous: false,
    description:
      'Can see conflicts — places where two devices recorded contradictory changes to the same record.',
  },
  {
    id: 'platform.conflict_acknowledge',
    module: 'platform',
    action: 'conflict_acknowledge',
    scope: 'store',
    isDangerous: false,
    description:
      'Can review a surfaced conflict and acknowledge it, confirming the recorded outcome.',
  },
  {
    id: 'platform.set_locale',
    module: 'platform',
    action: 'set_locale',
    scope: 'store',
    isDangerous: false,
    description: 'Can change their own app language.',
  },
];

export const PERMISSION_BY_ID: ReadonlyMap<string, PermissionDef> = new Map(
  PERMISSIONS.map((p) => [p.id, p]),
);

/** The exact §4.5 permission-id strings used by the server checks. Never module-prefix variants. */
export const PERM = {
  userCreate: 'auth.user_create',
  userEdit: 'auth.user_edit',
  userDeactivate: 'auth.user_deactivate',
  userResetPin: 'auth.user_reset_pin',
  roleManage: 'auth.role_manage',
  deviceEnroll: 'auth.device_enroll',
  deviceRevoke: 'auth.device_revoke',
  deviceRead: 'auth.device_read',
  tenantConfigure: 'auth.tenant_configure',
} as const;

/**
 * The tenant-administration permission for the LAST_ADMIN_PROTECTED guard (02-permissions §5.4.4):
 * a tenant admin is an active user holding `auth.role_manage` via a TENANT-WIDE grant.
 */
export const TENANT_ADMIN_PERMISSION = 'auth.role_manage';

export type RoleKey = 'main_owner' | 'store_owner' | 'staff';

export interface DefaultRoleDef {
  readonly key: RoleKey;
  readonly scopeType: 'tenant' | 'store';
  readonly permissionIds: readonly string[];
}

// §12 matrix. main_owner holds every permission (via a tenant-wide grant); store_owner holds
// everything except role_manage + tenant_configure; staff holds pin_change, notes.*, set_locale.
const STORE_OWNER_PERMS = PERMISSIONS.map((p) => p.id).filter(
  (id) => id !== 'auth.role_manage' && id !== 'auth.tenant_configure',
);
const STAFF_PERMS = [
  'auth.pin_change',
  'notes.create',
  'notes.edit',
  'notes.archive',
  'notes.read',
  'platform.set_locale',
];

/** 02-permissions §10 — the three v0 system-default roles, seeded at provisioning. */
export const DEFAULT_ROLES: readonly DefaultRoleDef[] = [
  { key: 'main_owner', scopeType: 'tenant', permissionIds: PERMISSIONS.map((p) => p.id) },
  { key: 'store_owner', scopeType: 'store', permissionIds: STORE_OWNER_PERMS },
  { key: 'staff', scopeType: 'store', permissionIds: STAFF_PERMS },
];

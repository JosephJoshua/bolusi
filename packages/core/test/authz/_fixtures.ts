// Authz test fixtures: the v0 permission registry (02-permissions §11) and the three v0 default
// roles (§10, grant lists from the §12 matrix), plus snapshot builders.
//
// These are FIXTURES, not production data. The real registry is assembled from the auth / notes /
// platform module manifests (tasks 11+); this task ships the MECHANISM. Encoding §11–§12 here is
// what the task file asks for ("§10–§12 — use as test fixtures") and gives the evaluator suite a
// realistic matrix to exercise rather than three invented roles that prove nothing about the spec.
import type {
  DirectoryGrant,
  DirectoryRole,
  DirectorySnapshot,
  DirectoryUser,
  ModulePermissionManifest,
  PermissionDeclaration,
} from '../../src/index.js';

export const TENANT = 'tenant-jaya';
export const OTHER_TENANT = 'tenant-other';
export const STORE_A = 'store-jayapura';
export const STORE_B = 'store-sentani';

const store = (isDangerous: boolean, description: string): PermissionDeclaration => ({
  scope: 'store',
  isDangerous,
  description,
});
const tenant = (isDangerous: boolean, description: string): PermissionDeclaration => ({
  scope: 'tenant',
  isDangerous,
  description,
});

/** §11.1 — the `auth` module's permissions, verbatim scopes and isDangerous flags. */
export const AUTH_PERMISSIONS: Readonly<Record<string, PermissionDeclaration>> = {
  'auth.user_create': store(false, 'Can create employee accounts for the store.'),
  'auth.user_edit': store(false, "Can edit an employee's name, photo, and store membership."),
  'auth.user_deactivate': store(
    true,
    "Can deactivate an employee's account, removing their access everywhere. Their history is kept.",
  ),
  'auth.user_reset_pin': store(true, "Can reset another employee's PIN."),
  'auth.pin_change': store(false, 'Can change their own PIN.'),
  'auth.pin_unlock': store(false, "Can clear an employee's PIN lockout so they can try again."),
  'auth.role_manage': tenant(
    true,
    'Can create, rename, edit, and delete roles, and give them to employees or take them away.',
  ),
  'auth.device_enroll': store(true, 'Can approve a new device for the store.'),
  'auth.device_revoke': store(true, 'Can block a device (lost, stolen, retired).'),
  'auth.device_read': store(false, "Can see the store's devices."),
  'auth.tenant_configure': tenant(
    true,
    'Can change business-wide settings that apply to every store.',
  ),
  'auth.audit_view': store(false, 'Can view the audit trail.'),
};

/** §11.2 — the `notes` reference module. */
export const NOTES_PERMISSIONS: Readonly<Record<string, PermissionDeclaration>> = {
  'notes.create': store(false, 'Can create a note in the store.'),
  'notes.edit': store(false, 'Can edit the body of an existing note.'),
  'notes.archive': store(false, "Can archive a note, removing it from the store's active list."),
  'notes.read': store(false, "Can read the store's notes."),
};

/** §11.3 — the `platform` module. */
export const PLATFORM_PERMISSIONS: Readonly<Record<string, PermissionDeclaration>> = {
  'platform.conflict_view': store(false, 'Can see conflicts.'),
  'platform.conflict_acknowledge': store(
    false,
    'Can review a surfaced conflict and acknowledge it.',
  ),
  'platform.set_locale': store(false, 'Can change their own app language.'),
};

/** The complete v0 registry size (§11): 12 auth + 4 notes + 3 platform. The suite's denominator. */
export const V0_PERMISSION_COUNT = 19;

/** The three module manifests, with the commands/queries 04 §5–§6 would declare. */
export const authModule: ModulePermissionManifest = {
  id: 'auth',
  permissions: AUTH_PERMISSIONS,
  commands: {
    changePin: { permission: 'auth.pin_change' },
    clearPinLockout: { permission: 'auth.pin_unlock' },
  },
  queries: {
    listPermissionDenials: { permission: 'auth.audit_view' },
    listDevices: { permission: 'auth.device_read' },
  },
};

export const notesModule: ModulePermissionManifest = {
  id: 'notes',
  permissions: NOTES_PERMISSIONS,
  commands: {
    createNote: { permission: 'notes.create' },
    editNoteBody: { permission: 'notes.edit' },
    archiveNote: { permission: 'notes.archive' },
  },
  queries: {
    listNotes: { permission: 'notes.read' },
    getNote: { permission: 'notes.read' },
  },
};

export const platformModule: ModulePermissionManifest = {
  id: 'platform',
  permissions: PLATFORM_PERMISSIONS,
  commands: {
    acknowledgeConflict: { permission: 'platform.conflict_acknowledge' },
    setLocale: { permission: 'platform.set_locale' },
  },
  queries: {
    listConflicts: { permission: 'platform.conflict_view' },
  },
};

export const V0_MODULES: readonly ModulePermissionManifest[] = [
  authModule,
  notesModule,
  platformModule,
];

/** Command/query → permission references across the v0 fixture modules. The rule-3 denominator. */
export const V0_REFERENCE_COUNT = 12;

// ---------------------------------------------------------------------------------------------
// §10 / §12 roles
// ---------------------------------------------------------------------------------------------

export const ROLE_MAIN_OWNER = 'role-main-owner';
export const ROLE_STORE_OWNER = 'role-store-owner';
export const ROLE_STAFF = 'role-staff';

const ALL_IDS = [
  ...Object.keys(AUTH_PERMISSIONS),
  ...Object.keys(NOTES_PERMISSIONS),
  ...Object.keys(PLATFORM_PERMISSIONS),
];

/** §12: `main_owner` holds EVERY v0 permission — no wildcard, no superuser flag, all explicit (§1). */
export const MAIN_OWNER_IDS: readonly string[] = ALL_IDS;

/** §12: `store_owner` = everything except the two tenant-scoped ids. */
export const STORE_OWNER_IDS: readonly string[] = ALL_IDS.filter(
  (id) => id !== 'auth.role_manage' && id !== 'auth.tenant_configure',
);

/** §12: `staff` — works with notes, administers nothing. */
export const STAFF_IDS: readonly string[] = [
  'auth.pin_change',
  'notes.create',
  'notes.edit',
  'notes.archive',
  'notes.read',
  'platform.set_locale',
];

/** Per-role denominators from the §12 matrix — a miscounted fixture fails loudly (T-14). */
export const MATRIX_COUNTS = { main_owner: 19, store_owner: 17, staff: 6 } as const;

export const USER_OWNER = 'user-main-owner';
export const USER_STORE_OWNER = 'user-store-owner';
export const USER_STAFF = 'user-staff';
export const USER_ZERO_GRANTS = 'user-zero-grants';

export function role(
  scopeType: 'tenant' | 'store',
  permissionIds: readonly string[],
): DirectoryRole {
  return { scopeType, permissionIdsJson: JSON.stringify(permissionIds) };
}

export interface SnapshotSpec {
  readonly tenantId?: string | null;
  readonly users?: Readonly<Record<string, DirectoryUser>>;
  readonly roles?: Readonly<Record<string, DirectoryRole>>;
  readonly grants?: Readonly<Record<string, readonly DirectoryGrant[]>>;
}

export function snapshot(spec: SnapshotSpec = {}): DirectorySnapshot {
  return {
    tenantId: spec.tenantId === undefined ? TENANT : spec.tenantId,
    users: new Map(Object.entries(spec.users ?? {})),
    roles: new Map(Object.entries(spec.roles ?? {})),
    grantsByUser: new Map(Object.entries(spec.grants ?? {})),
  };
}

/**
 * The canonical v0 directory: the three §10 roles, four users, and the §12 grant shapes —
 * `main_owner` tenant-wide, `store_owner` at STORE_A, `staff` at STORE_A, and a zero-grant user
 * (the literal 04 §8 harness case).
 */
export function v0Snapshot(overrides: SnapshotSpec = {}): DirectorySnapshot {
  return snapshot({
    tenantId: TENANT,
    users: {
      [USER_OWNER]: { status: 'active' },
      [USER_STORE_OWNER]: { status: 'active' },
      [USER_STAFF]: { status: 'active' },
      [USER_ZERO_GRANTS]: { status: 'active' },
    },
    roles: {
      [ROLE_MAIN_OWNER]: role('tenant', MAIN_OWNER_IDS),
      [ROLE_STORE_OWNER]: role('store', STORE_OWNER_IDS),
      [ROLE_STAFF]: role('store', STAFF_IDS),
    },
    grants: {
      // §10: the franchise owner's grant is tenant-wide — valid in every store of the tenant.
      [USER_OWNER]: [{ roleId: ROLE_MAIN_OWNER, storeId: null }],
      [USER_STORE_OWNER]: [{ roleId: ROLE_STORE_OWNER, storeId: STORE_A }],
      [USER_STAFF]: [{ roleId: ROLE_STAFF, storeId: STORE_A }],
      [USER_ZERO_GRANTS]: [],
    },
    ...overrides,
  });
}

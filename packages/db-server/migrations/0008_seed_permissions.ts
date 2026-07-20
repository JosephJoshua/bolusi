// Seed the global `permissions` registry (02-permissions §11; 10-db-schema §4: "rows are upserted
// at deploy from the module manifests"). This is GLOBAL, RLS-free reference data owned by
// bolusi_provision — the app role has SELECT only and cannot seed it, so a migration (run as the
// provisioning/superuser role) is the correct place. Without these rows the role_permissions FK
// makes tenant provisioning and every grant impossible.
//
// The rows mirror 02-permissions §11 verbatim. The runtime registry is the ONE assembled from the
// `@bolusi/core` module manifests (the server reads it via identity/permissions.ts); a drift-guard
// test (apps/server acting-user.test.ts) asserts that core registry and this seed agree on every
// id, scope, isDangerous, and description.
import { sql, type Kysely } from 'kysely';

interface PermRow {
  id: string;
  module: string;
  action: string;
  scope: 'tenant' | 'store';
  is_dangerous: boolean;
  description: string;
}

const PERMISSIONS: PermRow[] = [
  // auth (§11.1)
  {
    id: 'auth.user_create',
    module: 'auth',
    action: 'user_create',
    scope: 'store',
    is_dangerous: false,
    description: 'Can create employee accounts for the store.',
  },
  {
    id: 'auth.user_edit',
    module: 'auth',
    action: 'user_edit',
    scope: 'store',
    is_dangerous: false,
    description: "Can edit an employee's name, photo, and store membership.",
  },
  {
    id: 'auth.user_deactivate',
    module: 'auth',
    action: 'user_deactivate',
    scope: 'store',
    is_dangerous: true,
    description:
      "Can deactivate an employee's account, removing their access everywhere. Their history is kept.",
  },
  {
    id: 'auth.user_reset_pin',
    module: 'auth',
    action: 'user_reset_pin',
    scope: 'store',
    is_dangerous: true,
    description:
      "Can reset another employee's PIN. Whoever holds this can take over that person's identity until they change it.",
  },
  {
    id: 'auth.pin_change',
    module: 'auth',
    action: 'pin_change',
    scope: 'store',
    is_dangerous: false,
    description: 'Can change their own PIN.',
  },
  {
    id: 'auth.pin_unlock',
    module: 'auth',
    action: 'pin_unlock',
    scope: 'store',
    is_dangerous: false,
    description: "Can clear an employee's PIN lockout so they can try again.",
  },
  {
    id: 'auth.role_manage',
    module: 'auth',
    action: 'role_manage',
    scope: 'tenant',
    is_dangerous: true,
    description:
      'Can create, rename, edit, and delete roles, and give them to employees or take them away.',
  },
  {
    id: 'auth.device_enroll',
    module: 'auth',
    action: 'device_enroll',
    scope: 'store',
    is_dangerous: true,
    description:
      'Can approve a new device for the store. An approved device can record and sign business actions.',
  },
  {
    id: 'auth.device_revoke',
    module: 'auth',
    action: 'device_revoke',
    scope: 'store',
    is_dangerous: true,
    description:
      'Can block a device (lost, stolen, retired). Anything not yet synced from it will be rejected.',
  },
  {
    id: 'auth.device_read',
    module: 'auth',
    action: 'device_read',
    scope: 'store',
    is_dangerous: false,
    description: "Can see the store's devices, who is enrolled on them, and when each last synced.",
  },
  {
    id: 'auth.tenant_configure',
    module: 'auth',
    action: 'tenant_configure',
    scope: 'tenant',
    is_dangerous: true,
    description: 'Can change business-wide settings that apply to every store.',
  },
  {
    id: 'auth.audit_view',
    module: 'auth',
    action: 'audit_view',
    scope: 'store',
    is_dangerous: false,
    description:
      'Can view the audit trail: denied attempts, PIN resets, user switches, and device events.',
  },
  // notes (§11.2)
  {
    id: 'notes.create',
    module: 'notes',
    action: 'create',
    scope: 'store',
    is_dangerous: false,
    description: 'Can create a note in the store.',
  },
  {
    id: 'notes.edit',
    module: 'notes',
    action: 'edit',
    scope: 'store',
    is_dangerous: false,
    description: 'Can edit the body of an existing note.',
  },
  {
    id: 'notes.archive',
    module: 'notes',
    action: 'archive',
    scope: 'store',
    is_dangerous: false,
    description: "Can archive a note, removing it from the store's active list.",
  },
  {
    id: 'notes.read',
    module: 'notes',
    action: 'read',
    scope: 'store',
    is_dangerous: false,
    description: "Can read the store's notes.",
  },
  // platform (§11.3)
  {
    id: 'platform.conflict_view',
    module: 'platform',
    action: 'conflict_view',
    scope: 'store',
    is_dangerous: false,
    description:
      'Can see conflicts — places where two devices recorded contradictory changes to the same record.',
  },
  {
    id: 'platform.conflict_acknowledge',
    module: 'platform',
    action: 'conflict_acknowledge',
    scope: 'store',
    is_dangerous: false,
    description:
      'Can review a surfaced conflict and acknowledge it, confirming the recorded outcome.',
  },
  {
    id: 'platform.set_locale',
    module: 'platform',
    action: 'set_locale',
    scope: 'store',
    is_dangerous: false,
    description: 'Can change their own app language.',
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const p of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${p.id}, ${p.module}, ${p.action}, ${p.scope}, ${p.description}, ${p.is_dangerous})
      ON CONFLICT (id) DO UPDATE SET
        module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
        description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of PERMISSIONS) {
    await sql`DELETE FROM permissions WHERE id = ${p.id}`.execute(db);
  }
}

// A grant-all permission evaluator for the harness workload.
//
// The chaos harness proves CONVERGENCE and fault-tolerance, not the permission matrix (that is
// task 11's `@bolusi/core` authz suite). So every VirtualDevice's user holds a single tenant-wide
// role carrying exactly the permissions the modules it drives declare — assembled from the REAL
// module manifests (§2.8: the permission ids come from the manifest, never a second hand-typed
// list), fed through the REAL `PermissionEvaluator` (T-7). The command runtime therefore runs its
// real §5.1 permission step; it simply always passes, which is the correct precondition for a
// workload whose subject is ordering, not authorization.
import {
  assemblePermissionRegistry,
  PermissionEvaluator,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type DirectoryUser,
  type ModulePermissionManifest,
} from '@bolusi/core';

const HARNESS_ROLE_ID = 'harness.owner';

/**
 * Build a primed evaluator that grants `userId` every permission the given module manifests
 * declare, tenant-wide. The role is `tenant`-scoped so a `null` (tenant-wide) grant is valid
 * (02 §5.1), which makes the grant reach every store the device operates in.
 */
export async function buildGrantAllEvaluator(options: {
  readonly tenantId: string;
  readonly userId: string;
  readonly manifests: readonly ModulePermissionManifest[];
}): Promise<PermissionEvaluator> {
  const registry = assemblePermissionRegistry(options.manifests);
  const permissionIds = options.manifests.flatMap((manifest) =>
    Object.keys(manifest.permissions ?? {}),
  );

  const role: DirectoryRole = {
    scopeType: 'tenant',
    permissionIdsJson: JSON.stringify(permissionIds),
  };
  const user: DirectoryUser = { status: 'active' };
  const grant: DirectoryGrant = { roleId: HARNESS_ROLE_ID, storeId: null };
  const snapshot: DirectorySnapshot = {
    tenantId: options.tenantId,
    users: new Map([[options.userId, user]]),
    roles: new Map([[HARNESS_ROLE_ID, role]]),
    grantsByUser: new Map([[options.userId, [grant]]]),
  };

  const evaluator = new PermissionEvaluator(registry, {
    load: () => Promise.resolve(snapshot),
  });
  await evaluator.prime();
  return evaluator;
}

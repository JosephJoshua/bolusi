// The permissions the window shows or hides actions by: every module's (repair's, money's for Kas
// and payments, ...), so no module's screens are left without theirs. Enforcement stays in the core.
import { ALL_MODULES } from '@bolusi/modules';

const MODULE_PERMISSIONS: readonly string[] = ALL_MODULES.flatMap((module) =>
  Object.keys(module.permissions ?? {}),
);

/** The module permissions `has` grants. */
export function heldPermissions(has: (permission: string) => boolean): string[] {
  return MODULE_PERMISSIONS.filter((permission) => has(permission));
}

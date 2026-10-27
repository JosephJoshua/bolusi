// Authorization of a pushed op: the server is the authority on who may do what.
//
// Every op type declares the permission its author must hold (`OperationDeclaration.permission`),
// and this step checks it for every op, with no per-type opt-in, using the same `evaluatePermission`
// a device runs before a command, fed the SERVER's directory. A device's own check is a fast offline
// answer; this is the one that decides whether the op enters the log.
//
// Evaluated in the pushing device's store, exactly as the device evaluated it (02-permissions §5.2:
// the evaluation store is the enrolled device's store). The scope step has already proven
// `op.storeId` is that store or null for a tenant-scoped type.
//
// A deactivated author is refused like an unpermitted one (owner decision, 2026-10-26): the
// evaluator denies inactive users, and the server applies that to work still unsynced.
//
// The author must also be an employee of the device's store. The envelope's userId is the device's
// claim (it verified the PIN locally); without this a device could credit its op to any user of the
// tenant, for instance an owner of another store, and borrow that user's grants. Within the store
// the device remains the trust root for who is signed in, as for X-Acting-User (api/02-auth §4.5).
import type { DirectorySnapshot } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

import { evaluateWithDirectory, loadUserDirectory } from '../../auth/permissions.js';
import type { DeviceRecord, OpRegistry } from '../types.js';
import { AUTH_PIN_LOCKOUT_CLEARED, AUTH_PIN_RESET, GENESIS_TYPE } from './scope.js';

export type PermissionOutcome = null | { readonly reason: string };

/** The directory reads the authorization step needs, each made once per push batch. */
export interface AuthorLookup {
  directory(userId: string): Promise<DirectorySnapshot>;
  stores(userId: string): Promise<readonly string[]>;
}

/**
 * Loads each user's directory and store memberships once per push batch. A batch is one device's
 * ops, nearly always one user, so this turns per-op reads into one per batch. Lives only for one
 * transaction, so a grant change between pushes is always seen.
 */
export function createAuthorLookup(db: TenantDb, tenantId: string): AuthorLookup {
  const directories = new Map<string, Promise<DirectorySnapshot>>();
  const stores = new Map<string, Promise<readonly string[]>>();
  const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    let value = cache.get(key);
    if (value === undefined) {
      value = load();
      cache.set(key, value);
    }
    return value;
  };
  return {
    directory: (userId) => once(directories, userId, () => loadUserDirectory(db, tenantId, userId)),
    stores: (userId) =>
      once(stores, userId, async () =>
        (
          await db.selectFrom('userStores').select('storeId').where('userId', '=', userId).execute()
        ).map((row) => row.storeId),
      ),
  };
}

/**
 * Op types that act on ANOTHER user's credential (`entityId` is the target). Their author must hold
 * the permission in every store of the target too, exactly as the online endpoint requires
 * (routes/users.ts pin-verifier): a store owner's grant at store A does not reach a store-B employee.
 */
const TARGETS_ANOTHER_USER: ReadonlySet<string> = new Set([
  AUTH_PIN_RESET,
  AUTH_PIN_LOCKOUT_CLEARED,
]);

/**
 * Check the op's declared permission for its author. Runs after the schema step, so the type is
 * known to the registry.
 */
export async function checkPermission(
  op: SignedOperation,
  device: DeviceRecord,
  registry: OpRegistry,
  lookup: AuthorLookup,
): Promise<PermissionOutcome> {
  const permission = registry.permissionOf(op.type);
  // An undeclared type never gets here (UNKNOWN_TYPE), but if it did it must not pass.
  if (permission === undefined) return { reason: `${op.type} declares no permission` };
  // The genesis is the one exception to every rule below: its author enrolled the device online,
  // which is where that authority was checked, and the device's chain cannot start without it.
  if (op.type === GENESIS_TYPE) return null;

  if (device.storeId !== null && !(await lookup.stores(op.userId)).includes(device.storeId)) {
    return { reason: `${op.type} was written by a user who does not work at this store` };
  }

  const directory = await lookup.directory(op.userId);
  // Types only the runtime writes (session, lockout, denial audit) have no command and no
  // permission. Their other rules (PIN targeting, system-only types) are the scope step's. Their
  // author must still be active: a deactivated user's unsynced ops are ALL refused.
  if (permission === null) {
    if (directory.users.get(op.userId)?.status === 'active') return null;
    return { reason: `${op.type} was written by a user who is no longer active` };
  }

  const evaluate = (storeId: string | null) =>
    evaluateWithDirectory(directory, {
      userId: op.userId,
      tenantId: op.tenantId,
      storeId,
      permissionId: permission,
    });
  const decision = evaluate(device.storeId);
  if (!decision.allowed) {
    return {
      reason: `${op.type} requires ${permission}, which its author lacks (${decision.reason})`,
    };
  }
  if (TARGETS_ANOTHER_USER.has(op.type) && op.entityId !== op.userId) {
    for (const storeId of await lookup.stores(op.entityId)) {
      if (!evaluate(storeId).allowed) {
        return { reason: `${op.type} requires ${permission} in every store of the target user` };
      }
    }
  }
  return null;
}

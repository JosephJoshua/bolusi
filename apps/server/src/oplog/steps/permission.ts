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
import type { DirectorySnapshot } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

import { evaluateWithDirectory, loadUserDirectory } from '../../auth/permissions.js';
import type { DeviceRecord, OpRegistry } from '../types.js';
import { GENESIS_TYPE } from './scope.js';

export type PermissionOutcome = null | { readonly reason: string };

/**
 * Loads each author's directory once per push batch. A batch is one device's ops, nearly always one
 * user, so this turns a per-op directory read into one per batch. Lives only for one transaction,
 * so a grant change between pushes is always seen.
 */
export function createDirectoryCache(
  db: TenantDb,
  tenantId: string,
): (userId: string) => Promise<DirectorySnapshot> {
  const cache = new Map<string, Promise<DirectorySnapshot>>();
  return (userId) => {
    let directory = cache.get(userId);
    if (directory === undefined) {
      directory = loadUserDirectory(db, tenantId, userId);
      cache.set(userId, directory);
    }
    return directory;
  };
}

/**
 * Check the op's declared permission for its author. Runs after the schema step, so the type is
 * known to the registry.
 */
export async function checkPermission(
  op: SignedOperation,
  device: DeviceRecord,
  registry: OpRegistry,
  directoryFor: (userId: string) => Promise<DirectorySnapshot>,
): Promise<PermissionOutcome> {
  const permission = registry.permissionOf(op.type);
  // An undeclared type never gets here (UNKNOWN_TYPE), but if it did it must not pass.
  if (permission === undefined) return { reason: `${op.type} declares no permission` };
  const directory = await directoryFor(op.userId);
  // Types only the runtime writes (session, lockout, denial audit, enrollment) have no command and
  // no permission. Their other rules (genesis shape, PIN targeting, system-only types) are the
  // scope step's. Their author must still be active: a deactivated user's unsynced ops are ALL
  // refused. The genesis is the exception: its author enrolled the device online, which is where
  // that authority was checked, and the device's chain cannot start without it.
  if (permission === null) {
    if (op.type === GENESIS_TYPE) return null;
    if (directory.users.get(op.userId)?.status === 'active') return null;
    return { reason: `${op.type} was written by a user who is no longer active` };
  }

  const decision = evaluateWithDirectory(directory, {
    userId: op.userId,
    tenantId: op.tenantId,
    storeId: device.storeId,
    permissionId: permission,
  });
  if (decision.allowed) return null;
  return {
    reason: `${op.type} requires ${permission}, which its author lacks (${decision.reason})`,
  };
}

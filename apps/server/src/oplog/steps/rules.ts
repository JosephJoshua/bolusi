// The op type's rules against the server's records (core module/op-rules.ts): a legal state change,
// a target that exists in this store, values only the author's device may mint. The same rule the
// device ran before saving, judged here against every op the server has accepted, including the
// earlier ops of this batch (they are folded in this transaction before the next one is judged).
//
// A rule refuses by throwing a DomainError; that becomes the refusal, and its reason is the rule's
// refusal key (`<module>.refusal.<reason>`), which the device shows as the problem's copy. Any other
// throw is a fault and propagates (the batch rolls back as a 500), so a broken rule cannot pass an
// op by accident.
import { allowanceCovers, DomainError, refusalKeyOf } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

import { allowanceWithDirectory, evaluateWithDirectory } from '../../auth/permissions.js';
import type { DeviceRecord, OpRegistry } from '../types.js';
import type { AuthorLookup } from './permission.js';

export type RuleOutcome = null | { readonly reason: string };

export async function checkRules(
  db: TenantDb,
  op: SignedOperation,
  device: Pick<DeviceRecord, 'storeId'>,
  registry: OpRegistry,
  lookup: AuthorLookup,
): Promise<RuleOutcome> {
  try {
    await registry.checkRule(op, {
      db,
      // Someone the op names (an assigned technician) must work at this store and hold the
      // permission there, by the server's directory: the same test the author passed.
      holdsPermission: async (userId, permissionId) => {
        if (device.storeId === null || !(await lookup.stores(userId)).includes(device.storeId)) {
          return false;
        }
        return evaluateWithDirectory(await lookup.directory(userId), {
          userId,
          tenantId: op.tenantId,
          storeId: device.storeId,
          permissionId,
        }).allowed;
      },
      // The limit a limited role has at this store by the server's current directory: an owner who
      // lowered it since the device acted is the one who counts.
      withinLimit: async (userId, permissionId, amount) => {
        if (device.storeId === null || !(await lookup.stores(userId)).includes(device.storeId)) {
          return false;
        }
        return allowanceCovers(
          allowanceWithDirectory(await lookup.directory(userId), {
            userId,
            tenantId: op.tenantId,
            storeId: device.storeId,
            permissionId,
          }),
          amount,
        );
      },
    });
    return null;
  } catch (error) {
    if (error instanceof DomainError) return { reason: refusalKeyOf(error) ?? error.message };
    throw error;
  }
}

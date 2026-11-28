// Decisions on a shared store device are taken only with the person's proof (owner decision
// 2026-11-25). A shared device names an op's author on its own word: whoever has its keys (a counter
// PC's sealed secrets, a phone's storage) could record a cancel, refund or void in the owner's name.
// So an op that uses a `decision` permission (authz/registry.ts) for its own author, either as its
// declared permission or through its rule (a price drop needing the discount permission, Bayar nanti
// needing credit), is accepted from a shared device only when the push carries a person session the
// server opened for that author on that device after checking their PIN itself.
//
// Structural, for every module: the declared permission and the rule context's two grant checks are
// the only ways an op uses a power, and both pass through here. A personal phone is exempt: the
// scope step already takes only its own person's ops from it, and that person approves there.
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

import { personOfSession } from '../../auth/person-sessions.js';
import { PERMISSION_BY_ID } from '../../identity/permissions.js';
import type { DeviceRecord } from '../types.js';

/** Whether holding `permissionId` is a decision the person must prove on a shared device. */
export function isDecisionPermission(permissionId: string | null | undefined): boolean {
  return permissionId != null && PERMISSION_BY_ID.get(permissionId)?.decision === true;
}

/** The people a push proves, resolved once per batch from the person sessions it carries. */
export interface DecisionProofs {
  proves(userId: string): Promise<boolean>;
}

export function createDecisionProofs(
  db: TenantDb,
  device: Pick<DeviceRecord, 'id' | 'storeId'>,
  tokens: readonly string[],
  now: number,
): DecisionProofs {
  let people: Promise<ReadonlySet<string>> | null = null;
  const resolve = async (): Promise<ReadonlySet<string>> => {
    const found = new Set<string>();
    for (const token of tokens) {
      const userId = await personOfSession(db, {
        token,
        device: { deviceId: device.id, storeId: device.storeId },
        now,
      });
      if (userId !== null) found.add(userId);
    }
    return found;
  };
  return {
    async proves(userId) {
      people ??= resolve();
      return (await people).has(userId);
    },
  };
}

/**
 * Null when the op may be accepted, else why not: it used a decision for its own author on a
 * shared device, and the push proves no such person.
 */
export async function checkDecisionProof(
  op: SignedOperation,
  device: Pick<DeviceRecord, 'personalUserId'>,
  usedDecision: boolean,
  proofs: DecisionProofs,
): Promise<{ readonly reason: string } | null> {
  if (!usedDecision || device.personalUserId !== null) return null;
  if (await proofs.proves(op.userId)) return null;
  // The refusal key, so the author reads why (platform rules.ts `decisionNeedsPin`).
  return { reason: 'platform.refusal.decisionNeedsPin' };
}

// Two devices of one store and a server that judges each pushed op alone, in arrival order, by its
// type's rule, refusing what the rule refuses (as push ingestion does), plus a bystander device that
// only pulls what the server accepted. The second device's clock runs about 17 minutes ahead.
import { refusalKeyOf } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { openRepairHarness, type RepairHarness } from './repair-harness.js';

/** Opens the devices; each harness is added to `open` so the test closes it. */
export async function judgedStore(seed: number, open: RepairHarness[]) {
  const first = await openRepairHarness(seed);
  const shared = {
    tenantId: first.tenantId,
    storeId: first.storeId,
    users: [
      first.cashierId,
      first.technicianId,
      first.technician2Id,
      first.zeroUserId,
      first.ownerId,
      first.storeOwnerId,
    ],
  };
  const second = await openRepairHarness(seed + 1, shared);
  const server = await openRepairHarness(seed + 2, shared);
  const other = await openRepairHarness(seed + 3, shared);
  open.push(first, second, server, other);
  const seen = new Map<RepairHarness, Set<string>>();
  const arrival = new Map<RepairHarness, number>();
  const accepted: SignedOperation[] = [];
  /** `type:refusal` of each op the server refused, in order. */
  const refused: string[] = [];
  const deliver = async (to: RepairHarness, op: SignedOperation): Promise<void> => {
    const n = (arrival.get(to) ?? 0) + 1;
    arrival.set(to, n);
    await to.deliverPulled(op, n);
  };
  /** Pushes `from`'s new ops to the server, which judges each alone, in arrival order. */
  const push = async (from: RepairHarness): Promise<void> => {
    const pushed = seen.get(from) ?? new Set<string>();
    seen.set(from, pushed);
    for (const op of await from.ownOps()) {
      if (pushed.has(op.id)) continue;
      pushed.add(op.id);
      try {
        await server.checkRule(op);
      } catch (error) {
        refused.push(`${op.type}:${refusalKeyOf(error) ?? String(error)}`);
        continue;
      }
      accepted.push(op);
      await deliver(server, op);
    }
  };
  /** Hands `to` every op the server accepted that `to` did not write or get yet. */
  const pull = async (to: RepairHarness): Promise<void> => {
    const got = seen.get(to) ?? new Set<string>();
    seen.set(to, got);
    const own = new Set((await to.ownOps()).map((op) => op.id));
    for (const op of accepted) {
      if (got.has(op.id) || own.has(op.id)) continue;
      got.add(op.id);
      await deliver(to, op);
    }
  };
  return { first, second, server, other, push, pull, refused };
}

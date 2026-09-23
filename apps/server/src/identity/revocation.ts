// Device revocation server effects (api/02-auth §7.2) + the on-revoke hook registry.
//
// Effects: Device.status active → revoked (terminal); push-token rows for the device deleted;
// identity_audit row (revokedBy/revokedAt). The "401 DEVICE_REVOKED from the very next request"
// effect is automatic — verifyToken (auth/verify-token.ts) reads the flipped status and throws
// DEVICE_REVOKED. Revocation is idempotent: revoking an already-revoked device returns the same
// body and fires no hooks.
//
// The on-revoke hook registry is where task 20 registers socket-close (SEC-RT-02 lands there);
// here it is exercised by a spy. Hooks fire AFTER the DB effects, with per-hook error isolation —
// a socket-close failure must never undo a revocation.
import type { TenantDb } from '@bolusi/db-server';

import { appendAudit } from './audit.js';

export interface RevokeContext {
  readonly deviceId: string;
  readonly tenantId: string;
}

export type OnRevokeHook = (ctx: RevokeContext) => void | Promise<void>;

/** A mutable registry of on-revoke hooks. One instance is injected via ServerDeps. */
export class RevocationHooks {
  readonly #hooks: OnRevokeHook[] = [];

  register(hook: OnRevokeHook): void {
    this.#hooks.push(hook);
  }

  /** Fire every hook, isolating failures — one throwing hook must not stop the others. */
  async fire(ctx: RevokeContext): Promise<void> {
    for (const hook of this.#hooks) {
      try {
        await hook(ctx);
      } catch {
        // A hook failure (e.g. a socket already closed) is not a revocation failure.
      }
    }
  }
}

export interface RevokeResult {
  readonly deviceId: string;
  readonly status: 'revoked';
  readonly revokedAt: number;
}

export type RevokeOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'revoked'; readonly body: RevokeResult; readonly newlyRevoked: boolean };

/**
 * Apply the DB effects of revoking `deviceId` inside the caller's forTenant tx. Returns the
 * response body and whether this call was the one that flipped the status (so the caller fires
 * hooks exactly once, post-commit). Does NOT fire hooks itself.
 */
export async function revokeDevice(
  db: TenantDb,
  params: { tenantId: string; deviceId: string; revokedBy: string | null; now: number },
): Promise<RevokeOutcome> {
  const device = await db
    .selectFrom('devices')
    .select(['id', 'status', 'revokedAt', 'storeId'])
    .where('id', '=', params.deviceId)
    .executeTakeFirst();
  if (device === undefined) return { kind: 'not_found' };

  if (device.status === 'revoked') {
    return {
      kind: 'revoked',
      newlyRevoked: false,
      body: { deviceId: device.id, status: 'revoked', revokedAt: Number(device.revokedAt) },
    };
  }

  const revokedAt = params.now;
  // `status = 'active'` in the WHERE is the CONCURRENCY GUARD, not a redundant restatement of the
  // SELECT above (found by the QA sweep of task 168).
  //
  // The SELECT takes no row lock, so under READ COMMITTED two concurrent revocations of the same
  // device — a standalone `POST /:id/revoke` racing an enrol-with-`replacesDeviceId`, or two such
  // enrolments — both read `active` (each other's write is still uncommitted and invisible). Without
  // this predicate both would then UPDATE: the second to commit overwrites the first's `revokedAt`
  // and `revokedBy`, so the audit records whoever finished LAST rather than who actually ended the
  // identity, a second `device.revoked` audit row is appended for one transition, and both callers
  // compute `newlyRevoked: true` and fire the revocation hooks — breaking the "fires exactly once"
  // invariant their call sites rely on.
  //
  // With the predicate, Postgres re-evaluates it after the first transaction releases the row lock;
  // the loser matches zero rows and reports `newlyRevoked: false`, so exactly one caller owns the
  // transition. `numUpdatedRows` is the witness — it is the only way to tell "I did it" from "someone
  // else did it while I waited".
  const updated = await db
    .updateTable('devices')
    .set({ status: 'revoked', revokedAt: BigInt(revokedAt), revokedBy: params.revokedBy })
    .where('id', '=', params.deviceId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (updated.numUpdatedRows === 0n) {
    // Lost the race. Re-read so the response carries the WINNER's revocation, never our own values.
    const winner = await db
      .selectFrom('devices')
      .select(['id', 'revokedAt'])
      .where('id', '=', params.deviceId)
      .executeTakeFirst();
    if (winner === undefined) return { kind: 'not_found' };
    return {
      kind: 'revoked',
      newlyRevoked: false,
      body: {
        deviceId: winner.id,
        status: 'revoked',
        revokedAt: Number(winner.revokedAt),
      },
    };
  }

  // Push-token cleanup (api/02-auth §7.2; api/04-push: deletion is server-internal on revocation).
  await db.deleteFrom('pushTokens').where('deviceId', '=', params.deviceId).execute();

  await appendAudit(db, params.tenantId, {
    actorUserId: params.revokedBy,
    action: 'device.revoked',
    entityType: 'device',
    entityId: params.deviceId,
    before: { status: 'active' },
    after: { status: 'revoked', revokedAt, revokedBy: params.revokedBy },
    at: revokedAt,
  });

  return {
    kind: 'revoked',
    newlyRevoked: true,
    body: { deviceId: params.deviceId, status: 'revoked', revokedAt },
  };
}

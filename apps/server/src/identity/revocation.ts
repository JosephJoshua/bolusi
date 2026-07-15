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
  await db
    .updateTable('devices')
    .set({ status: 'revoked', revokedAt: BigInt(revokedAt), revokedBy: params.revokedBy })
    .where('id', '=', params.deviceId)
    .execute();

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

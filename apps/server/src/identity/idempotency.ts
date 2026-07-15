// Idempotency-Key store (api/00 §8.2). The only v0 consumer is device enrollment (api/02-auth
// §4.3): the stored response includes the plaintext device token — the one narrow,
// retention-bounded exception to "token stored only as a hash", which is why rows are PURGED at
// 24 h (SEC-DEV-02's companion assert bounds the exception).
//
// Semantics: same key + same body → the stored response verbatim (X-Idempotent-Replay: true), no
// re-execution; same key + different body → 409 IDEMPOTENCY_CONFLICT, nothing executed; concurrent
// duplicate executes AT MOST ONCE (claim-first: INSERT ... ON CONFLICT DO NOTHING acquires the row
// lock, so the loser waits for the winner to commit, then replays).
import type { TenantDb } from '@bolusi/db-server';

import { ApiError } from '../errors.js';

export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Placeholder status held only WITHIN the owning transaction — never observed on a committed row
 *  (the claim + execute + finalize are one tx: commit sets the real value, rollback removes it). */
const PENDING_STATUS = 0;

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface IdempotencyResult extends StoredResponse {
  readonly replay: boolean;
}

/**
 * Run `execute` under the idempotency contract for `(tenantId, key)`. `execute` performs the real
 * work (enroll) and returns the response to store, or throws an ApiError for a validation failure
 * (which rolls the whole transaction back — including the claim — so nothing is stored).
 */
export async function runIdempotent(
  db: TenantDb,
  params: {
    tenantId: string;
    endpoint: string;
    key: string;
    /** SHA-256 hex of the raw request body. */
    requestHash: string;
    now: number;
    execute: () => Promise<StoredResponse>;
  },
): Promise<IdempotencyResult> {
  // Purge expired rows first — bounds the plaintext-token retention window (24 h).
  await db
    .deleteFrom('idempotencyKeys')
    .where('tenantId', '=', params.tenantId)
    .where('createdAt', '<', BigInt(params.now - IDEMPOTENCY_RETENTION_MS))
    .execute();

  const existing = await lookup(db, params.tenantId, params.key);
  if (existing !== undefined) {
    if (existing.requestHash !== params.requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT');
    if (existing.responseStatus !== PENDING_STATUS) {
      return { status: existing.responseStatus, body: existing.responseBody, replay: true };
    }
  }

  // Claim the key. ON CONFLICT DO NOTHING acquires the (tenant,key) row lock; a racing duplicate
  // blocks here until we commit/rollback, then falls through to replay/re-execute.
  const claim = await db
    .insertInto('idempotencyKeys')
    .values({
      tenantId: params.tenantId,
      key: params.key,
      endpoint: params.endpoint,
      requestHash: params.requestHash,
      responseStatus: PENDING_STATUS,
      responseBody: {} as never,
      createdAt: BigInt(params.now),
    })
    .onConflict((oc) => oc.columns(['tenantId', 'key']).doNothing())
    .executeTakeFirst();

  const owned = Number(claim.numInsertedOrUpdatedRows ?? 0n) > 0;
  if (!owned) {
    // Lost the race (or a stale duplicate). Re-read the now-committed row and replay / conflict.
    const raced = await lookup(db, params.tenantId, params.key);
    if (raced === undefined) {
      // The prior owner rolled back (e.g. its enroll failed validation); the key is free again.
      return runIdempotent(db, params);
    }
    if (raced.requestHash !== params.requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT');
    return { status: raced.responseStatus, body: raced.responseBody, replay: true };
  }

  // We own the key: execute, then finalize the row with the real response.
  const result = await params.execute();
  await db
    .updateTable('idempotencyKeys')
    .set({ responseStatus: result.status, responseBody: result.body as never })
    .where('tenantId', '=', params.tenantId)
    .where('key', '=', params.key)
    .execute();
  return { ...result, replay: false };
}

async function lookup(
  db: TenantDb,
  tenantId: string,
  key: string,
): Promise<{ requestHash: string; responseStatus: number; responseBody: unknown } | undefined> {
  const row = await db
    .selectFrom('idempotencyKeys')
    .select(['requestHash', 'responseStatus', 'responseBody'])
    .where('tenantId', '=', tenantId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    requestHash: row.requestHash,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
  };
}

// Bookkeeping layers (05-operation-log §2.3–2.4) — mutable, local/server-side,
// NEVER signed and never merged into the signed core. Consumed by db layers only.
import { z } from 'zod';

import { zMsEpoch } from './primitives.js';

export const SYNC_STATUSES = ['local', 'synced', 'rejected'] as const;
export const zSyncStatus = z.enum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof zSyncStatus>;

/**
 * Client-local bookkeeping (05 §2.3) — only the sync engine may update it.
 * `rejectionCode` stays an open string, not the rejection enum: the client must
 * store and surface whatever code the server sent, including codes newer than
 * this build (api/00 §4 — unknown codes are surfaced, never dropped).
 */
export const zClientBookkeeping = z.strictObject({
  syncStatus: zSyncStatus,
  syncedAt: zMsEpoch.nullable(),
  rejectionCode: z.string().nullable(),
  rejectionReason: z.string().nullable(),
});
export type ClientBookkeeping = z.infer<typeof zClientBookkeeping>;

/** Server-side bookkeeping (05 §2.4) — assigned on acceptance. */
export const zServerBookkeeping = z.strictObject({
  serverSeq: z.number().int().min(1),
  receivedAt: zMsEpoch,
  clockSkewFlagged: z.boolean(),
});
export type ServerBookkeeping = z.infer<typeof zServerBookkeeping>;

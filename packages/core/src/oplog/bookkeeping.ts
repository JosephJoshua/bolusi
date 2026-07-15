// Operation.syncStatus bookkeeping transition layer (03-state-machines §3;
// 05-operation-log §2.3). This is the SINGLE place the operation-log bookkeeping columns
// are mutated (08 §5.2 allowlist target for `bolusi/no-op-table-update`) — everything else
// in the op log is append-only (05 §1). Only the sync engine (task 15) drives it, on a
// server push result (api/01-sync §3); nothing else may touch bookkeeping.
//
// Boundary note (08 §3.3): @bolusi/core may not import @bolusi/db-client, so the mutator
// takes an injected Kysely handle typed against a minimal structural view of the
// operations bookkeeping columns. db-client's real `Kysely<ClientDatabase>` (with its
// CamelCasePlugin) satisfies that view at the single wiring site (task 15). The pure
// `resolveSyncTransition` carries the machine substance and is exhaustively tested; the DB
// write is thin glue proven end-to-end downstream (L2/L4 + CHAOS-05/06, task 26).
import type { Kysely } from 'kysely';

import { runTransition } from '../state-machines/executor.js';
import { OP_SYNC_STATUS_MACHINE, type OpSyncStatus } from '../state-machines/op-sync-status.js';

/**
 * A server push result for one op (api/01-sync §3; 03 §3 events):
 *  - `accepted` / `duplicate`: op is `synced`; `syncedAt` set (both terminal-success).
 *  - `rejected`: op is `rejected` (terminal); `rejectionCode`/`rejectionReason` set
 *    atomically and surfaced — never silent (05 §8). NOTE: setting `SyncState.pushHalted`
 *    on `CHAIN_BROKEN` is the sync engine's side effect (task 15, 03 §10), NOT this layer's.
 *  - `chain_gap`: `CHAIN_GAP` — the op stays `local` and is resent; not an error (05 §8).
 */
export type SyncResultEvent =
  | { readonly kind: 'accepted'; readonly syncedAt: number }
  | { readonly kind: 'duplicate'; readonly syncedAt: number }
  | { readonly kind: 'rejected'; readonly rejectionCode: string; readonly rejectionReason: string }
  | { readonly kind: 'chain_gap' };

/**
 * The bookkeeping columns a transition writes — EXACTLY the four the client may mutate on
 * the operation log (08 §5.2 allowlist; 05 §2.3). `serverSeq` is deliberately NOT here:
 * 08 §5.2 scopes `serverSeq` to the server's insert-time acceptance path, and a client op's
 * `operations.server_seq` (10-db §9.2) is set at pull-insert for foreign ops, never by this
 * mutator — a device's own ops keep it NULL.
 */
export interface BookkeepingPatch {
  readonly syncStatus: OpSyncStatus;
  readonly syncedAt: number | null;
  readonly rejectionCode: string | null;
  readonly rejectionReason: string | null;
}

export type SyncTransition =
  | { readonly kind: 'transition'; readonly to: OpSyncStatus; readonly patch: BookkeepingPatch }
  /** A self-loop (idempotent ack on an already-`synced` op, or `chain_gap` on `local`): no write. */
  | { readonly kind: 'noop'; readonly to: OpSyncStatus };

/**
 * Resolve the bookkeeping transition for `from` + `event`, PURELY.
 *
 * Validates the transition through the shared executor — an invalid `(from, event)` (e.g.
 * `synced → rejected`, `rejected → synced`, any `* → local`) throws
 * `DomainError('INVALID_TRANSITION', { machine, from, event })`. A self-loop is a `noop`
 * (no side effects); a real transition returns the exact columns to write.
 *
 * @throws {DomainError} `INVALID_TRANSITION` for a disallowed pair.
 */
export function resolveSyncTransition(from: OpSyncStatus, event: SyncResultEvent): SyncTransition {
  const { to, changed } = runTransition(OP_SYNC_STATUS_MACHINE, from, event.kind);
  if (!changed) return { kind: 'noop', to };

  switch (event.kind) {
    case 'accepted':
    case 'duplicate':
      return {
        kind: 'transition',
        to,
        patch: {
          syncStatus: 'synced',
          syncedAt: event.syncedAt,
          rejectionCode: null,
          rejectionReason: null,
        },
      };
    case 'rejected':
      return {
        kind: 'transition',
        to,
        patch: {
          syncStatus: 'rejected',
          syncedAt: null,
          rejectionCode: event.rejectionCode,
          rejectionReason: event.rejectionReason,
        },
      };
    /* c8 ignore next 3 -- `chain_gap` is local→local (changed=false) and returns above; no
       other event both `changed` and unhandled exists, but the exhaustive default keeps the
       switch total if the event union ever grows. */
    default:
      return { kind: 'noop', to };
  }
}

/** The minimal structural view of the operations bookkeeping columns this mutator writes. */
export interface OpBookkeepingRow {
  id: string;
  syncStatus: string;
  syncedAt: number | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
}
export interface OpBookkeepingDatabase {
  operations: OpBookkeepingRow;
}

export interface MarkSyncResultInput {
  readonly id: string;
  /** The op's currently-observed status — the machine's `from`. */
  readonly currentStatus: OpSyncStatus;
  readonly event: SyncResultEvent;
}

/**
 * Apply a push result to one op's bookkeeping — the SINGLE sanctioned mutation of the
 * operation-log tables (05 §1, §2.3; 08 §5.2). Signed-core columns are never touched.
 *
 * Resolves the transition first (throwing `INVALID_TRANSITION` before any DB call), then —
 * only for a real transition — UPDATEs the bookkeeping columns for `id`, guarded on the
 * observed `currentStatus` so a concurrent transition cannot be clobbered. A `noop`
 * (idempotent ack / `chain_gap`) writes nothing.
 *
 * @throws {DomainError} `INVALID_TRANSITION` — before touching the database.
 */
export async function markSyncResult(
  db: Kysely<OpBookkeepingDatabase>,
  input: MarkSyncResultInput,
): Promise<SyncTransition> {
  const result = resolveSyncTransition(input.currentStatus, input.event);

  if (result.kind === 'transition') {
    await db
      .updateTable('operations')
      .set({
        syncStatus: result.patch.syncStatus,
        syncedAt: result.patch.syncedAt,
        rejectionCode: result.patch.rejectionCode,
        rejectionReason: result.patch.rejectionReason,
      })
      .where('id', '=', input.id)
      .where('syncStatus', '=', input.currentStatus)
      .execute();
  }

  return result;
}

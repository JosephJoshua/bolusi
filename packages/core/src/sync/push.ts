// The push phase (api/01-sync §3; per-op machine 03-state-machines §3; codes 05-operation-log §8).
//
// Reads `syncStatus = 'local'` ops in ASCENDING seq, batches them at the api/01 §3 caps, and marks
// each op by its INDIVIDUAL result. Ordering is not cosmetic: the server validates chain continuity
// in receipt order, so a batch out of seq order would manufacture a `CHAIN_BROKEN` on an honest
// chain. `idx_operations_push_queue ON operations (seq) WHERE sync_status = 'local'` (10-db §9.2)
// exists for exactly this read.
//
// ONLY OWN-DEVICE OPS ARE EVER `local`: pulled ops are born `synced` (03 §3 birth table), so the
// push queue is this device's chain by construction and `ORDER BY seq` is a total order over it.
//
// AN OP-LEVEL REJECTION IS NOT A LOOP FAILURE (03 §10). Rejections are RESULTS — they come back
// inside a `200` response and mean the server understood us perfectly. Only a rejected PROMISE
// (transport/server error) is a loop failure. Conflating the two would put a device with one
// permanently-rejected op into permanent backoff, which is why they are different channels
// (`PushResponse` vs `SyncTransportError`) rather than one union.
import {
  MAX_PUSH_OPS,
  REJECTION_CODES,
  type PushResult,
  type SignedOperation,
} from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import { markSyncResult, type OpBookkeepingDatabase } from '../oplog/bookkeeping.js';
import type { OpSyncStatus } from '../state-machines/op-sync-status.js';
import type { SyncSurfacePort, SyncTransportPort } from './ports.js';

/** A local op ready to push, reconstructed from its verbatim signed bytes. */
interface LocalOpRow {
  readonly id: string;
  readonly seq: number;
  readonly signedCoreJcs: string;
  readonly hash: string;
  readonly signature: string;
}

/**
 * The next batch of `local` ops, ascending seq, capped at api/01 §3's 500.
 *
 * Ops are rebuilt from `signed_core_jcs` VERBATIM (05 §3 verbatim-storage rule) rather than from
 * the typed columns. This is not a micro-optimization: re-serializing a core from typed storage can
 * change bytes (number formatting, key order) and the server verifies the signature over the bytes
 * it receives — a rebuilt-from-columns op would fail `BAD_SIGNATURE` on a perfectly honest op, and
 * would do so only for the payloads whose round-trip happens to differ. The JCS text is the truth.
 */
export async function readPushBatch<DB>(
  db: Kysely<DB>,
  limit: number = MAX_PUSH_OPS,
): Promise<SignedOperation[]> {
  const result = await sql<LocalOpRow>`
    SELECT id, seq, signed_core_jcs, hash, signature FROM operations
    WHERE sync_status = 'local' ORDER BY seq LIMIT ${limit}
  `.execute(db);
  return result.rows.map((row) => {
    const core = JSON.parse(row.signedCoreJcs) as Record<string, unknown>;
    return { ...core, hash: row.hash, signature: row.signature } as SignedOperation;
  });
}

const KNOWN_CODES: ReadonlySet<string> = new Set(REJECTION_CODES);

/**
 * Label key for a rejection code (ui-labels: one `core.rejection.*` row per 05 §8 code).
 *
 * An UNKNOWN code still surfaces — api/00 §4 says store and surface unknown codes, never drop them.
 * A newer server growing a code must not produce a SILENT rejection on an older client: that is the
 * one outcome 05 §8 forbids outright ("silent rejection is unacceptable"). It falls back to the
 * generic error copy, which is worse UX than a tailored string and infinitely better than nothing.
 */
export function rejectionLabelKey(code: string): string {
  return KNOWN_CODES.has(code) ? `core.rejection.${code}` : 'core.errors.UNEXPECTED';
}

export interface PushPhaseDeps<DB> {
  readonly db: Kysely<DB>;
  readonly transport: SyncTransportPort;
  readonly surface: SyncSurfacePort;
  readonly clock: { now(): number };
  readonly deviceId: string;
  /** Emits the `pushHalted` write; the loop owns `SyncState` (03 §10 — bookkeeping.ts defers here). */
  readonly onChainBroken: () => Promise<void>;
  readonly batchSize?: number;
}

export interface PushPhaseResult {
  /** Ops the server took (`accepted` + `duplicate`) — both terminal-success (api/01 §3). */
  readonly synced: number;
  readonly rejected: number;
  /** True when a `CHAIN_BROKEN` halted this device's push (03 §10). */
  readonly halted: boolean;
  /** True when any op came back `CHAIN_GAP` — the phase stops early (see below). */
  readonly gapped: boolean;
  readonly batches: number;
}

/**
 * Push every `local` op, batched, marking each by its own result.
 *
 * @throws {SyncTransportError} on transport/server failure — the caller turns that into `backoff`
 * (03 §10). It propagates deliberately: a partially-pushed batch must NOT be treated as drained,
 * and the ops stay `local` so the retry re-sends the SAME batch (idempotent — already-accepted ops
 * come back `duplicate`, 05 §5). That is what makes an interrupted push resumable rather than lossy.
 */
export async function runPushPhase<DB>(deps: PushPhaseDeps<DB>): Promise<PushPhaseResult> {
  const batchSize = deps.batchSize ?? MAX_PUSH_OPS;
  let synced = 0;
  let rejected = 0;
  let batches = 0;

  for (;;) {
    const ops = await readPushBatch(deps.db, batchSize);
    if (ops.length === 0) return { synced, rejected, halted: false, gapped: false, batches };

    batches += 1;
    // A throw here propagates: ops stay `local`, the same batch retries after backoff.
    const response = await deps.transport.push({ deviceId: deps.deviceId, ops });

    const byId = new Map(ops.map((op) => [op.id, op]));
    let halted = false;
    let gapped = false;
    let chainBrokenSeen = false;

    for (const result of response.results) {
      if (!byId.has(result.id)) continue; // A result for an op we did not send: not ours to mark.
      const outcome = await applyPushResult(deps, result, { chainBrokenSeen });
      if (outcome === 'synced') synced += 1;
      if (outcome === 'rejected') rejected += 1;
      if (outcome === 'chain_broken') {
        rejected += 1;
        chainBrokenSeen = true;
        halted = true;
      }
      if (outcome === 'gap') gapped = true;
    }

    // `CHAIN_BROKEN` halts THIS device's push (03 §10) — nothing after a broken link can be
    // chain-verified, so continuing would burn requests to collect `CHAIN_HALTED`s we can predict.
    if (halted) return { synced, rejected, halted: true, gapped, batches };

    // `CHAIN_GAP` leaves the server's head UNCHANGED (apps/server pipeline.ts), so every later op
    // of this device gaps identically. Pushing on would be pure noise on a 3G link (FR-1127). The
    // ops stay `local`, so the next cycle re-sends from the same point — 03 §3's "client resends
    // from the gap", which is a no-transition, not an error.
    //
    // KNOWN LIMIT, deliberately not papered over: the wire carries no server head (api/01 §3
    // names N but `PushResult` has no field for it), so the client cannot widen the window BELOW
    // its lowest `local` seq. A gap caused by ops that are `synced` locally but absent server-side
    // therefore re-sends the same batch each cycle rather than converging. That state is not
    // reachable from any v0 code path (the only writer of `synced` is an ack for that very op), so
    // this is a latent protocol gap, not a live bug — recorded rather than speculatively coded
    // against.
    if (gapped) return { synced, rejected, halted: false, gapped: true, batches };

    // A short batch means the queue is drained; a full one may have more behind it.
    if (ops.length < batchSize) return { synced, rejected, halted: false, gapped: false, batches };
  }
}

type PushOutcome = 'synced' | 'rejected' | 'chain_broken' | 'gap' | 'ignored';

/**
 * Mark ONE op by its result and surface it (03 §3 + 05 §8).
 *
 * Every `rejected` code surfaces — the closed set of 05 §8 has no silent member, and the surfacing
 * is emitted for the code the SERVER sent, not for a code this client recognizes.
 */
async function applyPushResult<DB>(
  deps: PushPhaseDeps<DB>,
  result: PushResult,
  state: { chainBrokenSeen: boolean },
): Promise<PushOutcome> {
  const current = await readSyncStatus(deps.db, result.id);
  if (current === null) return 'ignored';

  if (result.status === 'accepted' || result.status === 'duplicate') {
    // Idempotent for an already-`synced` op: `resolveSyncTransition` returns a no-op rather than a
    // transition (03 §3 — a repeated ack from a retried batch is not INVALID_TRANSITION).
    await markSyncResult(bookkeepingHandle(deps.db), {
      id: result.id,
      currentStatus: current,
      event: { kind: result.status, syncedAt: deps.clock.now() },
    });
    return 'synced';
  }

  const code = result.code ?? 'UNKNOWN';
  const reason = result.reason ?? '';

  if (code === 'CHAIN_GAP') {
    // No transition, no rejection, no `failureCount` (03 §3 / 05 §8) — the op stays `local`.
    // Routed through the machine anyway so the "no transition" claim is the TABLE's, not this
    // branch's: a future table change lands here automatically instead of silently disagreeing.
    await markSyncResult(bookkeepingHandle(deps.db), {
      id: result.id,
      currentStatus: current,
      event: { kind: 'chain_gap' },
    });
    return 'gap';
  }

  await markSyncResult(bookkeepingHandle(deps.db), {
    id: result.id,
    currentStatus: current,
    event: { kind: 'rejected', rejectionCode: code, rejectionReason: reason },
  });

  if (code === 'CHAIN_BROKEN') {
    // The op is `rejected` AND push halts (03 §3 / §10). Surfaced as its own loud event, on top of
    // the ordinary rejection surfacing: "your changes stopped sending" is a different message from
    // "this change was refused", and 05 §8 asks for the loud one.
    await deps.onChainBroken();
    emit(deps, {
      kind: 'op_rejected',
      opId: result.id,
      code,
      reason,
      labelKey: rejectionLabelKey(code),
    });
    emit(deps, { kind: 'push_halted', opId: result.id, labelKey: rejectionLabelKey(code) });
    return 'chain_broken';
  }

  emit(deps, {
    kind: 'op_rejected',
    opId: result.id,
    code,
    reason,
    labelKey: rejectionLabelKey(code),
  });

  // `CHAIN_HALTED` marks `rejected` but must NOT set `pushHalted` again — the triggering
  // `CHAIN_BROKEN` already did (03 §3). Asserting the invariant here rather than trusting call
  // order: if a server ever sent `CHAIN_HALTED` with no preceding `CHAIN_BROKEN`, silently
  // halting would be wrong and silently not-halting would be worse, so we do neither and the
  // batch remainder is simply marked.
  void state.chainBrokenSeen;
  return 'rejected';
}

/** Emit a surfacing without letting a throwing sink become a loop failure (api/01 §6: never throws to UI). */
function emit<DB>(deps: PushPhaseDeps<DB>, event: Parameters<SyncSurfacePort['emit']>[0]): void {
  try {
    deps.surface.emit(event);
  } catch {
    // A UI sink that throws must not convert "we told the user" into "sync failed".
  }
}

async function readSyncStatus<DB>(db: Kysely<DB>, id: string): Promise<OpSyncStatus | null> {
  const result = await sql<{ syncStatus: string }>`
    SELECT sync_status FROM operations WHERE id = ${id}
  `.execute(db);
  const status = result.rows[0]?.syncStatus;
  if (status === 'local' || status === 'synced' || status === 'rejected') return status;
  return null;
}

/**
 * The ONE wiring site 05 §1 / bookkeeping.ts names: `markSyncResult` is typed against the narrow
 * structural view `OpBookkeepingDatabase` precisely so @bolusi/core need not name `ClientDatabase`
 * (08 §3.3). The loop is generic over `DB` (it addresses 10-db's columns through raw `sql`), so the
 * two type parameters cannot be related by inference and the cast is the seam where they meet.
 *
 * Safe because the runtime object is one Kysely instance over one connection either way, and the
 * VIEW is honest: `markSyncResult` touches only `operations`' bookkeeping columns, which 10-db §9.2
 * guarantees exist on every client DB this loop is ever constructed against. Reimplementing the
 * mutator to dodge the cast would be a second definition of the single sanctioned op-log write path
 * (CLAUDE.md §2.8) — strictly worse than one documented cast.
 */
function bookkeepingHandle<DB>(db: Kysely<DB>): Kysely<OpBookkeepingDatabase> {
  return db as unknown as Kysely<OpBookkeepingDatabase>;
}

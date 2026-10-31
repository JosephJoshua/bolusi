// The pull phase (api/01-sync §4): pull-until-drained, verify every op, apply the batch ATOMICALLY.
//
// ══ THE LOAD-BEARING CONTRACT: THE BATCH IS ONE TRANSACTION ═══════════════════════════════════
//
// The op INSERTs, the projection APPLIES, and the cursor/watermark advance ALL commit together, or
// none of them do. This is the only place in the system where that contract lives: server-side the
// projections apply inside the PUSH transaction (04 §4.3, 10-db §8) and the server's pull is a pure
// read, so the client pull-apply is the sole production path that can get this wrong.
//
// WHY IT IS NOT MERELY TIDY. `ProjectionEngine.applyPulledOp` advances `applied_server_seq` to the
// highest CONTIGUOUS `arrival_seq` *present in the log* (projection/engine.ts → oplog-source
// `highestContiguousSeq`) — PRESENT, not APPLIED. The engine cannot tell the difference and
// should not have to: the atomicity of the caller's transaction is what makes "present" imply
// "applied". Break the batch into per-op commits and the two come apart:
//
//   insert 1..10, apply #1, COMMIT      → watermark jumps to 10 (all ten are *present*)
//   crash before applying #2..#10       → ops 2..10 durably in the log, never projected,
//                                          watermark durably says "caught up through 10"
//
// Nothing ever revisits them: the cursor has moved past, so they are never re-pulled; the watermark
// is at the frontier, so nothing re-applies them. The projection is permanently missing ten ops and
// reports itself healthy. No error, no red test, no way back short of a manual rebuild nobody knows
// to run. One transaction per batch closes it by construction — a crash rolls the ops back out of
// the log WITH the watermark, and the re-pull re-applies from the unmoved cursor.
//
// The engine's header states the other half of the deal ("`applyPulledOp` does NOT open its own
// transaction — it runs inside the caller's"), and its DELIVERY CONTRACT requires each op be
// inserted immediately before its own apply call, one at a time. Both are honoured below. This
// property is proved, and its falsification recorded, in `test/sync/pull-atomicity.test.ts` —
// an atomicity claim nobody has watched break is not load-bearing (CLAUDE.md §2.11).
//
// ══ THE ONE-BAD-OP TRAP (flagged by task 02's review) ═════════════════════════════════════════
//
// `zPullResponse` is tolerant at the top level but `ops: z.array(zSignedOperation)` is STRICT —
// correctly so: you cannot strip unknown keys out of a hashed structure without changing what was
// signed. The consequence is a trap: validating the batch through `zPullResponse` makes ONE odd op
// fail the WHOLE parse, and treating that throw as a transport failure would put the device into
// permanent backoff — violating api/01 §4.2's "one bad op must not brick sync" by exactly the route
// quarantine exists to prevent. So the envelope and each op are parsed INDIVIDUALLY, and a per-op
// parse failure is a quarantine case, not a loop failure.
import {
  zPullResponse,
  zSignedOperation,
  MAX_PULL_LIMIT,
  type DeviceInfo,
  type PullRequest,
  type PullResponse,
  type SignedOperation,
} from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import type { CryptoPort } from '../crypto/port.js';
import { signedCoreJcsOf } from '../crypto/signed-core.js';
import { insertOpLogRow } from '../oplog/row.js';
import type { ClockPort } from '../runtime/ports.js';
import { readDeviceRegistry, replaceDeviceRegistry, type DeviceRegistryEntry } from './devices.js';
import { purgePulledOps, type PurgedRecord } from './read-purge.js';
import {
  readPermissionsOf,
  readSetChange,
  typesReadWith,
  type ReadScopeRegistry,
} from './read-scope.js';
import type { SyncSurfacePort, SyncTransportPort } from './ports.js';
import {
  deleteQuarantinedOp,
  insertQuarantinedOp,
  QUARANTINE_LABEL_KEY,
  readQuarantinedOps,
  reconstructQuarantinedOp,
  signerKeyOf,
  verifyPulledOp,
} from './quarantine.js';
import { readSyncState, writeSyncState, type PullBackfill } from './state.js';

/** api/01-sync §4: `devicesDirectoryVersion: 0` forces a fresh sidecar (no version is "none"). */
const FORCE_FRESH_SIDECAR = 0;

export interface PullPhaseDeps<DB> {
  readonly db: Kysely<DB>;
  /**
   * Run `fn` in ONE transaction on the same connection the injected `db` and the projection engine
   * use. THE contract of this phase (see the header) — a `transaction` that does not actually
   * isolate makes every guarantee below a fiction.
   */
  readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly transport: SyncTransportPort;
  readonly surface: SyncSurfacePort;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  /** `ProjectionEngine.applyPulledOp` (task 08). Runs INSIDE the batch transaction. */
  readonly applyPulledOp: (op: SignedOperation) => Promise<unknown>;
  /**
   * Can this build fold `op` (its type is registered, at a schemaVersion it knows)? An op from a
   * newer app stops the pull before its batch, see {@link AppUpdateRequiredError}. Absent means
   * every op is foldable, which only a test or bench may assume.
   */
  readonly knowsOp?: (op: Pick<SignedOperation, 'type' | 'schemaVersion'>) => boolean;
  readonly limit?: number;
  /**
   * Called after each batch commits, outside the transaction, so a long pull can show progress.
   * Fire-and-forget like the surface: a throw is swallowed and never fails the pull.
   */
  readonly onBatchCommitted?: (batch: PulledBatch) => void;
  /**
   * Asked after each committed batch while the server has more. `false` stops the pull there: every
   * batch so far is committed with its cursor, so the next pull resumes exactly where this one
   * stopped. Lets a time-limited background run end cleanly instead of being killed mid-batch.
   */
  readonly shouldContinue?: () => boolean;
  /**
   * Permission-scoped sync: what to do when the server's read set for this device changes. Absent,
   * the device ignores the read set (a test or bench that pulls every op).
   */
  readonly readScope?: PullReadScope;
}

/** The pull's view of permission-scoped sync (read-scope.ts, read-purge.ts). */
export interface PullReadScope {
  /** Which permission each op type is read with. */
  readonly registry: ReadScopeRegistry;
  /** Re-fold a record after ops were dropped from it (`ProjectionEngine.refoldEntityOf`). */
  readonly refold: (record: PurgedRecord) => Promise<void>;
  /** `ProjectionEngine.catchUpPulledWatermarks`. */
  readonly catchUpWatermarks: () => Promise<void>;
}

/** What one committed pull batch carried, for progress display. */
export interface PulledBatch {
  readonly applied: number;
  /** Device timestamps of the oldest and newest op in the batch; `null` for an empty batch. */
  readonly oldestOpAt: number | null;
  readonly newestOpAt: number | null;
  readonly serverTime: number;
  readonly hasMore: boolean;
}

export interface PullPhaseResult {
  readonly applied: number;
  readonly quarantined: number;
  /** Quarantined ops released by a sidecar that delivered their missing key (api/01 §4.2). */
  readonly released: number;
  readonly batches: number;
  /** Forced `devicesDirectoryVersion: 0` re-pulls — at most one per batch (api/01 §4.2). */
  readonly refetches: number;
  readonly serverTime: number | null;
  /** False when `shouldContinue` stopped the pull before the server ran out of ops. */
  readonly drained: boolean;
}

/** `lastSyncError` while the pull waits for a newer app. */
export const APP_UPDATE_REQUIRED_ERROR_CODE = 'APP_UPDATE_REQUIRED';

/**
 * The server sent an op this build cannot fold: a type it does not know, or a newer schemaVersion
 * of one it does. Another device runs a newer app. Folding around it would leave records wrong
 * (and an unknown version throws in its applier, which would fail the batch on every retry), so the
 * batch is not applied and its cursor stays put: the pull resumes from it once this app is updated.
 * Pushing goes on meanwhile, since the push runs first and the server accepts older versions.
 */
export class AppUpdateRequiredError extends Error {
  override readonly name = 'AppUpdateRequiredError';
  readonly code = APP_UPDATE_REQUIRED_ERROR_CODE;
  constructor(
    readonly opType: string,
    readonly schemaVersion: number,
  ) {
    super(`pulled ${opType} at schemaVersion ${String(schemaVersion)}, which this app cannot fold`);
  }
}

/** An op as it survived (or failed) individual parsing. */
type ParsedOp =
  | { readonly ok: true; readonly op: SignedOperation }
  | { readonly ok: false; readonly raw: unknown };

/**
 * Parse the envelope, then each op INDIVIDUALLY (see the header's trap note).
 *
 * @throws {ZodError} only when the ENVELOPE itself is unusable (no cursor, no `hasMore`) — that is
 * a genuine protocol failure with nothing to salvage, and the loop treats it as a transport error.
 * A bad OP never throws here.
 */
export function parsePullResponse(raw: unknown): {
  envelope: Omit<PullResponse, 'ops'>;
  ops: ParsedOp[];
} {
  const source = raw as Record<string, unknown>;
  const rawOps = Array.isArray(source?.['ops']) ? (source['ops'] as unknown[]) : [];
  // Validate the envelope with the ops elided, so a single bad op cannot fail it.
  const envelope = zPullResponse.omit({ ops: true }).parse({ ...source, ops: undefined });
  const ops = rawOps.map<ParsedOp>((candidate) => {
    const result = zSignedOperation.safeParse(candidate);
    return result.success ? { ok: true, op: result.data } : { ok: false, raw: candidate };
  });
  return { envelope: envelope as Omit<PullResponse, 'ops'>, ops };
}

/**
 * Pull until drained (api/01-sync §4: "client loops while `hasMore`").
 *
 * @throws {SyncTransportError} on transport/server failure — the caller enters `backoff` (03 §10)
 * and partial progress is KEPT: every batch already committed its own cursor, so a resume neither
 * re-applies nor skips (api/01 §1 "interruption never restarts a sync from zero").
 */
export async function runPullPhase<DB>(deps: PullPhaseDeps<DB>): Promise<PullPhaseResult> {
  const limit = deps.limit ?? MAX_PULL_LIMIT;
  let applied = 0;
  let quarantined = 0;
  let released = 0;
  let batches = 0;
  let refetches = 0;
  let serverTime: number | null = null;

  // One page: the normal pull from the cursor, or a catch-up on newly readable ops.
  const pullPage = async (backfill: PullBackfill | null): Promise<boolean> => {
    const state = await readSyncState(deps.db);
    const request = (devicesDirectoryVersion: number): PullRequest => ({
      cursor: backfill === null ? state.cursor : backfill.cursor,
      limit,
      devicesDirectoryVersion,
      ...(backfill === null
        ? {}
        : { backfill: { reads: [...backfill.reads], through: backfill.through } }),
    });
    let response = await deps.transport.pull(request(state.devicesDirectoryVersion));
    let parsed = parsePullResponse(response);

    // ONE forced re-pull when a signer is unknown (api/01 §4.2). A device enrolled seconds ago is
    // legitimately absent from a stale registry, so an unknown key earns a fresh sidecar before it
    // earns a quarantine. Exactly once: a server that keeps omitting the key must not be able to
    // spin the client (CHAOS-12 asserts the count, which is why it is counted rather than assumed).
    if (await hasUnknownSigner(deps, parsed)) {
      response = await deps.transport.pull(request(FORCE_FRESH_SIDECAR));
      parsed = parsePullResponse(response);
      refetches += 1;
    }

    const unknown =
      deps.knowsOp === undefined ? undefined : firstUnknownOp(parsed.ops, deps.knowsOp);
    if (unknown !== undefined)
      throw new AppUpdateRequiredError(unknown.type, unknown.schemaVersion);

    const outcome = await applyBatchAtomically(deps, parsed, backfill !== null);
    applied += outcome.applied;
    quarantined += outcome.quarantined;
    released += outcome.released;
    serverTime = parsed.envelope.serverTime;
    batches += 1;
    reportBatch(deps, parsed, outcome.applied);
    return parsed.envelope.hasMore;
  };

  const stopped = (): PullPhaseResult => ({
    applied,
    quarantined,
    released,
    batches,
    refetches,
    serverTime,
    drained: false,
  });

  for (;;) {
    if (!(await pullPage(null))) break;
    if (deps.shouldContinue?.() === false) return stopped();
  }
  // Then the catch-up, once the normal pull is current: older ops the device newly may read.
  for (;;) {
    const { backfill } = await readSyncState(deps.db);
    if (backfill === null || deps.readScope === undefined) break;
    await pullPage(backfill);
    if (deps.shouldContinue?.() === false) return stopped();
  }

  return { applied, quarantined, released, batches, refetches, serverTime, drained: true };
}

/**
 * The first op in the batch this build cannot fold. That includes one that fails to parse yet
 * names a type and version: the server validated it on push, so its shape is newer than this
 * build's (an added envelope field, say). Dropping it would skip it for good.
 */
function firstUnknownOp(
  ops: readonly ParsedOp[],
  knowsOp: (op: Pick<SignedOperation, 'type' | 'schemaVersion'>) => boolean,
): Pick<SignedOperation, 'type' | 'schemaVersion'> | undefined {
  for (const entry of ops) {
    if (entry.ok) {
      if (!knowsOp(entry.op)) return entry.op;
      continue;
    }
    const raw = entry.raw as { type?: unknown; schemaVersion?: unknown } | null;
    if (typeof raw?.type === 'string' && Number.isInteger(raw.schemaVersion)) {
      return { type: raw.type, schemaVersion: raw.schemaVersion as number };
    }
  }
  return undefined;
}

/** Would any op in this batch fail verification for `unknown_pubkey`, given the registry it would see? */
async function hasUnknownSigner<DB>(
  deps: PullPhaseDeps<DB>,
  parsed: { envelope: Omit<PullResponse, 'ops'>; ops: ParsedOp[] },
): Promise<boolean> {
  const registry = await effectiveRegistry(deps.db, parsed.envelope.devices);
  // An unparseable op is quarantined on its own terms — no sidecar helps it. A known signer needs no
  // signature check here: the batch verifies every op once, inside the transaction.
  return parsed.ops.some((entry) => entry.ok && signerKeyOf(entry.op, registry) === null);
}

/**
 * The registry the batch will verify against: the sidecar's snapshot when one arrived (it REPLACES
 * the table wholesale), else the stored mirror. Computed before the transaction so the refetch
 * decision — which is a network call — is never made while holding a write lock.
 */
async function effectiveRegistry<DB>(
  db: Kysely<DB>,
  devices: readonly DeviceInfo[] | undefined,
): Promise<ReadonlyMap<string, DeviceRegistryEntry>> {
  if (devices === undefined) return readDeviceRegistry(db);
  return new Map(
    devices.map((device) => [
      device.id,
      {
        id: device.id,
        storeId: device.storeId,
        kind: device.kind,
        signingKeyPublic: device.signingKeyPublic,
        status: device.status,
        revokedAt: device.revokedAt,
      },
    ]),
  );
}

interface BatchOutcome {
  readonly applied: number;
  readonly quarantined: number;
  readonly released: number;
}

/**
 * Apply ONE pulled batch atomically — the contract this whole file exists for.
 *
 * Everything below happens in ONE transaction: the sidecar replace, each op's insert+apply, the
 * quarantine rows, the quarantine releases, and the cursor. The ORDER matters as much as the
 * atomicity:
 *
 *   1. sidecar first — later verifications must see the keys it delivered, including for ops in
 *      THIS batch signed by a device enrolled since the last pull.
 *   2. releases next — a quarantined op the sidecar just vindicated should apply before the batch
 *      that may supersede it; the engine's out-of-order path (04 §4.2) handles the late arrival, so
 *      "before" is about intent, not correctness.
 *   3. ops, each INSERTed immediately before its own apply (the engine's delivery contract).
 *   4. cursor LAST — api/01 §4: "persisted client-side AFTER the batch is applied atomically".
 *      Inside the same transaction, "after" is an ordering within one atom, not a second commit.
 */
async function applyBatchAtomically<DB>(
  deps: PullPhaseDeps<DB>,
  parsed: { envelope: Omit<PullResponse, 'ops'>; ops: ParsedOp[] },
  catchUp: boolean,
): Promise<BatchOutcome> {
  const surfacings: Array<{ opId: string; reason: 'bad_signature' | 'unknown_pubkey' }> = [];

  const outcome = await deps.transaction(async () => {
    let applied = 0;
    let quarantined = 0;
    let released = 0;

    // 1. Devices sidecar (api/01 §4.1) — a FULL snapshot; replaces the table wholesale.
    if (parsed.envelope.devices !== undefined) {
      await replaceDeviceRegistry(deps.db, parsed.envelope.devices);
      if (parsed.envelope.devicesDirectoryVersion !== undefined) {
        await writeSyncState(deps.db, {
          devicesDirectoryVersion: parsed.envelope.devicesDirectoryVersion,
        });
      }
    }

    const registry = await readDeviceRegistry(deps.db);

    // 2. Re-verify quarantined ops against the (possibly new) registry — api/01 §4.2: "quarantined
    //    ops are re-verified whenever a new devices sidecar arrives; on success they apply
    //    normally". Only worth doing when the registry actually changed.
    if (parsed.envelope.devices !== undefined) {
      released = await releaseQuarantined(deps, registry);
    }

    // 3. What this device may read: drop what it no longer may, plan a catch-up on what it newly
    //    may. Before the ops, so a dropped type is gone before this page's ops fold.
    const restartedCatchUp = await followReadSet(deps, parsed.envelope.readSet);

    // 4. The ops.
    for (const entry of parsed.ops) {
      if (!entry.ok) {
        // An op that does not even parse cannot be verified, and cannot be identified either — it
        // has no trustworthy `id`. It is dropped from the batch and surfaced; the cursor still
        // advances past it (§4.2's rule), so it cannot brick sync. It is NOT written to
        // `quarantined_ops`: every column there (id, device_id, hash, signature) would have to be
        // read out of the very structure that failed validation.
        emit(deps, {
          kind: 'quarantined',
          opId: 'unparseable',
          reason: 'bad_signature',
          labelKey: QUARANTINE_LABEL_KEY,
        });
        quarantined += 1;
        continue;
      }
      const op = entry.op;

      // Dedup by id (05 §5): applying an op we already hold is a no-op. The engine's delivery
      // contract makes this the INSERT layer's job — it never sees a duplicate.
      if (await hasOp(deps.db, op.id)) continue;

      const verification = verifyPulledOp(op, registry, deps.crypto);
      if (!verification.ok) {
        await insertQuarantinedOp(deps.db, {
          id: op.id,
          deviceId: op.deviceId,
          serverSeq: parsed.envelope.nextCursor,
          signedCoreJcs: signedCoreJcsOf(op, deps.crypto),
          hash: op.hash,
          signature: op.signature,
          reason: verification.reason,
          quarantinedAt: deps.clock.now(),
        });
        surfacings.push({ opId: op.id, reason: verification.reason });
        quarantined += 1;
        continue; // NOT applied to projections; the cursor still advances past it (§4.2).
      }

      // 03 §3 birth table: pulled ops are born `synced` with `syncedAt` = APPLY time (not the op's
      // own `timestamp`, which is the device-clock instant the user acted — 05 §2.1).
      await insertPulledOp(
        deps.db,
        op,
        deps.crypto,
        await nextArrivalSeq(deps.db),
        deps.clock.now(),
      );
      await deps.applyPulledOp(op);
      applied += 1;
    }

    // 5. The cursor — in the same atom as everything above. A catch-up page moves the catch-up's own
    //    cursor and ends it when the server has no more; the normal cursor stays where it is.
    const timing = {
      lastPullAt: deps.clock.now(),
      lastServerTime: parsed.envelope.serverTime,
      lastServerTimeReceivedAt: deps.clock.now(),
    };
    if (!catchUp) {
      await writeSyncState(deps.db, { cursor: parsed.envelope.nextCursor, ...timing });
    } else {
      const { backfill } = await readSyncState(deps.db);
      const next =
        restartedCatchUp || backfill === null
          ? backfill
          : parsed.envelope.hasMore
            ? { ...backfill, cursor: parsed.envelope.nextCursor }
            : null;
      await writeSyncState(deps.db, { backfill: next, ...timing });
    }

    return { applied, quarantined, released };
  });

  // Surfacing happens AFTER the commit: a quarantine the transaction rolled back is not a fact, and
  // telling the user about it would be a lie the DB disagrees with.
  for (const item of surfacings) {
    emit(deps, {
      kind: 'quarantined',
      opId: item.opId,
      reason: item.reason,
      labelKey: QUARANTINE_LABEL_KEY,
    });
  }

  return outcome;
}

/**
 * Follow the server's read set for this device (permission-scoped sync), inside the batch
 * transaction. A permission gone from it: the pulled ops read with it are dropped and their records
 * re-folded. A permission new in it: a catch-up is planned for its older ops, up to where the normal
 * pull is, since the server skipped them before. Returns whether the catch-up was started over.
 *
 * A device that never held a read set (`null`) held everything an older server sent, so it is
 * treated as holding every read permission: it only drops, never catches up. A brand-new device
 * (cursor 0) has nothing to drop or catch up on.
 */
async function followReadSet<DB>(
  deps: PullPhaseDeps<DB>,
  readSet: readonly string[] | undefined,
): Promise<boolean> {
  const scope = deps.readScope;
  if (scope === undefined || readSet === undefined) return false;
  const state = await readSyncState(deps.db);
  const now = [...readSet].sort();
  const fresh = state.cursor === 0 && state.readSet === null;
  const before = fresh ? now : (state.readSet ?? readPermissionsOf(scope.registry));
  const { added, removed } = readSetChange(before, now);
  if (removed.length > 0) {
    await purgePulledOps(
      { db: deps.db, refold: scope.refold, catchUpWatermarks: scope.catchUpWatermarks },
      typesReadWith(scope.registry, removed),
    );
  }

  // A catch-up keeps only what may still be read; a grown set starts it over from the beginning,
  // through where the normal pull is now (ops already held are skipped by id).
  const kept = new Set(now);
  let backfill = state.backfill;
  if (backfill !== null) {
    const reads = backfill.reads.filter((read) => kept.has(read));
    backfill = reads.length === 0 ? null : { ...backfill, reads };
  }
  const restarted = added.length > 0 && state.readSet !== null;
  if (restarted) {
    backfill = {
      reads: [...new Set([...(backfill?.reads ?? []), ...added])].sort(),
      through: Math.max(backfill?.through ?? 0, state.cursor),
      cursor: 0,
    };
  }
  if (
    state.readSet === null ||
    added.length > 0 ||
    removed.length > 0 ||
    backfill !== state.backfill
  ) {
    await writeSyncState(deps.db, { readSet: now, backfill });
  }
  return restarted;
}

/** Re-verify every quarantined op; apply and un-quarantine the ones that now check out (api/01 §4.2). */
async function releaseQuarantined<DB>(
  deps: PullPhaseDeps<DB>,
  registry: ReadonlyMap<string, DeviceRegistryEntry>,
): Promise<number> {
  const rows = await readQuarantinedOps(deps.db);
  let released = 0;
  for (const row of rows) {
    const op = reconstructQuarantinedOp(row);
    if (!verifyPulledOp(op, registry, deps.crypto).ok) continue; // A bad signature stays bad forever.
    if (await hasOp(deps.db, op.id)) {
      await deleteQuarantinedOp(deps.db, op.id);
      continue;
    }
    await insertPulledOp(deps.db, op, deps.crypto, await nextArrivalSeq(deps.db), deps.clock.now());
    // The engine's out-of-order path (04 §4.2) re-folds the entity if this op sorts before ops
    // already applied — which is the normal case for a late release, and exactly why quarantine can
    // afford to let the cursor run ahead.
    await deps.applyPulledOp(op);
    await deleteQuarantinedOp(deps.db, op.id);
    released += 1;
  }
  return released;
}

async function hasOp<DB>(db: Kysely<DB>, id: string): Promise<boolean> {
  const result = await sql<{ one: number }>`
    SELECT 1 AS one FROM operations WHERE id = ${id} LIMIT 1
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * The next `operations.arrival_seq` for a pulled op.
 *
 * ── WHY THIS IS AN ARRIVAL COUNTER AND NOT THE SERVER'S `serverSeq` (D20 §4, RATIFIED) ────────
 *
 * It cannot be the server's: **the pull wire carries no per-op serverSeq**. `zPullResponse.ops` is
 * `zSignedOperation[]` — the signed core (05 §2.1) plus hash/signature — and `serverSeq` is §2.4
 * server-side bookkeeping, assigned at acceptance, i.e. after signing. It is structurally impossible
 * for it to ride inside the signed core, and no sibling field carries it. The server's pull selects
 * `serverSeq` and then drops it in `reconstructWireOp` (apps/server/src/sync/pull.ts). The only
 * server-assigned number on the wire is the batch's `nextCursor`.
 *
 * So the column holds a LOCAL, GAPLESS, MONOTONIC arrival counter, and since D20 §4 it is NAMED for
 * what it holds — the old `server_seq` spelling claimed a meaning the column never had, which is the
 * decoy class of CLAUDE.md §2.11. Three things make the counter sound rather than a fudge:
 *
 *   1. NOTHING ELSE WRITES IT. `BookkeepingPatch` deliberately excludes `serverSeq`, so a device's
 *      own pushed ops keep `arrival_seq` NULL (oplog/bookkeeping.ts). The pull is the column's only
 *      writer, so there is no second numbering to collide with.
 *   2. IT IS WHAT THE WATERMARK ACTUALLY NEEDS. `highestContiguousSeq` pins the watermark at the
 *      first HOLE. The client's op stream is scope-FILTERED (api/01 §4.3: this store's ops plus
 *      tenant-scoped ones), so the server's true serverSeqs are inherently gappy on a multi-store
 *      tenant — storing them would pin `applied_server_seq` below the first other-store op forever
 *      and silently freeze the watermark (task 46's class, by another route). A gapless arrival
 *      counter is the only value that makes the watermark mean "caught up" on a client at all.
 *   3. THE RESUME POINT IS NOT THIS NUMBER. `sync_state.pull_cursor` is the server's `nextCursor`
 *      and is the ONLY value the protocol defines as the resume position (api/01 §4). This counter
 *      never leaves the device and is never sent anywhere.
 *
 * The gapless property is what leg 2 rests on, so it is ASSERTED, not assumed: `arrival-seq.test.ts`
 * pins 1..N across batches and watches the watermark reach the frontier, and `pull-atomicity.test.ts`
 * fails if the counter ever emits a hole. 10-db §9.2 states the two-sided meaning once.
 */
async function nextArrivalSeq<DB>(db: Kysely<DB>): Promise<number> {
  // `AS "maxSeq"` resolves the result key by construction, not via `CamelCasePlugin` (10-db §11.4;
  // task 74). The annotation is `maxSeq?` — OPTIONAL — because a raw-`sql` key genuinely CAN be
  // absent at runtime (the whole bug class: without the plugin a bare `AS max_seq` never binds
  // `maxSeq`), and typing it present is the assertion `tsc` believes and never checks (T-14f).
  //
  // `MAX(...)` over no GROUP BY ALWAYS returns exactly one row, whose column is NULL on an empty
  // log. The `?? 0` this used to carry conflated two different facts — an empty log (NULL → start
  // at 1, correct) and a MISSING KEY (undefined → 1, WRONG) — laundering a wrong arrival seq of 1
  // out with no error (T-19). They are now distinguished: NULL is the empty log; an absent `maxSeq`
  // THROWS, because a sequence number is the last place a plausible default belongs.
  // The pulled watermarks count too: ops dropped by permission-scoped sync (read-purge.ts) can take
  // the newest arrivals out of the log, and reusing their numbers would land new ops below a
  // watermark that already passed them. Normally no watermark is above the newest arrival.
  const result = await sql<{ maxSeq?: number | null }>`
    SELECT MAX(seq) AS "maxSeq" FROM (
      SELECT MAX(arrival_seq) AS seq FROM operations
      UNION ALL
      SELECT MAX(applied_server_seq) AS seq FROM projection_watermarks
    )
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      'nextArrivalSeq: MAX(arrival_seq) returned no row — impossible for an aggregate',
    );
  }
  if (row.maxSeq === undefined) {
    throw new Error(
      'nextArrivalSeq: the `maxSeq` result key did not bind — a raw-`sql` key failed to resolve. ' +
        'Refusing to launder a missing read into a plausible arrival seq of 1 (task 74; T-19).',
    );
  }
  return (row.maxSeq === null ? 0 : Number(row.maxSeq)) + 1;
}

/**
 * Insert one pulled op, born `synced` (03 §3 birth table: "insert via pull ⇒ `synced`, `syncedAt` =
 * apply time"), with its local arrival number.
 */
function insertPulledOp<DB>(
  db: Kysely<DB>,
  op: SignedOperation,
  crypto: CryptoPort,
  arrivalSeq: number,
  syncedAt: number,
): Promise<void> {
  return insertOpLogRow(
    db,
    { op, signedCoreJcs: signedCoreJcsOf(op, crypto) },
    { syncStatus: 'synced', syncedAt, arrivalSeq },
  );
}

function reportBatch<DB>(
  deps: PullPhaseDeps<DB>,
  parsed: { envelope: Omit<PullResponse, 'ops'>; ops: ParsedOp[] },
  applied: number,
): void {
  if (deps.onBatchCommitted === undefined) return;
  let oldestOpAt: number | null = null;
  let newestOpAt: number | null = null;
  for (const entry of parsed.ops) {
    if (!entry.ok) continue;
    const at = entry.op.timestamp;
    if (oldestOpAt === null || at < oldestOpAt) oldestOpAt = at;
    if (newestOpAt === null || at > newestOpAt) newestOpAt = at;
  }
  try {
    deps.onBatchCommitted({
      applied,
      oldestOpAt,
      newestOpAt,
      serverTime: parsed.envelope.serverTime,
      hasMore: parsed.envelope.hasMore,
    });
  } catch {
    // Progress is display only; it must never fail a pull that already committed.
  }
}

function emit<DB>(deps: PullPhaseDeps<DB>, event: Parameters<SyncSurfacePort['emit']>[0]): void {
  try {
    deps.surface.emit(event);
  } catch {
    // api/01 §6: the loop never throws to the UI — including when the UI is what threw.
  }
}

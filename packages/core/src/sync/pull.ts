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
// highest CONTIGUOUS serverSeq *present in the log* (projection/engine.ts → oplog-source
// `highestContiguousServerSeq`) — PRESENT, not APPLIED. The engine cannot tell the difference and
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
  type PullResponse,
  type SignedOperation,
} from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import type { CryptoPort } from '../crypto/port.js';
import type { ClockPort } from '../runtime/ports.js';
import { readDeviceRegistry, replaceDeviceRegistry, type DeviceRegistryEntry } from './devices.js';
import type { SyncSurfacePort, SyncTransportPort } from './ports.js';
import {
  deleteQuarantinedOp,
  insertQuarantinedOp,
  QUARANTINE_LABEL_KEY,
  readQuarantinedOps,
  reconstructQuarantinedOp,
  signedCoreJcsOf,
  verifyPulledOp,
} from './quarantine.js';
import { readSyncState, writeSyncState } from './state.js';

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
  readonly limit?: number;
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

  for (;;) {
    const state = await readSyncState(deps.db);
    let response = await deps.transport.pull({
      cursor: state.cursor,
      limit,
      devicesDirectoryVersion: state.devicesDirectoryVersion,
    });
    let parsed = parsePullResponse(response);

    // ONE forced re-pull when a signer is unknown (api/01 §4.2). A device enrolled seconds ago is
    // legitimately absent from a stale registry, so an unknown key earns a fresh sidecar before it
    // earns a quarantine. Exactly once: a server that keeps omitting the key must not be able to
    // spin the client (CHAOS-12 asserts the count, which is why it is counted rather than assumed).
    if (await hasUnknownSigner(deps, parsed)) {
      response = await deps.transport.pull({
        cursor: state.cursor,
        limit,
        devicesDirectoryVersion: FORCE_FRESH_SIDECAR,
      });
      parsed = parsePullResponse(response);
      refetches += 1;
    }

    const outcome = await applyBatchAtomically(deps, parsed);
    applied += outcome.applied;
    quarantined += outcome.quarantined;
    released += outcome.released;
    serverTime = parsed.envelope.serverTime;
    batches += 1;

    if (!parsed.envelope.hasMore) break;
  }

  return { applied, quarantined, released, batches, refetches, serverTime };
}

/** Would any op in this batch fail verification for `unknown_pubkey`, given the registry it would see? */
async function hasUnknownSigner<DB>(
  deps: PullPhaseDeps<DB>,
  parsed: { envelope: Omit<PullResponse, 'ops'>; ops: ParsedOp[] },
): Promise<boolean> {
  const registry = await effectiveRegistry(deps.db, parsed.envelope.devices);
  for (const entry of parsed.ops) {
    if (!entry.ok) continue; // An unparseable op is quarantined on its own terms — no sidecar helps it.
    const result = verifyPulledOp(entry.op, registry, deps.crypto);
    if (!result.ok && result.reason === 'unknown_pubkey') return true;
  }
  return false;
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

    // 3. The ops.
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

    // 4. The cursor — in the same atom as everything above.
    await writeSyncState(deps.db, {
      cursor: parsed.envelope.nextCursor,
      lastPullAt: deps.clock.now(),
      lastServerTime: parsed.envelope.serverTime,
      lastServerTimeReceivedAt: deps.clock.now(),
    });

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
 * The next `operations.server_seq` for a pulled op.
 *
 * ── WHY THIS IS AN ARRIVAL COUNTER AND NOT THE SERVER'S `serverSeq` ──────────────────────────
 *
 * It cannot be the server's: **the pull wire carries no per-op serverSeq**. `zPullResponse.ops` is
 * `zSignedOperation[]` — the signed core (05 §2.1) plus hash/signature — and `serverSeq` is §2.4
 * server-side bookkeeping, assigned at acceptance, i.e. after signing. It is structurally impossible
 * for it to ride inside the signed core, and no sibling field carries it. The server's pull selects
 * `serverSeq` and then drops it in `reconstructWireOp` (apps/server/src/sync/pull.ts). The only
 * server-assigned number on the wire is the batch's `nextCursor`. See TASK 49 (filed with this work).
 *
 * So the column holds a LOCAL, GAPLESS, MONOTONIC arrival counter. Three things make that sound
 * rather than a fudge:
 *
 *   1. NOTHING ELSE WRITES IT. `BookkeepingPatch` deliberately excludes `serverSeq`, so a device's
 *      own pushed ops keep `server_seq` NULL (oplog/bookkeeping.ts). The pull is the column's only
 *      writer, so there is no second numbering to collide with.
 *   2. IT IS WHAT THE WATERMARK ACTUALLY NEEDS. `highestContiguousServerSeq` pins the watermark at
 *      the first HOLE. The client's op stream is scope-FILTERED (api/01 §4.3: this store's ops plus
 *      tenant-scoped ones), so the server's true serverSeqs are inherently gappy on a multi-store
 *      tenant — storing them would pin `applied_server_seq` below the first other-store op forever
 *      and silently freeze the watermark. A gapless arrival counter is the only value that makes the
 *      watermark mean "caught up" on a client at all.
 *   3. THE RESUME POINT IS NOT THIS NUMBER. `sync_state.pull_cursor` is the server's `nextCursor`
 *      and is the ONLY value the protocol defines as the resume position (api/01 §4). This counter
 *      never leaves the device and is never sent anywhere.
 *
 * Task 08's own engine harness already models client `server_seq` exactly this way (arrival order,
 * `MAX(server_seq)+1` — test/projection/db.ts `deliverPulled`), so this matches the established
 * model rather than inventing a fourth one. 10-db §9.2's "from push ack / pull" comment overstates
 * the push half — no code path stores a push-ack serverSeq — and TASK 49 carries the doc fix.
 */
async function nextArrivalSeq<DB>(db: Kysely<DB>): Promise<number> {
  // `AS "maxSeq"` resolves the result key by construction, not via `CamelCasePlugin` (10-db §11.4;
  // task 74). The annotation is `maxSeq?` — OPTIONAL — because a raw-`sql` key genuinely CAN be
  // absent at runtime (the whole bug class: without the plugin a bare `AS max_seq` never binds
  // `maxSeq`), and typing it present is the assertion `tsc` believes and never checks (T-14f).
  //
  // `MAX(...)` over no GROUP BY ALWAYS returns exactly one row, whose column is NULL on an empty
  // log. The `?? 0` this used to carry conflated two different facts — an empty log (NULL → start
  // at 1, correct) and a MISSING KEY (undefined → 1, WRONG) — laundering a wrong serverSeq of 1 out
  // with no error (T-19). They are now distinguished: NULL is the empty log; an absent `maxSeq`
  // THROWS, because a sequence number is the last place a plausible default belongs.
  const result = await sql<{ maxSeq?: number | null }>`
    SELECT MAX(server_seq) AS "maxSeq" FROM operations
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      'nextArrivalSeq: MAX(server_seq) returned no row — impossible for an aggregate',
    );
  }
  if (row.maxSeq === undefined) {
    throw new Error(
      'nextArrivalSeq: the `maxSeq` result key did not bind — a raw-`sql` key failed to resolve. ' +
        'Refusing to launder a missing read into a plausible serverSeq of 1 (task 74; T-19).',
    );
  }
  return (row.maxSeq === null ? 0 : Number(row.maxSeq)) + 1;
}

/**
 * Insert one pulled op, born `synced` (03 §3 birth table: "insert via pull ⇒ `synced`, `syncedAt` =
 * apply time"). `signed_core_jcs` is recovered by re-canonicalizing the parsed core — JCS is a
 * fixpoint under `JSON.parse ∘ canonicalize`, so these are the exact bytes the signer hashed (05 §3).
 */
async function insertPulledOp<DB>(
  db: Kysely<DB>,
  op: SignedOperation,
  crypto: CryptoPort,
  serverSeq: number,
  syncedAt: number,
): Promise<void> {
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs,
      sync_status, synced_at, server_seq
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${op.location === null ? null : JSON.stringify(op.location)}, ${op.source},
      ${op.agentInitiated ? 1 : 0}, ${op.agentConversationId}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${signedCoreJcsOf(op, crypto)}, 'synced', ${syncedAt}, ${serverSeq}
    )
  `.execute(db);
}

function emit<DB>(deps: PullPhaseDeps<DB>, event: Parameters<SyncSurfacePort['emit']>[0]): void {
  try {
    deps.surface.emit(event);
  } catch {
    // api/01 §6: the loop never throws to the UI — including when the UI is what threw.
  }
}

// The server op-acceptance pipeline (05 §8–9, 10-db §3). NO HTTP — a pure function of deps +
// identity + batch; task 16 wires it to POST /v1/sync/push. Everything runs inside ONE forTenant
// transaction: the per-tenant counter is locked at the top, ops are validated in batch order with
// the normative per-op sequence, accepted ops are inserted with their verbatim JCS and a gapless
// serverSeq AND folded into the server read models (04 §4, 10-db §3 step 6) atomically with that
// insert, tamper-class rejections + skew flags write device_anomalies, and the device chain head
// is advanced once at the end.
//
// Per-op sequence (this ONE orchestrator pins it; steps never re-decide it):
//   halted? → CHAIN_HALTED (no validation, no anomaly, no sig verify)
//   dedupe(id) → duplicate
//   device binding (op.deviceId == token device) → SCOPE_VIOLATION  [before signature, so a
//     real op pushed via another device's token attributes to binding, not the crypto gate]
//   signature verify (recompute JCS from received fields) → BAD_SIGNATURE
//   chain continuity → CHAIN_GAP | CHAIN_BROKEN(+halt)
//   scope (tenant/store/user membership + per-type rules) → SCOPE_VIOLATION
//   registry + zod → UNKNOWN_TYPE | SCHEMA_INVALID
//   accepted → allocate serverSeq → INSERT (+ clock-skew flag) → APPLY PROJECTIONS → advance head
//
// The APPLY step is normative (10-db §3, 04 §5.1 step 6): the projection fold shares this
// transaction, so an op cannot be accepted without its server read model being updated — a crash
// between the two would strand a permanently unreadable projection (only rebuild.ts recovers it).
// An op whose type has no registered applier folds as a defined no-op (engine.ts `unregistered`):
// the log fills, no projection moves. `deps.projections` is empty until a module registers
// (tasks 17/25/43), so v0 folds nothing — the honest state, wired so those tasks light it up by
// adding to ONE module list (deps.ts), never by touching this orchestrator.
import { base64ToBytes } from '@bolusi/core';
import { createServerProjectionEngine, type DB, type TenantDb } from '@bolusi/db-server';
import type { RejectionCode, SignedOperation } from '@bolusi/schemas';

import type { SurfacedConflict } from '../sync/conflict-detection.js';

import { recordAnomaly, type AnomalyKind } from './anomalies.js';
import { insertOperationRow } from './persist.js';
import { allocateServerSeq, lockTenantCounter } from './server-seq.js';
import { isClockSkewed } from './skew.js';
import { classifyChain, type ChainHead } from './steps/chain.js';
import { isDuplicate } from './steps/dedupe.js';
import { classifySchema } from './steps/schema.js';
import { checkScope } from './steps/scope.js';
import { verifyPushedSignature } from './steps/signature.js';
import type {
  DeviceRecord,
  OplogPipelineDeps,
  ProcessPushResult,
  PushBatch,
  PushIdentity,
  PushOpResult,
} from './types.js';

/** Load the pushing device's directory row (pubkey, status, chain head) once inside the tx. */
async function loadDevice(db: TenantDb, deviceId: string): Promise<DeviceRecord | undefined> {
  const row = await db
    .selectFrom('devices')
    .select([
      'id',
      'tenantId',
      'storeId',
      'kind',
      'status',
      'signingKeyPublic',
      'lastSeq',
      'lastHash',
      'lastSyncAt',
    ])
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (row === undefined) return undefined;

  return {
    id: row.id,
    tenantId: row.tenantId,
    storeId: row.storeId,
    kind: row.kind === 'system' ? 'system' : 'member',
    status: row.status === 'revoked' ? 'revoked' : 'active',
    publicKey: base64ToBytes(row.signingKeyPublic),
    lastSeq: Number(row.lastSeq),
    lastHash: row.lastHash,
    lastSyncAt: row.lastSyncAt === null ? null : Number(row.lastSyncAt),
  };
}

/**
 * Process a push batch for one tenant/device. `identity` is the token-authenticated device
 * (task 16 supplies it after bearer auth); `ops` ascend by per-device seq (api/01 §3).
 */
export async function processPushBatch(
  deps: OplogPipelineDeps,
  identity: PushIdentity,
  ops: PushBatch,
): Promise<ProcessPushResult> {
  // Collected INSIDE the transaction, fired AFTER it commits (see the tail of this function).
  const surfacedOut: SurfacedConflict[] = [];

  const result = await deps.forTenant(identity.tenantId, async (db) => {
    const device = await loadDevice(db, identity.deviceId);
    if (device === undefined) {
      // The bearer-auth layer (task 16) guarantees an enrolled device before we get here; an
      // absent row is an invariant break, not a per-op rejection.
      throw new Error(`push for unknown device ${identity.deviceId}`);
    }

    // Revoked device: every op received after revocation → DEVICE_REVOKED (05 §8, receipt-time
    // cut, api/02-auth §7.2). No anomaly rows of tamper kinds; nothing allocated or inserted.
    if (device.status === 'revoked') {
      return {
        results: ops.map<PushOpResult>((op) => ({
          id: op.id,
          status: 'rejected',
          code: 'DEVICE_REVOKED',
          reason: 'device is revoked',
        })),
      };
    }

    await lockTenantCounter(db, identity.tenantId);

    // The projection engine for this transaction (04 §4). It folds each accepted op into the
    // server read models through `db`, so the fold commits or rolls back WITH the op insert
    // (10-db §3 step 6). Constructed once and reused: it holds no per-op state, and the watermark
    // it advances is computed from log presence per apply, never carried between calls.
    const projectionEngine = createServerProjectionEngine<DB>(
      db,
      identity.tenantId,
      deps.projections,
    );

    const results: PushOpResult[] = [];
    /** The ops this batch accepted, in acceptance order — conflict detection's input (01 §8.2). */
    const accepted: SignedOperation[] = [];
    /** Significant conflicts, for the POST-COMMIT hook (03 §7). Collected, never fired, in here. */
    const surfaced: SurfacedConflict[] = [];
    let head: ChainHead = { seq: device.lastSeq, hash: device.lastHash };
    let halted = false;

    const reject = (op: SignedOperation, code: RejectionCode, reason: string): void => {
      results.push({ id: op.id, status: 'rejected', code, reason });
    };
    const anomaly = async (
      op: SignedOperation,
      kind: AnomalyKind,
      reason: string,
    ): Promise<void> => {
      await recordAnomaly(db, {
        id: deps.newId(),
        tenantId: identity.tenantId,
        deviceId: device.id,
        kind,
        at: deps.now(),
        detail: { opId: op.id, seq: op.seq, reason },
      });
    };

    for (const op of ops) {
      // Batch remainder after a CHAIN_BROKEN: not individually validated — no anomaly, and the
      // signature is deliberately NOT verified (05 §8; asserted by the pipeline suite).
      if (halted) {
        reject(op, 'CHAIN_HALTED', 'an earlier op in this batch broke the chain');
        continue;
      }

      // 1. dedupe (05 §5): a replay consumes nothing.
      if (await isDuplicate(db, op.id)) {
        results.push({ id: op.id, status: 'duplicate' });
        continue;
      }

      // 2. device binding (05 §9.1): one token, one device, one chain. Before signature so a real
      // op from device A pushed via B's token attributes here, not to BAD_SIGNATURE.
      if (op.deviceId !== identity.deviceId) {
        await anomaly(op, 'SCOPE_VIOLATION', 'op deviceId does not match the token device');
        reject(op, 'SCOPE_VIOLATION', 'op deviceId does not match the token device');
        continue;
      }

      // 3. signature (05 §3, §9): recompute JCS from received fields; verify over the recomputed
      // digest against the device pubkey. The returned JCS is the verbatim bytes we store.
      const signature = verifyPushedSignature(op, device.publicKey, deps.crypto);
      if (!signature.ok) {
        await anomaly(op, 'BAD_SIGNATURE', 'signature does not verify against the device key');
        reject(op, 'BAD_SIGNATURE', 'signature does not verify against the device key');
        continue;
      }

      // 4. chain continuity (05 §4).
      const chain = classifyChain(op, head);
      if (chain.kind === 'gap') {
        // Resend from the gap — not tamper, no anomaly, no halt (api/01 §3). Head unchanged.
        reject(op, 'CHAIN_GAP', 'seq skips ahead of the last accepted op');
        continue;
      }
      if (chain.kind === 'broken') {
        await anomaly(op, 'CHAIN_BROKEN', chain.reason);
        reject(op, 'CHAIN_BROKEN', chain.reason);
        halted = true;
        continue;
      }

      // 5. scope (05 §9): tenant/store/user membership + per-type rules.
      const scope = await checkScope(db, op, device);
      if (scope !== null) {
        await anomaly(op, 'SCOPE_VIOLATION', scope.reason);
        reject(op, 'SCOPE_VIOLATION', scope.reason);
        continue;
      }

      // 6. registry + zod (05 §8): distinct codes.
      const schema = classifySchema(deps.registry, op);
      if (schema === 'UNKNOWN_TYPE') {
        reject(op, 'UNKNOWN_TYPE', `type ${op.type} is not in the server registry`);
        continue;
      }
      if (schema === 'SCHEMA_INVALID') {
        reject(op, 'SCHEMA_INVALID', `payload fails the registry schema for ${op.type}`);
        continue;
      }

      // Accepted: allocate a gapless serverSeq, flag skew (never reject), insert with verbatim JCS.
      const serverSeq = await allocateServerSeq(db, identity.tenantId);
      const receivedAt = deps.now();
      const clockSkewFlagged = isClockSkewed(op.timestamp, receivedAt, device.lastSyncAt);

      await insertOperationRow(db, {
        op,
        serverSeq,
        receivedAt,
        jcs: signature.jcs,
        clockSkewFlagged,
      });

      // Step 6 (10-db §3, 04 §5.1): fold the just-inserted op into the server read models. The op
      // is already in the log with its serverSeq, so the engine reads it as PRESENT and advances
      // `applied_server_seq` to the highest contiguous serverSeq (04 §4.3) — the PULL-shaped path,
      // because server projections track server-seq, not an own-device local seq (10-db §8). An
      // applier throw propagates out of `forTenant`, rolling back this op AND the whole batch
      // (atomic — 10-db §3). An unregistered type folds as a no-op (engine.ts).
      await projectionEngine.applyPulledOp(op);

      if (clockSkewFlagged) {
        await anomaly(
          op,
          'CLOCK_SKEW',
          'timestamp is grossly inconsistent with the offline window',
        );
      }

      head = { seq: op.seq, hash: op.hash };
      accepted.push(op);
      results.push({ id: op.id, status: 'accepted', serverSeq });
    }

    // Conflict detection (01 §8.2) — AFTER the acceptance loop, SAME transaction (10-db §3), over
    // the ops just accepted. It reads the log (including this batch's inserts) and the projections
    // (including this batch's folds), then emits `platform.conflict_detected` through the system
    // device: chained via `system_device_chain_state`, signed with the tenant system key, and
    // allocated a serverSeq from the SAME in-loop `UPDATE … RETURNING` under the counter lock this
    // transaction already holds — so system ops ride the same per-tenant gapless stream.
    //
    // Injected, and absent by default: a deployment with no conflict detector must push normally.
    // An all-duplicate or all-rejected batch accepts nothing, so `accepted` is empty and no
    // detection runs — which is also why a re-push mints no second conflict (05 §5).
    if (deps.detectConflicts !== undefined && accepted.length > 0) {
      const detection = await deps.detectConflicts(db, identity.tenantId, accepted);
      for (const op of detection.ops) {
        // The detection op folds through the SAME apply step as any accepted op — 10-db §3's
        // "INSERT operations → apply the conflicts projection". `appendSystemOp` already INSERTed
        // it, so the engine reads it as present and folds it into `conflicts`.
        await projectionEngine.applyPulledOp(op);
      }
      surfaced.push(...detection.surfaced);
    }

    // Advance the device chain-head cache + record contact once (10-db §3 tail).
    await db
      .updateTable('devices')
      .set({
        lastSeq: head.seq,
        lastHash: head.hash,
        lastSyncAt: deps.now(),
      })
      .where('id', '=', device.id)
      .execute();

    surfacedOut.push(...surfaced);
    return { results };
  });

  // ── THE POST-COMMIT HOOK (03 §7) ────────────────────────────────────────────────────────────
  //
  // AFTER the transaction, never inside it, for two independent reasons:
  //
  //  1. A hook that fired inside would announce conflicts a rollback then erased — a push notice
  //     for a conflict no device can ever pull. `forTenant` has returned here, so the commit is a
  //     fact, and an aborted transaction throws before this line and fires nothing.
  //  2. The hook is task 21's delivery seam (push category `conflict`). Delivery is network I/O:
  //     inside the transaction it would hold the per-tenant counter lock — which serializes EVERY
  //     push for the tenant (10-db §3) — for the duration of an HTTP call to Expo/FCM.
  //
  // Errors are NOT swallowed here: a hook that throws fails the push RESPONSE while the ops stay
  // committed, which is the same shape task 15's client already handles (a push whose result never
  // arrived is retried, and re-pushed ops are `duplicate` — 05 §5). Swallowing would be the
  // alternative and it is worse: a permanently undelivered notification with no signal anywhere.
  for (const conflict of surfacedOut) {
    await deps.onConflictSurfaced?.(conflict);
  }

  return result;
}

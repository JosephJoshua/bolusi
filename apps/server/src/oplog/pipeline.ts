// The server op-acceptance pipeline (05 §8–9, 10-db §3). NO HTTP — a pure function of deps +
// identity + batch; task 16 wires it to POST /v1/sync/push. Everything runs inside ONE forTenant
// transaction: the per-tenant counter is locked at the top, ops are validated in batch order with
// the normative per-op sequence, accepted ops are inserted with their verbatim JCS and a gapless
// serverSeq, tamper-class rejections + skew flags write device_anomalies, and the device chain
// head is advanced once at the end.
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
//   accepted → allocate serverSeq → INSERT (+ clock-skew flag) → advance head
import { base64ToBytes } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';
import type { RejectionCode, SignedOperation } from '@bolusi/schemas';

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
  return deps.forTenant(identity.tenantId, async (db) => {
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

    const results: PushOpResult[] = [];
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

      if (clockSkewFlagged) {
        await anomaly(
          op,
          'CLOCK_SKEW',
          'timestamp is grossly inconsistent with the offline window',
        );
      }

      head = { seq: op.seq, hash: op.hash };
      results.push({ id: op.id, status: 'accepted', serverSeq });
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

    return { results };
  });
}

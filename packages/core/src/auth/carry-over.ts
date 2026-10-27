// Carrying a re-enrolled phone's unsynced changes over to its new registration.
//
// Re-enrolment mints a new device id and key (an identity is never resurrected), so changes the old
// registration saved but never sent cannot be pushed as they are: the server checks each op against
// the device that pushes it. When the owner re-enrols the phone they approve those changes, and they
// are re-signed under the new device: same id, author, time, record and payload, new device, chain
// position and signature. They follow one `auth.device_changes_transferred` op naming the old
// device(s) and how many follow, so the log says who moved what. The server then checks every
// carried change like any other (permissions, rules, deactivated authors), and one it already holds
// comes back `duplicate` because the op id is unchanged.
//
// One transaction, with the audit op: either everything moved or nothing did.
import type { SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import type { CryptoPort } from '../crypto/port.js';
import { operationFromSignedCoreJcs } from '../crypto/signed-core.js';
import type { AppendedOp } from '../oplog/append.js';
import { nextChainPosition, type ChainHead } from '../oplog/chain.js';
import { completeDraft } from '../oplog/draft.js';
import { insertOpLogRow } from '../oplog/row.js';
import type { CommandRuntime } from '../runtime/execute.js';
import { AUTH_ENTITY, AUTH_OP } from './operations.js';

/** One unsynced change from an earlier registration of this phone, as the owner reviews it. */
export interface UnsyncedChange {
  readonly id: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly type: string;
  readonly timestamp: number;
}

/**
 * The changes saved on this phone under any device id other than `currentDeviceId` (null before the
 * phone has a new one) that never reached the server, oldest first.
 */
export async function readUnsyncedChanges<DB>(
  db: Kysely<DB>,
  currentDeviceId: string | null,
): Promise<readonly UnsyncedChange[]> {
  const result = await sql<UnsyncedChange>`
    SELECT id, device_id AS "deviceId", user_id AS "userId", type, timestamp_ms AS "timestamp"
    FROM operations
    WHERE sync_status = 'local' AND device_id <> ${currentDeviceId ?? ''}
    ORDER BY timestamp_ms, device_id, seq
  `.execute(db);
  return result.rows.map((row) => ({ ...row, timestamp: Number(row.timestamp) }));
}

export interface CarryOverDeps<DB> {
  readonly db: Kysely<DB>;
  readonly crypto: CryptoPort;
  /** The new device's signing seed (the keystore already holds it after enrolment). */
  readonly secretKey: Uint8Array;
  /** Re-fold the record an op belongs to, inside the caller's transaction. */
  readonly refold: (op: SignedOperation) => Promise<unknown>;
}

export interface CarryOverResult {
  /** The audit op, or none when there was nothing to carry. */
  readonly audit: readonly AppendedOp[];
  readonly carried: number;
}

/**
 * Re-sign every unsynced change from an earlier registration under `deviceId`, after one
 * `auth.device_changes_transferred` op by `ownerUserId`. A no-op when there is nothing to carry, so
 * a resumed enrolment can call it again safely.
 */
export async function carryOverUnsyncedChanges<DB>(
  deps: CarryOverDeps<DB>,
  runtime: CommandRuntime,
  params: { readonly deviceId: string; readonly ownerUserId: string },
): Promise<CarryOverResult> {
  const pending = await readCarryRows(deps.db, params.deviceId);
  if (pending.length === 0) return { audit: [], carried: 0 };
  const fromDeviceIds = [...new Set(pending.map((row) => row.op.deviceId))];

  const audit = await runtime.emitRuntimeOp(
    {
      type: AUTH_OP.deviceChangesTransferred,
      entityType: AUTH_ENTITY.device,
      entityId: params.deviceId,
      payload: { fromDeviceIds, opCount: pending.length },
      userId: params.ownerUserId,
      source: 'system',
    },
    {
      withinAppend: async (appended) => {
        const first = appended[0];
        if (first?.status !== 'appended') throw new Error('carry-over audit op was not appended');
        let head: ChainHead = { seq: first.seq, hash: first.op.hash };
        // Re-read inside the transaction: this is the set the audit op's count must describe.
        const rows = await readCarryRows(deps.db, params.deviceId);
        if (rows.length !== pending.length) {
          throw new Error('unsynced changes changed while carrying them over');
        }
        const refolded = new Set<string>();
        for (const { op } of rows) {
          const { seq, previousHash } = nextChainPosition(head);
          const completed = completeDraft(
            {
              type: op.type,
              entityType: op.entityType,
              entityId: op.entityId,
              schemaVersion: op.schemaVersion,
              payload: rebindMediaRefs(op.payload, op.deviceId, params.deviceId),
              source: op.source,
              agentInitiated: op.agentInitiated,
              agentConversationId: op.agentConversationId,
            },
            {
              id: op.id,
              tenantId: op.tenantId,
              storeId: op.storeId,
              userId: op.userId,
              deviceId: params.deviceId,
              seq,
              previousHash,
              timestamp: op.timestamp,
              location: op.location,
            },
            deps.secretKey,
            deps.crypto,
          );
          await sql`DELETE FROM operations WHERE id = ${op.id}`.execute(deps.db);
          await insertOpLogRow(
            deps.db,
            { op: completed.op, signedCoreJcs: completed.jcs },
            { syncStatus: 'local', syncedAt: null, arrivalSeq: null },
          );
          head = { seq, hash: completed.op.hash };
          // The record's canonical order breaks ties on device and seq, both of which just changed.
          const record = `${op.entityType}:${op.entityId}`;
          if (!refolded.has(record)) {
            refolded.add(record);
            await deps.refold(completed.op);
          }
        }
        // Photos not uploaded yet go up under the new device, which the carried refs now name: the
        // server takes an upload only for a device it knows, and the old one it may have forgotten.
        // The row's device must agree with the signed ref that points at it, which is exactly what
        // the frozen-column rule protects, so it moves with the ref here and nowhere else.
        for (const fromDeviceId of fromDeviceIds) {
          // eslint-disable-next-line bolusi/no-media-column-update -- moves with the re-signed ref
          await sql`
            UPDATE media_items SET device_id = ${params.deviceId}
            WHERE device_id = ${fromDeviceId} AND upload_status <> 'uploaded'
          `.execute(deps.db);
        }
      },
    },
  );
  return { audit, carried: pending.length };
}

interface CarryRow {
  readonly op: SignedOperation;
}

/** Each old device's unsynced ops in chain order, devices ordered by their oldest change. */
async function readCarryRows<DB>(db: Kysely<DB>, deviceId: string): Promise<CarryRow[]> {
  const result = await sql<{
    id: string;
    seq: number;
    signedCoreJcs: string;
    hash: string;
    signature: string;
  }>`
    SELECT o.id, o.seq, o.signed_core_jcs AS "signedCoreJcs", o.hash, o.signature
    FROM operations o
    JOIN (
      SELECT device_id, MIN(timestamp_ms) AS first_at FROM operations
      WHERE sync_status = 'local' AND device_id <> ${deviceId}
      GROUP BY device_id
    ) d ON d.device_id = o.device_id
    WHERE o.sync_status = 'local'
    ORDER BY d.first_at, o.device_id, o.seq
  `.execute(db);
  return result.rows.map((row) => ({ op: operationFromSignedCoreJcs(row.signedCoreJcs, row) }));
}

/**
 * A media ref names the device that captured it, and the server binds it to the device that signs
 * the op (a ref naming another device is refused). The carried op is signed by the new device, so
 * its refs to the old one move with it.
 */
function rebindMediaRefs(
  payload: Record<string, unknown>,
  fromDeviceId: string,
  toDeviceId: string,
): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== 'object') return value;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      visit(inner),
    ]);
    const next = Object.fromEntries(entries) as Record<string, unknown>;
    if ('mediaId' in next && next['deviceId'] === fromDeviceId) next['deviceId'] = toDeviceId;
    return next;
  };
  return visit(payload) as Record<string, unknown>;
}

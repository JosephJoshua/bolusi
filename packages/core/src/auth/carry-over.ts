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
import { readSyncState } from '../sync/state.js';
import { AUTH_ENTITY, AUTH_OP } from './operations.js';
import { DEVICE_ID_META_KEY, readMeta, STORE_ID_META_KEY, STORE_NAME_META_KEY } from './repo.js';

/**
 * Records about a registration itself (its genesis, an earlier carry-over) mean nothing under a new
 * one, and the server would refuse them there. An unsent one is dropped at re-enrolment instead of
 * carried: the new registration's own records replace it.
 */
const REGISTRATION_OP_TYPES = [AUTH_OP.deviceEnrolled, AUTH_OP.deviceChangesTransferred];

/** Whose unsynced changes a re-enrolment will carry over, as the owner reviews them. */
export interface UnsyncedAuthor {
  readonly userId: string;
  /** From the phone's staff list; null for someone no longer on it. */
  readonly name: string | null;
  readonly count: number;
  /** The kinds of change, by op type, in the order first made. */
  readonly types: readonly string[];
}

/** What a phone that already holds a store's data brings to its re-enrolment. */
export interface HeldPhone {
  /** The store whose data is on this phone: the only store it may be re-enrolled into. */
  readonly storeId: string;
  readonly storeName: string | null;
  /**
   * The registration this enrolment replaces, which the server then revokes in the same step: set
   * only while sync still runs. A revoked phone is already revoked, and a phone the server no longer
   * recognises has nothing there to replace.
   */
  readonly replacesDeviceId: string | null;
  /** Oldest change first; empty when everything reached the server. */
  readonly unsynced: readonly UnsyncedAuthor[];
}

/**
 * The phone's store, registration and unsynced changes, for the owner to review before re-enrolling
 * it; null on a phone that was never enrolled.
 */
export async function readHeldPhone<DB>(db: Kysely<DB>): Promise<HeldPhone | null> {
  const storeId = await readMeta(db, STORE_ID_META_KEY);
  if (storeId === null) return null;
  const [storeName, deviceId, sync] = await Promise.all([
    readMeta(db, STORE_NAME_META_KEY),
    readMeta(db, DEVICE_ID_META_KEY),
    readSyncState(db),
  ]);
  const result = await sql<{ userId: string; name: string | null; type: string }>`
    SELECT o.user_id AS "userId", u.name, o.type
    FROM operations o LEFT JOIN users_directory u ON u.id = o.user_id
    WHERE o.sync_status = 'local' AND o.type NOT IN (${sql.join(REGISTRATION_OP_TYPES)})
    ORDER BY o.timestamp_ms, o.device_id, o.seq
  `.execute(db);
  const byUser = new Map<string, { name: string | null; count: number; types: string[] }>();
  for (const row of result.rows) {
    const author = byUser.get(row.userId) ?? { name: row.name, count: 0, types: [] };
    author.count += 1;
    if (!author.types.includes(row.type)) author.types.push(row.type);
    byUser.set(row.userId, author);
  }
  return {
    storeId,
    storeName,
    replacesDeviceId: deviceId !== null && !sync.syncDisabled ? deviceId : null,
    unsynced: [...byUser].map(([userId, author]) => ({ userId, ...author })),
  };
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
  if (pending.length === 0) {
    await dropRegistrationRecords(deps.db, params.deviceId);
    return { audit: [], carried: 0 };
  }
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
        await dropRegistrationRecords(deps.db, params.deviceId);
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

/** The old registrations' own unsent records (see `REGISTRATION_OP_TYPES`). */
async function dropRegistrationRecords<DB>(db: Kysely<DB>, deviceId: string): Promise<void> {
  await sql`
    DELETE FROM operations
    WHERE sync_status = 'local' AND device_id <> ${deviceId}
      AND type IN (${sql.join(REGISTRATION_OP_TYPES)})
  `.execute(db);
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
        AND type NOT IN (${sql.join(REGISTRATION_OP_TYPES)})
      GROUP BY device_id
    ) d ON d.device_id = o.device_id
    WHERE o.sync_status = 'local' AND o.type NOT IN (${sql.join(REGISTRATION_OP_TYPES)})
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

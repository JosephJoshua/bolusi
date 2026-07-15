// appendSystemOp — the primitive task 17 uses to emit server-built ops (the ONLY ops the system
// device signs: platform.conflict_detected, 01-domain-model §3.6). This task ships the seam, not
// the conflict-detection rules. It runs INSIDE the push transaction, AFTER the acceptance loop
// (10-db §3), under the same tenant_op_counters row lock the pipeline already holds — so the
// system chain never forks and the op rides the SAME per-tenant gapless serverSeq stream.
//
// Chain: seq = last_seq + 1, previousHash = last_hash (genesis rule when NULL — 05 §2.2), read
// from system_device_chain_state. Signing: the JCS core is hashed via @bolusi/core and signed by
// an INJECTED signer (the tenant system-device Ed25519 key lives in the server secret store, never
// in Postgres — 10-db §12); the produced op is self-verified against the system pubkey so a
// mis-wired signer fails loudly here, not silently on a client's pull.
import { bytesToBase64, hashSignedCore, verifyOp } from '@bolusi/core';
import type { CryptoPort } from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';
import type { SignedCore, SignedOperation } from '@bolusi/schemas';
import type { TenantDb } from '@bolusi/db-server';

import { insertOperationRow } from './persist.js';
import { allocateServerSeq } from './server-seq.js';

/** Signs the raw 32-byte hash with the tenant system device's Ed25519 key (05 §2.2). */
export type SystemSigner = (hash: Uint8Array) => Uint8Array;

export interface AppendSystemOpDeps {
  readonly crypto: CryptoPort;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface AppendSystemOpInput {
  readonly tenantId: string;
  /** The tenant's system device (devices.kind = 'system') and its keypair. */
  readonly systemDeviceId: string;
  readonly systemUserId: string;
  readonly systemDevicePublicKey: Uint8Array;
  readonly sign: SystemSigner;
  /** Signed-core content of the op to emit (envelope facts are computed here). */
  readonly storeId: string | null;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
}

export interface AppendSystemOpResult {
  readonly op: SignedOperation;
  readonly serverSeq: number;
}

interface ChainStateRow {
  readonly lastSeq: number;
  readonly lastHash: string | null;
}

async function lockSystemChainState(
  db: TenantDb,
  tenantId: string,
  systemDeviceId: string,
): Promise<ChainStateRow> {
  // Ensure the row exists (provisioning creates it with the system device); idempotent lazy
  // create keeps a tenant that somehow lacks it from wedging emission.
  await db
    .insertInto('systemDeviceChainState')
    .values({ tenantId, deviceId: systemDeviceId })
    .onConflict((oc) => oc.doNothing())
    .execute();

  const row = await db
    .selectFrom('systemDeviceChainState')
    .select(['lastSeq', 'lastHash'])
    .where('tenantId', '=', tenantId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  return { lastSeq: Number(row.lastSeq), lastHash: row.lastHash };
}

export async function appendSystemOp(
  db: TenantDb,
  deps: AppendSystemOpDeps,
  input: AppendSystemOpInput,
): Promise<AppendSystemOpResult> {
  const chain = await lockSystemChainState(db, input.tenantId, input.systemDeviceId);
  const seq = chain.lastSeq + 1;
  const previousHash = chain.lastHash ?? GENESIS_PREVIOUS_HASH;

  const core: SignedCore = {
    id: deps.newId(),
    tenantId: input.tenantId,
    storeId: input.storeId,
    userId: input.systemUserId,
    deviceId: input.systemDeviceId,
    seq,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    schemaVersion: input.schemaVersion,
    payload: input.payload,
    timestamp: input.timestamp,
    location: null,
    source: 'system',
    agentInitiated: false,
    agentConversationId: null,
    previousHash,
  };

  const digest = hashSignedCore(core, deps.crypto);
  const signature = bytesToBase64(input.sign(digest.hash));
  const op: SignedOperation = { ...core, hash: digest.hashHex, signature };

  // Self-check: the produced op must verify like any pulled op (05 §2.2) — a wrong injected signer
  // is a bug that must not reach a client's quarantine path.
  if (!verifyOp(op, input.systemDevicePublicKey, deps.crypto)) {
    throw new Error('appendSystemOp: produced op does not verify against the system device pubkey');
  }

  const serverSeq = await allocateServerSeq(db, input.tenantId);
  await insertOperationRow(db, {
    op,
    serverSeq,
    receivedAt: deps.now(),
    jcs: digest.jcs,
    clockSkewFlagged: false,
  });

  await db
    .updateTable('systemDeviceChainState')
    .set({ lastSeq: seq, lastHash: digest.hashHex })
    .where('tenantId', '=', input.tenantId)
    .execute();

  return { op, serverSeq };
}

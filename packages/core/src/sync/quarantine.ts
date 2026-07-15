// Pull-side verification + quarantine (api/01-sync §4.2; DDL 10-db §9.5 `quarantined_ops`).
// This is the client half of SEC-OPLOG-09.
//
// TRUST, BUT VERIFY (api/01-sync §4.2). The device token authenticates the SERVER's transport, not
// the HISTORY it serves. Every pulled op is verified against the device pubkeys the directory
// sidecar delivered, so a compromised server cannot inject unsigned history into a device's
// projections silently. The signature is the client's independent evidence, and it is the only
// thing standing between "the server said so" and "this actually happened".
//
// WHY QUARANTINE RATHER THAN REFUSE. Two failure modes with opposite correct answers:
//
//   Refusing the batch  — one bad op bricks sync forever (nothing after it ever arrives). An
//                         attacker who can inject ONE op gets a permanent denial of service on
//                         every device in the tenant. Unacceptable.
//   Applying it anyway  — unverifiable history enters projections. Unacceptable.
//
// So: hold the op aside, DON'T apply it, and ADVANCE THE CURSOR PAST IT (api/01 §4.2 —
// "one bad op must not brick sync"), then surface loudly. Sync keeps working, the bad op is
// visibly held, and a human is told. Cursor advance is what makes quarantine a repair rather than
// a stall, and it is the counter-intuitive half — it is deliberate, not a leak.
//
// UNKNOWN KEY IS NOT THE SAME AS A BAD KEY, and conflating them would be a real bug. A device
// enrolled 30 seconds ago is legitimately absent from a stale local registry — quarantining its
// ops on sight would quarantine every new device's first ops. So an unknown signer earns exactly
// ONE forced sidecar refetch (`devicesDirectoryVersion: 0`) before it is quarantined, and a
// quarantined `unknown_pubkey` op is re-verified whenever a new sidecar lands. A verified-BAD
// signature earns no such benefit: the key is known and the signature is forged or corrupt.
import { sql, type Kysely } from 'kysely';

import type { SignedOperation } from '@bolusi/schemas';

import { base64ToBytes } from '../crypto/bytes.js';
import type { CryptoPort } from '../crypto/port.js';
import { hashSignedCore, verifyOp } from '../crypto/signed-core.js';
import type { SignedCore } from '@bolusi/schemas';
import type { DeviceRegistryEntry } from './devices.js';
import type { QuarantineReason } from './ports.js';

/** Label key for quarantine surfacing (ui-labels §sync; api/01 §4.2 mandates `sync.quarantine.*`). */
export const QUARANTINE_LABEL_KEY = 'sync.quarantine.title';

/** Verification outcome for one pulled op. */
export type PulledOpVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: QuarantineReason };

/**
 * Verify one pulled op against the device registry (api/01-sync §4.2).
 *
 * Deliberately does NOT consult `entry.status`: a revoked device's pre-revocation ops stay
 * verifiable forever (03 §5), and rejecting on status would retroactively quarantine honest
 * history the moment someone revokes a device. Receipt-time revocation is enforced SERVER-side
 * (05 §9.4 — the op never reaches a pull), which is the only place it can be enforced honestly.
 *
 * A registry entry whose key is not decodable counts as `unknown_pubkey`, not `bad_signature`:
 * we hold no usable key, so the honest recovery is a fresh sidecar — the same path a genuinely
 * unknown signer takes. Calling it `bad_signature` would permanently condemn ops that a corrected
 * directory would verify.
 */
export function verifyPulledOp(
  op: SignedOperation,
  registry: ReadonlyMap<string, DeviceRegistryEntry>,
  crypto: CryptoPort,
): PulledOpVerification {
  const entry = registry.get(op.deviceId);
  if (entry === undefined) return { ok: false, reason: 'unknown_pubkey' };

  let publicKey: Uint8Array;
  try {
    publicKey = base64ToBytes(entry.signingKeyPublic);
  } catch {
    return { ok: false, reason: 'unknown_pubkey' };
  }

  // Total by contract — `verifyOp` never throws on hostile input (crypto/signed-core.ts).
  return verifyOp(op, publicKey, crypto) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * The verbatim JCS text of a pulled op's signed core (05 §3 verbatim-storage rule).
 *
 * The wire carries the core as parsed JSON, and JCS is a fixpoint under `JSON.parse ∘ canonicalize`
 * — re-canonicalizing recovers the exact bytes the signer hashed. That round-trip is why the pull
 * can persist `signed_core_jcs` at all without the server shipping the text twice.
 *
 * @throws {ZodError | JcsInputError} if the core is not a §2.1 core — callers must have parsed the
 * op through `zSignedOperation` first, so a throw here is a bug, not hostile input.
 */
export function signedCoreJcsOf(op: SignedOperation, crypto: CryptoPort): string {
  return hashSignedCore(signedCoreOf(op), crypto).jcs;
}

/**
 * The §2.1 signed core of an op — the §2.2 derived fields removed.
 *
 * `zSignedCore` is STRICT, so leaving `hash`/`signature` in would fail the parse rather than be
 * ignored — which is the schema doing its job (they are not part of the preimage). Written as an
 * omission rather than a hand-listed field set: a field added to 05 §2.1 must flow through here
 * automatically, and a hand-listed core would silently drop it from the hash.
 */
function signedCoreOf(op: SignedOperation): SignedCore {
  const core: Partial<SignedOperation> = { ...op };
  delete core.hash;
  delete core.signature;
  return core as SignedCore;
}

/** A quarantined op as stored (10-db §9.5). */
export interface QuarantinedOp {
  readonly id: string;
  readonly deviceId: string;
  readonly serverSeq: number;
  readonly signedCoreJcs: string;
  readonly hash: string;
  readonly signature: string;
  readonly reason: QuarantineReason;
  readonly quarantinedAt: number;
}

/**
 * Insert a quarantine row (10-db §9.5). Idempotent on `id`: a re-pull of the same bad op must not
 * fail the batch on a PK collision — the op is already held, which is the desired state.
 */
export async function insertQuarantinedOp<DB>(db: Kysely<DB>, row: QuarantinedOp): Promise<void> {
  await sql`
    INSERT OR IGNORE INTO quarantined_ops
      (id, device_id, server_seq, signed_core_jcs, hash, signature, reason, quarantined_at)
    VALUES (${row.id}, ${row.deviceId}, ${row.serverSeq}, ${row.signedCoreJcs}, ${row.hash},
            ${row.signature}, ${row.reason}, ${row.quarantinedAt})
  `.execute(db);
}

/** Every quarantined op, oldest `server_seq` first (the order they would have applied in). */
export async function readQuarantinedOps<DB>(db: Kysely<DB>): Promise<QuarantinedOp[]> {
  const result = await sql<{
    id: string;
    deviceId: string;
    serverSeq: number;
    signedCoreJcs: string;
    hash: string;
    signature: string;
    reason: string;
    quarantinedAt: number;
  }>`
    SELECT id, device_id, server_seq, signed_core_jcs, hash, signature, reason, quarantined_at
    FROM quarantined_ops ORDER BY server_seq
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    serverSeq: Number(row.serverSeq),
    signedCoreJcs: row.signedCoreJcs,
    hash: row.hash,
    signature: row.signature,
    reason: row.reason === 'bad_signature' ? 'bad_signature' : 'unknown_pubkey',
    quarantinedAt: Number(row.quarantinedAt),
  }));
}

export async function deleteQuarantinedOp<DB>(db: Kysely<DB>, id: string): Promise<void> {
  await sql`DELETE FROM quarantined_ops WHERE id = ${id}`.execute(db);
}

/**
 * Reconstruct the wire op from a quarantine row. The signed core is rebuilt from the VERBATIM JCS
 * text (05 §3) rather than from typed columns — the same rule the server's pull follows, and for
 * the same reason: a numeric round-trip through typed storage can change bytes and fail a genuine
 * signature. Re-verification would then reject an op that a corrected directory should release.
 */
export function reconstructQuarantinedOp(row: QuarantinedOp): SignedOperation {
  const core = JSON.parse(row.signedCoreJcs) as Record<string, unknown>;
  return { ...core, hash: row.hash, signature: row.signature } as SignedOperation;
}

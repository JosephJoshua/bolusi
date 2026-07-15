// The devices sidecar mirror (api/01-sync §4.1; DDL 10-db §9.5 `device_registry`).
//
// DIRECTORY TRUTH, NOT OP-SOURCED (03-state-machines §5). Device status is learned HERE and never
// from ops: no `auth.*` op carries a revocation, and a client that inferred device state from the
// op stream could be fed a forged "revoked" by the very device it should distrust. The server's
// directory row is the truth; this table is its mirror, and it exists for exactly two consumers —
// the device list (display) and pull-side signature verification (api/01-sync §4.2).
//
// REVOKED DEVICES REMAIN LISTED, and that is load-bearing rather than an oversight: their public
// keys must keep verifying the history they legitimately signed BEFORE revocation (api/02-auth
// §7.2, 03 §5 "ops accepted before revocation remain valid"). Dropping them would retroactively
// quarantine a revoked device's entire honest history — a revocation would corrupt the past.
// Verification therefore does NOT consult `status`; it consults the key.
import { sql, type Kysely } from 'kysely';

import type { DeviceInfo } from '@bolusi/schemas';

/** A `device_registry` row (10-db §9.5) — 1:1 with the sidecar's `DeviceInfo`. */
export interface DeviceRegistryEntry {
  readonly id: string;
  readonly storeId: string | null;
  readonly kind: 'member' | 'system';
  /** base64 Ed25519 public key. */
  readonly signingKeyPublic: string;
  readonly status: 'active' | 'revoked';
  readonly revokedAt: number | null;
}

/**
 * Replace `device_registry` wholesale with the sidecar snapshot (api/01-sync §4.1: the sidecar is
 * a FULL snapshot of the pull scope, not a delta).
 *
 * ATOMIC BY THE CALLER'S TRANSACTION. The DELETE + INSERTs run on the handle they are given; the
 * pull wraps them in the same transaction as the ops and the cursor, so a crash between the delete
 * and the inserts cannot leave the device with an EMPTY registry — which would quarantine every
 * subsequent pulled op until the next sidecar arrived. That is why there is no `transaction()` call
 * in here: opening one would make the delete independently committable and create exactly that
 * window.
 */
export async function replaceDeviceRegistry<DB>(
  db: Kysely<DB>,
  devices: readonly DeviceInfo[],
): Promise<void> {
  await sql`DELETE FROM device_registry`.execute(db);
  for (const device of devices) {
    await sql`
      INSERT INTO device_registry (id, store_id, kind, signing_key_public, status, revoked_at)
      VALUES (${device.id}, ${device.storeId}, ${device.kind}, ${device.signingKeyPublic},
              ${device.status}, ${device.revokedAt})
    `.execute(db);
  }
}

/** Every known device key, by device id — the verification input for pulled ops (api/01 §4.2). */
export async function readDeviceRegistry<DB>(
  db: Kysely<DB>,
): Promise<Map<string, DeviceRegistryEntry>> {
  const result = await sql<{
    id: string;
    storeId: string | null;
    kind: string;
    signingKeyPublic: string;
    status: string;
    revokedAt: number | null;
  }>`
    SELECT id, store_id, kind, signing_key_public, status, revoked_at FROM device_registry
  `.execute(db);
  const entries = new Map<string, DeviceRegistryEntry>();
  for (const row of result.rows) {
    entries.set(row.id, {
      id: row.id,
      storeId: row.storeId,
      kind: row.kind === 'system' ? 'system' : 'member',
      signingKeyPublic: row.signingKeyPublic,
      status: row.status === 'revoked' ? 'revoked' : 'active',
      revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
    });
  }
  return entries;
}

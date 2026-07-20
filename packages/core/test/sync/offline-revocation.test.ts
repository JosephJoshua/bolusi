// ── SEC-DEV-04 — the offline-revocation caveat (security-guide §218) ─────────────────────────────
//
// D18 §2 (decisions/2026-07-17-owner-rulings-muting-218-ios-sync.md) resolved §218's long-standing
// self-contradiction. The owner ruled §218 OVER-SPECIFIED and DROPPED the earlier "queued ops →
// DEVICE_REVOKED, kept + surfaced as `rejected`" wording. The corrected, buildable guarantee —
// matching api/02-auth §7.3 — is: a revoked device CANNOT SYNC, and its unsynced work is WIPED
// (crypto-erase), not leaked or resurrected. That is exactly the three behaviours this file has
// always asserted, so with the over-specification gone they now FULLY discharge §218 and the
// `describe` below carries the id verbatim (SEC-META-01 retires it here — task 70).
//
// WHAT §218 ASKS FOR (post-D18), AND WHAT THIS FILE ASSERTS (traced 2026-07-15, task 61):
//
//   1. "continues local operation"                 → HOLDS. Asserted below.
//   2. (DROPPED by D18 §2 — "queued ops → DEVICE_REVOKED" never happens, and cannot; see below)
//   3. "kept" (locally, until §7.3's wipe)          → HOLDS (as `local`, not `rejected`). Below.
//   4. (DROPPED by D18 §2 — "surfaced as `rejected`" never happens; surfaced as `sync_disabled`)
//   5. "none accepted"                             → HOLDS. Asserted below, with a positive control.
//
// Why the DROPPED behaviours 2/4 could never be built — three independent, spec-level reasons the
// ruling records (kept here because the CORRECTED §218 depends on them being true; a comment is a
// hypothesis, so each is traced to a producer, CLAUDE.md §2.11 / testing-guide T-16):
//
//   (a) A revoked token 401s at the AUTH MIDDLEWARE (middleware/auth.ts:115), which is normative:
//       api/02-auth §8 "A revoked device → DEVICE_REVOKED" and the §10 table "401 | DEVICE_REVOKED
//       | Token of a revoked device — triggers §7.3 confirm-then-wipe". Every /v1 route sits behind
//       it (app.ts:99). The per-op DEVICE_REVOKED results the OLD §218 wanted are produced ONLY by
//       oplog/pipeline.ts:91, which is BEHIND that middleware and therefore unreachable over HTTP
//       for a revoked device. sec-sync.test.ts proves the wire truth: push/pull by a revoked device
//       → 401, handler never runs. (pipeline.ts:91 is still correct defence-in-depth for a revoke
//       that lands mid-request; it is simply not the offline-reconnect path.)
//   (b) The client marks ops from a 200 `PushResponse` only (push.ts → markSyncResult). A 401 is a
//       CYCLE FAILURE (loop.ts:277) → sync disabled. There is no path from a 401 to op marking.
//   (c) "kept + surfaced as `rejected`" contradicted api/02-auth §7.3, which is explicit that a
//       confirmed DEVICE_REVOKED WIPES the device: "Unsynced ops and media are destroyed with the
//       rest — by design; the mitigation for that loss is sync frequency, not wipe reluctance."
//       And `rejected` is TERMINAL (03 §3): marking queued ops rejected on a 401 would let ONE
//       spurious 401 permanently destroy a device's unsynced work — precisely what §7.3's
//       confirm-then-wipe step exists to prevent ("a single spurious 401 must never wipe a fleet").
//
// So this file asserts the REAL, corrected contract: the ops are kept, untouched and re-pushable,
// and the revocation is surfaced through `sync_disabled` until §7.3's confirm-then-wipe destroys
// them with the rest of the device data. D18 §2 recorded the ruling; this file is its retirement.
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import { signedCoreJcsOf, SyncTransportError } from '../../src/index.js';
import {
  makeDevice,
  makeSignedNoteOp,
  openSyncHarness,
  prngFor,
  uuidV4,
  uuidV7,
  type SyncHarness,
  type TestDevice,
} from './_fixtures.js';

let harness: SyncHarness;
let device: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;
let clockAt: number;

beforeEach(async () => {
  harness = await openSyncHarness();
  const prng = prngFor(31337);
  device = makeDevice(prng, 5);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  clockAt = 1_726_000_000_000;
});

afterEach(async () => {
  await harness.close();
});

/** Insert a local (unsynced) op — the state the append path (04 §5.1) leaves behind. */
async function seedLocalOp(seq: number): Promise<SignedOperation> {
  const prng = prngFor(7000 + seq);
  clockAt += 1000;
  const op = makeSignedNoteOp({
    device,
    seq,
    timestamp: clockAt,
    tenantId,
    storeId,
    userId,
    entityId: uuidV7(prng, clockAt),
    payload: { title: `t${seq}`, body: `b${seq}` },
    prng,
  });
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${null}, ${op.source}, ${0}, ${null}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${signedCoreJcsOf(op, noblePort)}, 'local'
    )
  `.execute(harness.db);
  return op;
}

async function statusOf(id: string): Promise<{ status: string; code: string | null }> {
  const rows = await sql<{ syncStatus: string; rejectionCode: string | null }>`
    SELECT sync_status, rejection_code FROM operations WHERE id = ${id}
  `.execute(harness.db);
  const row = rows.rows[0];
  return { status: row?.syncStatus ?? 'MISSING', code: row?.rejectionCode ?? null };
}

async function syncStateRow(): Promise<{
  syncDisabled: number;
  syncDisabledReason: string | null;
}> {
  const rows = await sql<{ syncDisabled: number; syncDisabledReason: string | null }>`
    SELECT sync_disabled, sync_disabled_reason FROM sync_state WHERE id = 1
  `.execute(harness.db);
  return rows.rows[0] as { syncDisabled: number; syncDisabledReason: string | null };
}

/** The transport is dead — the device is offline and cannot learn it has been revoked. */
const offline = (): never => {
  throw new SyncTransportError('offline', { code: 'NETWORK', status: 0 });
};
/** Reconnect against a server that has revoked us: 401 at the middleware (api/02-auth §9). */
const revoked401 = (): never => {
  throw new SyncTransportError('revoked', { code: 'DEVICE_REVOKED', status: 401 });
};

describe('SEC-DEV-04 the offline-revocation caveat holds: a device revoked while offline keeps working locally, cannot sync on reconnect (401 DEVICE_REVOKED), and its unsynced work is kept locally then wiped (api/02-auth §7.3) — never leaked, resurrected, or accepted', () => {
  it('a device revoked while offline keeps working locally: ops append and queue, sync is not disabled', async () => {
    // The caveat api/02-auth §7.2 (:434) and security-guide §6.3 document and PROMISE: "an offline
    // revoked device keeps working locally until it reconnects". The device has been revoked
    // server-side at this point — it has no way to know, and must not degrade.
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPush(offline).scriptPull(offline);

    const a = await seedLocalOp(1);
    loop.requestSync('manual');
    await loop.settle();

    // Sync retries (backoff), it does NOT disable itself: an unreachable server is not a
    // revocation. Disabling here would brick every offline device on a flaky network.
    expect(loop.state).toBe('backoff');
    expect((await syncStateRow()).syncDisabled).toBe(0);

    // Local operation CONTINUES: work created after the (unknown) revocation still lands and
    // still queues. This is the "documented behavior" half of §218 — the caveat is real, and the
    // product's honesty about it (never overselling revocation) depends on it staying true.
    const b = await seedLocalOp(2);
    expect((await statusOf(a.id)).status).toBe('local');
    expect((await statusOf(b.id)).status).toBe('local');
    expect(harness.surface.ofKind('sync_disabled')).toHaveLength(0);
  });

  it('on reconnect the queued ops are KEPT, none are accepted, and the revocation is surfaced', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });

    // Two ops queued while offline-and-revoked.
    harness.transport.scriptPush(offline).scriptPull(offline);
    const a = await seedLocalOp(1);
    const b = await seedLocalOp(2);
    loop.requestSync('manual');
    await loop.settle();

    // Reconnect. The server 401s the revoked token before the push handler runs.
    harness.transport.scriptPush(revoked401);
    loop.requestSync('manual');
    await loop.settle();

    // NONE ACCEPTED (§218's actual security property — the one that matters). The device worked
    // for an unbounded offline window; not one op of that work enters the log.
    for (const op of [a, b]) {
      const row = await statusOf(op.id);
      expect(row.status).not.toBe('synced');
      expect(row.status).toBe('local');
    }

    // KEPT — the rows survive the revocation. The sync engine never deletes a device's work; the
    // only thing that destroys it is the deliberate §7.3 wipe, which is a separate act with its
    // own confirm step. A silent drop here would lose a shift's work with no trace.
    const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM operations`.execute(harness.db);
    expect(Number(rows.rows[0]?.c)).toBe(2);

    // SURFACED — never silent (05 §8 / PRD-012 §6). Via `sync_disabled`, which is what a 401
    // produces; §218's "surfaced as `rejected`" is unreachable (see the header).
    expect((await syncStateRow()).syncDisabled).toBe(1);
    expect((await syncStateRow()).syncDisabledReason).toBe('device_revoked');
    expect(harness.surface.ofKind('sync_disabled')).toHaveLength(1);
    expect(loop.state).toBe('idle');

    // And sync really has stopped: no further automatic cycles, nothing retried into the void.
    const pushesBefore = harness.transport.pushes.length;
    loop.requestSync('manual');
    await loop.settle();
    expect(harness.transport.pushes.length).toBe(pushesBefore);
  });

  it('positive control: an UNREVOKED device reconnecting has the same queued ops ACCEPTED', async () => {
    // "None accepted" is worthless without this. Everything above passes trivially against a
    // client that accepts nothing, ever — a broken push would score identically (T-14b). This is
    // the discriminating case: same harness, same queue, same reconnect, revocation the only
    // difference. If this goes red, the two assertions above prove nothing.
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPush(offline).scriptPull(offline);
    const a = await seedLocalOp(1);
    const b = await seedLocalOp(2);
    loop.requestSync('manual');
    await loop.settle();

    harness.transport.scriptPush({
      results: [
        { id: a.id, status: 'accepted', serverSeq: 1 },
        { id: b.id, status: 'accepted', serverSeq: 2 },
      ],
      serverTime: clockAt,
    });
    loop.requestSync('manual');
    await loop.settle();

    for (const op of [a, b]) {
      expect((await statusOf(op.id)).status).toBe('synced');
    }
    expect((await syncStateRow()).syncDisabled).toBe(0);
    expect(harness.surface.ofKind('sync_disabled')).toHaveLength(0);
  });
});

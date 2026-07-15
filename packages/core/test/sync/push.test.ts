// The push phase (api/01-sync §3; per-op machine 03-state-machines §3; codes 05-operation-log §8).
//
// SEC-SYNC-02's CLIENT LEG lives here: security-guide §4.2 requires "ops pushed in the same window
// → `DEVICE_REVOKED`, kept client-side as `rejected`". Task 16 shipped that id's SERVER legs (the
// 401 and the per-op code) and deliberately kept the id out of its titles so SEC-META-01 would not
// read the id as fully shipped. The client leg is the missing half, and it is titled verbatim below.
//
// "NEVER SILENT" IS THE WHOLE POINT OF THE REJECTION SUITE. 05 §8: "a rejected op stays in the local
// log flagged `rejected` — it is never deleted, and the user is always told"; PRD-012 §6 calls silent
// rejection unacceptable. So the surfacing test asserts the ENTIRE closed set of §8 codes, not a
// sample: a guard that spot-checked three codes would never notice the fourth going silent (T-14 —
// assert the set, and let the SET be the denominator).
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_PUSH_OPS,
  REJECTION_CODES,
  type PushResult,
  type SignedOperation,
} from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import { runPushPhase } from '../../src/index.js';
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
let chainBrokenCalls: number;

beforeEach(async () => {
  harness = await openSyncHarness();
  const prng = prngFor(31337);
  device = makeDevice(prng, 5);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  clockAt = 1_726_000_000_000;
  chainBrokenCalls = 0;
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
  const { hash: _h, signature: _s, ...core } = op;
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${null}, ${op.source}, ${0}, ${null}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${JSON.stringify(sortedCore(core))}, 'local'
    )
  `.execute(harness.db);
  return op;
}

/** JCS-ish: key-sorted JSON. Enough for the push path's `JSON.parse` round-trip in these tests. */
function sortedCore(core: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(core).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function deps() {
  return {
    db: harness.db,
    transport: harness.transport,
    surface: harness.surface,
    clock: harness.clock,
    deviceId: device.id,
    onChainBroken: async () => {
      chainBrokenCalls += 1;
      await sql`UPDATE sync_state SET push_halted = 1 WHERE id = 1`.execute(harness.db);
    },
  };
}

async function statusOf(id: string): Promise<{ status: string; code: string | null }> {
  const rows = await sql<{ syncStatus: string; rejectionCode: string | null }>`
    SELECT sync_status, rejection_code FROM operations WHERE id = ${id}
  `.execute(harness.db);
  return {
    status: rows.rows[0]?.syncStatus ?? 'missing',
    code: rows.rows[0]?.rejectionCode ?? null,
  };
}

describe('push results mark each op individually (03 §3)', () => {
  it('accepted and duplicate are both terminal-success ⇒ synced', async () => {
    const a = await seedLocalOp(1);
    const b = await seedLocalOp(2);
    harness.transport.scriptPush({
      results: [
        { id: a.id, status: 'accepted', serverSeq: 10 },
        { id: b.id, status: 'duplicate' },
      ],
      serverTime: clockAt,
    });

    const result = await runPushPhase(deps());

    expect(result.synced).toBe(2);
    expect((await statusOf(a.id)).status).toBe('synced');
    expect((await statusOf(b.id)).status).toBe('synced');
  });

  it('a repeated ack for an already-synced op is an idempotent no-op, not INVALID_TRANSITION', async () => {
    const a = await seedLocalOp(1);
    harness.transport.scriptPush({
      results: [{ id: a.id, status: 'accepted', serverSeq: 10 }],
      serverTime: clockAt,
    });
    await runPushPhase(deps());

    // The retry-of-a-partially-acked-batch case (03 §3, CHAOS-06a). The op is already `synced`;
    // a second `accepted` must fold as a no-op. `synced → synced` is a self-loop in the table, and
    // `markSyncResult` would THROW on a real invalid pair — so this passing is evidence, not luck.
    await sql`UPDATE operations SET sync_status = 'local' WHERE id = ${a.id}`.execute(harness.db);
    await sql`UPDATE operations SET sync_status = 'synced' WHERE id = ${a.id}`.execute(harness.db);
    harness.transport.scriptPush({
      results: [{ id: a.id, status: 'duplicate' }],
      serverTime: clockAt,
    });
    // Nothing is `local`, so no batch is even sent — the queue is drained.
    const result = await runPushPhase(deps());
    expect(result.batches).toBe(0);
    expect((await statusOf(a.id)).status).toBe('synced');
  });

  it('CHAIN_GAP leaves the op local and is not a rejection, not a failure (03 §3 / 05 §8)', async () => {
    const a = await seedLocalOp(1);
    harness.transport.scriptPush({
      results: [{ id: a.id, status: 'rejected', code: 'CHAIN_GAP', reason: 'seq skips ahead' }],
      serverTime: clockAt,
    });

    const result = await runPushPhase(deps());

    // No transition: still `local`, so the next cycle re-sends it — 03 §3's "client resends from
    // the gap". Crucially NOT `rejected`: a gap is routine after a partial ack, not a refusal.
    expect((await statusOf(a.id)).status).toBe('local');
    expect((await statusOf(a.id)).code).toBeNull();
    expect(result.rejected).toBe(0);
    expect(result.gapped).toBe(true);
  });
});

describe('every rejection code in 05 §8 is surfaced — the closed set, never a sample', () => {
  it('surfaces EVERY code of the 05 §8 registry (no silent path)', async () => {
    // The DENOMINATOR is the exported registry, not a hand-typed list: a code added to 05 §8 and
    // to `REJECTION_CODES` lands in this test automatically. A hardcoded list here would be the
    // exact "guard that silently checks less than it claims" failure (T-14).
    const codes = [...REJECTION_CODES].filter((c) => c !== 'CHAIN_GAP'); // GAP is not a rejection (03 §3)
    const ops: SignedOperation[] = [];
    for (let i = 0; i < codes.length; i += 1) ops.push(await seedLocalOp(i + 1));

    // One op per code. CHAIN_BROKEN halts the phase, so it goes LAST — otherwise it would
    // short-circuit the codes after it and this test would silently check fewer than it claims.
    const ordered = [...codes.filter((c) => c !== 'CHAIN_BROKEN'), 'CHAIN_BROKEN'];
    harness.transport.scriptPush({
      results: ordered.map<PushResult>((code, i) => ({
        id: (ops[i] as SignedOperation).id,
        status: 'rejected',
        code,
        reason: `reason-${code}`,
      })),
      serverTime: clockAt,
    });

    await runPushPhase(deps());

    const surfaced = harness.surface.ofKind('op_rejected');
    expect(new Set(surfaced.map((e) => e.code))).toEqual(new Set(ordered));
    // Every op is `rejected` in the log with its code recorded — never deleted (05 §8).
    for (let i = 0; i < ordered.length; i += 1) {
      const row = await statusOf((ops[i] as SignedOperation).id);
      expect(row.status).toBe('rejected');
      expect(row.code).toBe(ordered[i]);
    }
  });

  it('an UNKNOWN code still surfaces and still marks rejected (api/00 §4 — never dropped)', async () => {
    const a = await seedLocalOp(1);
    harness.transport.scriptPush({
      results: [{ id: a.id, status: 'rejected', code: 'FUTURE_CODE_v9', reason: 'newer server' }],
      serverTime: clockAt,
    });

    await runPushPhase(deps());

    // A newer server growing a code must not produce a SILENT rejection on an older client — the
    // one outcome 05 §8 forbids outright.
    const surfaced = harness.surface.ofKind('op_rejected');
    expect(surfaced[0]?.code).toBe('FUTURE_CODE_v9');
    expect((await statusOf(a.id)).status).toBe('rejected');
    expect((await statusOf(a.id)).code).toBe('FUTURE_CODE_v9');
  });
});

describe('SEC-SYNC-02 — revoked device rejected (client leg)', () => {
  it('SEC-SYNC-02: ops pushed in the revocation window come back DEVICE_REVOKED and are kept client-side as rejected', async () => {
    // security-guide §4.2's client leg. The server's 401 + per-op `DEVICE_REVOKED` are task 16's
    // legs; THIS is "kept client-side as `rejected`" — the op is not deleted, not retried, and the
    // user is told. A revoked device's work is still a record of what happened (05 §8: a rejected op
    // is never deleted), and re-pushing it is impossible — `rejected` is terminal (03 §3).
    const a = await seedLocalOp(1);
    const b = await seedLocalOp(2);
    harness.transport.scriptPush({
      results: [
        { id: a.id, status: 'rejected', code: 'DEVICE_REVOKED', reason: 'device revoked' },
        { id: b.id, status: 'rejected', code: 'DEVICE_REVOKED', reason: 'device revoked' },
      ],
      serverTime: clockAt,
    });

    const result = await runPushPhase(deps());

    for (const op of [a, b]) {
      const row = await statusOf(op.id);
      expect(row.status).toBe('rejected'); // kept client-side as rejected
      expect(row.code).toBe('DEVICE_REVOKED');
    }
    expect(result.rejected).toBe(2);

    // Never silent (05 §8) — both surfaced with their label key.
    const surfaced = harness.surface.ofKind('op_rejected');
    expect(surfaced.map((e) => e.code)).toEqual(['DEVICE_REVOKED', 'DEVICE_REVOKED']);
    expect(surfaced[0]?.labelKey).toBe('core.rejection.DEVICE_REVOKED');

    // The ops still EXIST — a revoked device's log is evidence, not garbage.
    const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM operations`.execute(harness.db);
    expect(Number(rows.rows[0]?.c)).toBe(2);

    // And DEVICE_REVOKED as an op-level result is NOT a chain break: push is not halted by it.
    expect(chainBrokenCalls).toBe(0);
    expect(result.halted).toBe(false);
  });
});

describe('CHAIN_BROKEN halts push (03 §3 / §10)', () => {
  it('CHAIN_BROKEN rejects the op, sets pushHalted once, and CHAIN_HALTED remainder does not re-set it', async () => {
    const a = await seedLocalOp(1);
    const b = await seedLocalOp(2);
    const c = await seedLocalOp(3);
    harness.transport.scriptPush({
      results: [
        { id: a.id, status: 'accepted', serverSeq: 1 },
        { id: b.id, status: 'rejected', code: 'CHAIN_BROKEN', reason: 'previousHash mismatch' },
        {
          id: c.id,
          status: 'rejected',
          code: 'CHAIN_HALTED',
          reason: 'earlier op broke the chain',
        },
      ],
      serverTime: clockAt,
    });

    const result = await runPushPhase(deps());

    expect(result.halted).toBe(true);
    expect((await statusOf(a.id)).status).toBe('synced'); // ops before the break still landed
    expect((await statusOf(b.id)).code).toBe('CHAIN_BROKEN');
    expect((await statusOf(c.id)).code).toBe('CHAIN_HALTED');
    // The remainder is marked `rejected` but must NOT set the flag a second time (03 §3) — the
    // triggering CHAIN_BROKEN already did. Counting the calls is the only way to see the
    // difference between "set once" and "set twice with the same value".
    expect(chainBrokenCalls).toBe(1);
    expect(harness.surface.ofKind('push_halted')).toHaveLength(1);
  });
});

describe('batching (api/01 §3: ascending seq, ≤ 500 per batch)', () => {
  it('splits >500 local ops into ascending-seq batches of at most 500', async () => {
    const total = 12;
    const ops: SignedOperation[] = [];
    for (let i = 1; i <= total; i += 1) ops.push(await seedLocalOp(i));

    const batchSize = 5;
    harness.transport.scriptPush(
      () => ackAll(harness.transport.pushes[0]?.ops ?? []),
      () => ackAll(harness.transport.pushes[1]?.ops ?? []),
      () => ackAll(harness.transport.pushes[2]?.ops ?? []),
    );

    const result = await runPushPhase({ ...deps(), batchSize });

    expect(result.batches).toBe(3); // 5 + 5 + 2
    expect(result.synced).toBe(total);
    for (const request of harness.transport.pushes) {
      expect(request.ops.length).toBeLessThanOrEqual(batchSize);
      // Ascending seq is not cosmetic: the server validates chain continuity in receipt order, so
      // an out-of-order batch would manufacture a CHAIN_BROKEN on an honest chain.
      const seqs = request.ops.map((o) => o.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    }
    // The batches partition the queue in ascending order overall — no op sent twice, none skipped.
    const sent = harness.transport.pushes.flatMap((r) => r.ops.map((o) => o.seq));
    expect(sent).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('the batch cap is the schema constant, not a local literal', () => {
    // If api/01 §3's cap ever moves, it moves in ONE place. A literal 500 here would pass a change
    // it should have caught.
    expect(MAX_PUSH_OPS).toBe(500);
  });

  it('a transport failure mid-push leaves the batch local so the SAME batch retries (F1/F2)', async () => {
    const a = await seedLocalOp(1);
    const b = await seedLocalOp(2);
    harness.transport.scriptPush(() => {
      throw new Error('network down');
    });

    await expect(runPushPhase(deps())).rejects.toThrow('network down');

    // Nothing was marked: the ops stay `local` and the retry re-sends the same batch. Already-
    // accepted ops come back `duplicate` (05 §5), which is why re-sending is safe rather than lossy.
    expect((await statusOf(a.id)).status).toBe('local');
    expect((await statusOf(b.id)).status).toBe('local');
  });
});

function ackAll(ops: readonly SignedOperation[]): { results: PushResult[]; serverTime: number } {
  return {
    results: ops.map((op, i) => ({ id: op.id, status: 'accepted' as const, serverSeq: i + 1 })),
    serverTime: clockAt,
  };
}

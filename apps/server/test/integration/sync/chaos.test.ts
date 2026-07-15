// CHAOS-01..05 — the SERVER legs, in-process (testing-guide §3.1 server half: production app.fetch
// over PGlite, seeded tenant/stores/devices, real signed chains + raw tamper payloads). The full
// multi-device convergence versions (client digests, arrival-order permutations, the sync loop's
// resume) are task 26's `@bolusi/harness`; the fixture helpers here (makeSyncHarness + the tamper
// builders) are structured for it to reuse.
import { breakPreviousHash, makeWorld, mutatePayloadPostHash, resign } from '@bolusi/test-support';
import type { PullResponse, PushResponse, SignedOperation } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/index.js';
import { readError } from '../../helpers/http.js';
import { makeSyncHarness, type SeededDevice, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const H72 = 72 * 60 * 60 * 1000;
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const WRONG_HASH = 'b'.repeat(64);
const note = (title: string, body: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body },
});
async function pushJson(res: Response): Promise<PushResponse> {
  return (await res.json()) as PushResponse;
}
async function pullJson(res: Response): Promise<PullResponse> {
  return (await res.json()) as PullResponse;
}
/** Every op row in the log, ascending by serverSeq (owner handle — bypasses RLS on purpose). */
async function logRows() {
  return h.db
    .selectFrom('operations')
    .select(['id', 'deviceId', 'seq', 'serverSeq', 'clockSkewFlagged'])
    .orderBy('serverSeq')
    .execute();
}

describe('CHAOS-01 interleaved multi-device push arrival (server leg)', () => {
  test('CHAOS-01 three devices pushing interleaved → server log complete, per-device seq order enforced, serverSeq gapless', async () => {
    const a = await h.seedDevice(114);
    const b = await h.seedDevice(115);
    const c = await h.seedDevice(116);

    const chains: { dev: SeededDevice; ops: SignedOperation[] }[] = [a, b, c].map((dev) => ({
      dev,
      ops: [
        dev.builder.genesis(),
        ...Array.from({ length: 5 }, (_, i) => dev.builder.append(note(`t${i}`, `b${i}`))),
      ],
    }));

    // Interleave ARRIVAL across devices in batches of 2 — each device still pushes its own ops in
    // seq order (the per-device chain requires it); the interleaving is between devices.
    for (let offset = 0; offset < 6; offset += 2) {
      for (const { dev, ops } of chains) {
        const res = await pushJson(
          await h.push(dev.auth, dev.world.deviceId, ops.slice(offset, offset + 2)),
        );
        expect(res.results.every((r) => r.status === 'accepted')).toBe(true);
      }
    }

    // Server log complete: every op of every device landed.
    const rows = await logRows();
    expect(rows).toHaveLength(18);
    for (const { dev } of chains) {
      const mine = rows.filter((r) => r.deviceId === dev.world.deviceId);
      // Per-device seq order enforced: contiguous 1..6 in ascending serverSeq order.
      expect(mine.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5, 6]);
    }
    // Per-tenant serverSeq is gapless (each device is its own tenant here → each stream is 1..6).
    for (const { dev } of chains) {
      const mine = rows.filter((r) => r.deviceId === dev.world.deviceId);
      expect(mine.map((r) => Number(r.serverSeq))).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });
});

describe('CHAOS-02 F2 lost-response retry at every batch boundary (server leg)', () => {
  test('CHAOS-02 re-pushing each acknowledged batch → all duplicate, op count exact, no re-insert', async () => {
    const dev = await h.seedDevice(120);
    const all = [
      dev.builder.genesis(),
      ...Array.from({ length: 7 }, (_, i) => dev.builder.append(note(`n${i}`, `v${i}`))),
    ];
    const batches = [all.slice(0, 3), all.slice(3, 6), all.slice(6, 8)];

    for (const batch of batches) {
      // The batch is processed fully…
      const first = await pushJson(await h.push(dev.auth, dev.world.deviceId, batch));
      expect(first.results.every((r) => r.status === 'accepted')).toBe(true);
      const snapshot = await logRows();

      // …and its RESPONSE IS LOST (F2): the client retries the identical batch.
      const retry = await pushJson(await h.push(dev.auth, dev.world.deviceId, batch));
      expect(retry.results.every((r) => r.status === 'duplicate')).toBe(true);

      // No re-insert, no serverSeq consumed: the log is byte-identical across the retry.
      expect(await logRows()).toEqual(snapshot);
    }

    const rows = await logRows();
    expect(rows).toHaveLength(all.length); // op count exact — no loss, no dupes
    expect(rows.map((r) => Number(r.serverSeq))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // gapless
  });
});

describe('CHAOS-03 incremental pull (server leg)', () => {
  test('CHAOS-03 a pull from a cursor transfers ONLY the missing ops; the ≤500 page cap holds', async () => {
    const dev = await h.seedDevice(130);
    const ops = [
      dev.builder.genesis(),
      ...Array.from({ length: 9 }, (_, i) => dev.builder.append(note(`n${i}`, `v${i}`))),
    ];
    await h.push(dev.auth, dev.world.deviceId, ops); // serverSeq 1..10

    // A device that already holds through serverSeq 6 re-syncs: it must receive 7..10 and nothing
    // else — no re-download of the world (FR-1123 incremental).
    const incremental = await pullJson(
      await h.pull(dev.auth, { cursor: 6, devicesDirectoryVersion: 999 }),
    );
    expect(incremental.ops).toHaveLength(4);
    expect(incremental.hasMore).toBe(false);
    expect(incremental.nextCursor).toBe(10);

    // Batching: a page never exceeds the requested limit, and the loop drains without gap/overlap.
    let cursor = 0;
    const seen: SignedOperation[] = [];
    for (;;) {
      const page = await pullJson(
        await h.pull(dev.auth, { cursor, limit: 3, devicesDirectoryVersion: 999 }),
      );
      expect(page.ops.length).toBeLessThanOrEqual(3);
      seen.push(...page.ops);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(seen).toHaveLength(10);
    expect(new Set(seen.map((o) => o.id)).size).toBe(10); // no overlap
  });
});

describe('CHAOS-04 clock skew (server leg, 05 §6)', () => {
  test('CHAOS-04 ±72h skewed ops are ACCEPTED and clockSkewFlagged; skew reaches no rejection path', async () => {
    const now = h.clock.now();

    // Recently-synced devices (threshold ≈ 48h): the genesis push sets lastSyncAt = now.
    const a = await h.seedDevice(140); // clock +72h
    const b = await h.seedDevice(141); // clock −72h
    const d = await h.seedDevice(142); // honest
    for (const dev of [a, b, d]) {
      await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis({ timestamp: now - 1_000 })]);
    }

    const aSkew = a.builder.append({ ...note('future', 'op'), timestamp: now + H72 });
    const bSkew = b.builder.append({ ...note('past', 'op'), timestamp: now - H72 });
    const dHonest = d.builder.append({ ...note('honest', 'op'), timestamp: now - 1_000 });

    const aRes = await pushJson(await h.push(a.auth, a.world.deviceId, [aSkew]));
    const bRes = await pushJson(await h.push(b.auth, b.world.deviceId, [bSkew]));
    const dRes = await pushJson(await h.push(d.auth, d.world.deviceId, [dHonest]));
    // NEVER rejected — the timestamp is the device's honest belief (05 §6).
    expect(aRes.results[0]?.status).toBe('accepted');
    expect(bRes.results[0]?.status).toBe('accepted');
    expect(dRes.results[0]?.status).toBe('accepted');

    const rows = await logRows();
    const flagOf = (opId: string) => rows.find((r) => r.id === opId)?.clockSkewFlagged;
    expect(flagOf(aSkew.id)).toBe(true); // +72h beyond the 48h window → flagged
    expect(flagOf(bSkew.id)).toBe(true); // −72h likewise (absolute difference)
    expect(flagOf(dHonest.id)).toBe(false); // honest device unflagged

    // A device legitimately offline for 5 days carries old timestamps: the window grows with the
    // offline gap (48h + 120h), so its 72h-old op is NOT flagged.
    const c = await h.seedDevice(143);
    await h.push(c.auth, c.world.deviceId, [c.builder.genesis({ timestamp: now - 1_000 })]);
    await h.db
      .updateTable('devices')
      .set({ lastSyncAt: BigInt(now - 120 * 60 * 60 * 1000) })
      .where('id', '=', c.world.deviceId)
      .execute();
    const cOp = c.builder.append({ ...note('offline', 'op'), timestamp: now - H72 });
    expect((await pushJson(await h.push(c.auth, c.world.deviceId, [cOp]))).results[0]?.status).toBe(
      'accepted',
    );
    expect((await logRows()).find((r) => r.id === cOp.id)?.clockSkewFlagged).toBe(false);
  });
});

describe('CHAOS-05 tampered chain / rejection matrix T1–T9 (05 §8, api/01 §3)', () => {
  test('CHAOS-05 T1 payload modified post-hash → BAD_SIGNATURE', async () => {
    const dev = await h.seedDevice(150);
    const genesis = dev.builder.genesis();
    const good = dev.builder.append(note('a', 'b'));
    const t1 = mutatePayloadPostHash(good);
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, t1]));
    expect(body.results[0]?.status).toBe('accepted'); // positive control
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
    expect((await logRows()).some((r) => r.id === t1.id)).toBe(false); // absent from the log
  });

  test('CHAOS-05 T2 re-signed with a non-enrolled key → BAD_SIGNATURE', async () => {
    const dev = await h.seedDevice(151);
    const foreignKey = makeWorld(999, serverCryptoPort).secretKey;
    const genesis = dev.builder.genesis();
    const good = dev.builder.append(note('a', 'b'));
    const t2 = resign(
      { ...good, payload: { title: 'x', body: 'y' } },
      foreignKey,
      serverCryptoPort,
    );
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, t2]));
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
    expect((await logRows()).some((r) => r.id === t2.id)).toBe(false);
  });

  test('CHAOS-05 T3 wrong previousHash → CHAIN_BROKEN, batch remainder CHAIN_HALTED', async () => {
    const dev = await h.seedDevice(152);
    const genesis = dev.builder.genesis();
    const op2 = dev.builder.append(note('a', 'b'));
    const op3 = dev.builder.append(note('c', 'd'));
    const t3 = breakPreviousHash(op2, WRONG_HASH, dev.world.secretKey, serverCryptoPort);
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, t3, op3]));
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
    expect(body.results[2]).toMatchObject({ status: 'rejected', code: 'CHAIN_HALTED' });
    const rows = await logRows();
    expect(rows.some((r) => r.id === t3.id)).toBe(false);
    expect(rows.some((r) => r.id === op3.id)).toBe(false);
  });

  test('CHAOS-05 T4 two ops’ seq swapped (reorder) → first out-of-order op CHAIN_BROKEN', async () => {
    const dev = await h.seedDevice(153);
    const genesis = dev.builder.genesis(); // seq 1
    const opA = dev.builder.append(note('a', 'b')); // seq 2, previousHash = genesis.hash
    const opB = dev.builder.append(note('c', 'd')); // seq 3, previousHash = opA.hash
    // Swap the seq values and re-sign: B now claims seq 2 while still linking to A's hash.
    const bAsSeq2 = resign({ ...opB, seq: 2 }, dev.world.secretKey, serverCryptoPort);
    const aAsSeq3 = resign({ ...opA, seq: 3 }, dev.world.secretKey, serverCryptoPort);
    const body = await pushJson(
      await h.push(dev.auth, dev.world.deviceId, [genesis, bAsSeq2, aAsSeq3]),
    );
    expect(body.results[0]?.status).toBe('accepted');
    // seq 2 is the expected next, but its previousHash links to A, not to the genesis → tamper.
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
    expect(body.results[2]).toMatchObject({ status: 'rejected', code: 'CHAIN_HALTED' });
    const rows = await logRows();
    expect(rows.some((r) => r.id === bAsSeq2.id || r.id === aAsSeq3.id)).toBe(false);
  });

  test('CHAOS-05 T5 seq skips ahead → CHAIN_GAP, and re-pushing from the gap is accepted (not an error state)', async () => {
    const dev = await h.seedDevice(154);
    const genesis = dev.builder.genesis(); // seq 1
    const op2 = dev.builder.append(note('a', 'b')); // seq 2 — withheld to create the gap
    const op3 = dev.builder.append(note('c', 'd')); // seq 3

    await h.push(dev.auth, dev.world.deviceId, [genesis]);
    const gap = await pushJson(await h.push(dev.auth, dev.world.deviceId, [op3]));
    expect(gap.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_GAP' });
    expect((await logRows()).some((r) => r.id === op3.id)).toBe(false);

    // The client re-pushes from the gap: all ops eventually accepted (05 §8 — not an error state).
    const resend = await pushJson(await h.push(dev.auth, dev.world.deviceId, [op2, op3]));
    expect(resend.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  test('CHAOS-05 T6 another tenant’s tenantId, correctly signed → SCOPE_VIOLATION', async () => {
    const dev = await h.seedDevice(155);
    const genesis = dev.builder.genesis();
    const good = dev.builder.append(note('a', 'b'));
    const t6 = resign({ ...good, tenantId: FOREIGN_TENANT }, dev.world.secretKey, serverCryptoPort);
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, t6]));
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
    expect((await logRows()).some((r) => r.id === t6.id)).toBe(false);
  });

  test('CHAOS-05 T7 push from a revoked device → HTTP 401 DEVICE_REVOKED', async () => {
    const dev = await h.seedDevice(156, { deviceStatus: 'revoked' });
    const res = await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]);
    expect(res.status).toBe(401);
    expect((await readError(res)).error.code).toBe('DEVICE_REVOKED');
    expect(await logRows()).toHaveLength(0);
  });

  test('CHAOS-05 T8 payload violating the registry schema → SCHEMA_INVALID', async () => {
    const dev = await h.seedDevice(157);
    const genesis = dev.builder.genesis();
    // notes.note_created requires {title, body}; omit `title` and sign correctly.
    const t8 = dev.builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      payload: { body: 'no title' },
    });
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, t8]));
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'SCHEMA_INVALID' });
    expect((await logRows()).some((r) => r.id === t8.id)).toBe(false);
  });

  test('CHAOS-05 T9 type absent from the server registry → UNKNOWN_TYPE', async () => {
    const dev = await h.seedDevice(158);
    const genesis = dev.builder.genesis();
    const t9 = dev.builder.append({ type: 'ghost.module_event', entityType: 'ghost', payload: {} });
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, t9]));
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_TYPE' });
    expect((await logRows()).some((r) => r.id === t9.id)).toBe(false);
  });

  test('CHAOS-05 rejected ops never appear in another device’s pull', async () => {
    const a = await h.seedDevice(159);
    const peer = await h.seedDeviceIn(a.world.tenantId, a.world.storeId, 160);

    const genesis = a.builder.genesis();
    const good = a.builder.append(note('real', 'op'));
    const tampered = mutatePayloadPostHash(a.builder.append(note('tampered', 'op')));
    const body = await pushJson(await h.push(a.auth, a.world.deviceId, [genesis, good, tampered]));
    expect(body.results[2]?.status).toBe('rejected');

    // The peer (same tenant + store) drains its pull: it sees the accepted ops and NOT the rejected
    // one — a rejection is never observable to anybody else.
    const pulled = await pullJson(
      await h.pull(peer.auth, { cursor: 0, devicesDirectoryVersion: 999 }),
    );
    const ids = pulled.ops.map((o) => o.id);
    expect(ids).toContain(genesis.id); // positive control: the accepted ops DID travel
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(tampered.id);
  });
});

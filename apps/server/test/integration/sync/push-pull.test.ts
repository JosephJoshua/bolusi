// Push/pull behaviour + pagination + poke (api/01-sync §3–4; task 16 acceptance "Push behaviour",
// "Pull pagination boundary", "Poke hook"). The real app.fetch + task-07 pipeline over real PG16.
import { verifyOp } from '@bolusi/core';
import type { PullResponse, PushResponse, SignedOperation } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness, type SeededDevice, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

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

/** Push a fresh device's genesis + `count` notes; returns the accepted ops in seq order. */
async function seedAcceptedOps(dev: SeededDevice, count: number): Promise<SignedOperation[]> {
  const ops = [
    dev.builder.genesis(),
    ...Array.from({ length: count }, (_, i) => dev.builder.append(note(`t${i}`, `b${i}`))),
  ];
  const res = await h.push(dev.auth, dev.world.deviceId, ops);
  expect(res.status).toBe(200);
  const body = await pushJson(res);
  expect(body.results.every((r) => r.status === 'accepted')).toBe(true);
  return ops;
}

describe('push happy path', () => {
  test('genesis + notes all accepted, ascending serverSeq, integer-ms serverTime', async () => {
    const dev = await h.seedDevice(1);
    const ops = [
      dev.builder.genesis(),
      dev.builder.append(note('a', 'b')),
      dev.builder.append(note('c', 'd')),
    ];
    const res = await h.push(dev.auth, dev.world.deviceId, ops);
    expect(res.status).toBe(200);
    const body = await pushJson(res);
    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(body.results.map((r) => r.serverSeq)).toEqual([1, 2, 3]);
    expect(Number.isInteger(body.serverTime)).toBe(true);
  });

  test('all-rejected batch still returns HTTP 200 (api/00 §6 — HTTP errors ≠ op rejections)', async () => {
    const dev = await h.seedDevice(2);
    // An unknown op type is rejected UNKNOWN_TYPE (registry miss), but the request transported fine.
    const bad = dev.builder.append({ type: 'nonexistent.type', entityType: 'x', payload: {} });
    const res = await h.push(dev.auth, dev.world.deviceId, [bad]);
    expect(res.status).toBe(200);
    const body = await pushJson(res);
    expect(body.results[0]?.status).toBe('rejected');
  });

  test('Idempotency-Key header on push is ignored (no 422, no replay) — api/00 §8.1', async () => {
    const dev = await h.seedDevice(3);
    const ops = [dev.builder.genesis()];
    const res = await h.app.request('http://srv.test/v1/sync/push', {
      method: 'POST',
      headers: {
        Authorization: dev.auth,
        'Content-Type': 'application/json',
        'Idempotency-Key': '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      },
      body: JSON.stringify({ deviceId: dev.world.deviceId, ops }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Idempotent-Replay')).toBeNull();
    const body = await pushJson(res);
    expect(body.results[0]?.status).toBe('accepted');
  });
});

describe('pull pagination boundaries (api/01-sync §4)', () => {
  test('cursor 0 returns from genesis; ops ascend by serverSeq; nextCursor = last serverSeq', async () => {
    const dev = await h.seedDevice(4);
    await seedAcceptedOps(dev, 2); // genesis + 2 notes = serverSeq 1..3
    const res = await h.pull(dev.auth, { cursor: 0, devicesDirectoryVersion: 0 });
    expect(res.status).toBe(200);
    const body = await pullJson(res);
    expect(body.ops.length).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBe(3);
  });

  test('exact-limit page with more remaining → hasMore true, nextCursor = last of page', async () => {
    const dev = await h.seedDevice(5);
    await seedAcceptedOps(dev, 4); // serverSeq 1..5
    const first = await pullJson(
      await h.pull(dev.auth, { cursor: 0, limit: 2, devicesDirectoryVersion: 999 }),
    );
    expect(first.ops.length).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(2);

    // Resume verbatim: no gap, no overlap, ascending.
    const second = await pullJson(
      await h.pull(dev.auth, { cursor: first.nextCursor, limit: 2, devicesDirectoryVersion: 999 }),
    );
    expect(second.ops.length).toBe(2);
    expect(second.hasMore).toBe(true);
    expect(second.nextCursor).toBe(4);

    const third = await pullJson(
      await h.pull(dev.auth, { cursor: second.nextCursor, limit: 2, devicesDirectoryVersion: 999 }),
    );
    expect(third.ops.length).toBe(1);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBe(5);
  });

  test('cursor at head → empty ops, hasMore false, nextCursor echoes the cursor', async () => {
    const dev = await h.seedDevice(6);
    await seedAcceptedOps(dev, 1); // serverSeq 1..2
    const body = await pullJson(
      await h.pull(dev.auth, { cursor: 2, devicesDirectoryVersion: 999 }),
    );
    expect(body.ops).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBe(2);
  });

  test('limit > 500 rejected by schema (422), before the handler runs', async () => {
    const dev = await h.seedDevice(7);
    const res = await h.pull(dev.auth, { cursor: 0, limit: 501, devicesDirectoryVersion: 0 });
    expect(res.status).toBe(422);
  });

  test('served op re-canonicalizes and its signature verifies (verbatim JCS round-trip)', async () => {
    const dev = await h.seedDevice(8);
    await seedAcceptedOps(dev, 1);
    const body = await pullJson(
      await h.pull(dev.auth, { cursor: 0, devicesDirectoryVersion: 999 }),
    );
    for (const op of body.ops) {
      expect(verifyOp(op, dev.world.publicKey, serverCryptoPort)).toBe(true);
    }
  });
});

describe('poke hook (api/00 §12.1; api/01-sync §4.1)', () => {
  test('push with ≥1 accepted op delivers one poke scoped to the ops pull scope', async () => {
    const dev = await h.seedDevice(9);
    await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]);
    expect(h.pokes).toEqual([{ tenantId: dev.world.tenantId, storeId: dev.world.storeId }]);
  });

  test('all-rejected push delivers no poke', async () => {
    const dev = await h.seedDevice(10);
    const bad = dev.builder.append({ type: 'nonexistent.type', entityType: 'x', payload: {} });
    await h.push(dev.auth, dev.world.deviceId, [bad]);
    expect(h.pokes).toEqual([]);
  });

  test('all-duplicate replay delivers no poke', async () => {
    const dev = await h.seedDevice(11);
    const ops = [dev.builder.genesis()];
    await h.push(dev.auth, dev.world.deviceId, ops); // accepted → one poke
    h.pokes.length = 0;
    await h.push(dev.auth, dev.world.deviceId, ops); // replay → all duplicate → no poke
    expect(h.pokes).toEqual([]);
  });
});

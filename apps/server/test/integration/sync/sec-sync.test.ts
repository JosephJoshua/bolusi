// Named sync-endpoint adversarial tests that require the REAL push/pull pipeline (security-guide
// §4.2). Titles embed the SEC id verbatim (SEC-META-01 greps them). The transport-only legs
// (SEC-SYNC-01/04/08/10 — unauthenticated, gzip bomb, truncated, wrong-encoding) run against the
// stub-independent middleware chain in test/integration/sec-sync.test.ts; the ids that need op
// acceptance (02/03/05/06/07/09) live here. Every deny carries a POSITIVE control so a broken
// fixture cannot masquerade as a passing security test (T-14b).
import { gzipSync } from 'node:zlib';

import { resign } from '@bolusi/test-support';
import type { PullResponse, PushResponse, SignedOperation } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/index.js';
import { readError } from '../../helpers/http.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const PUSH = 'http://srv.test/v1/sync/push';
const FOREIGN_TENANT = '11111111-1111-4111-8111-111111111111';
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
function gzipReq(url: string, body: Uint8Array, auth: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    body,
  });
}

// ── Revoked-device SERVER legs — the id is DELIBERATELY ABSENT from these titles ──────────────
//
// The surface id is SEC-SYNC-02 (security-guide §4.2), but it has TWO legs: the 401 +
// DEVICE_REVOKED half proven here, and a CLIENT half — "ops pushed in the same window →
// DEVICE_REVOKED, kept client-side as `rejected`" (security-guide.md:99) — which lands with
// task 15's sync loop, not here.
//
// SEC-META-01 counts an id as shipped when a test TITLE contains it verbatim (`title.includes(id)`)
// — it cannot read this comment (proved by sec-meta.test.ts:49). So a verbatim title here would
// mark the id fully shipped, and with its allowlist row gone the client-side `rejected`
// persistence requirement would be invisible forever (task 28 requires the allowlist EMPTY, so it
// could never come back). Naming the id correctly in a test that covers half of it is how a real
// security requirement gets quietly retired.
//
// So: titles carry no id, and the pending-allowlist row (SEC-SYNC-02 → ai-docs/tasks/15-sync-client.md)
// is what keeps the outstanding leg visible. Do not "tidy" the id back into these titles.
describe('revoked device rejected (server legs — see the comment above for the surface id)', () => {
  test('a revoked device token → 401 DEVICE_REVOKED on push and pull', async () => {
    const revoked = await h.seedDevice(50, { deviceStatus: 'revoked' });
    const pushRes = await h.push(revoked.auth, revoked.world.deviceId, [revoked.builder.genesis()]);
    expect(pushRes.status).toBe(401);
    expect((await readError(pushRes)).error.code).toBe('DEVICE_REVOKED');
    const pullRes = await h.pull(revoked.auth, { cursor: 0, devicesDirectoryVersion: 0 });
    expect(pullRes.status).toBe(401);
    expect((await readError(pullRes)).error.code).toBe('DEVICE_REVOKED');
  });

  test('positive control: an active device pushes successfully', async () => {
    const active = await h.seedDevice(51);
    const res = await h.push(active.auth, active.world.deviceId, [active.builder.genesis()]);
    expect(res.status).toBe(200);
    expect((await pushJson(res)).results[0]?.status).toBe('accepted');
  });
});

describe('SEC-SYNC-03 cross-tenant op claim', () => {
  test('SEC-SYNC-03 a foreign-tenant op → SCOPE_VIOLATION; sibling valid ops unaffected', async () => {
    const dev = await h.seedDevice(52);
    const genesis = dev.builder.genesis(); // seq 1, tenant A
    const note1 = dev.builder.append(note('a', 'b')); // seq 2, tenant A
    const foreign = resign(
      { ...note1, tenantId: FOREIGN_TENANT },
      dev.world.secretKey,
      serverCryptoPort,
    );
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, foreign]));
    expect(body.results[0]).toMatchObject({ status: 'accepted' }); // sibling unaffected
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });
});

describe('SEC-SYNC-05 oversized batch rejected before any op is processed', () => {
  test('SEC-SYNC-05 501 ops → 422 at the schema, handler never runs', async () => {
    const dev = await h.seedDevice(53);
    const ops = Array.from({ length: 501 }, () => dev.builder.genesis());
    const res = await h.push(dev.auth, dev.world.deviceId, ops);
    expect(res.status).toBe(422); // zPushRequest.max(500) — structural, before the pipeline
    expect(h.stubCalls).not.toContain('sync.push');
    // No op reached the log.
    const rows = await h.db.selectFrom('operations').select('id').execute();
    expect(rows).toHaveLength(0);
  });

  test('SEC-SYNC-05 > 1 MiB wire body → 413 BODY_TOO_LARGE before decompression', async () => {
    const dev = await h.seedDevice(54);
    const oversized = Buffer.alloc(1024 * 1024 + 1024, 0x41); // > 1 MiB wire cap
    const res = await h.app.request(gzipReq(PUSH, oversized, dev.auth));
    expect(res.status).toBe(413);
    expect((await readError(res)).error.code).toBe('BODY_TOO_LARGE');
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('SEC-SYNC-05 positive control: a ≤ 500-op batch is accepted', async () => {
    const dev = await h.seedDevice(55);
    const res = await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]);
    expect((await pushJson(res)).results[0]?.status).toBe('accepted');
  });
});

describe('SEC-SYNC-06 malformed JSON after valid gzip', () => {
  test('SEC-SYNC-06 valid gzip of invalid JSON → 400 MALFORMED_REQUEST, no partial acceptance', async () => {
    const dev = await h.seedDevice(56);
    const res = await h.app.request(
      gzipReq(PUSH, gzipSync(Buffer.from('{ not json', 'utf8')), dev.auth),
    );
    expect(res.status).toBe(400);
    expect((await readError(res)).error.code).toBe('MALFORMED_REQUEST');
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('SEC-SYNC-06 valid gzip of JSON failing the push schema → 422, no crash', async () => {
    const dev = await h.seedDevice(57);
    const badSchema = gzipSync(
      Buffer.from(JSON.stringify({ deviceId: 'not-a-uuid', ops: [] }), 'utf8'),
    );
    const res = await h.app.request(gzipReq(PUSH, badSchema, dev.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
    expect(h.stubCalls).not.toContain('sync.push');
  });

  test('SEC-SYNC-06 positive control: valid gzip of a valid push → 200', async () => {
    const dev = await h.seedDevice(58);
    const valid = gzipSync(
      Buffer.from(JSON.stringify({ deviceId: dev.world.deviceId, ops: [] }), 'utf8'),
    );
    const res = await h.app.request(gzipReq(PUSH, valid, dev.auth));
    expect(res.status).toBe(200);
  });
});

describe('SEC-SYNC-07 acknowledged-batch replay idempotent', () => {
  test('SEC-SYNC-07 replaying an acknowledged batch → all duplicate; serverSeq stream unchanged', async () => {
    const dev = await h.seedDevice(59);
    const ops = [dev.builder.genesis(), dev.builder.append(note('a', 'b'))];
    const first = await pushJson(await h.push(dev.auth, dev.world.deviceId, ops));
    expect(first.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    const firstSeqs = first.results.map((r) => r.serverSeq);

    const rowsBefore = await h.db
      .selectFrom('operations')
      .select(['id', 'serverSeq'])
      .orderBy('serverSeq')
      .execute();

    const replay = await pushJson(await h.push(dev.auth, dev.world.deviceId, ops));
    expect(replay.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);

    const rowsAfter = await h.db
      .selectFrom('operations')
      .select(['id', 'serverSeq'])
      .orderBy('serverSeq')
      .execute();
    // No re-insert, no new serverSeq consumed: the log is byte-identical.
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.map((r) => Number(r.serverSeq))).toEqual(firstSeqs);
  });
});

describe('SEC-SYNC-09 pull scope leak probe', () => {
  test('SEC-SYNC-09 store-1 device pulls to exhaustion → only own store + tenant-null ops', async () => {
    const a1 = await h.seedDevice(60); // tenant A, store 1
    const store2 = await h.seedStore(a1.world.tenantId, 61);
    const a2 = await h.seedDeviceIn(a1.world.tenantId, store2, 62); // tenant A, store 2
    const b = await h.seedDevice(63); // tenant B, its own store

    // a1's chain: genesis (store 1) → a store-1 note → a TENANT-NULL op (storeId explicitly null).
    const g = a1.builder.genesis();
    const s1note = a1.builder.append(note('store', 'one'));
    const tenantNull = a1.builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      payload: { title: 'tenant', body: 'wide' },
      storeId: null,
    });
    const a1push = await pushJson(
      await h.push(a1.auth, a1.world.deviceId, [g, s1note, tenantNull]),
    );
    expect(a1push.results.every((r) => r.status === 'accepted')).toBe(true);

    // a2 (store 2) + b (tenant B) each push a genesis + note — the foreign data a1 must NOT see.
    await h.push(a2.auth, a2.world.deviceId, [
      a2.builder.genesis(),
      a2.builder.append(note('store', 'two')),
    ]);
    await h.push(b.auth, b.world.deviceId, [
      b.builder.genesis(),
      b.builder.append(note('other', 'tenant')),
    ]);

    // a1 pulls to exhaustion.
    let cursor = 0;
    const pulled: SignedOperation[] = [];
    for (;;) {
      const body = await pullJson(
        await h.pull(a1.auth, { cursor, limit: 2, devicesDirectoryVersion: 999 }),
      );
      pulled.push(...body.ops);
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }

    // Every pulled op is tenant A and in scope (store 1 or tenant-null). Zero store-2, zero tenant-B.
    for (const op of pulled) {
      expect(op.tenantId).toBe(a1.world.tenantId);
      expect([a1.world.storeId, null]).toContain(op.storeId);
    }
    expect(pulled.some((op) => op.storeId === null)).toBe(true); // tenant-null ops present
    expect(pulled.some((op) => op.storeId === store2)).toBe(false); // zero store-2
    expect(pulled.length).toBe(3); // genesis + store-1 note + tenant-null note, and nothing else
  });
});

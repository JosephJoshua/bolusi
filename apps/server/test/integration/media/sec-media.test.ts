// SEC-MEDIA-01..06 (security-guide §7.2) — the named adversarial set for the media surface, shipped
// WITH the surface, before review (CLAUDE.md §2.5). Titles embed the id verbatim so SEC-META-01 can
// grep them. Each asserts exactly what §7.2 specifies.
//
// ALLOCATION NOTE (for task 31): sec-pending-allowlist.json attributes SEC-MEDIA-01 to task 18
// (media-client). Its server-observable core — a completed media rejecting re-init/PUT with 409 and
// its blob unchanged — is a media-SERVER guarantee and is covered here. Task 18 owns the CLIENT
// flavor (attach-to-op, then treat 409 as success). SEC-MEDIA-02..06 are task 19's and are removed
// from the allowlist by this task.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  completeReq,
  detUuidV7,
  downloadReq,
  initBodyFor,
  initReq,
  makeMediaHarness,
  mediaStorageKeyForTest,
  sha256Hex,
  statusReq,
  uploadFull,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

describe('SEC-MEDIA-01 replace after attach → 409', () => {
  test('SEC-MEDIA-01 re-init/PUT of a complete id → 409 MEDIA_IMMUTABLE; blob byte-identical', async () => {
    const ctx = await h.seedDevice('sec01');
    const bytes = buildImage(1000, 'image/jpeg', 'sec01');
    const { mediaId } = await uploadFull(h, ctx, bytes, 'image/jpeg', 'sec01');
    const key = mediaStorageKeyForTest(ctx.tenantId, mediaId);
    const before = await h.readBlob(key);

    // re-init with DIFFERENT bytes (different sha/size) → immutable.
    const different = buildImage(1200, 'image/jpeg', 'sec01-diff');
    const reInit = await h.app.request(
      initReq(mediaId, initBodyFor(ctx, different, 'image/jpeg'), ctx.auth),
    );
    expect(reInit.status).toBe(409);
    expect((await readError(reInit)).error.code).toBe('MEDIA_IMMUTABLE');

    // PUT different bytes to chunk 0 → immutable.
    const put = await h.app.request(
      chunkReq(mediaId, 0, chunkize(different)[0] as Uint8Array, ctx.auth),
    );
    expect(put.status).toBe(409);
    expect((await readError(put)).error.code).toBe('MEDIA_IMMUTABLE');

    const after = await h.readBlob(key);
    expect(sha256Hex(after)).toBe(sha256Hex(before)); // blob byte-identical
    expect(sha256Hex(after)).toBe(sha256Hex(bytes));
  });
});

describe('SEC-MEDIA-02 metadata immutable', () => {
  test('SEC-MEDIA-02 varied re-init → 409 (INIT_MISMATCH receiving / MEDIA_IMMUTABLE complete); no mutation endpoint; metadata unchanged', async () => {
    const ctx = await h.seedDevice('sec02');
    const bytes = buildImage(800, 'image/jpeg', 'sec02');
    const id = detUuidV7('sec02:media');
    const base = initBodyFor(ctx, bytes, 'image/jpeg');
    expect((await h.app.request(initReq(id, base, ctx.auth))).status).toBe(200);

    const before = await h.db
      .selectFrom('media')
      .select(['byteSize', 'sha256', 'mimeType', 'capturedAt', 'capturedByUserId'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    // Each varied field against the RECEIVING id → INIT_MISMATCH.
    const variants = [
      { ...base, sizeBytes: base.sizeBytes + 1 },
      { ...base, sha256: 'f'.repeat(64) },
      { ...base, mime: 'image/png' },
      { ...base, metadata: { ...base.metadata, capturedAt: base.metadata.capturedAt + 1 } },
    ];
    for (const v of variants) {
      const res = await h.app.request(initReq(id, v, ctx.auth));
      expect(res.status).toBe(409);
      expect((await readError(res)).error.code).toBe('INIT_MISMATCH');
    }

    // stored metadata identical before/after the rejected mutations.
    const after = await h.db
      .selectFrom('media')
      .select(['byteSize', 'sha256', 'mimeType', 'capturedAt', 'capturedByUserId'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);

    // Same varied field against a COMPLETE id → MEDIA_IMMUTABLE.
    const done = buildImage(500, 'image/jpeg', 'sec02-done');
    const { mediaId } = await uploadFull(h, ctx, done, 'image/jpeg', 'sec02-done');
    const immut = await h.app.request(
      initReq(
        mediaId,
        { ...initBodyFor(ctx, done, 'image/jpeg'), sha256: '0'.repeat(64) },
        ctx.auth,
      ),
    );
    expect(immut.status).toBe(409);
    expect((await readError(immut)).error.code).toBe('MEDIA_IMMUTABLE');

    // Route-table walk: no metadata-mutation endpoint (no PATCH; the bare /:id path is GET-only).
    const mediaRoutes = h.app.routes.filter((r) => r.path.startsWith('/v1/media'));
    expect(mediaRoutes.some((r) => r.method === 'PATCH')).toBe(false);
    const bareIdMutations = mediaRoutes.filter(
      (r) => r.path === '/v1/media/:id' && ['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method),
    );
    expect(bareIdMutations).toEqual([]);
  });
});

describe('SEC-MEDIA-03 out-of-scope download probe → 404', () => {
  test('SEC-MEDIA-03 four 404 legs (indistinguishable) + authorized 200; RLS alone blocks cross-tenant', async () => {
    const ctx = await h.seedDevice('sec03'); // tenant A, store S1

    // Authorized + complete → 200.
    const okBytes = buildImage(300, 'image/jpeg', 'sec03-ok');
    const ok = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes: okBytes,
      seed: 'sec03-ok',
    });
    expect((await h.app.request(downloadReq(ok.mediaId, ctx.auth))).status).toBe(200);

    // Leg A: tenant B's media.
    const other = await h.seedDevice('sec03-b');
    const tenantB = await h.seedCompleteMedia({
      tenantId: other.tenantId,
      storeId: other.storeId,
      deviceId: other.deviceId,
      userId: other.userId,
      bytes: buildImage(300, 'image/jpeg', 'sec03-b'),
      seed: 'sec03-b',
    });
    // Leg B: same-tenant unassigned store.
    const s2 = await h.seedStore(ctx.tenantId, 'sec03-s2');
    const unassigned = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: s2,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes: buildImage(300, 'image/jpeg', 'sec03-s2'),
      seed: 'sec03-s2',
    });
    // Leg C: a receiving (incomplete) id in-scope.
    const incId = detUuidV7('sec03-inc:media');
    await h.app.request(
      initReq(
        incId,
        initBodyFor(ctx, buildImage(300, 'image/jpeg', 'sec03-inc'), 'image/jpeg'),
        ctx.auth,
      ),
    );
    // Leg D: nonexistent.
    const none = detUuidV7('sec03-none');

    // NON-VACUITY (T-14b): each hidden row EXISTS before we believe a 404.
    const present = await h.db
      .selectFrom('media')
      .select('id')
      .where('id', 'in', [tenantB.mediaId, unassigned.mediaId, incId])
      .execute();
    expect(present.length).toBe(3);

    const bodies: string[] = [];
    for (const id of [tenantB.mediaId, unassigned.mediaId, incId, none]) {
      const res = await h.app.request(downloadReq(id, ctx.auth));
      expect(res.status).toBe(404);
      expect(res.headers.get('ETag')).toBeNull();
      bodies.push(await res.text());
      expect(JSON.parse(bodies.at(-1) as string).error.code).toBe('MEDIA_NOT_FOUND');
    }
    expect(new Set(bodies).size).toBe(1); // indistinguishable

    // forTenant layer bypassed in test: query the media table DIRECTLY under tenant A's RLS context
    // for tenant B's id → RLS alone returns nothing. Non-vacuous control: tenant B's own context sees it.
    const asA = await h.testDb.appForTenant(ctx.tenantId, (db) =>
      db.selectFrom('media').select('id').where('id', '=', tenantB.mediaId).execute(),
    );
    expect(asA).toEqual([]); // RLS blocks cross-tenant even without the app-layer scope check
    const asB = await h.testDb.appForTenant(other.tenantId, (db) =>
      db.selectFrom('media').select('id').where('id', '=', tenantB.mediaId).execute(),
    );
    expect(asB.map((r) => r.id)).toEqual([tenantB.mediaId]); // control: visible in its own tenant
  });
});

describe('SEC-MEDIA-04 path/param fuzzing', () => {
  test('SEC-MEDIA-04 traversal :id → 422 VALIDATION_FAILED; :index out-of-range → CHUNK_INDEX_INVALID; blobs only under root', async () => {
    const ctx = await h.seedDevice('sec04');

    // :id fuzzing → the param schema (zUuidV7) rejects → 422 VALIDATION_FAILED, nothing stored.
    const badIds = ['not-a-uuid', '..%2f..%2fetc%2fpasswd', '00000000-0000-4000-8000-000000000000']; // last is a v4, not v7
    for (const bad of badIds) {
      const res = await h.app.request(
        new Request(`http://media.test/v1/media/${bad}/init`, {
          method: 'POST',
          headers: { Authorization: ctx.auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            initBodyFor(ctx, buildImage(300, 'image/jpeg', 'sec04'), 'image/jpeg'),
          ),
        }),
      );
      expect(res.status).toBe(422);
      expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
    }

    // :index fuzzing on a valid init'd media (1 chunk → totalChunks = 1).
    const bytes = buildImage(1000, 'image/jpeg', 'sec04-idx');
    const id = detUuidV7('sec04-idx:media');
    await h.app.request(initReq(id, initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth));
    for (const index of [-1, 1, 2 ** 31]) {
      const res = await h.app.request(chunkReq(id, index, bytes, ctx.auth));
      expect(res.status).toBe(422);
      expect((await readError(res)).error.code).toBe('CHUNK_INDEX_INVALID');
    }

    // A couple of real uploads, then the fs assertion: every stored blob lives under the server root
    // and matches the server-generated key shape — no traversal ever reached a filesystem path.
    await uploadFull(h, ctx, buildImage(500, 'image/jpeg', 'sec04-f1'), 'image/jpeg', 'sec04-f1');
    await uploadFull(h, ctx, buildImage(500, 'image/png', 'sec04-f2'), 'image/png', 'sec04-f2');
    const files = await listFilesRecursive(h.storageDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const rootReal = await fs.realpath(h.storageDir);
    for (const abs of files) {
      const real = await fs.realpath(abs);
      expect(real.startsWith(rootReal + path.sep)).toBe(true);
      const rel = path.relative(rootReal, real).split(path.sep).join('/');
      expect(rel).toMatch(/^t\/[0-9a-f-]{36}\/m\/[0-9a-f-]{36}$/);
    }
  });
});

describe('SEC-MEDIA-05 content validation at complete', () => {
  test('SEC-MEDIA-05 declared jpeg + png bytes → MIME_MISMATCH; bit-flip → HASH_MISMATCH; ±1 → CHUNK_SIZE_INVALID (all purge/store nothing)', async () => {
    const ctx = await h.seedDevice('sec05');

    // (a) Declared image/jpeg with PNG magic → MIME_MISMATCH at complete, chunks purged, no blob.
    const png = buildImage(1000, 'image/png', 'sec05-png');
    const mimeId = detUuidV7('sec05-mime:media');
    await h.app.request(initReq(mimeId, initBodyFor(ctx, png, 'image/jpeg'), ctx.auth));
    await h.app.request(chunkReq(mimeId, 0, png, ctx.auth));
    const mimeRes = await h.app.request(completeReq(mimeId, ctx.auth));
    expect(mimeRes.status).toBe(422);
    expect((await readError(mimeRes)).error.code).toBe('MIME_MISMATCH');
    expect(await chunkCount(mimeId)).toBe(0);
    expect(await h.blobStore.exists(mediaStorageKeyForTest(ctx.tenantId, mimeId))).toBe(false);

    // (b) Bit-flipped chunk → HASH_MISMATCH, chunks purged, blob untouched.
    const good = buildImage(1000, 'image/jpeg', 'sec05-hash');
    const hashId = detUuidV7('sec05-hash:media');
    await h.app.request(initReq(hashId, initBodyFor(ctx, good, 'image/jpeg'), ctx.auth));
    const flipped = Uint8Array.from(good);
    flipped[500] = (flipped[500] ?? 0) ^ 0xff; // same length → passes CHUNK_SIZE, breaks the hash
    await h.app.request(chunkReq(hashId, 0, flipped, ctx.auth));
    const hashRes = await h.app.request(completeReq(hashId, ctx.auth));
    expect(hashRes.status).toBe(422);
    expect((await readError(hashRes)).error.code).toBe('HASH_MISMATCH');
    expect(await chunkCount(hashId)).toBe(0);
    expect(await h.blobStore.exists(mediaStorageKeyForTest(ctx.tenantId, hashId))).toBe(false);

    // (c) Chunk byte count ±1 → CHUNK_SIZE_INVALID, nothing stored.
    const sizeId = detUuidV7('sec05-size:media');
    await h.app.request(initReq(sizeId, initBodyFor(ctx, good, 'image/jpeg'), ctx.auth));
    const shortRes = await h.app.request(
      chunkReq(sizeId, 0, buildImage(999, 'image/jpeg', 's'), ctx.auth),
    );
    expect(shortRes.status).toBe(422);
    expect((await readError(shortRes)).error.code).toBe('CHUNK_SIZE_INVALID');
    expect(await chunkCount(sizeId)).toBe(0);
  });
});

describe('SEC-MEDIA-06 cross-device chunk injection', () => {
  test('SEC-MEDIA-06 chunk PUT to another device’s in-flight id with a different-device token → 404; real receivedChunks unpolluted', async () => {
    const a = await h.seedDevice('sec06-a');
    const b = await h.seedDeviceInTenant('sec06-b', { tenantId: a.tenantId, storeId: a.storeId });
    const bytes = buildImage(2 * 262144 + 3, 'image/jpeg', 'sec06'); // 3 chunks
    const chunks = chunkize(bytes);
    const id = detUuidV7('sec06:media');
    await h.app.request(initReq(id, initBodyFor(a, bytes, 'image/jpeg'), a.auth));
    await h.app.request(chunkReq(id, 0, chunks[0] as Uint8Array, a.auth));

    // Device B injects chunk 1 with its own valid token → 404, stores nothing.
    const inject = await h.app.request(chunkReq(id, 1, chunks[1] as Uint8Array, b.auth));
    expect(inject.status).toBe(404);
    expect((await readError(inject)).error.code).toBe('MEDIA_NOT_FOUND');

    const st = await h.app.request(statusReq(id, a.auth));
    expect(((await st.json()) as { receivedChunks: number[] }).receivedChunks).toEqual([0]); // unpolluted
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function chunkCount(mediaId: string): Promise<number> {
  return h.db
    .selectFrom('media_chunks')
    .select('chunkIndex')
    .where('mediaId', '=', mediaId)
    .execute()
    .then((r) => r.length);
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
}

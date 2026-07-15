// POST /v1/media/:id/complete — assembly, whole-file hash, magic-byte mime, purge-on-failure, and
// crash-window convergence (api/03-media §3.4). The purge and "blob untouched" claims are asserted
// against the DB + blob store, not inferred.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  completeReq,
  detUuidV7,
  initBodyFor,
  initReq,
  makeMediaHarness,
  mediaStorageKeyForTest,
  type DeviceContext,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

/** Init + upload every chunk, but DO NOT complete. Returns the media id. */
async function uploadChunksOnly(
  ctx: DeviceContext,
  bytes: Uint8Array,
  seed: string,
  mime: 'image/jpeg' | 'image/png' = 'image/jpeg',
  chunkMutator?: (i: number, chunk: Uint8Array) => Uint8Array,
): Promise<string> {
  const id = detUuidV7(`${seed}:media`);
  const init = await h.app.request(initReq(id, initBodyFor(ctx, bytes, mime), ctx.auth));
  if (init.status !== 200) throw new Error(`init ${init.status}`);
  const chunks = chunkize(bytes);
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunkMutator
      ? chunkMutator(i, chunks[i] as Uint8Array)
      : (chunks[i] as Uint8Array);
    const put = await h.app.request(chunkReq(id, i, chunk, ctx.auth));
    if (put.status !== 200) throw new Error(`chunk ${i} ${put.status}: ${await put.text()}`);
  }
  return id;
}

function chunkCount(mediaId: string): Promise<number> {
  return h.db
    .selectFrom('media_chunks')
    .select('chunkIndex')
    .where('mediaId', '=', mediaId)
    .execute()
    .then((r) => r.length);
}

function mediaStatus(mediaId: string): Promise<string | undefined> {
  return h.db
    .selectFrom('media')
    .select('status')
    .where('id', '=', mediaId)
    .executeTakeFirst()
    .then((r) => r?.status);
}

describe('complete: success & idempotency', () => {
  test('success → blob at t/{tenant}/m/{id}, row complete + storage_key, chunks deleted', async () => {
    const ctx = await h.seedDevice('cp-ok');
    const bytes = buildImage(1000, 'image/jpeg', 'cp-ok');
    const id = await uploadChunksOnly(ctx, bytes, 'cp-ok');
    const res = await h.app.request(completeReq(id, ctx.auth));
    expect(res.status).toBe(200);

    const key = mediaStorageKeyForTest(ctx.tenantId, id);
    expect(await h.blobStore.exists(key)).toBe(true);
    const row = await h.db
      .selectFrom('media')
      .select(['status', 'storageKey'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('complete');
    expect(row.storageKey).toBe(key);
    expect(await chunkCount(id)).toBe(0);
  });

  test('complete on already-complete → 200 (idempotent)', async () => {
    const ctx = await h.seedDevice('cp-idem');
    const bytes = buildImage(600, 'image/jpeg', 'cp-idem');
    const id = await uploadChunksOnly(ctx, bytes, 'cp-idem');
    expect((await h.app.request(completeReq(id, ctx.auth))).status).toBe(200);
    expect((await h.app.request(completeReq(id, ctx.auth))).status).toBe(200);
  });
});

describe('complete: failure paths purge + leave blob untouched', () => {
  test('missing chunks → 422 CHUNKS_MISSING with accurate missingChunks', async () => {
    const ctx = await h.seedDevice('cp-missing');
    const size = 2 * 262144 + 10; // 3 chunks
    const bytes = buildImage(size, 'image/jpeg', 'cp-missing');
    const id = detUuidV7('cp-missing:media');
    await h.app.request(initReq(id, initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth));
    const chunks = chunkize(bytes);
    await h.app.request(chunkReq(id, 0, chunks[0] as Uint8Array, ctx.auth)); // only chunk 0

    const res = await h.app.request(completeReq(id, ctx.auth));
    expect(res.status).toBe(422);
    const err = await readError(res);
    expect(err.error.code).toBe('CHUNKS_MISSING');
    expect(err.error.details['missingChunks']).toEqual([1, 2]);
  });

  test('bit-flipped chunk → 422 HASH_MISMATCH, all chunks purged, blob untouched', async () => {
    const ctx = await h.seedDevice('cp-hash');
    const bytes = buildImage(1000, 'image/jpeg', 'cp-hash');
    const id = await uploadChunksOnly(ctx, bytes, 'cp-hash', 'image/jpeg', (i, chunk) => {
      // Flip a byte in the middle (keeps the length → passes CHUNK_SIZE, breaks the whole-file hash).
      const copy = Uint8Array.from(chunk);
      const mid = Math.floor(copy.length / 2);
      copy[mid] = (copy[mid] ?? 0) ^ 0xff;
      return copy;
    });

    const res = await h.app.request(completeReq(id, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('HASH_MISMATCH');
    expect(await chunkCount(id)).toBe(0); // chunks purged
    expect(await mediaStatus(id)).toBe('receiving'); // never marked complete
    expect(await h.blobStore.exists(mediaStorageKeyForTest(ctx.tenantId, id))).toBe(false);
  });

  test('declared jpeg + PNG magic → 422 MIME_MISMATCH, chunks purged, blob untouched', async () => {
    const ctx = await h.seedDevice('cp-mime');
    const pngBytes = buildImage(1000, 'image/png', 'cp-mime'); // PNG magic
    // init DECLARES image/jpeg but the sha is over the PNG bytes → hash passes, magic mismatches.
    const id = detUuidV7('cp-mime:media');
    const init = await h.app.request(
      initReq(id, initBodyFor(ctx, pngBytes, 'image/jpeg'), ctx.auth),
    );
    expect(init.status).toBe(200);
    await h.app.request(chunkReq(id, 0, pngBytes, ctx.auth));

    const res = await h.app.request(completeReq(id, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('MIME_MISMATCH');
    expect(await chunkCount(id)).toBe(0);
    expect(await mediaStatus(id)).toBe('receiving');
    expect(await h.blobStore.exists(mediaStorageKeyForTest(ctx.tenantId, id))).toBe(false);
  });
});

describe('complete: crash-window convergence (api/03 §3.4 step 6)', () => {
  test('blob already written, row still receiving, chunks intact → retried complete converges', async () => {
    const ctx = await h.seedDevice('cp-crash');
    const bytes = buildImage(1000, 'image/jpeg', 'cp-crash');
    const id = await uploadChunksOnly(ctx, bytes, 'cp-crash');

    // Simulate a crash between blob write and commit: the blob exists, but the row is still
    // 'receiving' and the chunks are intact.
    await h.blobStore.put(mediaStorageKeyForTest(ctx.tenantId, id), bytes);
    expect(await mediaStatus(id)).toBe('receiving');
    expect(await chunkCount(id)).toBeGreaterThan(0);

    const res = await h.app.request(completeReq(id, ctx.auth));
    expect(res.status).toBe(200);
    expect(await mediaStatus(id)).toBe('complete');
    expect(await chunkCount(id)).toBe(0);
  });
});

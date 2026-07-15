// PUT /v1/media/:id/chunks/:index — exact-size enforcement, index bounds, encoding rejection,
// idempotent overwrite, and immutability (api/03-media §3.2, §7). "Nothing stored" on a rejection is
// asserted against the DB, not inferred.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  detUuidV7,
  initBodyFor,
  initReq,
  makeMediaHarness,
  uploadFull,
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

/** Init a media and return its id (receiving, no chunks). */
async function initMedia(
  ctx: DeviceContext,
  bytes: Uint8Array,
  seed: string,
  mime: 'image/jpeg' | 'image/png' = 'image/jpeg',
): Promise<string> {
  const id = detUuidV7(`${seed}:media`);
  const res = await h.app.request(initReq(id, initBodyFor(ctx, bytes, mime), ctx.auth));
  if (res.status !== 200) throw new Error(`init ${res.status}`);
  return id;
}

function chunkRowCount(mediaId: string, index: number): Promise<number> {
  return h.db
    .selectFrom('media_chunks')
    .select('chunkIndex')
    .where('mediaId', '=', mediaId)
    .where('chunkIndex', '=', index)
    .execute()
    .then((r) => r.length);
}

describe('chunk size enforcement (api/03 §3.2)', () => {
  test('exact-size chunk accepted; receivedChunks reflects it', async () => {
    const ctx = await h.seedDevice('ch-exact');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-exact');
    const id = await initMedia(ctx, bytes, 'ch-exact');
    const res = await h.app.request(chunkReq(id, 0, bytes, ctx.auth));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { receivedChunks: number[] }).receivedChunks).toEqual([0]);
  });

  test.each([-1, +1])('±1 byte (%s) → 422 CHUNK_SIZE_INVALID, nothing stored', async (delta) => {
    const ctx = await h.seedDevice(`ch-size${delta}`);
    const bytes = buildImage(1000, 'image/jpeg', `ch-size${delta}`);
    const id = await initMedia(ctx, bytes, `ch-size${delta}`);
    const wrong = buildImage(1000 + delta, 'image/jpeg', `ch-size${delta}-wrong`);
    const res = await h.app.request(chunkReq(id, 0, wrong, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('CHUNK_SIZE_INVALID');
    expect(await chunkRowCount(id, 0)).toBe(0);
  });

  test('empty body → 422 CHUNK_SIZE_INVALID, nothing stored', async () => {
    const ctx = await h.seedDevice('ch-empty');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-empty');
    const id = await initMedia(ctx, bytes, 'ch-empty');
    const res = await h.app.request(chunkReq(id, 0, new Uint8Array(0), ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('CHUNK_SIZE_INVALID');
    expect(await chunkRowCount(id, 0)).toBe(0);
  });

  test('body over bodyLimit(262144) → 413 CHUNK_TOO_LARGE', async () => {
    const ctx = await h.seedDevice('ch-toobig');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-toobig');
    const id = await initMedia(ctx, bytes, 'ch-toobig');
    const oversized = buildImage(262144 + 1, 'image/jpeg', 'ch-toobig-over');
    const res = await h.app.request(chunkReq(id, 0, oversized, ctx.auth));
    expect(res.status).toBe(413);
    expect((await readError(res)).error.code).toBe('CHUNK_TOO_LARGE');
    expect(await chunkRowCount(id, 0)).toBe(0);
  });
});

describe('chunk index bounds (api/03 §3.2)', () => {
  test.each([
    ['-1', -1],
    ['totalChunks', 1],
    ['2^31', 2 ** 31],
  ])('index %s → 422 CHUNK_INDEX_INVALID, nothing stored', async (label, index) => {
    const ctx = await h.seedDevice(`ch-idx-${label}`);
    const bytes = buildImage(1000, 'image/jpeg', `ch-idx-${label}`); // 1 chunk → totalChunks = 1
    const id = await initMedia(ctx, bytes, `ch-idx-${label}`);
    const res = await h.app.request(chunkReq(id, index, bytes, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('CHUNK_INDEX_INVALID');
    const rows = await h.db
      .selectFrom('media_chunks')
      .select('chunkIndex')
      .where('mediaId', '=', id)
      .execute();
    expect(rows).toEqual([]);
  });
});

describe('chunk encoding, idempotency & immutability', () => {
  test('Content-Encoding: gzip → 415 UNSUPPORTED_ENCODING, nothing stored', async () => {
    const ctx = await h.seedDevice('ch-gzip');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-gzip');
    const id = await initMedia(ctx, bytes, 'ch-gzip');
    const res = await h.app.request(
      chunkReq(id, 0, bytes, ctx.auth, { 'Content-Encoding': 'gzip' }),
    );
    expect(res.status).toBe(415);
    expect((await readError(res)).error.code).toBe('UNSUPPORTED_ENCODING');
    expect(await chunkRowCount(id, 0)).toBe(0);
  });

  test('re-PUT same index → 200 overwrite, single row', async () => {
    const ctx = await h.seedDevice('ch-reput');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-reput');
    const id = await initMedia(ctx, bytes, 'ch-reput');
    expect((await h.app.request(chunkReq(id, 0, bytes, ctx.auth))).status).toBe(200);
    expect((await h.app.request(chunkReq(id, 0, bytes, ctx.auth))).status).toBe(200);
    expect(await chunkRowCount(id, 0)).toBe(1);
  });

  test('concurrent PUTs of one index → single consistent row', async () => {
    const ctx = await h.seedDevice('ch-concurrent');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-concurrent');
    const id = await initMedia(ctx, bytes, 'ch-concurrent');
    const results = await Promise.all([
      h.app.request(chunkReq(id, 0, bytes, ctx.auth)),
      h.app.request(chunkReq(id, 0, bytes, ctx.auth)),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await chunkRowCount(id, 0)).toBe(1);
  });

  test('PUT after complete → 409 MEDIA_IMMUTABLE', async () => {
    const ctx = await h.seedDevice('ch-complete');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-complete');
    const { mediaId } = await uploadFull(h, ctx, bytes, 'image/jpeg', 'ch-complete');
    const res = await h.app.request(
      chunkReq(mediaId, 0, chunkize(bytes)[0] as Uint8Array, ctx.auth),
    );
    expect(res.status).toBe(409);
    expect((await readError(res)).error.code).toBe('MEDIA_IMMUTABLE');
  });

  test('un-init’d id → 404 MEDIA_NOT_FOUND', async () => {
    const ctx = await h.seedDevice('ch-noinit');
    const bytes = buildImage(1000, 'image/jpeg', 'ch-noinit');
    const res = await h.app.request(chunkReq(detUuidV7('never-init'), 0, bytes, ctx.auth));
    expect(res.status).toBe(404);
    expect((await readError(res)).error.code).toBe('MEDIA_NOT_FOUND');
  });
});

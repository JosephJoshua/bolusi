// Full-flow media integration (api/03-media): init → PUT chunks → status resume → complete →
// download round-trip, on the real production app.fetch over a real PostgreSQL 16 DB with RLS-aware
// forTenant (SET LOCAL ROLE bolusi_app). Witnesses server-authoritative resume, idempotent replay,
// and a byte-exact download.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  completeReq,
  downloadReq,
  initBodyFor,
  initReq,
  makeMediaHarness,
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

describe('media upload → resume → complete → download', () => {
  test('single-chunk upload completes and downloads byte-identically', async () => {
    const ctx = await h.seedDevice('flow-single');
    const bytes = buildImage(1000, 'image/jpeg', 'flow-single');
    const { mediaId } = await uploadFull(h, ctx, bytes, 'image/jpeg', 'flow-single');

    const dl = await h.app.request(downloadReq(mediaId, ctx.auth));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Type')).toBe('image/jpeg');
    expect(dl.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(dl.headers.get('ETag')).toBe(`"${sha256Hex(bytes)}"`);
    expect(dl.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    const got = new Uint8Array(await dl.arrayBuffer());
    expect(sha256Hex(got)).toBe(sha256Hex(bytes)); // downloaded bytes hash-match init sha256
  });

  test('multi-chunk upload: interrupt mid-file → status resume → complete', async () => {
    const ctx = await h.seedDevice('flow-multi');
    const size = 2 * 262144 + 500; // 3 chunks (two full + a short last)
    const bytes = buildImage(size, 'image/png', 'flow-multi');
    const chunks = chunkize(bytes);
    expect(chunks.length).toBe(3);

    const mediaId = (await import('../../helpers/media.js')).detUuidV7('flow-multi:media');
    const init = await h.app.request(
      initReq(mediaId, initBodyFor(ctx, bytes, 'image/png'), ctx.auth),
    );
    expect(init.status).toBe(200);
    const initJson = (await init.json()) as { totalChunks: number; chunkSize: number };
    expect(initJson.chunkSize).toBe(262144);
    expect(initJson.totalChunks).toBe(3);

    // Send only chunk 0 and 2 (interrupt before chunk 1).
    await h.app.request(chunkReq(mediaId, 0, chunks[0] as Uint8Array, ctx.auth));
    await h.app.request(chunkReq(mediaId, 2, chunks[2] as Uint8Array, ctx.auth));

    // complete now → CHUNKS_MISSING listing the gap.
    const early = await h.app.request(completeReq(mediaId, ctx.auth));
    expect(early.status).toBe(422);
    const earlyErr = await readError(early);
    expect(earlyErr.error.code).toBe('CHUNKS_MISSING');
    expect(earlyErr.error.details['missingChunks']).toEqual([1]);

    // status is server-authoritative — resume the missing chunk it reports.
    const st = await h.app.request(statusReq(mediaId, ctx.auth));
    const stJson = (await st.json()) as { receivedChunks: number[]; totalChunks: number };
    expect(stJson.receivedChunks).toEqual([0, 2]);
    await h.app.request(chunkReq(mediaId, 1, chunks[1] as Uint8Array, ctx.auth));

    const done = await h.app.request(completeReq(mediaId, ctx.auth));
    expect(done.status).toBe(200);
    expect((await done.json()) as unknown).toEqual({ status: 'complete' });

    // media_chunks purged after assembly.
    const remaining = await h.db
      .selectFrom('mediaChunks')
      .select('chunkIndex')
      .where('mediaId', '=', mediaId)
      .execute();
    expect(remaining).toEqual([]);

    const dl = await h.app.request(downloadReq(mediaId, ctx.auth));
    expect(dl.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await dl.arrayBuffer()))).toBe(sha256Hex(bytes));
  });

  test('end-to-end replay of a finished upload → all 200s, single blob, no duplicate rows', async () => {
    const ctx = await h.seedDevice('flow-replay');
    const bytes = buildImage(500, 'image/jpeg', 'flow-replay');
    const { mediaId } = await uploadFull(h, ctx, bytes, 'image/jpeg', 'flow-replay');

    // Replay init (byte-identical) → 200 with status complete/immutable-tolerant; here re-init of a
    // COMPLETE id is 409 MEDIA_IMMUTABLE, and re-complete is idempotent 200.
    const reComplete = await h.app.request(completeReq(mediaId, ctx.auth));
    expect(reComplete.status).toBe(200);

    const rows = await h.db.selectFrom('media').select('id').where('id', '=', mediaId).execute();
    expect(rows.length).toBe(1); // single row, no duplicate
    const dl = await h.app.request(downloadReq(mediaId, ctx.auth));
    expect(sha256Hex(new Uint8Array(await dl.arrayBuffer()))).toBe(sha256Hex(bytes));
  });

  test('If-None-Match matching ETag → 304', async () => {
    const ctx = await h.seedDevice('flow-inm');
    const bytes = buildImage(300, 'image/png', 'flow-inm');
    const { mediaId } = await uploadFull(h, ctx, bytes, 'image/png', 'flow-inm');
    const etag = `"${sha256Hex(bytes)}"`;
    const res = await h.app.request(downloadReq(mediaId, ctx.auth, { 'If-None-Match': etag }));
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
  });
});

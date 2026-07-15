// GET /v1/media/:id (download) — the device-scoped read (api/03-media §2 = the sync pull rule),
// the §2.2 existence-oracle defense (every out-of-scope/incomplete/nonexistent id → an
// indistinguishable 404), headers, and 304. Fixtures are asserted to EXIST (owner handle) before a
// 404 is believed — an empty store would pass the 404 legs vacuously (testing-guide T-14b).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  buildImage,
  detUuidV7,
  downloadReq,
  initBodyFor,
  initReq,
  makeMediaHarness,
  sha256Hex,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

async function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe('download scope matrix (api/03 §2)', () => {
  test('same tenant + same store → 200; store_id NULL → 200 (tenant-wide)', async () => {
    const ctx = await h.seedDevice('dl-in'); // tenant A, store S1
    const sameStore = buildImage(400, 'image/jpeg', 'dl-in-same');
    const nullStore = buildImage(400, 'image/png', 'dl-in-null');
    const a = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes: sameStore,
      mime: 'image/jpeg',
      seed: 'dl-in-same',
    });
    const b = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: null,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes: nullStore,
      mime: 'image/png',
      seed: 'dl-in-null',
    });

    const r1 = await h.app.request(downloadReq(a.mediaId, ctx.auth));
    expect(r1.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await r1.arrayBuffer()))).toBe(sha256Hex(sameStore));

    const r2 = await h.app.request(downloadReq(b.mediaId, ctx.auth));
    expect(r2.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await r2.arrayBuffer()))).toBe(sha256Hex(nullStore));
  });

  test('all out-of-scope / incomplete / nonexistent ids → an indistinguishable 404', async () => {
    const ctx = await h.seedDevice('dl-scope'); // tenant A, store S1

    // Leg 1: same tenant, a store the device is NOT assigned to (S2).
    const s2 = await h.seedStore(ctx.tenantId, 'dl-scope-s2');
    const otherStore = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: s2,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes: buildImage(300, 'image/jpeg', 'dl-scope-s2'),
      seed: 'dl-scope-s2',
    });

    // Leg 2: another tenant entirely.
    const other = await h.seedDevice('dl-scope-b'); // tenant B
    const otherTenant = await h.seedCompleteMedia({
      tenantId: other.tenantId,
      storeId: other.storeId,
      deviceId: other.deviceId,
      userId: other.userId,
      bytes: buildImage(300, 'image/png', 'dl-scope-b'),
      mime: 'image/png',
      seed: 'dl-scope-b',
    });

    // Leg 3: a receiving (incomplete) media in the device's OWN scope.
    const incompleteId = detUuidV7('dl-scope-inc:media');
    const incBytes = buildImage(300, 'image/jpeg', 'dl-scope-inc');
    await h.app.request(initReq(incompleteId, initBodyFor(ctx, incBytes, 'image/jpeg'), ctx.auth));

    // Leg 4: a nonexistent id.
    const nonexistent = detUuidV7('dl-scope-none');

    // NON-VACUITY (T-14b): every hidden row EXISTS (owner handle) before we assert 404.
    const existing = await h.db
      .selectFrom('media')
      .select('id')
      .where('id', 'in', [otherStore.mediaId, otherTenant.mediaId, incompleteId])
      .execute();
    expect(existing.map((r) => r.id).sort()).toEqual(
      [otherStore.mediaId, otherTenant.mediaId, incompleteId].sort(),
    );

    const legs = [otherStore.mediaId, otherTenant.mediaId, incompleteId, nonexistent];
    const responses: { status: number; body: string; etag: string | null }[] = [];
    for (const id of legs) {
      const res = await h.app.request(downloadReq(id, ctx.auth));
      responses.push({
        status: res.status,
        body: await bodyOf(res),
        etag: res.headers.get('ETag'),
      });
    }
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body).error.code).toBe('MEDIA_NOT_FOUND');
      expect(r.etag).toBeNull(); // no header distinguishes the legs
    }
    // Byte-indistinguishable: every leg's response body is identical.
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
  });
});

describe('download headers & conditional', () => {
  test('headers: Content-Type/Length, ETag, immutable Cache-Control; bytes hash-match', async () => {
    const ctx = await h.seedDevice('dl-hdr');
    const bytes = buildImage(777, 'image/png', 'dl-hdr');
    const m = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes,
      mime: 'image/png',
      seed: 'dl-hdr',
    });
    const res = await h.app.request(downloadReq(m.mediaId, ctx.auth));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(res.headers.get('ETag')).toBe(`"${m.sha256}"`);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(m.sha256);
  });

  test('If-None-Match matching ETag → 304, no body', async () => {
    const ctx = await h.seedDevice('dl-304');
    const bytes = buildImage(400, 'image/jpeg', 'dl-304');
    const m = await h.seedCompleteMedia({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      bytes,
      seed: 'dl-304',
    });
    const res = await h.app.request(
      downloadReq(m.mediaId, ctx.auth, { 'If-None-Match': `"${m.sha256}"` }),
    );
    expect(res.status).toBe(304);
    expect((await res.text()).length).toBe(0);
  });
});

// POST /v1/media/:id/init — idempotency, immutability 409s, and the validation/size/mime matrix
// (api/03-media §3.1). Error codes are the api/03 §8 vocabulary (MIME_UNSUPPORTED / MEDIA_TOO_LARGE
// / INIT_MISMATCH / MEDIA_IMMUTABLE) — NOT a generic VALIDATION_FAILED where a media code is owed.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  detUuidV7,
  initBodyFor,
  initReq,
  makeMediaHarness,
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

describe('init idempotency & mismatch (api/03 §3.1)', () => {
  test('byte-identical re-init → 200 with current receivedChunks (crash-resume path)', async () => {
    const ctx = await h.seedDevice('init-idem');
    const bytes = buildImage(500, 'image/jpeg', 'init-idem');
    const id = detUuidV7('init-idem:media');
    const body = initBodyFor(ctx, bytes, 'image/jpeg');

    const first = await h.app.request(initReq(id, body, ctx.auth));
    expect(first.status).toBe(200);
    expect((await first.json()) as unknown).toEqual({
      chunkSize: 262144,
      totalChunks: 1,
      receivedChunks: [],
      status: 'receiving',
    });

    const again = await h.app.request(initReq(id, body, ctx.auth));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('receiving');
  });

  test.each([
    ['sizeBytes', { sizeBytes: 999 }],
    ['sha256', { sha256: 'a'.repeat(64) }],
    ['mime', { mime: 'image/png' }],
    ['type', { type: 'signature' as const }],
  ])('re-init varying %s against a receiving id → 409 INIT_MISMATCH', async (_field, patch) => {
    const ctx = await h.seedDevice(`init-mm-${_field}`);
    const bytes = buildImage(500, 'image/jpeg', `init-mm-${_field}`);
    const id = detUuidV7(`init-mm-${_field}:media`);
    const body = initBodyFor(ctx, bytes, 'image/jpeg');
    expect((await h.app.request(initReq(id, body, ctx.auth))).status).toBe(200);

    const res = await h.app.request(initReq(id, { ...body, ...patch }, ctx.auth));
    expect(res.status).toBe(409);
    expect((await readError(res)).error.code).toBe('INIT_MISMATCH');
  });

  test.each([
    ['metadata.userId', 'userId'],
    ['metadata.capturedAt', 'capturedAt'],
  ])('re-init varying %s → 409 INIT_MISMATCH', async (_label, key) => {
    const ctx = await h.seedDevice(`init-meta-${key}`);
    const bytes = buildImage(500, 'image/jpeg', `init-meta-${key}`);
    const id = detUuidV7(`init-meta-${key}:media`);
    const body = initBodyFor(ctx, bytes, 'image/jpeg');
    expect((await h.app.request(initReq(id, body, ctx.auth))).status).toBe(200);

    const metadata =
      key === 'userId'
        ? { ...body.metadata, userId: detUuidV7('some-other-user') }
        : { ...body.metadata, capturedAt: body.metadata.capturedAt + 1 };
    const res = await h.app.request(initReq(id, { ...body, metadata }, ctx.auth));
    expect(res.status).toBe(409);
    expect((await readError(res)).error.code).toBe('INIT_MISMATCH');
  });

  test('re-init after complete → 409 MEDIA_IMMUTABLE (even a varied field)', async () => {
    const ctx = await h.seedDevice('init-immut');
    const bytes = buildImage(400, 'image/jpeg', 'init-immut');
    const { mediaId } = await uploadFull(h, ctx, bytes, 'image/jpeg', 'init-immut');
    const body = initBodyFor(ctx, bytes, 'image/jpeg');

    const res = await h.app.request(
      initReq(mediaId, { ...body, sha256: 'b'.repeat(64) }, ctx.auth),
    );
    expect(res.status).toBe(409);
    expect((await readError(res)).error.code).toBe('MEDIA_IMMUTABLE');
  });
});

describe('init validation matrix (api/03 §3.1)', () => {
  test('mime outside {jpeg,png} → 422 MIME_UNSUPPORTED', async () => {
    const ctx = await h.seedDevice('init-mime');
    const bytes = buildImage(300, 'image/jpeg', 'init-mime');
    const body = { ...initBodyFor(ctx, bytes, 'image/jpeg'), mime: 'image/gif' };
    const res = await h.app.request(initReq(detUuidV7('init-mime:media'), body, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('MIME_UNSUPPORTED');
  });

  test('sizeBytes > 10 MiB → 413 MEDIA_TOO_LARGE', async () => {
    const ctx = await h.seedDevice('init-big');
    const bytes = buildImage(300, 'image/jpeg', 'init-big');
    const body = { ...initBodyFor(ctx, bytes, 'image/jpeg'), sizeBytes: 10 * 1024 * 1024 + 1 };
    const res = await h.app.request(initReq(detUuidV7('init-big:media'), body, ctx.auth));
    expect(res.status).toBe(413);
    expect((await readError(res)).error.code).toBe('MEDIA_TOO_LARGE');
  });

  test('sizeBytes 0 → 422 VALIDATION_FAILED (Zod min(1))', async () => {
    const ctx = await h.seedDevice('init-zero');
    const bytes = buildImage(300, 'image/jpeg', 'init-zero');
    const body = { ...initBodyFor(ctx, bytes, 'image/jpeg'), sizeBytes: 0 };
    const res = await h.app.request(initReq(detUuidV7('init-zero:media'), body, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown metadata.userId → 422 VALIDATION_FAILED', async () => {
    const ctx = await h.seedDevice('init-baduser');
    const bytes = buildImage(300, 'image/jpeg', 'init-baduser');
    const body = initBodyFor(ctx, bytes, 'image/jpeg');
    body.metadata.userId = detUuidV7('not-enrolled-user');
    const res = await h.app.request(initReq(detUuidV7('init-baduser:media'), body, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown metadata.deviceId → 422 VALIDATION_FAILED', async () => {
    const ctx = await h.seedDevice('init-baddev');
    const bytes = buildImage(300, 'image/jpeg', 'init-baddev');
    const body = initBodyFor(ctx, bytes, 'image/jpeg');
    body.metadata.deviceId = detUuidV7('not-enrolled-device');
    const res = await h.app.request(initReq(detUuidV7('init-baddev:media'), body, ctx.auth));
    expect(res.status).toBe(422);
    expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
  });
});

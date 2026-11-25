// Uploads left unfinished for 48 hours are cleared by the tenant's next upload init, and a device
// that comes back afterwards starts the upload over.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ABANDONED_UPLOAD_MS } from '../../../src/media/sweep.js';
import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  detUuidV7,
  initBodyFor,
  initReq,
  makeMediaHarness,
  completeReq,
  statusReq,
  uploadFull,
  type DeviceContext,
  type InitBody,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

const HOUR = 60 * 60 * 1000;
const CHUNK = 262144;

/** Upload `bytes` under `id` from `init` to `complete`. */
async function uploadAs(id: string, body: InitBody, bytes: Uint8Array, auth: string) {
  expect((await h.app.request(initReq(id, body, auth))).status).toBe(200);
  for (let i = 0; i * CHUNK < bytes.length; i += 1) {
    const part = bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bytes.length));
    expect((await h.app.request(chunkReq(id, i, part, auth))).status).toBe(200);
  }
  expect((await h.app.request(completeReq(id, auth))).status).toBe(200);
}

async function mediaRow(tenantId: string, id: string) {
  return h.db
    .selectFrom('media')
    .select(['status'])
    .where('tenantId', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
}

async function chunkCount(tenantId: string, id: string): Promise<number> {
  const rows = await h.db
    .selectFrom('mediaChunks')
    .select('chunkIndex')
    .where('tenantId', '=', tenantId)
    .where('mediaId', '=', id)
    .execute();
  return rows.length;
}

describe('abandoned upload sweep', () => {
  test('an upload idle for 48 hours is cleared by the next init; a fresh one is kept', async () => {
    const ctx = await h.seedDevice('sweep-basic');
    // Two chunks, so one can be sent and the other left missing.
    const bytes = buildImage(262144 + 100, 'image/jpeg', 'sweep-basic');
    const stale = detUuidV7('sweep-basic:stale');
    const staleBody = initBodyFor(ctx, bytes, 'image/jpeg');
    expect((await h.app.request(initReq(stale, staleBody, ctx.auth))).status).toBe(200);
    expect(
      (await h.app.request(chunkReq(stale, 0, bytes.subarray(0, 262144), ctx.auth))).status,
    ).toBe(200);

    h.clock.advance(ABANDONED_UPLOAD_MS - HOUR);
    const recent = detUuidV7('sweep-basic:recent');
    const recentBytes = buildImage(400, 'image/jpeg', 'sweep-basic-recent');
    expect(
      (await h.app.request(initReq(recent, initBodyFor(ctx, recentBytes, 'image/jpeg'), ctx.auth)))
        .status,
    ).toBe(200);
    // Not yet 48 hours since the stale one's last chunk.
    expect(await mediaRow(ctx.tenantId, stale)).toEqual({ status: 'receiving' });

    h.clock.advance(2 * HOUR);
    const next = detUuidV7('sweep-basic:next');
    const nextBytes = buildImage(300, 'image/jpeg', 'sweep-basic-next');
    expect(
      (await h.app.request(initReq(next, initBodyFor(ctx, nextBytes, 'image/jpeg'), ctx.auth)))
        .status,
    ).toBe(200);

    expect(await mediaRow(ctx.tenantId, stale)).toBeUndefined();
    expect(await chunkCount(ctx.tenantId, stale)).toBe(0);
    expect(await mediaRow(ctx.tenantId, recent)).toEqual({ status: 'receiving' });

    // The device coming back is told the upload is gone, and starting over completes it.
    const status = await h.app.request(statusReq(stale, ctx.auth));
    expect(status.status).toBe(404);
    expect((await readError(status)).error.code).toBe('MEDIA_NOT_FOUND');
    await uploadAs(stale, staleBody, bytes, ctx.auth);
    expect(await mediaRow(ctx.tenantId, stale)).toEqual({ status: 'complete' });
  });

  test('a recent chunk keeps an old upload; finished uploads are never touched', async () => {
    const ctx = await h.seedDevice('sweep-active');
    const bytes = buildImage(262144 + 100, 'image/jpeg', 'sweep-active');
    const slow = detUuidV7('sweep-active:slow');
    expect(
      (await h.app.request(initReq(slow, initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth))).status,
    ).toBe(200);
    const doneBytes = buildImage(500, 'image/jpeg', 'sweep-active-done');
    const { mediaId: done } = await uploadFull(
      h,
      ctx,
      doneBytes,
      'image/jpeg',
      'sweep-active-done',
    );

    h.clock.advance(ABANDONED_UPLOAD_MS);
    expect(
      (await h.app.request(chunkReq(slow, 0, bytes.subarray(0, 262144), ctx.auth))).status,
    ).toBe(200);
    h.clock.advance(2 * HOUR);
    const trigger = detUuidV7('sweep-active:trigger');
    const triggerBytes = buildImage(300, 'image/jpeg', 'sweep-active-trigger');
    expect(
      (
        await h.app.request(
          initReq(trigger, initBodyFor(ctx, triggerBytes, 'image/jpeg'), ctx.auth),
        )
      ).status,
    ).toBe(200);

    expect(await mediaRow(ctx.tenantId, slow)).toEqual({ status: 'receiving' });
    expect(await chunkCount(ctx.tenantId, slow)).toBe(1);
    expect(await mediaRow(ctx.tenantId, done)).toEqual({ status: 'complete' });
  });

  test("one tenant's init never clears another tenant's uploads", async () => {
    const a = await h.seedDevice('sweep-tenant-a');
    const b = await h.seedDevice('sweep-tenant-b');
    const bytes = buildImage(500, 'image/jpeg', 'sweep-tenant');
    const held = detUuidV7('sweep-tenant:held');
    expect(
      (await h.app.request(initReq(held, initBodyFor(b, bytes, 'image/jpeg'), b.auth))).status,
    ).toBe(200);

    h.clock.advance(ABANDONED_UPLOAD_MS + HOUR);
    const other = detUuidV7('sweep-tenant:other');
    expect(
      (await h.app.request(initReq(other, initBodyFor(a, bytes, 'image/jpeg'), a.auth))).status,
    ).toBe(200);

    expect(await mediaRow(b.tenantId, held)).toEqual({ status: 'receiving' });
  });
});

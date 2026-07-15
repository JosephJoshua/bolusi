// Revoked-device behavior on the media surface (api/03-media §2; security-guide §6.3). Revocation is
// enforced by the shared app-level bearerAuth (task 12) — this pins that a device revoked mid-upload
// is rejected on its next media request with 401 DEVICE_REVOKED, and its already-stored in-flight
// chunks are retained (the request never reaches the handler, so nothing is mutated).
import { afterAll, beforeAll, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  detUuidV7,
  initBodyFor,
  initReq,
  makeMediaHarness,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

test('revoked device mid-upload → 401 DEVICE_REVOKED, chunks retained', async () => {
  const ctx = await h.seedDevice('revoke');
  const bytes = buildImage(2 * 262144 + 7, 'image/jpeg', 'revoke'); // 3 chunks
  const chunks = chunkize(bytes);
  const id = detUuidV7('revoke:media');
  expect(
    (await h.app.request(initReq(id, initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth))).status,
  ).toBe(200);
  expect((await h.app.request(chunkReq(id, 0, chunks[0] as Uint8Array, ctx.auth))).status).toBe(
    200,
  );

  // Revoke the device: overwrite its token record (keyed by token hash) with a revoked status.
  h.tokenStore.add(ctx.token, {
    kind: 'device',
    deviceId: ctx.deviceId,
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    deviceStatus: 'revoked',
  });

  const res = await h.app.request(chunkReq(id, 1, chunks[1] as Uint8Array, ctx.auth));
  expect(res.status).toBe(401);
  expect((await readError(res)).error.code).toBe('DEVICE_REVOKED');

  // The already-received chunk 0 is retained (the revoked request never reached the handler).
  const rows = await h.db
    .selectFrom('media_chunks')
    .select('chunkIndex')
    .where('mediaId', '=', id)
    .execute();
  expect(rows.map((r) => r.chunkIndex)).toEqual([0]);
});

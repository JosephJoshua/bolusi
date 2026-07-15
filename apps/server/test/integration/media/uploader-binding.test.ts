// Uploader binding (api/03-media §2): an in-flight upload belongs to the device that created it.
// A DIFFERENT device (same tenant, valid token) touching it with init/PUT/status/complete → 404,
// and the real upload's server-authoritative receivedChunks stays unpolluted. Same-tenant on
// purpose — this isolates the device binding from the RLS/tenant boundary (that is SEC-MEDIA-03).
import { afterAll, beforeAll, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  completeReq,
  initBodyFor,
  initReq,
  statusReq,
  makeMediaHarness,
  detUuidV7,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

test('second device (same tenant) cannot touch another device’s in-flight upload → 404, real upload unpolluted', async () => {
  const a = await h.seedDevice('bind-a'); // tenant A, device A, store S1
  const b = await h.seedDeviceInTenant('bind-b', { tenantId: a.tenantId, storeId: a.storeId }); // device B, same tenant

  const bytes = buildImage(2 * 262144 + 5, 'image/jpeg', 'bind'); // 3 chunks
  const id = detUuidV7('bind:media');
  const chunks = chunkize(bytes);
  expect(
    (await h.app.request(initReq(id, initBodyFor(a, bytes, 'image/jpeg'), a.auth))).status,
  ).toBe(200);
  expect((await h.app.request(chunkReq(id, 0, chunks[0] as Uint8Array, a.auth))).status).toBe(200);

  // Device B (valid token, same tenant, NOT the uploader) → 404 on every verb.
  const reInit = await h.app.request(initReq(id, initBodyFor(a, bytes, 'image/jpeg'), b.auth));
  expect(reInit.status).toBe(404);
  expect((await readError(reInit)).error.code).toBe('MEDIA_NOT_FOUND');

  const put = await h.app.request(chunkReq(id, 1, chunks[1] as Uint8Array, b.auth));
  expect(put.status).toBe(404);
  expect((await readError(put)).error.code).toBe('MEDIA_NOT_FOUND');

  const st = await h.app.request(statusReq(id, b.auth));
  expect(st.status).toBe(404);

  const done = await h.app.request(completeReq(id, b.auth));
  expect(done.status).toBe(404);

  // The real uploader's server-authoritative inventory is unchanged: only chunk 0, and B's PUT of
  // chunk 1 stored nothing.
  const owner = await h.app.request(statusReq(id, a.auth));
  expect(owner.status).toBe(200);
  expect(((await owner.json()) as { receivedChunks: number[] }).receivedChunks).toEqual([0]);
});

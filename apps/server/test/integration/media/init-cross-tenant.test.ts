// Task 114 — `POST /v1/media/:id/init` must NOT be a cross-tenant existence oracle.
//
// `media.id` is a GLOBAL `uuid PRIMARY KEY` (10-db §8). Inside tenant A's forTenant tx, RLS hides
// tenant B's media row from the handler's SELECT, so the handler treats the id as new and INSERTs —
// which trips the GLOBAL unique index (RLS filters SELECTs, NOT unique-index conflicts, 10-db §6).
// Before the fix that unique violation escaped as `500 INTERNAL`, while a same-tenant other-device
// id answered a clean `404 MEDIA_NOT_FOUND`: the status code distinguished "exists in another
// tenant" from "does not exist" — precisely the oracle security-guide §2.2's media exception + the
// SEC-MEDIA-03 contract exist to remove. This suite is the apps/server (real PG16) proof; the
// harness-lane gate is SEC-TENANT-04's `POST /v1/media/:id/init` leg.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
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

describe('task 114 — media init is not a cross-tenant existence oracle', () => {
  test('cross-tenant, same-tenant other-device, and nonexistent init ids are indistinguishable (404 vs a fresh 200), never a 500 leak', async () => {
    const a = await h.seedDevice('t114-a'); // tenant A, store S1, device A
    const b = await h.seedDevice('t114-b'); // tenant B

    // A real tenant-B media row (the cross-tenant id under probe) — seeded via the owner handle so
    // it EXISTS but is RLS-hidden from tenant A (non-vacuity, T-14b).
    const crossTenant = await h.seedCompleteMedia({
      tenantId: b.tenantId,
      storeId: b.storeId,
      deviceId: b.deviceId,
      userId: b.userId,
      bytes: buildImage(300, 'image/jpeg', 't114-b'),
      seed: 't114-b',
    });

    // A same-tenant media owned by ANOTHER device in tenant A — the clean 404 comparator (init's
    // device-binding branch: an existing row whose device != the caller's → MEDIA_NOT_FOUND).
    const otherDevice = await h.seedDeviceInTenant('t114-a2', {
      tenantId: a.tenantId,
      storeId: a.storeId,
    });
    const sameTenantOther = await h.seedCompleteMedia({
      tenantId: a.tenantId,
      storeId: a.storeId,
      deviceId: otherDevice.deviceId,
      userId: otherDevice.userId,
      bytes: buildImage(300, 'image/jpeg', 't114-a-other'),
      seed: 't114-a-other',
    });

    const nonexistent = detUuidV7('t114-nonexistent');

    // Non-vacuity: both hidden/other rows EXIST before we believe a 404 (T-14b).
    const present = await h.db
      .selectFrom('media')
      .select('id')
      .where('id', 'in', [crossTenant.mediaId, sameTenantOther.mediaId])
      .execute();
    expect(present.length).toBe(2);

    const probeBody = initBodyFor(a, buildImage(300, 'image/jpeg', 't114-probe'), 'image/jpeg');

    // The two denied legs must be a byte-identical 404 MEDIA_NOT_FOUND.
    const denied: string[] = [];
    for (const id of [crossTenant.mediaId, sameTenantOther.mediaId]) {
      const res = await h.app.request(initReq(id, probeBody, a.auth));
      expect(res.status, `init(${id}) must be 404, never a 500 existence oracle`).toBe(404);
      expect((await readError(res.clone())).error.code).toBe('MEDIA_NOT_FOUND');
      denied.push(await res.text());
    }
    expect(new Set(denied).size).toBe(1); // indistinguishable

    // A genuinely-new (globally-nonexistent) id is the legitimate path → 200 receiving.
    const fresh = await h.app.request(initReq(nonexistent, probeBody, a.auth));
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ status: 'receiving', receivedChunks: [] });

    // The cross-tenant probe left NO tenant-A row for the foreign id (fails closed, no partial write):
    // tenant B still owns it, tenant A sees nothing.
    const asA = await h.testDb.appForTenant(a.tenantId, (db) =>
      db.selectFrom('media').select('id').where('id', '=', crossTenant.mediaId).execute(),
    );
    expect(asA).toEqual([]);
    const asB = await h.testDb.appForTenant(b.tenantId, (db) =>
      db
        .selectFrom('media')
        .select(['id', 'deviceId'])
        .where('id', '=', crossTenant.mediaId)
        .execute(),
    );
    expect(asB).toEqual([{ id: crossTenant.mediaId, deviceId: b.deviceId }]); // untouched, still B's
  });

  test('idempotent re-init of an in-scope receiving id still returns 200 with receivedChunks (positive control)', async () => {
    const a = await h.seedDevice('t114-idem');
    const id = detUuidV7('t114-idem:media');
    const initBody = initBodyFor(a, buildImage(300, 'image/jpeg', 't114-idem'), 'image/jpeg');

    const first = await h.app.request(initReq(id, initBody, a.auth));
    expect(first.status).toBe(200);
    const second = await h.app.request(initReq(id, initBody, a.auth));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'receiving', receivedChunks: [] });
  });
});

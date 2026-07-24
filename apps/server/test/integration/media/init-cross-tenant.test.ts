// Task 114 → superseded by D23 §2 (task 170): `POST /v1/media/:id/init` is not a cross-tenant
// existence oracle — now because media id uniqueness is `(tenant_id, id)` (migration 0011), not
// because the route folds a global-id collision into a uniform 404.
//
// HISTORY. `media.id` was a GLOBAL `uuid PRIMARY KEY`. Inside tenant A's forTenant tx, RLS hid tenant
// B's row from the SELECT, so the handler INSERTed and tripped the GLOBAL unique index (RLS filters
// SELECTs, not unique conflicts, 10-db §6) → first a `500`, then (d12face) a `404`. Either way the
// response for a HELD foreign id differed from a FREE id's `200`: the oracle.
//
// POST-D23 §2. A foreign tenant's id is a FREE id in the caller's own namespace, so init CREATES a
// row and returns `200` — byte-identical to a fresh id. Held == free: the caller learns nothing about
// tenant B. Tenant B's row is untouched; tenant A gets its OWN row at that id (two tenants, one id).
// The same-tenant other-device id still answers `404` — that is the uploader-binding rule (api/03
// §2), a genuine existing-row denial, NOT the cross-tenant oracle. This is the apps/server (real
// PG16) proof; the harness-lane gate is SEC-TENANT-04's dedicated `POST /v1/media/:id/init` leg.
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

describe('task 114 / D23 §2 — media init is not a cross-tenant existence oracle', () => {
  test('a foreign tenant id inits identically to a fresh id (held == free, 200), creating tenant A its own row and leaving tenant B untouched', async () => {
    const a = await h.seedDevice('t170-a'); // tenant A, store S1, device A
    const b = await h.seedDevice('t170-b'); // tenant B

    // A real tenant-B media row at the id under probe — seeded via the owner handle so it EXISTS but
    // is RLS-hidden from tenant A (non-vacuity, T-14b).
    const crossTenant = await h.seedCompleteMedia({
      tenantId: b.tenantId,
      storeId: b.storeId,
      deviceId: b.deviceId,
      userId: b.userId,
      bytes: buildImage(300, 'image/jpeg', 't170-b'),
      seed: 't170-b',
    });
    // Non-vacuity: tenant B's row EXISTS before we believe anything about the probe (T-14b).
    const present = await h.db
      .selectFrom('media')
      .select('id')
      .where('id', '=', crossTenant.mediaId)
      .execute();
    expect(present.length).toBe(1);

    const fresh = detUuidV7('t170-fresh');
    const probeBody = initBodyFor(a, buildImage(300, 'image/jpeg', 't170-probe'), 'image/jpeg');

    // The oracle test: init at the id tenant B holds must be BYTE-IDENTICAL to init at a free id.
    const held = await h.app.request(initReq(crossTenant.mediaId, probeBody, a.auth));
    const free = await h.app.request(initReq(fresh, probeBody, a.auth));
    expect(held.status, 'a foreign id must not reveal existence via status').toBe(free.status);
    expect(held.status, 'a tenant-scoped id is free in tenant A — init creates it').toBe(200);
    expect(await held.clone().text(), 'held and free init bodies must be identical').toBe(
      await free.clone().text(),
    );
    expect(await held.json()).toMatchObject({ status: 'receiving', receivedChunks: [] });

    // Isolation: tenant A now owns ITS OWN row at that id; tenant B's row is untouched. Two tenants,
    // one id — the point of D23 §2.
    const asA = await h.testDb.appForTenant(a.tenantId, (db) =>
      db
        .selectFrom('media')
        .select(['id', 'deviceId'])
        .where('id', '=', crossTenant.mediaId)
        .execute(),
    );
    expect(asA).toEqual([{ id: crossTenant.mediaId, deviceId: a.deviceId }]); // A's own new row
    const asB = await h.testDb.appForTenant(b.tenantId, (db) =>
      db
        .selectFrom('media')
        .select(['id', 'deviceId'])
        .where('id', '=', crossTenant.mediaId)
        .execute(),
    );
    expect(asB).toEqual([{ id: crossTenant.mediaId, deviceId: b.deviceId }]); // untouched, still B's
  });

  test('a same-tenant other-device id answers 404 (uploader binding, api/03 §2) — an existing-row denial, not the cross-tenant oracle', async () => {
    const a = await h.seedDevice('t170-bind-a'); // tenant A, store S1, device A

    // A same-tenant media owned by ANOTHER device in tenant A: init's device-binding branch — an
    // existing row whose device != the caller's → MEDIA_NOT_FOUND (api/03 §2). This 404 is about
    // uploader binding, not existence: it is the SAME 404 an unrelated caller gets, and it does not
    // reveal cross-tenant anything (the row is in the caller's OWN tenant).
    const otherDevice = await h.seedDeviceInTenant('t170-a2', {
      tenantId: a.tenantId,
      storeId: a.storeId,
    });
    const sameTenantOther = await h.seedCompleteMedia({
      tenantId: a.tenantId,
      storeId: a.storeId,
      deviceId: otherDevice.deviceId,
      userId: otherDevice.userId,
      bytes: buildImage(300, 'image/jpeg', 't170-a-other'),
      seed: 't170-a-other',
    });

    // Non-vacuity: the other-device row EXISTS before we believe a 404 (T-14b).
    const present = await h.db
      .selectFrom('media')
      .select('id')
      .where('id', '=', sameTenantOther.mediaId)
      .execute();
    expect(present.length).toBe(1);

    const probeBody = initBodyFor(a, buildImage(300, 'image/jpeg', 't170-probe'), 'image/jpeg');
    const res = await h.app.request(initReq(sameTenantOther.mediaId, probeBody, a.auth));
    expect(res.status, 'an existing in-tenant row owned by another device → 404').toBe(404);
    expect((await readError(res)).error.code).toBe('MEDIA_NOT_FOUND');
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

// D23 §2 — media id uniqueness is `(tenant_id, id)`, not global, so `POST /v1/media/:id/init`
// stops being a cross-tenant existence oracle (task 170; discharges a SEC-TENANT-04 finding).
//
// THE DEFECT THIS CLOSES. `init` creates a media row at a CALLER-SUPPLIED id. While `media.id` was
// a global PK, an id another tenant already held could not be inserted — RLS hides the row from the
// SELECT but does not stop a unique conflict (10-db §6) — so the route answered `404
// MEDIA_NOT_FOUND` for a held id and `200 {...,"status":"receiving"}` for a free one. Held-vs-free
// was therefore distinguishable across a tenant boundary, over ids the caller was never shown.
// security-guide §2.2's table forbids that, and D23 §2 ruled it be REMOVED rather than documented:
// this route's budget is `perRoutePerMinute: 120` (~172,800 probes/day), so §2.2 exception 2's
// probe-budget justification — its only remaining leg after D22 §2's addendum withdrew the entropy
// one — does not reach here.
//
// WHY THE ASSERTIONS COMPARE BODIES, NOT ONLY STATUSES. A fix that merely moves the difference from
// the status line into the body is not a fix. The `receivedChunks`/`totalChunks` echo makes that a
// live risk here, so the indistinguishability leg asserts status AND code AND the parsed body.
//
// These run on the real PostgreSQL 16 lane (D16/task 81), so the composite key, the FK and the
// per-tenant `ON CONFLICT` target are exercised by the engine that enforces them in production —
// not by a unit test over an index definition.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  chunkize,
  completeReq,
  detUuidV7,
  downloadReq,
  initBodyFor,
  initReq,
  makeMediaHarness,
  sha256Hex,
  statusReq,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

interface InitOk {
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  status: string;
}

describe('media id is tenant-scoped (D23 §2)', () => {
  test('init of an id ANOTHER tenant holds is indistinguishable from init of a free id — status, code and body', async () => {
    const a = await h.seedDevice('ts-oracle-a');
    const b = await h.seedDevice('ts-oracle-b');
    const bytes = buildImage(1000, 'image/jpeg', 'ts-oracle');

    // Tenant B takes an id. Its row is real and in-flight; nothing about it is ever shown to A.
    const heldId = detUuidV7('ts-oracle:held');
    const bInit = await h.app.request(initReq(heldId, initBodyFor(b, bytes, 'image/jpeg'), b.auth));
    expect(bInit.status).toBe(200);

    // A globally-free id, same shape, same tenant-A caller.
    const freeId = detUuidV7('ts-oracle:free');

    const held = await h.app.request(initReq(heldId, initBodyFor(a, bytes, 'image/jpeg'), a.auth));
    const free = await h.app.request(initReq(freeId, initBodyFor(a, bytes, 'image/jpeg'), a.auth));
    const heldBody = (await held.json()) as InitOk;
    const freeBody = (await free.json()) as InitOk;

    // The oracle is closed only if BOTH legs answer the ordinary success, not merely if they match:
    // two identical 404s would also "match" while making the endpoint useless.
    expect(held.status, 'an id another tenant holds must not exist in this tenant').toBe(200);
    expect(free.status).toBe(200);
    expect(heldBody).toEqual(freeBody);
    expect(heldBody).toEqual({
      chunkSize: 262144,
      totalChunks: 1,
      receivedChunks: [],
      status: 'receiving',
    });

    // …and B's row is untouched by A's init at the same id: two rows, two tenants, one id.
    const rows = await h.db
      .selectFrom('media')
      .select(['tenantId', 'deviceId'])
      .where('id', '=', heldId)
      .orderBy('tenantId')
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([a.tenantId, b.tenantId]));
  });

  test('cross-tenant collision: two tenants upload DIFFERENT bytes under the SAME media id, independently, end to end', async () => {
    const a = await h.seedDevice('ts-collide-a');
    const b = await h.seedDevice('ts-collide-b');
    const sharedId = detUuidV7('ts-collide:shared');

    // Deliberately different payloads: if either tenant's chunks or blob leaked into the other's,
    // the sha256 check at complete (or the downloaded bytes) would catch it.
    const bytesA = buildImage(1500, 'image/jpeg', 'ts-collide-a');
    const bytesB = buildImage(2200, 'image/png', 'ts-collide-b');
    expect(sha256Hex(bytesA)).not.toBe(sha256Hex(bytesB));

    for (const leg of [
      { ctx: a, bytes: bytesA, mime: 'image/jpeg' as const },
      { ctx: b, bytes: bytesB, mime: 'image/png' as const },
    ]) {
      const init = await h.app.request(
        initReq(sharedId, initBodyFor(leg.ctx, leg.bytes, leg.mime), leg.ctx.auth),
      );
      expect(init.status, `init for ${leg.mime}`).toBe(200);
      const chunks = chunkize(leg.bytes);
      for (let i = 0; i < chunks.length; i += 1) {
        const put = await h.app.request(
          chunkReq(sharedId, i, chunks[i] as Uint8Array, leg.ctx.auth),
        );
        expect(put.status, `chunk ${i} for ${leg.mime}`).toBe(200);
      }
      const done = await h.app.request(completeReq(sharedId, leg.ctx.auth));
      expect(done.status, `complete for ${leg.mime}`).toBe(200);
    }

    // Each tenant downloads ITS OWN bytes under the shared id — the blob key is tenant-prefixed and
    // the read is RLS-scoped, so neither can reach the other's object.
    const dlA = await h.app.request(downloadReq(sharedId, a.auth));
    const dlB = await h.app.request(downloadReq(sharedId, b.auth));
    expect(dlA.status).toBe(200);
    expect(dlB.status).toBe(200);
    expect(dlA.headers.get('Content-Type')).toBe('image/jpeg');
    expect(dlB.headers.get('Content-Type')).toBe('image/png');
    expect(sha256Hex(new Uint8Array(await dlA.arrayBuffer()))).toBe(sha256Hex(bytesA));
    expect(sha256Hex(new Uint8Array(await dlB.arrayBuffer()))).toBe(sha256Hex(bytesB));

    // Two complete rows at one id; each carries its own hash and its own tenant-prefixed blob key.
    const rows = await h.db
      .selectFrom('media')
      .select(['tenantId', 'sha256', 'storageKey', 'status'])
      .where('id', '=', sharedId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.sha256))).toEqual(
      new Set([sha256Hex(bytesA), sha256Hex(bytesB)]),
    );
    expect(new Set(rows.map((r) => r.storageKey))).toHaveLength(2);
    expect(rows.every((r) => r.status === 'complete')).toBe(true);
  });

  test('positive control: a legitimate double-init of the caller’s OWN in-flight id still behaves per api/03-media §3.1', async () => {
    const a = await h.seedDevice('ts-double');
    const bytes = buildImage(300_000, 'image/jpeg', 'ts-double'); // 2 chunks
    const id = detUuidV7('ts-double:media');
    const body = initBodyFor(a, bytes, 'image/jpeg');

    const first = await h.app.request(initReq(id, body, a.auth));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      chunkSize: 262144,
      totalChunks: 2,
      receivedChunks: [],
      status: 'receiving',
    });

    // A chunk lands, then the SAME body is re-initted (crash-resume): idempotent 200 that reports
    // the server-authoritative received set — NOT a fresh row, and not a 404.
    const chunks = chunkize(bytes);
    expect((await h.app.request(chunkReq(id, 0, chunks[0] as Uint8Array, a.auth))).status).toBe(
      200,
    );
    const again = await h.app.request(initReq(id, body, a.auth));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      chunkSize: 262144,
      totalChunks: 2,
      receivedChunks: [0],
      status: 'receiving',
    });

    // A DIFFERING body at the same in-flight id is still 409 INIT_MISMATCH (not silently accepted).
    const mismatch = await h.app.request(
      initReq(
        id,
        initBodyFor(a, buildImage(400, 'image/jpeg', 'ts-double-x'), 'image/jpeg'),
        a.auth,
      ),
    );
    expect(mismatch.status).toBe(409);
    expect((await readError(mismatch)).error.code).toBe('INIT_MISMATCH');

    // The row is unchanged and the upload still completes.
    const st = await h.app.request(statusReq(id, a.auth));
    expect((await st.json()) as unknown).toMatchObject({
      receivedChunks: [0],
      status: 'receiving',
    });
    expect((await h.app.request(chunkReq(id, 1, chunks[1] as Uint8Array, a.auth))).status).toBe(
      200,
    );
    expect((await h.app.request(completeReq(id, a.auth))).status).toBe(200);

    // …and a complete id re-initted is still 409 MEDIA_IMMUTABLE (api/03 §3.1), tenant-scoping or not.
    const afterComplete = await h.app.request(initReq(id, body, a.auth));
    expect(afterComplete.status).toBe(409);
    expect((await readError(afterComplete)).error.code).toBe('MEDIA_IMMUTABLE');
  });

  test('another DEVICE in the caller’s own tenant still cannot address the row (api/03 §2 uploader binding)', async () => {
    const a = await h.seedDevice('ts-binding-a');
    const peer = await h.seedDeviceInTenant('ts-binding-b', {
      tenantId: a.tenantId,
      storeId: a.storeId,
    });
    const bytes = buildImage(900, 'image/jpeg', 'ts-binding');
    const id = detUuidV7('ts-binding:media');
    expect(
      (await h.app.request(initReq(id, initBodyFor(a, bytes, 'image/jpeg'), a.auth))).status,
    ).toBe(200);

    // Same tenant, different device: the row IS visible to RLS, so this leg is the one tenant
    // scoping could have quietly broken. It must still be 404 — and it must NOT have created a
    // second row, since uniqueness is per tenant, not per device.
    const peerInit = await h.app.request(
      initReq(id, initBodyFor(peer, bytes, 'image/jpeg'), peer.auth),
    );
    expect(peerInit.status).toBe(404);
    expect((await readError(peerInit)).error.code).toBe('MEDIA_NOT_FOUND');
    const rows = await h.db.selectFrom('media').select('id').where('id', '=', id).execute();
    expect(rows).toHaveLength(1);
  });
});

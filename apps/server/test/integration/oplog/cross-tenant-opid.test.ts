// Task 114 (class sweep) — `POST /v1/sync/push` must NOT be a cross-tenant op-id existence oracle.
//
// `operations.id` is a GLOBAL uuid PK (10-db §5). The pipeline's dedupe step (05 §5) is an
// RLS-scoped SELECT, so an op id an RLS-hidden row in ANOTHER tenant already holds passes dedupe as
// new — then `insertOperationRow` trips the global PK (RLS filters SELECTs, not unique-index
// conflicts, 10-db §6). Before the fix that unique violation threw out of `forTenant` and surfaced
// as `500 INTERNAL`, while a SAME-tenant replay of an accepted op answered a clean per-op
// `duplicate` inside a 200 envelope: the status distinguished "this op id exists in another tenant"
// from "does not exist". The fix maps the collision to the SAME `duplicate`, indistinguishable from
// a replay (security-guide §2.2; task 114) — and preserves the gapless serverSeq invariant via a
// per-op SAVEPOINT (10-db §3).
import { describe, expect, test } from 'vitest';

import { resign } from '@bolusi/test-support';

import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness } from '../sync/helpers.js';

describe('task 114 — sync push op-id collision is not a cross-tenant existence oracle', () => {
  test('an op whose id collides with another tenant’s op reads as `duplicate` (like a same-tenant replay), never a 500', async () => {
    const h = await makeSyncHarness();
    try {
      // Tenant B accepts a genesis op → its id now exists globally in `operations`.
      const b = await h.seedDevice(1);
      const bGenesis = b.builder.genesis();
      const bRes = await h.push(b.auth, b.world.deviceId, [bGenesis]);
      expect(bRes.status).toBe(200);
      expect(((await bRes.json()) as { results: { status: string }[] }).results[0]?.status).toBe(
        'accepted',
      );

      // Non-vacuity (T-14b): B's op row exists (owner handle sees it across the boundary).
      const present = await h.db
        .selectFrom('operations')
        .select('id')
        .where('id', '=', bGenesis.id)
        .executeTakeFirst();
      expect(present).toBeDefined();

      // Tenant A crafts a VALID, correctly-signed genesis whose id == B's op id. Only the id is
      // foreign: `resign` re-hashes + re-signs A's own signed core with A's key, so device binding,
      // signature, chain (genesis) and scope all pass — the op reaches the INSERT.
      const a = await h.seedDevice(2);
      const aGenesis = a.builder.genesis();
      expect(bGenesis.id).not.toBe(aGenesis.id); // distinct worlds mint distinct ids (sanity)
      const colliding = resign(
        { ...aGenesis, id: bGenesis.id },
        a.world.secretKey,
        serverCryptoPort,
      );

      const aRes = await h.push(a.auth, a.world.deviceId, [colliding]);
      expect(aRes.status, 'a colliding op id must not 500 (a cross-tenant existence oracle)').toBe(
        200,
      );
      const aBody = (await aRes.json()) as { results: { id: string; status: string }[] };
      expect(
        aBody.results[0]?.status,
        'a cross-tenant op-id collision reads as an indistinguishable duplicate',
      ).toBe('duplicate');

      // Fail-closed: the single global row for that id is still B's — A neither created nor
      // overwrote it.
      const row = await h.db
        .selectFrom('operations')
        .select(['id', 'tenantId', 'deviceId'])
        .where('id', '=', bGenesis.id)
        .executeTakeFirstOrThrow();
      expect(row.tenantId).toBe(b.world.tenantId);
      expect(row.deviceId).toBe(b.world.deviceId);

      // The legitimate path is intact: A's own genesis still accepts, and a replay is `duplicate` —
      // the exact response the collision is now indistinguishable from. serverSeq stays gapless.
      const accept = await h.push(a.auth, a.world.deviceId, [aGenesis]);
      expect(((await accept.json()) as { results: { status: string }[] }).results[0]?.status).toBe(
        'accepted',
      );
      const replay = await h.push(a.auth, a.world.deviceId, [aGenesis]);
      expect(((await replay.json()) as { results: { status: string }[] }).results[0]?.status).toBe(
        'duplicate',
      );

      // A's tenant now holds exactly its own genesis at serverSeq 1 (gapless — the rolled-back
      // colliding op consumed no number), never B's id. (Filtered by tenant on the owner handle:
      // the harness's `forTenant` is the RLS-bypassing owner, so it would see both tenants.)
      const aOps = await h.db
        .selectFrom('operations')
        .select(['id', 'serverSeq'])
        .where('tenantId', '=', a.world.tenantId)
        .orderBy('serverSeq')
        .execute();
      expect(aOps.map((o) => o.id)).toEqual([aGenesis.id]);
      expect(Number(aOps[0]?.serverSeq)).toBe(1);
    } finally {
      await h.close();
    }
  });
});

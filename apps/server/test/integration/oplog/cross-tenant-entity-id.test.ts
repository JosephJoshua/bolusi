// Projection tables key on GLOBAL, client-minted entity ids, while the rules' existence checks are
// RLS-scoped. An entity id another tenant already holds therefore passes the rules and trips the
// projection PK in the applier. That must be a per-op refusal that spends the op's chain slot, not
// a 500 that rolls back the batch on every retry (a stuck device, and an answer that tells the
// pusher the id exists in some other tenant).
import { describe, expect, test } from 'vitest';

import { ID_TAKEN_REFUSAL } from '../../../src/oplog/pipeline.js';
import { makeSyncHarness, type SeededDevice, type SyncHarness } from '../sync/helpers.js';
import { testId } from './helpers.js';

interface PushResultRow {
  readonly id: string;
  readonly status: string;
  readonly code?: string;
  readonly reason?: string;
  readonly serverSeq?: number;
}

async function enrollAtGenesis(h: SyncHarness, d: SeededDevice): Promise<void> {
  const genesis = d.builder.genesis();
  await h.db
    .updateTable('devices')
    .set({ lastSeq: 1n, lastHash: genesis.hash })
    .where('id', '=', d.world.deviceId)
    .execute();
}

async function results(res: Response): Promise<PushResultRow[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: PushResultRow[] }).results;
}

describe('an entity id another tenant already holds', () => {
  test('refuses only that op, spends its slot, and the rest of the batch lands gapless', async () => {
    const h = await makeSyncHarness();
    try {
      const victim = await h.seedDevice(9101);
      const squatter = await h.seedDevice(9102);
      expect(victim.world.tenantId).not.toBe(squatter.world.tenantId);
      await enrollAtGenesis(h, victim);
      await enrollAtGenesis(h, squatter);

      // The id the victim's device minted offline, created first by another tenant.
      const entityId = testId(9103);
      const squat = squatter.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        entityId,
        payload: { title: 'squat', body: 'x' },
      });
      expect(
        (await results(await h.push(squatter.auth, squatter.world.deviceId, [squat])))[0],
      ).toMatchObject({ status: 'accepted' });

      const before = victim.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        payload: { title: 'before', body: 'a' },
      });
      const own = victim.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        entityId,
        payload: { title: 'mine', body: 'y' },
      });
      const later = victim.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        payload: { title: 'later', body: 'z' },
      });

      const first = await results(
        await h.push(victim.auth, victim.world.deviceId, [before, own, later]),
      );
      expect(first).toEqual([
        { id: before.id, status: 'accepted', serverSeq: expect.any(Number) },
        { id: own.id, status: 'rejected', code: 'RULE_VIOLATED', reason: ID_TAKEN_REFUSAL },
        { id: later.id, status: 'accepted', serverSeq: first[0]!.serverSeq! + 1 },
      ]);

      // A retry of the same batch gets the same answers, never a 500.
      const again = await results(
        await h.push(victim.auth, victim.world.deviceId, [before, own, later]),
      );
      expect(again.map((r) => r.status)).toEqual(['duplicate', 'rejected', 'duplicate']);

      const logged = await h.db
        .selectFrom('operations')
        .select('id')
        .where('tenantId', '=', victim.world.tenantId)
        .orderBy('serverSeq')
        .execute();
      expect(logged.map((r) => r.id)).toEqual([before.id, later.id]);
      const head = await h.db
        .selectFrom('devices')
        .select('lastSeq')
        .where('id', '=', victim.world.deviceId)
        .executeTakeFirstOrThrow();
      expect(Number(head.lastSeq)).toBe(later.seq);

      // The other tenant's note is untouched.
      const note = await h.db
        .selectFrom('notes')
        .select(['tenantId', 'title'])
        .where('id', '=', entityId)
        .executeTakeFirstOrThrow();
      expect(note).toEqual({ tenantId: squatter.world.tenantId, title: 'squat' });
    } finally {
      await h.close();
    }
  });
});

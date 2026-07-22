// Task 139 (QA adversarial sweep, HTTP-C) — a projection APPLIER's unique violation must NOT be
// misreported as `duplicate`.
//
// Before the fix, `projectionEngine.applyPulledOp(op)` ran INSIDE the `SAVEPOINT op_write` catch that
// mapped ANY 23505 to `duplicate`. The applier runs arbitrary module SQL, so two DISTINCT,
// correctly-chained, correctly-signed `notes.note_created` ops sharing one `entityId` made the second
// op's fold trip the `notes` projection PK (`notes_pkey`) — a 23505 the catch absorbed as
// `duplicate`. That is a data-loss + client-brick defect: the op VANISHED from the append-only log
// (05 §1), the client was told `synced` (api/01 §3 maps `duplicate`→synced), and the chain head
// desynced into a permanent CHAIN_BROKEN brick (05 §8) on the device's next push.
//
// The fix (task 139): the dedupe catch is narrowed to `allocateServerSeq` + `insertOperationRow`
// alone and keyed on the constraint NAME `operations_pkey` (the ONLY unique violation those two
// statements raise — a cross-tenant global-PK collision, task 114/security-guide §2.2). The applier
// fold runs AFTER that catch, still inside the savepoint, with its throw PROPAGATING out of
// `forTenant` — a loud 500 that rolls back the whole batch atomically (10-db §3). There is no 05 §8
// rejection code for a schema-valid-but-unfoldable op and minting one is out of scope (CLAUDE.md §6),
// so a loud failure is the specified outcome: never accepted-and-logged, never silently dropped.
//
// PRE-FIX OUTPUT (captured by widening the catch back — §2.11 falsification, real PG16): the primary
// test's own `console.log` reported `results: [accepted, duplicate]`, `op2 durably logged: false`,
// `ops in log: [op1]`, `device lastSeq: 1` — the op vanished. After the fix the same test reports a
// 500 with `ops in log: []` and the head unmoved: the second op is REPORTED (loud), never vanished.
//
// Real PG16 in apps/server's own stamped testcontainer (T-14d), through the production `createApp`
// middleware chain + the real `SERVER_MODULES` projections (notes applier + `notes` table).
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { resign } from '@bolusi/test-support';

import { serverCryptoPort } from '../../../src/oplog/index.js';
import { OPERATIONS_PK_CONSTRAINT } from '../../../src/oplog/persist.js';
import { makeSyncHarness, type SeededDevice, type SyncHarness } from '../sync/helpers.js';
import { testId } from './helpers.js';

interface PushResultRow {
  readonly id: string;
  readonly status: string;
  readonly code?: string;
}

/**
 * Advance a freshly-seeded device to its genesis chain head WITHOUT pushing the genesis op, so the
 * batch under test pushes only `notes` ops at seq ≥ 2 (mirrors `notes-registration.test`'s
 * `setupWorld` — genesis is task 43's `auth.device_enrolled`, not this file's subject).
 */
async function enrollAtGenesis(h: SyncHarness, d: SeededDevice): Promise<void> {
  const genesis = d.builder.genesis(); // advances d.builder to {seq:1, hash}; never pushed
  await h.db
    .updateTable('devices')
    .set({ lastSeq: 1n, lastHash: genesis.hash })
    .where('id', '=', d.world.deviceId)
    .execute();
}

/** Op ids in the append-only log for a tenant, ascending by serverSeq (owner handle — sees the row
 *  regardless of RLS, so a "vanished" op is a genuine absence, not a hidden one). */
async function opIdsInLog(h: SyncHarness, tenantId: string): Promise<string[]> {
  const rows = await h.db
    .selectFrom('operations')
    .select('id')
    .where('tenantId', '=', tenantId)
    .orderBy('serverSeq')
    .execute();
  return rows.map((r) => r.id);
}

async function deviceLastSeq(h: SyncHarness, deviceId: string): Promise<number> {
  const row = await h.db
    .selectFrom('devices')
    .select('lastSeq')
    .where('id', '=', deviceId)
    .executeTakeFirstOrThrow();
  return Number(row.lastSeq); // int8 → string over real `pg` (T-14f); normalise for comparison
}

async function noteIdsFor(h: SyncHarness, tenantId: string): Promise<string[]> {
  const rows = await h.db
    .selectFrom('notes')
    .select('id')
    .where('tenantId', '=', tenantId)
    .execute();
  return rows.map((r) => r.id);
}

describe('task 139 — an applier unique violation is a loud failure, never a silent `duplicate`', () => {
  test('two distinct note_created ops sharing one entityId — the second is a LOUD 500 that rolls the whole batch back, never a `duplicate` that vanishes from the log', async () => {
    const h = await makeSyncHarness();
    try {
      const d = await h.seedDevice(1390);
      await enrollAtGenesis(h, d);

      // Two DISTINCT ops (the builder mints distinct op ids from its id stream) that share one
      // entityId — the exact shape a buggy client double-creating a note would emit. Both are v1
      // `notes.note_created` (the harness registry validates `{title, body}` and the real applier
      // folds v1), correctly chained (seq 2 then 3) and correctly signed.
      const entityId = testId(1390);
      const op1 = d.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        entityId,
        payload: { title: 'Kopi', body: 'karung 1' },
      });
      const op2 = d.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        entityId,
        payload: { title: 'Kopi', body: 'karung 2' },
      });
      expect(op1.id).not.toBe(op2.id); // distinct ops (sanity: not a replay)
      expect(op1.entityId).toBe(op2.entityId); // …that collide on entityId

      const res = await h.push(d.auth, d.world.deviceId, [op1, op2]);

      // Diagnostics that LEAD the report (§2.11): identical lines run pre- and post-fix, so the
      // pre-fix `[accepted, duplicate]` / `op2 durably logged: false` is captured by the same probe.
      const logAfter = await opIdsInLog(h, d.world.tenantId);
      const lastSeqAfter = await deviceLastSeq(h, d.world.deviceId);
      const bodyText = await res.clone().text();
      console.log(
        `[task-139] status=${res.status} body=${bodyText}\n` +
          `  ops in log: ${JSON.stringify(logAfter)}\n` +
          `  op2 durably logged: ${logAfter.includes(op2.id)}\n` +
          `  device lastSeq: ${lastSeqAfter}\n` +
          `  provenance: ${h.provenance}`,
      );

      // The applier throw propagates out of `forTenant` → the Hono error handler → 500 INTERNAL. The
      // op is REPORTED loudly, not swallowed as a success.
      expect(
        res.status,
        'an applier unique violation surfaces loudly, never as a 200 duplicate',
      ).toBe(500);

      // Assert on the LOG, not just the reply. The batch is atomic (10-db §3): the fold that could not
      // happen rolls back its op AND op1 — nothing is half-committed, so the head cannot desync.
      expect(
        logAfter,
        'the whole batch rolled back — neither op is in the append-only log',
      ).toEqual([]);
      expect(logAfter.includes(op2.id), 'op2 must not vanish silently into a `duplicate`').toBe(
        false,
      );
      expect(await noteIdsFor(h, d.world.tenantId), 'no half-written projection row').toEqual([]);
      expect(lastSeqAfter, 'the device chain head did not advance — no CHAIN_BROKEN brick').toBe(1);
    } finally {
      await h.close();
    }
  });

  test('constraint names (verified against the schema): the op-write catch keys on `operations_pkey`, which is a DIFFERENT constraint from the applier’s `notes_pkey`', async () => {
    const h = await makeSyncHarness();
    try {
      const opsPk = await sql<{ conname: string }>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'operations'::regclass AND contype = 'p'
      `.execute(h.db);
      const notesPk = await sql<{ conname: string }>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'notes'::regclass AND contype = 'p'
      `.execute(h.db);

      const opsName = opsPk.rows[0]?.conname;
      const notesName = notesPk.rows[0]?.conname;
      console.log(`[task-139] operations PK=${opsName} notes PK=${notesName} (${h.provenance})`);

      // The name the narrowed catch matches is the REAL constraint (not a guessed string).
      expect(opsName).toBe(OPERATIONS_PK_CONSTRAINT);
      expect(opsName).toBe('operations_pkey');
      // The applier's collision trips a DISTINCT constraint — which is precisely why keying the catch
      // on `operations_pkey` (not SQLSTATE 23505 alone) makes an applier throw re-throw, not absorb.
      expect(notesName).toBe('notes_pkey');
      expect(opsName).not.toBe(notesName);
    } finally {
      await h.close();
    }
  });

  test('POSITIVE CONTROL 1 (task 114 replay) — a genuine same-op-id replay still returns `duplicate` and does NOT 500', async () => {
    const h = await makeSyncHarness();
    try {
      const d = await h.seedDevice(1392);
      await enrollAtGenesis(h, d);
      const note = d.builder.append({
        type: 'notes.note_created',
        entityType: 'note',
        payload: { title: 'x', body: 'y' },
      });

      const first = await h.push(d.auth, d.world.deviceId, [note]);
      expect(first.status).toBe(200);
      expect(((await first.json()) as { results: PushResultRow[] }).results[0]?.status).toBe(
        'accepted',
      );

      // The very same op again: caught by the dedupe step (05 §5), a terminal-success `duplicate`.
      const replay = await h.push(d.auth, d.world.deviceId, [note]);
      expect(replay.status, 'a replay is a clean duplicate, never a 500').toBe(200);
      expect(((await replay.json()) as { results: PushResultRow[] }).results[0]?.status).toBe(
        'duplicate',
      );
      // The narrowing did not regress the log: exactly one row for this op.
      expect(await opIdsInLog(h, d.world.tenantId)).toEqual([note.id]);
    } finally {
      await h.close();
    }
  });

  test('POSITIVE CONTROL 2 (task 114 / security-guide §2.2) — a cross-tenant op-id collision still reads as `duplicate`, never a 500 that confirms the foreign id exists', async () => {
    const h = await makeSyncHarness();
    try {
      // Tenant B accepts a genesis op → its id now exists globally in `operations`.
      const b = await h.seedDevice(1393);
      const bGenesis = b.builder.genesis();
      const bRes = await h.push(b.auth, b.world.deviceId, [bGenesis]);
      expect(((await bRes.json()) as { results: PushResultRow[] }).results[0]?.status).toBe(
        'accepted',
      );

      // Tenant A crafts a VALID genesis whose id == B's op id (only the id is foreign — `resign`
      // re-hashes/re-signs A's own core with A's key, so binding, signature, chain and scope all
      // pass and the op reaches the INSERT, where it trips `operations_pkey`).
      const a = await h.seedDevice(1394);
      const aGenesis = a.builder.genesis();
      const colliding = resign(
        { ...aGenesis, id: bGenesis.id },
        a.world.secretKey,
        serverCryptoPort,
      );

      const aRes = await h.push(a.auth, a.world.deviceId, [colliding]);
      // The narrowed catch STILL maps the `operations_pkey` collision to `duplicate`: if the
      // constraint name were wrong, `isUniqueViolationOn` would return false, the error would
      // propagate, and this would be a 500 existence oracle. So this is the runtime pin of the name.
      expect(aRes.status, 'a colliding op id must not 500 (a cross-tenant existence oracle)').toBe(
        200,
      );
      expect(((await aRes.json()) as { results: PushResultRow[] }).results[0]?.status).toBe(
        'duplicate',
      );

      // Fail-closed: the single global row for that id is still B's — A neither created nor overwrote it.
      const row = await h.db
        .selectFrom('operations')
        .select(['id', 'tenantId'])
        .where('id', '=', bGenesis.id)
        .executeTakeFirstOrThrow();
      expect(row.tenantId).toBe(b.world.tenantId);
    } finally {
      await h.close();
    }
  });
});

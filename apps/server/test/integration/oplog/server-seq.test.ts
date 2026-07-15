// serverSeq allocation through the PIPELINE (10-db §3): only accepted ops consume a value, the
// stream is dense per tenant, tenants are independent, and the counter row is actually LOCKED.
//
// SCOPE OF THIS LANE: PGlite drives one in-process connection, so two transactions here cannot
// genuinely RACE — Kysely serialises them on the single connection. A "concurrent" test on PGlite
// would therefore pass with the FOR UPDATE lock ABSENT and prove nothing (testing-guide T-11).
// The split, forced by the `pg` boundary lock (only packages/db-server may open a real pool):
//   - HERE: the pipeline's per-op accounting + proof it EMITS the FOR UPDATE lock (statement spy).
//   - packages/db-server/test/oplog-server-seq-concurrency.test.ts under `pnpm test:rls`: the same
//     statements raced across REAL pooled connections against postgres:16 — where a missing lock
//     produces duplicate/lost serverSeq and the assertions go red.
import { breakPreviousHash, ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import { makeDeps, makeOplogTestDb, readOps, seedWorld, type OplogTestDb } from './helpers.js';

let testDb: OplogTestDb;

beforeEach(async () => {
  testDb = await makeOplogTestDb();
}, 120_000);

afterEach(async () => {
  await testDb?.close();
});

const identityOf = (world: ChainWorld) => ({ deviceId: world.deviceId, tenantId: world.tenantId });
const note = (title: string, body: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body },
});

async function setupWorld(seed: number, options = {}) {
  const world = makeWorld(seed, serverCryptoPort);
  await seedWorld(testDb.db, world, options);
  return { world, builder: new ChainBuilder(world, serverCryptoPort) };
}

async function counterOf(tenantId: string): Promise<number> {
  const row = await testDb.db
    .selectFrom('tenantOpCounters')
    .select('nextServerSeq')
    .where('tenantId', '=', tenantId)
    .executeTakeFirstOrThrow();
  return Number(row.nextServerSeq);
}

describe('gapless allocation through the pipeline', () => {
  test('a 10-op batch produces dense ascending serverSeq with no gaps', async () => {
    const { world, builder } = await setupWorld(3001);
    const ops = [builder.genesis()];
    for (let i = 0; i < 9; i += 1) ops.push(builder.append(note(`t${i}`, `b${i}`)));

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      ops,
    );

    expect(result.results.map((r) => ('serverSeq' in r ? r.serverSeq : null))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  test('serverSeq continues densely across separate push transactions', async () => {
    const { world, builder } = await setupWorld(3002);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    const first = [builder.genesis(), builder.append(note('a', 'b'))];
    const second = [builder.append(note('c', 'd')), builder.append(note('e', 'f'))];

    await processPushBatch(deps, identityOf(world), first);
    const result = await processPushBatch(deps, identityOf(world), second);

    expect(result.results.map((r) => ('serverSeq' in r ? r.serverSeq : null))).toEqual([3, 4]);
  });

  test('a MIXED batch: max(server_seq) - start == accepted count (rejects/duplicates consume none)', async () => {
    const { world, builder } = await setupWorld(3003);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const unknown = builder.append({
      type: 'notes.note_teleported', // UNKNOWN_TYPE — consumes nothing
      entityType: 'note',
      payload: {},
    });

    // Pre-accept genesis so the replay below is a genuine duplicate.
    await processPushBatch(deps, identityOf(world), [genesis]);
    const start = await counterOf(world.tenantId); // == 2 (genesis consumed 1)

    // duplicate(genesis) + accepted(op2) + accepted(op3) + rejected(unknown)
    const result = await processPushBatch(deps, identityOf(world), [genesis, op2, op3, unknown]);

    const accepted = result.results.filter((r) => r.status === 'accepted');
    expect(result.results.map((r) => r.status)).toEqual([
      'duplicate',
      'accepted',
      'accepted',
      'rejected',
    ]);
    const rows = await readOps(testDb.db, world.tenantId);
    const maxServerSeq = Math.max(...rows.map((r) => Number(r.serverSeq)));
    expect(maxServerSeq - (start - 1)).toBe(accepted.length);
    // And the stream is still dense from 1 — no holes burned by the duplicate or the reject.
    expect(rows.map((r) => Number(r.serverSeq))).toEqual([1, 2, 3]);
  });

  test('a CHAIN_BROKEN + halted remainder consumes no counter values', async () => {
    const { world, builder } = await setupWorld(3004);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    await processPushBatch(deps, identityOf(world), [genesis]);
    const before = await counterOf(world.tenantId);

    const broken = breakPreviousHash(op2, '7'.repeat(64), world.secretKey, serverCryptoPort);
    await processPushBatch(deps, identityOf(world), [broken, op3]);

    expect(await counterOf(world.tenantId)).toBe(before);
  });

  test('two tenants each keep an independently gapless stream starting at 1', async () => {
    const a = await setupWorld(3005);
    const b = await setupWorld(3006);
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    await processPushBatch(deps, identityOf(a.world), [
      a.builder.genesis(),
      a.builder.append(note('a', 'b')),
    ]);
    await processPushBatch(deps, identityOf(b.world), [b.builder.genesis()]);

    // Separate counter rows (10-db §3): tenant B's stream is not advanced by tenant A's ops.
    expect((await readOps(testDb.db, a.world.tenantId)).map((r) => Number(r.serverSeq))).toEqual([
      1, 2,
    ]);
    expect((await readOps(testDb.db, b.world.tenantId)).map((r) => Number(r.serverSeq))).toEqual([
      1,
    ]);
  });
});

describe('the counter row lock is actually taken (statement spy)', () => {
  test('the pipeline locks tenant_op_counters FOR UPDATE at transaction start', async () => {
    const { world, builder } = await setupWorld(3010);
    testDb.appStatements.length = 0; // drop seeding noise; only the push is under inspection

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      builder.genesis(),
    ]);

    // This is what ties THIS pipeline to the lock the real-Postgres race proves out: without the
    // FOR UPDATE the race in db-server's lane produces duplicate serverSeq, and a PGlite-only
    // suite would never notice.
    const locking = testDb.appStatements.filter(
      (s) => /tenant_op_counters/i.test(s) && /for update/i.test(s),
    );
    expect(locking.length).toBeGreaterThanOrEqual(1);
  });

  test('the lock is taken BEFORE any operations INSERT', async () => {
    const { world, builder } = await setupWorld(3011);
    testDb.appStatements.length = 0;

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      builder.genesis(),
    ]);

    const lockAt = testDb.appStatements.findIndex(
      (s) => /tenant_op_counters/i.test(s) && /for update/i.test(s),
    );
    const insertAt = testDb.appStatements.findIndex((s) => /insert into "operations"/i.test(s));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(insertAt);
  });

  test('allocation increments and returns the consumed value (UPDATE ... RETURNING)', async () => {
    const { world, builder } = await setupWorld(3012);
    testDb.appStatements.length = 0;

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      builder.genesis(),
    ]);

    const allocating = testDb.appStatements.filter(
      (s) => /update "tenant_op_counters"/i.test(s) && /returning/i.test(s),
    );
    // Exactly one accepted op ⇒ exactly one allocation.
    expect(allocating).toHaveLength(1);
  });

  test('a rejected op issues NO allocation statement', async () => {
    const { world, builder } = await setupWorld(3013);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    await processPushBatch(deps, identityOf(world), [genesis]);
    testDb.appStatements.length = 0;

    const broken = breakPreviousHash(op2, '8'.repeat(64), world.secretKey, serverCryptoPort);
    await processPushBatch(deps, identityOf(world), [broken]);

    const allocating = testDb.appStatements.filter(
      (s) => /update "tenant_op_counters"/i.test(s) && /returning/i.test(s),
    );
    expect(allocating).toEqual([]);
  });
});

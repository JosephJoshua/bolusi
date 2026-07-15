// SEC-OPLOG-01/02/03/04/05/08 — the required adversarial tests for the operation-log integrity
// surface (security-guide §3.2). Titles embed the id VERBATIM so SEC-META-01 can grep them
// (security-guide §2.1.3).
//
// Every tamper here is built from real noble-signed ops (@bolusi/test-support builders) and
// changes EXACTLY ONE thing, so the op is structurally valid except for the tampered field and the
// rejection is ATTRIBUTABLE (testing-guide T-14b). Each id also ships its FIXTURE-VALIDITY CONTROL:
// the same op with the tampered thing CORRECTED must be ACCEPTED — without it, a test could pass
// because the op was malformed in some other way and prove nothing about the gate under test.
//
// SEC-OPLOG-06 (JCS vectors on Hermes) is task 03's and ships there; SEC-OPLOG-09 (client pull-side
// quarantine) is task 15's. SEC-OPLOG-07 (no mutation path) is in ./sec-oplog-07.test.ts.
import {
  breakPreviousHash,
  ChainBuilder,
  forgeSignature,
  makeWorld,
  mutateHashField,
  mutatePayloadPostHash,
  mutateUserIdPostHash,
  relabelDeviceId,
  type ChainWorld,
} from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import {
  makeDeps,
  makeFakeClock,
  makeOplogTestDb,
  readAnomalies,
  readOps,
  seedDevice,
  seedUser,
  seedWorld,
  testId,
  type OplogTestDb,
} from './helpers.js';

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

// =================================================================================================
describe('SEC-OPLOG-01 forged signature rejected', () => {
  test('SEC-OPLOG-01 forged signature rejected with BAD_SIGNATURE', async () => {
    const { world, builder } = await setupWorld(2001);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const attacker = makeWorld(2002, serverCryptoPort);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // Structurally valid op, CORRECT hash — only the signature is by a non-enrolled key.
    const forged = forgeSignature(op2, attacker.secretKey, serverCryptoPort);
    const result = await processPushBatch(deps, identityOf(world), [forged]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
  });

  test('SEC-OPLOG-01 forged signature is not persisted as accepted', async () => {
    const { world, builder } = await setupWorld(2003);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const attacker = makeWorld(2004, serverCryptoPort);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const forged = forgeSignature(op2, attacker.secretKey, serverCryptoPort);
    await processPushBatch(deps, identityOf(world), [forged]);

    const rows = await readOps(testDb.db, world.tenantId);
    expect(rows.map((r) => r.id)).toEqual([genesis.id]);
  });

  test('SEC-OPLOG-01 forged signature records a BAD_SIGNATURE device_anomalies row', async () => {
    const { world, builder } = await setupWorld(2005);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const attacker = makeWorld(2006, serverCryptoPort);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const forged = forgeSignature(op2, attacker.secretKey, serverCryptoPort);
    await processPushBatch(deps, identityOf(world), [forged]);

    const anomalies = await readAnomalies(testDb.db, world.deviceId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ kind: 'BAD_SIGNATURE', deviceId: world.deviceId });
    // detail carries the op id + context, NEVER the rejected op body (10-db §4).
    expect(anomalies[0]?.detail).toMatchObject({ opId: op2.id });
    expect(JSON.stringify(anomalies[0]?.detail)).not.toContain('"payload"');
  });

  test('SEC-OPLOG-01 the same op with its GENUINE signature is ACCEPTED (fixture-validity control)', async () => {
    const { world, builder } = await setupWorld(2007);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // The forge test's op, untampered — proves the rejection was the signature and nothing else.
    const result = await processPushBatch(deps, identityOf(world), [op2]);

    expect(result.results[0]).toMatchObject({ status: 'accepted', serverSeq: 2 });
  });
});

// =================================================================================================
describe('SEC-OPLOG-02 replayed op is inert', () => {
  test('SEC-OPLOG-02 replayed op returns duplicate', async () => {
    const { world, builder } = await setupWorld(2010);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis, op2]);

    const replay = await processPushBatch(deps, identityOf(world), [genesis, op2]);

    expect(replay.results).toEqual([
      { id: genesis.id, status: 'duplicate' },
      { id: op2.id, status: 'duplicate' },
    ]);
  });

  test('SEC-OPLOG-02 replay leaves every serverSeq UNCHANGED', async () => {
    const { world, builder } = await setupWorld(2011);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis, op2]);
    const before = await readOps(testDb.db, world.tenantId);

    await processPushBatch(deps, identityOf(world), [genesis, op2]);
    const after = await readOps(testDb.db, world.tenantId);

    expect(after.map((r) => [r.id, String(r.serverSeq)])).toEqual(
      before.map((r) => [r.id, String(r.serverSeq)]),
    );
  });

  test('SEC-OPLOG-02 replay consumes no counter value (server state unchanged)', async () => {
    const { world, builder } = await setupWorld(2012);
    const ops = [builder.genesis(), builder.append(note('a', 'b'))];
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), ops);

    await processPushBatch(deps, identityOf(world), ops);

    const counter = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', world.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(counter.nextServerSeq)).toBe(3); // 2 accepted ops, nothing more
    expect(await readOps(testDb.db, world.tenantId)).toHaveLength(2);
  });
});

// =================================================================================================
describe('SEC-OPLOG-03 resequenced chain rejected', () => {
  test('SEC-OPLOG-03 resequenced chain rejects CHAIN_BROKEN', async () => {
    const { world, builder } = await setupWorld(2020);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis, op2]);

    // A reorder: the op at the expected seq links to the WRONG predecessor (op3's own hash rather
    // than op2's). Correctly signed over that core, so it passes the crypto gate and the CHAIN
    // check is unambiguously what rejects it.
    const resequenced = breakPreviousHash(op3, genesis.hash, world.secretKey, serverCryptoPort);
    const result = await processPushBatch(deps, identityOf(world), [resequenced]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
  });

  test('SEC-OPLOG-03 the batch remainder after CHAIN_BROKEN is CHAIN_HALTED', async () => {
    const { world, builder } = await setupWorld(2021);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const op4 = builder.append(note('e', 'f'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const resequenced = breakPreviousHash(
      op2,
      genesis.hash.replace(/^./, '9'),
      world.secretKey,
      serverCryptoPort,
    );
    const result = await processPushBatch(deps, identityOf(world), [resequenced, op3, op4]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'CHAIN_BROKEN',
      'CHAIN_HALTED',
      'CHAIN_HALTED',
    ]);
  });

  test('SEC-OPLOG-03 skip-ahead is CHAIN_GAP, DISTINGUISHED from CHAIN_BROKEN', async () => {
    const { world, builder } = await setupWorld(2022);
    const genesis = builder.genesis();
    builder.append(note('a', 'b')); // seq 2 — deliberately never pushed
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // seq 3 after seq 1: the client thinks seq 2 was acked. A RESEND, not tamper.
    const result = await processPushBatch(deps, identityOf(world), [op3]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_GAP' });
    // The distinction is the whole point: a suite that lumped gap and broken together would be
    // vacuous. A gap is recoverable and raises NO tamper alarm.
    expect(result.results[0]).not.toMatchObject({ code: 'CHAIN_BROKEN' });
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });

  test('SEC-OPLOG-03 CHAIN_BROKEN raises a tamper alarm where CHAIN_GAP does not', async () => {
    const { world, builder } = await setupWorld(2023);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const broken = breakPreviousHash(op2, '1'.repeat(64), world.secretKey, serverCryptoPort);
    await processPushBatch(deps, identityOf(world), [broken]);

    const anomalies = await readAnomalies(testDb.db, world.deviceId);
    expect(anomalies.map((a) => a.kind)).toEqual(['CHAIN_BROKEN']);
  });

  test('SEC-OPLOG-03 the same chain in correct order is ACCEPTED (fixture-validity control)', async () => {
    const { world, builder } = await setupWorld(2024);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    const result = await processPushBatch(deps, identityOf(world), [genesis, op2, op3]);

    expect(result.results).toEqual([
      { id: genesis.id, status: 'accepted', serverSeq: 1 },
      { id: op2.id, status: 'accepted', serverSeq: 2 },
      { id: op3.id, status: 'accepted', serverSeq: 3 },
    ]);
  });
});

// =================================================================================================
describe('SEC-OPLOG-04 cross-device seq splice rejected', () => {
  /** Device B enrolled in device A's tenant — the splice target. */
  async function setupSplice(seedA: number, seedB: number) {
    const worldA = makeWorld(seedA, serverCryptoPort);
    await seedWorld(testDb.db, worldA);
    const rawB = makeWorld(seedB, serverCryptoPort);
    // Same tenant/store/user, B's own deviceId + keypair.
    const worldB: ChainWorld = {
      ...rawB,
      tenantId: worldA.tenantId,
      storeId: worldA.storeId,
      userId: worldA.userId,
    };
    await seedDevice(testDb.db, worldB);
    return { worldA, worldB };
  }

  test('SEC-OPLOG-04 an op signed by device A pushed via device B token is SCOPE_VIOLATION', async () => {
    const { worldA, worldB } = await setupSplice(2030, 2031);
    const builderA = new ChainBuilder(worldA, serverCryptoPort);
    const genesisA = builderA.genesis();
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    // A's genuine, correctly-signed op — pushed on B's token, still claiming deviceId = A.
    const result = await processPushBatch(deps, identityOf(worldB), [genesisA]);

    // Device binding (05 §9.1) rejects it BEFORE the crypto gate: one token, one device, one chain.
    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('SEC-OPLOG-04 an op relabelled to B but signed by A is BAD_SIGNATURE', async () => {
    const { worldA, worldB } = await setupSplice(2032, 2033);
    const builderA = new ChainBuilder(worldA, serverCryptoPort);
    const genesisA = builderA.genesis();
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    // Rewrite deviceId to B so device binding passes — now the signature must answer for it.
    const spliced = relabelDeviceId(genesisA, worldB.deviceId);
    const result = await processPushBatch(deps, identityOf(worldB), [spliced]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
  });

  test('SEC-OPLOG-04 a spliced op is NEVER accepted into B chain', async () => {
    const { worldA, worldB } = await setupSplice(2034, 2035);
    const builderA = new ChainBuilder(worldA, serverCryptoPort);
    const genesisA = builderA.genesis();
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    await processPushBatch(deps, identityOf(worldB), [genesisA]);
    await processPushBatch(deps, identityOf(worldB), [relabelDeviceId(genesisA, worldB.deviceId)]);

    expect(await readOps(testDb.db, worldB.tenantId)).toEqual([]);
    const device = await testDb.db
      .selectFrom('devices')
      .select(['lastSeq', 'lastHash'])
      .where('id', '=', worldB.deviceId)
      .executeTakeFirstOrThrow();
    expect(Number(device.lastSeq)).toBe(0);
    expect(device.lastHash).toBeNull();
  });

  test('SEC-OPLOG-04 device B own genesis on B token is ACCEPTED (fixture-validity control)', async () => {
    const { worldB } = await setupSplice(2036, 2037);
    const builderB = new ChainBuilder(worldB, serverCryptoPort);
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    const result = await processPushBatch(deps, identityOf(worldB), [builderB.genesis()]);

    // B's chain works — so the splice rejections above are about the splice, not a broken fixture.
    expect(result.results[0]).toMatchObject({ status: 'accepted' });
  });
});

// =================================================================================================
describe('SEC-OPLOG-05 payload mutation post-hash rejected', () => {
  test('SEC-OPLOG-05 payload mutated after hashing is BAD_SIGNATURE', async () => {
    const { world, builder } = await setupWorld(2040);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // hash + signature untouched; the server recomputes JCS from the RECEIVED fields and the
    // recomputed digest no longer matches (05 §3 verbatim-bytes rule).
    const result = await processPushBatch(deps, identityOf(world), [mutatePayloadPostHash(op2)]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
  });

  test('SEC-OPLOG-05 a mutated non-payload core field (userId) is BAD_SIGNATURE', async () => {
    const { world, builder } = await setupWorld(2041);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const otherUser = testId(2042);
    await seedUser(testDb.db, world.tenantId, otherUser);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // The substituted user IS a tenant member, so scope would pass — only the hash recompute can
    // reject this. Re-attributing an op to a colleague is the fraud this gate exists for.
    const result = await processPushBatch(deps, identityOf(world), [
      mutateUserIdPostHash(op2, otherUser),
    ]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
  });

  test('SEC-OPLOG-05 a mutated hash field with a genuine core and signature is BAD_SIGNATURE', async () => {
    const { world, builder } = await setupWorld(2045);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // The class the hash CROSS-CHECK owns, and the ONLY tamper here the signature cannot see: the
    // core is untouched and the signature over its recomputed digest still verifies. Mutation
    // testing (scripts/falsify-oplog.mjs) found this gap — disabling the cross-check left the rest
    // of this suite green. Accepting it would store an op whose `hash` column contradicts its own
    // content, and every later op chains onto that lie.
    const tampered = mutateHashField(op2, 'a'.repeat(64));
    const result = await processPushBatch(deps, identityOf(world), [tampered]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'BAD_SIGNATURE' });
  });

  test('SEC-OPLOG-05 an op with a mutated hash field never reaches the log', async () => {
    const { world, builder } = await setupWorld(2046);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    await processPushBatch(deps, identityOf(world), [mutateHashField(op2, 'b'.repeat(64))]);

    // The chain head must NOT have advanced onto a fabricated hash.
    expect((await readOps(testDb.db, world.tenantId)).map((r) => r.id)).toEqual([genesis.id]);
    const device = await testDb.db
      .selectFrom('devices')
      .select('lastHash')
      .where('id', '=', world.deviceId)
      .executeTakeFirstOrThrow();
    expect(device.lastHash).toBe(genesis.hash);
  });

  test('SEC-OPLOG-05 a post-hash mutation is not persisted', async () => {
    const { world, builder } = await setupWorld(2043);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    await processPushBatch(deps, identityOf(world), [mutatePayloadPostHash(op2)]);

    expect((await readOps(testDb.db, world.tenantId)).map((r) => r.id)).toEqual([genesis.id]);
  });

  test('SEC-OPLOG-05 the same op unmutated is ACCEPTED (fixture-validity control)', async () => {
    const { world, builder } = await setupWorld(2044);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [op2]);

    expect(result.results[0]).toMatchObject({ status: 'accepted', serverSeq: 2 });
  });
});

// =================================================================================================
describe('SEC-OPLOG-08 clock skew flagged not rejected', () => {
  const RECEIVED_AT = 1_726_900_000_000;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  test('SEC-OPLOG-08 an op 30 days older than receivedAt is ACCEPTED, not rejected', async () => {
    // lastSyncAt is recent, so the offline window adds nothing: threshold ≈ 48h ≪ 30 days.
    const { world, builder } = await setupWorld(2050, { lastSyncAt: RECEIVED_AT - 60_000 });
    const clock = makeFakeClock(RECEIVED_AT);
    const genesis = builder.genesis({ timestamp: RECEIVED_AT - THIRTY_DAYS });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant, clock }),
      identityOf(world),
      [genesis],
    );

    // 05 §6: the server flags, NEVER rejects — the timestamp is business truth; assume drift.
    expect(result.results[0]).toMatchObject({ status: 'accepted' });
  });

  test('SEC-OPLOG-08 the skewed op is stored with clock_skew_flagged = true', async () => {
    const { world, builder } = await setupWorld(2051, { lastSyncAt: RECEIVED_AT - 60_000 });
    const clock = makeFakeClock(RECEIVED_AT);
    const genesis = builder.genesis({ timestamp: RECEIVED_AT - THIRTY_DAYS });

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant, clock }), identityOf(world), [
      genesis,
    ]);

    const [row] = await readOps(testDb.db, world.tenantId);
    expect(row?.clockSkewFlagged).toBe(true);
    // The timestamp is preserved as written — late sync must not rewrite when the user acted.
    expect(Number(row?.timestampMs)).toBe(RECEIVED_AT - THIRTY_DAYS);
  });

  test('SEC-OPLOG-08 the skewed op records a CLOCK_SKEW device_anomalies row', async () => {
    const { world, builder } = await setupWorld(2052, { lastSyncAt: RECEIVED_AT - 60_000 });
    const clock = makeFakeClock(RECEIVED_AT);
    const genesis = builder.genesis({ timestamp: RECEIVED_AT - THIRTY_DAYS });

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant, clock }), identityOf(world), [
      genesis,
    ]);

    const anomalies = await readAnomalies(testDb.db, world.deviceId);
    expect(anomalies.map((a) => a.kind)).toEqual(['CLOCK_SKEW']);
    expect(anomalies[0]).toMatchObject({ deviceId: world.deviceId });
  });

  test('SEC-OPLOG-08 an honest-clock op is accepted UNFLAGGED (skew fixture-validity control)', async () => {
    const { world, builder } = await setupWorld(2053, { lastSyncAt: RECEIVED_AT - 60_000 });
    const clock = makeFakeClock(RECEIVED_AT);
    const genesis = builder.genesis({ timestamp: RECEIVED_AT - 1_000 });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant, clock }),
      identityOf(world),
      [genesis],
    );

    expect(result.results[0]).toMatchObject({ status: 'accepted' });
    const [row] = await readOps(testDb.db, world.tenantId);
    expect(row?.clockSkewFlagged).toBe(false);
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });
});

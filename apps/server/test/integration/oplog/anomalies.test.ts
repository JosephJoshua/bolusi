// device_anomalies recording matrix (10-db §4; FR-829; security-guide §3.1).
//
// EXACTLY the tamper-class rejections (BAD_SIGNATURE, CHAIN_BROKEN, SCOPE_VIOLATION) and the
// CLOCK_SKEW flag write rows. CHAIN_GAP / CHAIN_HALTED / DEVICE_REVOKED / SCHEMA_INVALID /
// UNKNOWN_TYPE / duplicate write NONE — they are routine or version-skew, not tamper indicators,
// and a false alarm on the owner's device list is a real cost.
//
// The negative half asserts its own denominator (T-14): a "no anomaly" assertion is only
// meaningful next to a case that DOES write one on the same fixture shape, so each writes-nothing
// test is paired with the positive control above it.
import {
  breakPreviousHash,
  ChainBuilder,
  forgeSignature,
  makeWorld,
  type ChainWorld,
} from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ANOMALY_KINDS } from '../../../src/oplog/anomalies.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import {
  makeDeps,
  makeFakeClock,
  makeOplogTestDb,
  readAnomalies,
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

describe('the four anomaly kinds are exactly the DDL CHECK set', () => {
  test('ANOMALY_KINDS matches the 10-db §4 CHECK constraint set', () => {
    // The denominator (T-14): if a kind is added to the DDL and not here (or vice versa) an insert
    // fails at runtime, not at review.
    expect([...ANOMALY_KINDS].sort()).toEqual([
      'BAD_SIGNATURE',
      'CHAIN_BROKEN',
      'CLOCK_SKEW',
      'SCOPE_VIOLATION',
    ]);
  });
});

describe('rejections that DO write an anomaly row', () => {
  test('BAD_SIGNATURE writes one row with the op id in detail', async () => {
    const { world, builder } = await setupWorld(4001);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const attacker = makeWorld(4002, serverCryptoPort);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    await processPushBatch(deps, identityOf(world), [
      forgeSignature(op2, attacker.secretKey, serverCryptoPort),
    ]);

    const rows = await readAnomalies(testDb.db, world.deviceId);
    expect(rows.map((r) => r.kind)).toEqual(['BAD_SIGNATURE']);
    expect(rows[0]?.detail).toMatchObject({ opId: op2.id, seq: op2.seq });
  });

  test('CHAIN_BROKEN writes one row', async () => {
    const { world, builder } = await setupWorld(4003);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    await processPushBatch(deps, identityOf(world), [
      breakPreviousHash(op2, '2'.repeat(64), world.secretKey, serverCryptoPort),
    ]);

    expect((await readAnomalies(testDb.db, world.deviceId)).map((r) => r.kind)).toEqual([
      'CHAIN_BROKEN',
    ]);
  });

  test('SCOPE_VIOLATION writes one row', async () => {
    const { world, builder } = await setupWorld(4004);
    const genesis = builder.genesis();
    const stranger = testId(4005);
    const op2 = builder.append({ ...note('a', 'b'), userId: stranger });
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    await processPushBatch(deps, identityOf(world), [op2]);

    expect((await readAnomalies(testDb.db, world.deviceId)).map((r) => r.kind)).toEqual([
      'SCOPE_VIOLATION',
    ]);
  });

  test('CLOCK_SKEW writes one row on an accepted-but-flagged op', async () => {
    const receivedAt = 1_726_900_000_000;
    const { world, builder } = await setupWorld(4006, { lastSyncAt: receivedAt - 60_000 });
    const clock = makeFakeClock(receivedAt);

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant, clock }), identityOf(world), [
      builder.genesis({ timestamp: receivedAt - 30 * 24 * 60 * 60 * 1000 }),
    ]);

    expect((await readAnomalies(testDb.db, world.deviceId)).map((r) => r.kind)).toEqual([
      'CLOCK_SKEW',
    ]);
  });

  test('the anomaly detail never carries the rejected op body (10-db §4)', async () => {
    const { world, builder } = await setupWorld(4007);
    const genesis = builder.genesis();
    const secret = 'super-secret-note-body-do-not-store';
    const op2 = builder.append(note('a', secret));
    const attacker = makeWorld(4008, serverCryptoPort);
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    await processPushBatch(deps, identityOf(world), [
      forgeSignature(op2, attacker.secretKey, serverCryptoPort),
    ]);

    const rows = await readAnomalies(testDb.db, world.deviceId);
    expect(JSON.stringify(rows[0]?.detail)).not.toContain(secret);
  });
});

describe('rejections that write NO anomaly row', () => {
  test('CHAIN_GAP writes none', async () => {
    const { world, builder } = await setupWorld(4010);
    const genesis = builder.genesis();
    builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [op3]);

    // The rejection happened (denominator) — and still raised no alarm.
    expect(result.results[0]).toMatchObject({ code: 'CHAIN_GAP' });
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });

  test('CHAIN_HALTED writes none (only the triggering CHAIN_BROKEN does)', async () => {
    const { world, builder } = await setupWorld(4011);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const op4 = builder.append(note('e', 'f'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [
      breakPreviousHash(op2, '3'.repeat(64), world.secretKey, serverCryptoPort),
      op3,
      op4,
    ]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'CHAIN_BROKEN',
      'CHAIN_HALTED',
      'CHAIN_HALTED',
    ]);
    // Two halted ops, but exactly ONE row — the CHAIN_BROKEN's.
    expect((await readAnomalies(testDb.db, world.deviceId)).map((r) => r.kind)).toEqual([
      'CHAIN_BROKEN',
    ]);
  });

  test('DEVICE_REVOKED writes none', async () => {
    const { world, builder } = await setupWorld(4012, { deviceStatus: 'revoked' });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [builder.genesis()],
    );

    expect(result.results[0]).toMatchObject({ code: 'DEVICE_REVOKED' });
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });

  test('UNKNOWN_TYPE writes none', async () => {
    const { world, builder } = await setupWorld(4013);
    const genesis = builder.genesis();
    const unknown = builder.append({
      type: 'notes.note_teleported',
      entityType: 'note',
      payload: {},
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, unknown],
    );

    expect(result.results[1]).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });

  test('SCHEMA_INVALID writes none', async () => {
    const { world, builder } = await setupWorld(4014);
    const genesis = builder.genesis();
    const bad = builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      payload: { title: 99, body: 'b' },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, bad],
    );

    expect(result.results[1]).toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });

  test('a fully accepted honest batch writes none', async () => {
    const { world, builder } = await setupWorld(4015);

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [builder.genesis(), builder.append(note('a', 'b'))],
    );

    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });
});

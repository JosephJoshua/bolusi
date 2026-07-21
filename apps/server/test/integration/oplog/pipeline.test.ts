// The push-validation pipeline: sequence, happy path, and the rejection matrix (05 §8–9,
// 10-db §3, api/01 §3). One behaviour per test (T-2); every case builds its own world from its
// own seed (T-3). The pipeline runs through `appForTenant` (SET LOCAL ROLE bolusi_app), so RLS
// and the read-append grant on `operations` are exercised, not bypassed.
import { canonicalizeJcs } from '@bolusi/core';
import {
  breakPreviousHash,
  ChainBuilder,
  makeWorld,
  resign,
  toSignedCore,
  type ChainWorld,
} from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { processPushBatch } from '../../../src/oplog/pipeline.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import {
  grantRole,
  makeCryptoSpy,
  makeDeps,
  makeFakeClock,
  makeOplogTestDb,
  readAnomalies,
  readOps,
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

function identityOf(world: ChainWorld) {
  return { deviceId: world.deviceId, tenantId: world.tenantId };
}

/** A world + a genesis-rooted chain, seeded and ready to push. */
async function setupWorld(seed: number, options = {}) {
  const world = makeWorld(seed, serverCryptoPort);
  await seedWorld(testDb.db, world, options);
  const builder = new ChainBuilder(world, serverCryptoPort);
  return { world, builder };
}

const note = (title: string, body: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body },
});

describe('happy path + sequence', () => {
  test('accepts a valid in-order batch with dense ascending serverSeq', async () => {
    const { world, builder } = await setupWorld(1001);
    const ops = [
      builder.genesis(),
      builder.append(note('a', 'one')),
      builder.append(note('b', 'two')),
    ];

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      ops,
    );

    expect(result.results).toEqual([
      { id: ops[0]!.id, status: 'accepted', serverSeq: 1 },
      { id: ops[1]!.id, status: 'accepted', serverSeq: 2 },
      { id: ops[2]!.id, status: 'accepted', serverSeq: 3 },
    ]);
  });

  test('stores signed_core_jcs byte-equal to the exact text that was hashed and verified', async () => {
    const { world, builder } = await setupWorld(1002);
    const op = builder.genesis();

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [op]);

    const [row] = await readOps(testDb.db, world.tenantId);
    // Independently re-derive the canonical bytes from the op's own signed core (05 §3): the
    // stored blob must be byte-identical — never a jsonb reconstruction (10-db §2.1).
    expect(row?.signedCoreJcs).toBe(canonicalizeJcs(toSignedCore(op) as never));
  });

  test('cross-checks the envelope columns against the stored JCS blob', async () => {
    const { world, builder } = await setupWorld(1003);
    const genesis = builder.genesis();
    const noteOp = builder.append(note('x', 'y'));

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      genesis,
      noteOp,
    ]);

    const rows = await readOps(testDb.db, world.tenantId);
    const stored = rows[1]!;
    const blob = JSON.parse(stored.signedCoreJcs) as Record<string, unknown>;
    expect(blob['id']).toBe(stored.id);
    expect(blob['userId']).toBe(stored.userId);
    expect(blob['deviceId']).toBe(stored.deviceId);
    expect(blob['type']).toBe(stored.type);
    expect(Number(stored.seq)).toBe(blob['seq']);
    expect(Number(stored.timestampMs)).toBe(blob['timestamp']);
  });

  test('updates the device chain head and last_sync_at once at the end of the batch', async () => {
    const { world, builder } = await setupWorld(1005);
    const clock = makeFakeClock(1_726_500_000_000);
    const ops = [builder.genesis(), builder.append(note('a', 'b'))];

    await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant, clock }),
      identityOf(world),
      ops,
    );

    const device = await testDb.db
      .selectFrom('devices')
      .select(['lastSeq', 'lastHash', 'lastSyncAt'])
      .where('id', '=', world.deviceId)
      .executeTakeFirstOrThrow();
    expect(Number(device.lastSeq)).toBe(2);
    expect(device.lastHash).toBe(ops[1]!.hash);
    expect(Number(device.lastSyncAt)).toBe(clock.now());
  });
});

describe('duplicate (05 §5)', () => {
  test('re-pushing an accepted op returns duplicate and consumes no serverSeq', async () => {
    const { world, builder } = await setupWorld(1010);
    const genesis = builder.genesis();
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    const identity = identityOf(world);

    await processPushBatch(deps, identity, [genesis]);
    const second = await processPushBatch(deps, identity, [genesis]);

    expect(second.results).toEqual([{ id: genesis.id, status: 'duplicate' }]);
    const counter = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', world.tenantId)
      .executeTakeFirstOrThrow();
    // One accepted op consumed exactly one value: next is 2, not 3.
    expect(Number(counter.nextServerSeq)).toBe(2);
  });

  test('a duplicate inserts no second row and records no anomaly', async () => {
    const { world, builder } = await setupWorld(1011);
    const genesis = builder.genesis();
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    const identity = identityOf(world);

    await processPushBatch(deps, identity, [genesis]);
    await processPushBatch(deps, identity, [genesis]);

    expect(await readOps(testDb.db, world.tenantId)).toHaveLength(1);
    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });
});

describe('chain continuity (05 §4, §8)', () => {
  test('rejects CHAIN_GAP when seq skips ahead, leaving earlier ops accepted', async () => {
    const { world, builder } = await setupWorld(1020);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    // Server holds genesis only; pushing seq 3 skips seq 2.
    const first = await processPushBatch(deps, identityOf(world), [genesis]);
    const gapped = await processPushBatch(deps, identityOf(world), [op3]);

    expect(first.results[0]).toMatchObject({ status: 'accepted' });
    expect(gapped.results).toEqual([
      { id: op3.id, status: 'rejected', code: 'CHAIN_GAP', reason: expect.any(String) },
    ]);
    void op2;
  });

  test('CHAIN_GAP records no anomaly row (a resend is not tamper)', async () => {
    const { world, builder } = await setupWorld(1021);
    const genesis = builder.genesis();
    builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    await processPushBatch(deps, identityOf(world), [genesis]);
    await processPushBatch(deps, identityOf(world), [op3]);

    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });

  test('a gapped op is accepted once the missing op is resent (gap is recoverable)', async () => {
    const { world, builder } = await setupWorld(1022);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    await processPushBatch(deps, identityOf(world), [genesis]);
    await processPushBatch(deps, identityOf(world), [op3]);
    const resent = await processPushBatch(deps, identityOf(world), [op2, op3]);

    expect(resent.results).toEqual([
      { id: op2.id, status: 'accepted', serverSeq: 2 },
      { id: op3.id, status: 'accepted', serverSeq: 3 },
    ]);
  });

  test('rejects CHAIN_BROKEN when previousHash mismatches at the expected seq', async () => {
    const { world, builder } = await setupWorld(1023);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    // Correctly signed over a core whose previousHash is wrong → passes crypto, fails chain.
    const tampered = breakPreviousHash(op2, 'f'.repeat(64), world.secretKey, serverCryptoPort);
    const result = await processPushBatch(deps, identityOf(world), [tampered]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
  });

  test('the same op with a correct previousHash is ACCEPTED (fixture-validity control)', async () => {
    const { world, builder } = await setupWorld(1024);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [op2]);

    expect(result.results[0]).toMatchObject({ status: 'accepted', serverSeq: 2 });
  });

  test('genesis with a non-zero previousHash is CHAIN_BROKEN', async () => {
    const { world, builder } = await setupWorld(1025);
    const genesis = builder.genesis();
    const tampered = breakPreviousHash(genesis, 'a'.repeat(64), world.secretKey, serverCryptoPort);

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [tampered],
    );

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
  });
});

describe('device revocation (05 §8, api/02-auth §7.2)', () => {
  test('a revoked device has every op rejected DEVICE_REVOKED', async () => {
    const { world, builder } = await setupWorld(1030, { deviceStatus: 'revoked' });
    const ops = [builder.genesis(), builder.append(note('a', 'b'))];

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      ops,
    );

    expect(result.results).toEqual([
      { id: ops[0]!.id, status: 'rejected', code: 'DEVICE_REVOKED', reason: expect.any(String) },
      { id: ops[1]!.id, status: 'rejected', code: 'DEVICE_REVOKED', reason: expect.any(String) },
    ]);
  });

  test('a revoked device writes no tamper-class anomaly rows and inserts nothing', async () => {
    const { world, builder } = await setupWorld(1031, { deviceStatus: 'revoked' });

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      builder.genesis(),
    ]);

    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
    expect(await readOps(testDb.db, world.tenantId)).toEqual([]);
  });

  test('the same batch from an ACTIVE device is accepted (revocation control)', async () => {
    const { world, builder } = await setupWorld(1032, { deviceStatus: 'active' });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [builder.genesis()],
    );

    expect(result.results[0]).toMatchObject({ status: 'accepted' });
  });
});

describe('registry + schema (05 §8)', () => {
  test('rejects UNKNOWN_TYPE for a type absent from the server registry', async () => {
    const { world, builder } = await setupWorld(1040);
    const genesis = builder.genesis();
    const unknown = builder.append({
      type: 'notes.note_teleported',
      entityType: 'note',
      payload: { title: 'a', body: 'b' },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, unknown],
    );

    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_TYPE' });
  });

  test('rejects SCHEMA_INVALID for a known type whose payload fails Zod', async () => {
    const { world, builder } = await setupWorld(1041);
    const genesis = builder.genesis();
    // Known type, wrong payload shape (title must be a string) — a DISTINCT code from UNKNOWN_TYPE.
    const bad = builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      payload: { title: 42, body: 'b' },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, bad],
    );

    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCHEMA_INVALID' });
  });

  test('the same op with a valid payload is ACCEPTED (schema fixture-validity control)', async () => {
    const { world, builder } = await setupWorld(1042);
    const genesis = builder.genesis();
    const good = builder.append({
      type: 'notes.note_created',
      entityType: 'note',
      payload: { title: 'ok', body: 'b' },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, good],
    );

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('neither UNKNOWN_TYPE nor SCHEMA_INVALID records an anomaly row', async () => {
    const { world, builder } = await setupWorld(1043);
    const genesis = builder.genesis();
    const unknown = builder.append({
      type: 'notes.note_teleported',
      entityType: 'note',
      payload: {},
    });

    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      genesis,
      unknown,
    ]);

    expect(await readAnomalies(testDb.db, world.deviceId)).toEqual([]);
  });
});

describe('scope validation (05 §9)', () => {
  test('rejects SCOPE_VIOLATION when op tenantId is not the device tenant', async () => {
    const { world, builder } = await setupWorld(1050);
    const genesis = builder.genesis();
    const foreign = makeWorld(1051, serverCryptoPort);
    const op2 = builder.append(note('a', 'b'));
    // Correctly signed over a core claiming another tenant.
    const tampered = resign(
      { ...op2, tenantId: foreign.tenantId },
      world.secretKey,
      serverCryptoPort,
    );
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [tampered]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('rejects SCOPE_VIOLATION when storeId is outside the tenant', async () => {
    const { world, builder } = await setupWorld(1052);
    const genesis = builder.genesis();
    const otherTenantStore = testId(77);
    const op2 = builder.append(note('a', 'b'));
    const tampered = resign(
      { ...op2, storeId: otherTenantStore },
      world.secretKey,
      serverCryptoPort,
    );
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [tampered]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('accepts a tenant-scoped op with storeId null (not every op has a store)', async () => {
    const { world, builder } = await setupWorld(1053);
    const genesis = builder.genesis();
    const tenantScoped = builder.append({ ...note('a', 'b'), storeId: null });
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    const result = await processPushBatch(deps, identityOf(world), [genesis, tenantScoped]);

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('rejects SCOPE_VIOLATION when userId is not in the tenant directory', async () => {
    const { world, builder } = await setupWorld(1054);
    const genesis = builder.genesis();
    const strangerId = testId(88);
    const op2 = builder.append({ ...note('a', 'b'), userId: strangerId });
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const result = await processPushBatch(deps, identityOf(world), [op2]);

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('MEMBERSHIP-NOT-STATUS: an op from a deactivated-but-member user is ACCEPTED (05 §9.3) (I-2: deactivation preserves every operation, with no history gap)', async () => {
    const { world, builder } = await setupWorld(1055);
    const genesis = builder.genesis();
    const deactivatedId = testId(99);
    await seedUser(testDb.db, world.tenantId, deactivatedId, 'deactivated');
    const op2 = builder.append({ ...note('a', 'b'), userId: deactivatedId });
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    const result = await processPushBatch(deps, identityOf(world), [genesis, op2]);

    // Deactivation gates authentication and command execution — never op acceptance. The audit
    // trail wants the record (03 §6; api/02-auth §1).
    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });
});

describe('per-type rules (05 §9.5, api/02-auth §6.3)', () => {
  test('auth.device_enrolled at seq != 1 is SCOPE_VIOLATION', async () => {
    const { world, builder } = await setupWorld(1060);
    const genesis = builder.genesis();
    // A SECOND enrolment op, chain-valid at seq 2 → the per-type genesis rule is what rejects it.
    const second = builder.genesis();
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    const result = await processPushBatch(deps, identityOf(world), [genesis, second]);

    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('auth.device_enrolled whose entityId is not the device id is SCOPE_VIOLATION', async () => {
    const { world } = await setupWorld(1061);
    const builder = new ChainBuilder(world, serverCryptoPort);
    const wrong = builder.genesis({ entityId: testId(123) });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [wrong],
    );

    expect(result.results[0]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('auth.pin_changed targeting another user is SCOPE_VIOLATION', async () => {
    const { world, builder } = await setupWorld(1062);
    const genesis = builder.genesis();
    const otherId = testId(124);
    await seedUser(testDb.db, world.tenantId, otherId);
    const op = builder.append({
      type: 'auth.pin_changed',
      entityType: 'user_credential',
      entityId: otherId,
      payload: { targetUserId: otherId, verifierRef: otherId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('auth.pin_changed targeting self is ACCEPTED (pin_changed control)', async () => {
    const { world, builder } = await setupWorld(1063);
    const genesis = builder.genesis();
    const op = builder.append({
      type: 'auth.pin_changed',
      entityType: 'user_credential',
      entityId: world.userId,
      payload: { targetUserId: world.userId, verifierRef: world.userId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('auth.pin_reset by an actor without auth.user_reset_pin is SCOPE_VIOLATION', async () => {
    const { world, builder } = await setupWorld(1064);
    const genesis = builder.genesis();
    const targetId = testId(125);
    await seedUser(testDb.db, world.tenantId, targetId);
    const op = builder.append({
      type: 'auth.pin_reset',
      entityType: 'user_credential',
      entityId: targetId,
      payload: { targetUserId: targetId, verifierRef: targetId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('auth.pin_reset by an actor holding auth.user_reset_pin is ACCEPTED (permission control)', async () => {
    const { world, builder } = await setupWorld(1065);
    const genesis = builder.genesis();
    const targetId = testId(126);
    await seedUser(testDb.db, world.tenantId, targetId);
    await grantRole(testDb.db, {
      tenantId: world.tenantId,
      userId: world.userId,
      roleId: testId(127),
      roleName: 'store_owner',
      permissionIds: ['auth.user_reset_pin'],
    });
    const op = builder.append({
      type: 'auth.pin_reset',
      entityType: 'user_credential',
      entityId: targetId,
      payload: { targetUserId: targetId, verifierRef: targetId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('auth.pin_reset targeting a main_owner by a non-main_owner actor is SCOPE_VIOLATION', async () => {
    const { world, builder } = await setupWorld(1066);
    const genesis = builder.genesis();
    const mainOwnerId = testId(128);
    await seedUser(testDb.db, world.tenantId, mainOwnerId);
    await grantRole(testDb.db, {
      tenantId: world.tenantId,
      userId: mainOwnerId,
      roleId: testId(129),
      roleName: 'main_owner',
      permissionIds: ['auth.user_reset_pin'],
    });
    // The actor is a store_owner: holds user_reset_pin, but NOT main_owner.
    await grantRole(testDb.db, {
      tenantId: world.tenantId,
      userId: world.userId,
      roleId: testId(130),
      roleName: 'store_owner',
      permissionIds: ['auth.user_reset_pin'],
    });
    const op = builder.append({
      type: 'auth.pin_reset',
      entityType: 'user_credential',
      entityId: mainOwnerId,
      payload: { targetUserId: mainOwnerId, verifierRef: mainOwnerId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    // Blocks store_owner → main_owner impersonation (api/02-auth §6.6).
    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('auth.pin_reset targeting a main_owner by a main_owner actor is ACCEPTED', async () => {
    const { world, builder } = await setupWorld(1067);
    const genesis = builder.genesis();
    const targetId = testId(131);
    await seedUser(testDb.db, world.tenantId, targetId);
    const mainOwnerRole = testId(132);
    await grantRole(testDb.db, {
      tenantId: world.tenantId,
      userId: targetId,
      roleId: mainOwnerRole,
      roleName: 'main_owner',
      permissionIds: ['auth.user_reset_pin'],
    });
    await grantRole(testDb.db, {
      tenantId: world.tenantId,
      userId: world.userId,
      roleId: mainOwnerRole,
      roleName: 'main_owner',
      permissionIds: ['auth.user_reset_pin'],
    });
    const op = builder.append({
      type: 'auth.pin_reset',
      entityType: 'user_credential',
      entityId: targetId,
      payload: { targetUserId: targetId, verifierRef: targetId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('auth.pin_lockout_cleared without auth.pin_unlock is SCOPE_VIOLATION', async () => {
    const { world, builder } = await setupWorld(1068);
    const genesis = builder.genesis();
    const targetId = testId(133);
    await seedUser(testDb.db, world.tenantId, targetId);
    const op = builder.append({
      type: 'auth.pin_lockout_cleared',
      entityType: 'user_credential',
      entityId: targetId,
      payload: {},
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('auth.pin_lockout_cleared with auth.pin_unlock is ACCEPTED (permission control)', async () => {
    const { world, builder } = await setupWorld(1069);
    const genesis = builder.genesis();
    const targetId = testId(134);
    await seedUser(testDb.db, world.tenantId, targetId);
    await grantRole(testDb.db, {
      tenantId: world.tenantId,
      userId: world.userId,
      roleId: testId(135),
      roleName: 'store_owner',
      permissionIds: ['auth.pin_unlock'],
    });
    const op = builder.append({
      type: 'auth.pin_lockout_cleared',
      entityType: 'user_credential',
      entityId: targetId,
      payload: {},
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });

  test('platform.conflict_detected pushed from a member device is SCOPE_VIOLATION (I-11: the system actor/device is the only permitted source)', async () => {
    const { world, builder } = await setupWorld(1070);
    const genesis = builder.genesis();
    const op = builder.append({
      type: 'platform.conflict_detected',
      entityType: 'conflict',
      payload: { opAId: world.userId, opBId: world.userId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    // conflict_detected is server-built via appendSystemOp; a member device may never emit it.
    expect(result.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
  });

  test('platform.conflict_acknowledged from a member device is ACCEPTED', async () => {
    const { world, builder } = await setupWorld(1071);
    const genesis = builder.genesis();
    const op = builder.append({
      type: 'platform.conflict_acknowledged',
      entityType: 'conflict',
      payload: { conflictId: world.userId },
    });

    const result = await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      identityOf(world),
      [genesis, op],
    );

    expect(result.results[1]).toMatchObject({ status: 'accepted' });
  });
});

describe('CHAIN_HALTED batch remainder (05 §8, api/01 §3)', () => {
  test('every op after a CHAIN_BROKEN is CHAIN_HALTED', async () => {
    const { world, builder } = await setupWorld(1080);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const op4 = builder.append(note('e', 'f'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const broken = breakPreviousHash(op2, 'b'.repeat(64), world.secretKey, serverCryptoPort);
    const result = await processPushBatch(deps, identityOf(world), [broken, op3, op4]);

    expect(result.results.map((r) => ('code' in r ? r.code : r.status))).toEqual([
      'CHAIN_BROKEN',
      'CHAIN_HALTED',
      'CHAIN_HALTED',
    ]);
  });

  test('halted ops are NOT signature-verified (no individual validation attempted)', async () => {
    const { world, builder } = await setupWorld(1081);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const op4 = builder.append(note('e', 'f'));
    await processPushBatch(makeDeps({ forTenant: testDb.appForTenant }), identityOf(world), [
      genesis,
    ]);

    const spy = makeCryptoSpy();
    const broken = breakPreviousHash(op2, 'c'.repeat(64), world.secretKey, serverCryptoPort);
    await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant, crypto: spy.port }),
      identityOf(world),
      [broken, op3, op4],
    );

    // Exactly ONE verify: the CHAIN_BROKEN op itself. The two halted ops are never validated.
    expect(spy.verifyCalls()).toBe(1);
  });

  test('halted ops record no anomaly rows and consume no serverSeq', async () => {
    const { world, builder } = await setupWorld(1082);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });
    await processPushBatch(deps, identityOf(world), [genesis]);

    const broken = breakPreviousHash(op2, 'd'.repeat(64), world.secretKey, serverCryptoPort);
    await processPushBatch(deps, identityOf(world), [broken, op3]);

    // One anomaly only — the CHAIN_BROKEN. CHAIN_HALTED writes none.
    const anomalies = await readAnomalies(testDb.db, world.deviceId);
    expect(anomalies.map((a) => a.kind)).toEqual(['CHAIN_BROKEN']);
    const counter = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', world.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(counter.nextServerSeq)).toBe(2); // genesis only
  });

  test('ops accepted EARLIER in the same batch stay accepted after a later CHAIN_BROKEN', async () => {
    const { world, builder } = await setupWorld(1083);
    const genesis = builder.genesis();
    const op2 = builder.append(note('a', 'b'));
    const op3 = builder.append(note('c', 'd'));
    const deps = makeDeps({ forTenant: testDb.appForTenant });

    const broken = breakPreviousHash(op3, 'e'.repeat(64), world.secretKey, serverCryptoPort);
    const result = await processPushBatch(deps, identityOf(world), [genesis, op2, broken]);

    expect(result.results[0]).toMatchObject({ status: 'accepted', serverSeq: 1 });
    expect(result.results[1]).toMatchObject({ status: 'accepted', serverSeq: 2 });
    expect(result.results[2]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
    expect(await readOps(testDb.db, world.tenantId)).toHaveLength(2);
  });
});

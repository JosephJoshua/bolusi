// appendSystemOp — the server-built-op seam task 17 uses for conflict emission (10-db §3;
// 01-domain-model §3.6). This task ships the primitive, not the conflict-detection rules.
import { bytesToBase64, verifyOp } from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';
import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import { appendSystemOp, type SystemSigner } from '../../../src/oplog/system-op.js';
import { lockTenantCounter } from '../../../src/oplog/server-seq.js';
import {
  makeDeps,
  makeFakeClock,
  makeIdSource,
  makeOplogTestDb,
  readOps,
  seedDevice,
  seedWorld,
  type OplogTestDb,
} from './helpers.js';

let testDb: OplogTestDb;

beforeEach(async () => {
  testDb = await makeOplogTestDb();
}, 120_000);

afterEach(async () => {
  await testDb?.close();
});

const CLOCK_START = 1_726_800_000_000;

/**
 * A tenant with a member device AND its system device (kind='system', storeId null — the tenant's
 * conflict emitter, whose private key lives in the server secret store, never in Postgres).
 */
async function setupTenantWithSystemDevice(seed: number) {
  const member = makeWorld(seed, serverCryptoPort);
  await seedWorld(testDb.db, member);

  const rawSystem = makeWorld(seed + 500, serverCryptoPort);
  const system: ChainWorld = {
    ...rawSystem,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  await seedDevice(testDb.db, system, { deviceKind: 'system' });
  await testDb.db
    .insertInto('systemDeviceChainState')
    .values({ tenantId: member.tenantId, deviceId: system.deviceId })
    .execute();

  const sign: SystemSigner = (hash) => serverCryptoPort.sign(hash, system.secretKey);
  return { member, system, sign };
}

function systemDeps(clockStart = CLOCK_START, idSeed = 900) {
  const clock = makeFakeClock(clockStart);
  return {
    deps: { crypto: serverCryptoPort, now: () => clock.now(), newId: makeIdSource(idSeed) },
    clock,
  };
}

function conflictInput(system: ChainWorld, sign: SystemSigner, overrides = {}) {
  return {
    tenantId: system.tenantId,
    systemDeviceId: system.deviceId,
    systemUserId: system.userId,
    systemDevicePublicKey: system.publicKey,
    sign,
    storeId: system.storeId,
    type: 'platform.conflict_detected',
    entityType: 'conflict',
    entityId: system.userId,
    schemaVersion: 1,
    payload: { opAId: system.userId, opBId: system.userId },
    timestamp: CLOCK_START,
    ...overrides,
  };
}

describe('chaining from system_device_chain_state', () => {
  test('the first system op is a genesis: seq 1 with a 64-zero previousHash', async () => {
    const { system, sign } = await setupTenantWithSystemDevice(5001);
    const { deps } = systemDeps();

    const result = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    expect(result.op.seq).toBe(1);
    expect(result.op.previousHash).toBe(GENESIS_PREVIOUS_HASH);
  });

  test('a second system op chains onto the first (seq + 1, previousHash = last hash)', async () => {
    const { system, sign } = await setupTenantWithSystemDevice(5002);
    const { deps } = systemDeps();

    const first = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });
    const second = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    expect(second.op.seq).toBe(2);
    expect(second.op.previousHash).toBe(first.op.hash);
  });

  test('the chain state row is advanced to the emitted op', async () => {
    const { system, sign } = await setupTenantWithSystemDevice(5003);
    const { deps } = systemDeps();

    const result = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    const state = await testDb.db
      .selectFrom('systemDeviceChainState')
      .select(['lastSeq', 'lastHash'])
      .where('tenantId', '=', system.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(state.lastSeq)).toBe(1);
    expect(state.lastHash).toBe(result.op.hash);
  });
});

describe('signing + verification', () => {
  test('the produced op signature-verifies against the system device pubkey like any pulled op', async () => {
    const { system, sign } = await setupTenantWithSystemDevice(5004);
    const { deps } = systemDeps();

    const result = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    // The client verifies pulled ops with exactly this call (api/01 §4.2) — a system op that fails
    // here would be quarantined on every device.
    expect(verifyOp(result.op, system.publicKey, serverCryptoPort)).toBe(true);
  });

  test('a WRONG injected signer fails loudly at emission, not silently on a client pull', async () => {
    const { system } = await setupTenantWithSystemDevice(5005);
    const impostor = makeWorld(5006, serverCryptoPort);
    const wrongSigner: SystemSigner = (hash) => serverCryptoPort.sign(hash, impostor.secretKey);
    const { deps } = systemDeps();

    await expect(
      testDb.appForTenant(system.tenantId, async (db) => {
        await lockTenantCounter(db, system.tenantId);
        return appendSystemOp(db, deps, conflictInput(system, wrongSigner));
      }),
    ).rejects.toThrow(/does not verify/i);
  });

  test('the stored signed_core_jcs is the verbatim text that was signed', async () => {
    const { system, sign } = await setupTenantWithSystemDevice(5007);
    const { deps } = systemDeps();

    const result = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    const [row] = await readOps(testDb.db, system.tenantId);
    const blob = JSON.parse(row!.signedCoreJcs) as Record<string, unknown>;
    expect(blob['id']).toBe(result.op.id);
    expect(blob['source']).toBe('system');
    expect(row?.signature).toBe(result.op.signature);
  });

  test('the system op is marked source=system and is never clock-skew flagged', async () => {
    const { system, sign } = await setupTenantWithSystemDevice(5008);
    const { deps } = systemDeps();

    await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    const [row] = await readOps(testDb.db, system.tenantId);
    expect(row?.source).toBe('system');
    // A server-built op carries the server clock: skew is not a meaningful concept for it.
    expect(row?.clockSkewFlagged).toBe(false);
  });
});

describe('serverSeq comes from the SAME per-tenant stream as pushed ops', () => {
  test('a system op takes the next serverSeq after the pushed ops', async () => {
    const { member, system, sign } = await setupTenantWithSystemDevice(5010);
    const builder = new ChainBuilder(member, serverCryptoPort);
    const pushDeps = makeDeps({ forTenant: testDb.appForTenant });

    const pushed = await processPushBatch(
      pushDeps,
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        builder.genesis(),
        builder.append({
          type: 'notes.note_created',
          entityType: 'note',
          payload: { title: 'a', body: 'b' },
        }),
      ],
    );

    const { deps } = systemDeps();
    const emitted = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    // Same gapless stream (10-db §3): pushed ops took 1..2, the system op takes 3 — so a client's
    // pull cursor walks system and member ops in one order with no holes.
    expect(pushed.results.map((r) => ('serverSeq' in r ? r.serverSeq : null))).toEqual([1, 2]);
    expect(emitted.serverSeq).toBe(3);
  });

  test('the system op is readable in the tenant op log alongside pushed ops', async () => {
    const { member, system, sign } = await setupTenantWithSystemDevice(5011);
    const builder = new ChainBuilder(member, serverCryptoPort);
    await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [builder.genesis()],
    );

    const { deps } = systemDeps();
    await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    const rows = await readOps(testDb.db, member.tenantId);
    expect(rows.map((r) => [r.type, Number(r.serverSeq)])).toEqual([
      ['auth.device_enrolled', 1],
      ['platform.conflict_detected', 2],
    ]);
  });

  test('the emitted system op has the system device as its signer, not the member device', async () => {
    const { member, system, sign } = await setupTenantWithSystemDevice(5012);
    const { deps } = systemDeps();

    const result = await testDb.appForTenant(system.tenantId, async (db) => {
      await lockTenantCounter(db, system.tenantId);
      return appendSystemOp(db, deps, conflictInput(system, sign));
    });

    expect(result.op.deviceId).toBe(system.deviceId);
    expect(result.op.deviceId).not.toBe(member.deviceId);
    // And the registered pubkey for that device is the one that verifies it.
    const device = await testDb.db
      .selectFrom('devices')
      .select(['signingKeyPublic', 'kind'])
      .where('id', '=', system.deviceId)
      .executeTakeFirstOrThrow();
    expect(device.kind).toBe('system');
    expect(device.signingKeyPublic).toBe(bytesToBase64(system.publicKey));
  });
});

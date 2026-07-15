// SyncState bookkeeping (01-domain-model §5.2), the derived pending counts, the devices sidecar
// (api/01-sync §4.1), and the platform-freeness lock (08 §3.3 rule 3 / §3.4).
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { noblePort } from '@bolusi/test-support';

import {
  pendingMediaCount,
  pendingOperationCount,
  readDeviceRegistry,
  readSyncState,
  runPullPhase,
  writeSyncState,
} from '../../src/index.js';
import { poisonAmbientEffects } from '../runtime/_purity.js';
import {
  deviceInfoOf,
  makeDevice,
  makeSignedNoteOp,
  openSyncHarness,
  prngFor,
  seedDeviceRegistry,
  uuidV4,
  uuidV7,
  type SyncHarness,
  type TestDevice,
} from './_fixtures.js';

let harness: SyncHarness;
let known: TestDevice;
let other: TestDevice;
let storeId: string;

beforeEach(async () => {
  harness = await openSyncHarness();
  const prng = prngFor(2024);
  known = makeDevice(prng, 31);
  other = makeDevice(prng, 32);
  storeId = uuidV4(prng);
});

afterEach(async () => {
  await harness.close();
});

function deps() {
  return {
    db: harness.db,
    transaction: harness.transaction,
    transport: harness.transport,
    surface: harness.surface,
    crypto: noblePort,
    clock: harness.clock,
    applyPulledOp: async () => undefined,
  };
}

describe('the devices sidecar mirrors directory truth (api/01-sync §4.1)', () => {
  it('replaces device_registry wholesale and stores the new version when the version differs', async () => {
    await seedDeviceRegistry(harness.db, [deviceInfoOf(known, storeId)]);
    harness.transport.scriptPull({
      ops: [],
      nextCursor: 3,
      hasMore: false,
      serverTime: 1,
      devices: [deviceInfoOf(other, storeId)], // a FULL snapshot that no longer contains `known`
      devicesDirectoryVersion: 12,
    });

    await runPullPhase(deps());

    // Wholesale replace, not a merge: the sidecar is the full pull scope, so a device absent from it
    // is absent from the directory. Merging would resurrect devices the server has stopped listing.
    const registry = await readDeviceRegistry(harness.db);
    expect([...registry.keys()]).toEqual([other.id]);
    expect((await readSyncState(harness.db)).devicesDirectoryVersion).toBe(12);
  });

  it('retains REVOKED devices — their historical signatures must keep verifying (03 §5)', async () => {
    harness.transport.scriptPull({
      ops: [],
      nextCursor: 1,
      hasMore: false,
      serverTime: 1,
      devices: [
        deviceInfoOf(known, storeId),
        { ...deviceInfoOf(other, storeId), status: 'revoked', revokedAt: 999 },
      ],
      devicesDirectoryVersion: 5,
    });

    await runPullPhase(deps());

    const registry = await readDeviceRegistry(harness.db);
    expect(registry.size).toBe(2);
    const revoked = registry.get(other.id);
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedAt).toBe(999);
    // The key is retained, which is the whole point: dropping it would retroactively quarantine
    // every op the device honestly signed before revocation.
    expect(revoked?.signingKeyPublic).toBe(other.publicKeyBase64);
  });

  it('no sidecar in the response ⇒ the registry and the version are untouched', async () => {
    await seedDeviceRegistry(harness.db, [deviceInfoOf(known, storeId)]);
    await writeSyncState(harness.db, { devicesDirectoryVersion: 4 });
    // Equal version ⇒ server omits BOTH fields (apps/server pull.ts). Nothing changed since our
    // snapshot, so a client that cleared the registry here would quarantine the whole next batch.
    harness.transport.scriptPull({ ops: [], nextCursor: 0, hasMore: false, serverTime: 1 });

    await runPullPhase(deps());

    expect([...(await readDeviceRegistry(harness.db)).keys()]).toEqual([known.id]);
    expect((await readSyncState(harness.db)).devicesDirectoryVersion).toBe(4);
  });

  it('echoes the stored devicesDirectoryVersion on every pull', async () => {
    await writeSyncState(harness.db, { devicesDirectoryVersion: 77 });
    harness.transport.scriptPull({ ops: [], nextCursor: 0, hasMore: false, serverTime: 1 });
    await runPullPhase(deps());
    // The echo is what lets the server decide whether to send a snapshot at all (api/01 §4.1).
    expect(harness.transport.pulls[0]?.devicesDirectoryVersion).toBe(77);
  });

  it('device state is never read from ops — an op claiming a device says nothing about the registry', async () => {
    // 03 §5: the transition is NOT op-sourced. A device that could revoke another by appending an op
    // would be a self-service kill switch for any compromised device in the tenant.
    await seedDeviceRegistry(harness.db, [deviceInfoOf(known, storeId)]);
    const prng = prngFor(9);
    const op = makeSignedNoteOp({
      device: known,
      seq: 1,
      timestamp: 1_726_000_000_000,
      tenantId: uuidV4(prng),
      storeId,
      userId: uuidV4(prng),
      entityId: uuidV7(prng, 1_726_000_000_000),
      payload: { title: 'revoke everything', body: 'status: revoked' },
      prng,
    });
    harness.transport.scriptPull({
      ops: [op],
      nextCursor: 2,
      hasMore: false,
      serverTime: 1,
    });

    await runPullPhase({ ...deps(), applyPulledOp: async () => undefined });

    const registry = await readDeviceRegistry(harness.db);
    expect(registry.get(known.id)?.status).toBe('active'); // unchanged by the op's contents
  });
});

describe('pending counts are DERIVED queries, never stored (01 §5.2)', () => {
  it('pendingOperationCount counts syncStatus = local and writes no column', async () => {
    expect(await pendingOperationCount(harness.db)).toBe(0);

    const prng = prngFor(12);
    for (let i = 1; i <= 3; i += 1) {
      const op = makeSignedNoteOp({
        device: known,
        seq: i,
        timestamp: 1_726_000_000_000 + i,
        tenantId: uuidV4(prng),
        storeId,
        userId: uuidV4(prng),
        entityId: uuidV7(prng, 1_726_000_000_000 + i),
        prng,
      });
      await sql`
        INSERT INTO operations (
          id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
          schema_version, payload, timestamp_ms, location, source, agent_initiated,
          agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status
        ) VALUES (
          ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq},
          ${op.type}, ${op.entityType}, ${op.entityId}, ${op.schemaVersion},
          ${JSON.stringify(op.payload)}, ${op.timestamp}, ${null}, ${op.source}, ${0}, ${null},
          ${op.previousHash}, ${op.hash}, ${op.signature}, ${`jcs:${op.id}`},
          ${i === 3 ? 'synced' : 'local'}
        )
      `.execute(harness.db);
    }

    expect(await pendingOperationCount(harness.db)).toBe(2); // the `synced` one does not count

    // "Stored derivables drift" (01 §5.2) — so there is no column to drift. Asserting the ABSENCE
    // of the column is what makes "never stored" enforceable rather than aspirational: if someone
    // adds one, this fails.
    const columns = await sql<{ name: string }>`PRAGMA table_info(sync_state)`.execute(harness.db);
    const names = columns.rows.map((r) => r.name);
    expect(names).not.toContain('pending_operation_count');
    expect(names).not.toContain('pending_media_count');
  });

  it('pendingMediaCount excludes orphans — unattached captures are debris, not pending work', async () => {
    const insertMedia = async (attached: string | null, status: string): Promise<void> => {
      const id = uuidV7(prngFor(Math.random() * 1000), 1_726_000_000_000);
      await sql`
        INSERT INTO media_items (
          id, tenant_id, store_id, captured_by_user_id, device_id, type, mime_type, byte_size,
          sha256, captured_at, attached_to_operation_id, upload_status
        ) VALUES (
          ${id}, ${uuidV4(prngFor(1))}, ${storeId}, ${uuidV4(prngFor(2))}, ${known.id}, 'image',
          'image/jpeg', ${100}, ${'a'.repeat(64)}, ${1}, ${attached}, ${status}
        )
      `.execute(harness.db);
    };

    await insertMedia('op-1', 'pending');
    await insertMedia('op-2', 'uploading');
    await insertMedia('op-3', 'failed');
    await insertMedia('op-4', 'uploaded'); // terminal — not pending
    await insertMedia(null, 'pending'); // ORPHAN — 06 §4 excludes it

    // The formula is 06-media-pipeline §4's, quoted by 01 §5.2. The orphan is the case that makes
    // the difference between the right number and a plausible one.
    expect(await pendingMediaCount(harness.db)).toBe(3);
  });
});

describe('SyncState persistence (10-db §9.3)', () => {
  it('round-trips every field, and booleans survive the 0/1 encoding', async () => {
    await writeSyncState(harness.db, {
      cursor: 91,
      devicesDirectoryVersion: 8,
      lastSuccessfulSyncAt: 111,
      lastPushAt: 222,
      lastPullAt: 333,
      lastServerTime: 444,
      lastServerTimeReceivedAt: 555,
      pushHalted: true,
      syncDisabled: true,
      syncDisabledReason: 'device_revoked',
      lastSyncError: 'NETWORK',
      backoffUntil: 666,
    });

    expect(await readSyncState(harness.db)).toEqual({
      cursor: 91,
      devicesDirectoryVersion: 8,
      lastSuccessfulSyncAt: 111,
      lastPushAt: 222,
      lastPullAt: 333,
      lastServerTime: 444,
      lastServerTimeReceivedAt: 555,
      pushHalted: true,
      syncDisabled: true,
      syncDisabledReason: 'device_revoked',
      lastSyncError: 'NETWORK',
      backoffUntil: 666,
    });
  });

  it('a patch touches only its own fields', async () => {
    await writeSyncState(harness.db, { cursor: 5, lastSyncError: 'NETWORK' });
    await writeSyncState(harness.db, { cursor: 6 });
    // Round-tripping a whole row would silently revert a concurrent writer's field.
    const state = await readSyncState(harness.db);
    expect(state.cursor).toBe(6);
    expect(state.lastSyncError).toBe('NETWORK');
  });

  it('an empty patch is a no-op rather than invalid SQL', async () => {
    await expect(writeSyncState(harness.db, {})).resolves.toBeUndefined();
  });
});

describe('platform-freeness (08 §3.3 rule 3, §3.4)', () => {
  it('the sync loop reaches NO ambient clock, timer, rng or network', async () => {
    // The third lock (the type and the lint are the other two — see test/runtime/purity.test.ts).
    // It is the only one that sees through a cast, a dynamic property access, or a transitive
    // import: the globals are POISONED for the duration, so a reach fails wherever it actually
    // lives. A spy counting calls would have to decide an acceptable count; the answer is zero, so
    // make it throw.
    const loop = await harness.makeLoop({ deviceId: known.id });
    harness.transport.scriptPull({ ops: [], nextCursor: 0, hasMore: false, serverTime: 1 });

    await poisonAmbientEffects(async () => {
      loop.requestSync('manual');
      await loop.settle();
    });

    // And it really ran under the poison — otherwise this asserts nothing (T-14b).
    expect(loop.getStats().cycles).toBe(1);
    expect(loop.state).toBe('idle');
  });

  it('the backoff timer is the injected port, not a real setTimeout', async () => {
    const loop = await harness.makeLoop({ deviceId: known.id });
    harness.transport.scriptPull(() => {
      throw new Error('down');
    });

    await poisonAmbientEffects(async () => {
      loop.requestSync('manual');
      await loop.settle();
    });

    // A real `setTimeout` would have thrown under the poison; the injected timer armed instead.
    expect(loop.state).toBe('backoff');
    expect(harness.timer.pending()).toBe(1);
  });
});

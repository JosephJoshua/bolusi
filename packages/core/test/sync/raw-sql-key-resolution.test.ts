// The raw-`sql<T>` readers must resolve their result KEYS by construction, not because a caller
// happened to wire `CamelCasePlugin` (10-db §11.4; testing-guide T-14f; task 74).
//
// WHAT THIS FILE FALSIFIES, AND WHY IT IS SHAPED LIKE THIS
// -------------------------------------------------------
// A raw `sql<T>` annotation is an ASSERTION tsc believes and never checks (task 39/46). Task 18
// found a second dimension of that lie: `CamelCasePlugin` rewrites raw-`sql` RESULT KEYS, not just
// builder identifiers — so `sql<{ pullCursor }>` over a bare `SELECT pull_cursor` arrives as
// `pullCursor` WITH the plugin and `pull_cursor` (i.e. `row.pullCursor === undefined`) WITHOUT it.
// Every production Kysely wires the plugin today, so nothing is broken — but the coupling is
// invisible and its failure mode is silent (`NaN`, a laundered `1`, a `0` watermark). The moment a
// Kysely is built without the plugin — a new lane (task 73), a refactor, a package with its own
// handle — the reads become `undefined` and, worse, some launder into plausible values.
//
// This test builds TWO Kysely handles over ONE migrated in-memory database:
//   - `withPlugin` — the POSITIVE CONTROL (T-17): proves the seed landed and the reader is correct.
//   - `noPlugin`   — the SUBJECT: a Kysely with no `CamelCasePlugin`, the thing that used to break.
// After the task-74 fix (explicit `col AS "camelKey"` aliases, inert under both wirings) every
// reader returns identical, correct data through BOTH handles. Revert any one alias to a bare
// column and that reader's `noPlugin` assertion goes red — which is the per-site falsification the
// task requires (§2.11): the alias is load-bearing, not decoration.
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort, type Prng } from '@bolusi/test-support';

import {
  createSqlWatermarkStore,
  highestContiguousServerSeq,
  insertQuarantinedOp,
  readCanonicalPage,
  readDeviceRegistry,
  readEntityOps,
  readPushBatch,
  readQuarantinedOps,
  readSyncState,
  runPullPhase,
  runPushPhase,
  writeSyncState,
} from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';
import {
  deviceInfoOf,
  FakeClock,
  FakeSurface,
  FakeTransport,
  makeDevice,
  makeSignedNoteOp,
  prngFor,
  seedDeviceRegistry,
  uuidV4,
  uuidV7,
  type TestDevice,
} from './_fixtures.js';

interface Handles {
  readonly driver: DbDriver;
  /** Positive control (T-17): the plugin is wired, so a bare-column read still resolves. */
  readonly withPlugin: Kysely<ClientDatabase>;
  /** Subject: no `CamelCasePlugin`. A bare-column read returns `undefined` unless the SQL aliases. */
  readonly noPlugin: Kysely<ClientDatabase>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function openHandles(): Promise<Handles> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  // Two handles, ONE underlying connection (better-sqlite3 :memory:), so both see the same rows and
  // the ONLY difference between them is the plugin — which is precisely the variable under test.
  const withPlugin = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  const noPlugin = new Kysely<ClientDatabase>({ dialect: createClientDialect(driver) });
  const transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    await driver.begin();
    try {
      const result = await fn();
      await driver.commit();
      return result;
    } catch (error) {
      await driver.rollback();
      throw error;
    }
  };
  return { driver, withPlugin, noPlugin, transaction, close: () => driver.close() };
}

let h: Handles;
let prng: Prng;

beforeEach(async () => {
  h = await openHandles();
  prng = prngFor(74);
});

afterEach(async () => {
  await h.close();
});

/** A full `operations` row via raw snake-cased SQL — the write path is plugin-independent. */
async function seedOperation(
  db: Kysely<ClientDatabase>,
  op: SignedOperation,
  overrides: { syncStatus?: string; serverSeq?: number | null } = {},
): Promise<void> {
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status, server_seq
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq},
      ${op.type}, ${op.entityType}, ${op.entityId}, ${op.schemaVersion},
      ${JSON.stringify(op.payload)}, ${op.timestamp}, ${null}, ${op.source}, ${0}, ${null},
      ${op.previousHash}, ${op.hash}, ${op.signature},
      ${JSON.stringify({ ...op, hash: undefined, signature: undefined })},
      ${overrides.syncStatus ?? 'synced'}, ${overrides.serverSeq ?? null}
    )
  `.execute(db);
}

function noteOp(seq: number, extra: Partial<{ timestamp: number }> = {}): SignedOperation {
  return makeSignedNoteOp({
    device: signer,
    seq,
    timestamp: (extra.timestamp ?? 1_726_000_000_000) + seq,
    tenantId: uuidV4(prng),
    storeId: uuidV4(prng),
    userId: uuidV4(prng),
    entityId: uuidV7(prng, 1_726_000_000_000 + seq),
    prng,
  });
}

let signer: TestDevice;
beforeEach(() => {
  signer = makeDevice(prng, 74);
});

describe('exported readers resolve their keys WITHOUT the CamelCasePlugin (task 74)', () => {
  it('readSyncState — pull_cursor is a real cursor, not NaN (state.ts:60)', async () => {
    await writeSyncState(h.withPlugin, {
      cursor: 91,
      devicesDirectoryVersion: 8,
      lastPushAt: 222,
      pushHalted: true,
      syncDisabled: false,
      syncDisabledReason: 'x',
      lastSyncError: 'NETWORK',
      backoffUntil: 666,
    });

    // Positive control: with the plugin, snake columns arrive camelCased and the read is correct.
    expect((await readSyncState(h.withPlugin)).cursor).toBe(91);

    // Subject: without the plugin the same read must STILL be correct. Before the alias fix this
    // returned `cursor: NaN` (Number(undefined)) — silent, typechecked, linted, on the wire.
    const state = await readSyncState(h.noPlugin);
    expect(state.cursor).toBe(91);
    expect(state.devicesDirectoryVersion).toBe(8);
    expect(state.lastPushAt).toBe(222);
    expect(state.pushHalted).toBe(true);
    expect(state.lastSyncError).toBe('NETWORK');
    expect(state.backoffUntil).toBe(666);
  });

  it('readDeviceRegistry — device keys resolve, not undefined (devices.ts:58)', async () => {
    const storeId = uuidV4(prng);
    await seedDeviceRegistry(h.withPlugin, [
      { ...deviceInfoOf(signer, storeId), status: 'revoked', revokedAt: 999 },
    ]);

    expect((await readDeviceRegistry(h.withPlugin)).get(signer.id)?.signingKeyPublic).toBe(
      signer.publicKeyBase64,
    );

    const entry = (await readDeviceRegistry(h.noPlugin)).get(signer.id);
    // Without the fix `signingKeyPublic`/`storeId`/`revokedAt` were undefined — a verifier with no
    // public key rejects every pulled op it should accept.
    expect(entry?.signingKeyPublic).toBe(signer.publicKeyBase64);
    expect(entry?.storeId).toBe(storeId);
    expect(entry?.status).toBe('revoked');
    expect(entry?.revokedAt).toBe(999);
  });

  it('readQuarantinedOps — server_seq/signedCoreJcs resolve, not NaN/undefined (quarantine.ts:134)', async () => {
    await insertQuarantinedOp(h.withPlugin, {
      id: uuidV7(prng, 1_726_000_000_000),
      deviceId: signer.id,
      serverSeq: 42,
      signedCoreJcs: 'jcs:body',
      hash: 'h'.repeat(64),
      signature: 's'.repeat(86),
      reason: 'bad_signature',
      quarantinedAt: 1_726_000_000_123,
    });

    expect((await readQuarantinedOps(h.withPlugin))[0]?.serverSeq).toBe(42);

    const row = (await readQuarantinedOps(h.noPlugin))[0];
    expect(row?.serverSeq).toBe(42);
    expect(row?.signedCoreJcs).toBe('jcs:body');
    expect(row?.deviceId).toBe(signer.id);
    expect(row?.quarantinedAt).toBe(1_726_000_000_123);
  });

  it('readEntityOps — reconstructs the op instead of throwing on undefined keys (oplog-source.ts:165)', async () => {
    const op = noteOp(1);
    await seedOperation(h.withPlugin, op);

    expect((await readEntityOps(h.withPlugin, 'note', op.entityId))[0]?.tenantId).toBe(op.tenantId);

    // Without the fix `reconstructOperation` read `row.tenantId`/`row.timestampMs` = undefined and
    // `int8ToNumber(undefined)` THREW — loud here, but the same undefined keys are silent elsewhere.
    const rebuilt = (await readEntityOps(h.noPlugin, 'note', op.entityId))[0];
    expect(rebuilt?.tenantId).toBe(op.tenantId);
    expect(rebuilt?.entityType).toBe('note');
    expect(rebuilt?.seq).toBe(1);
  });

  it('readCanonicalPage — same OP_COLUMNS read, both branches (oplog-source.ts:190,196)', async () => {
    const first = noteOp(1);
    const second = noteOp(2);
    await seedOperation(h.withPlugin, first);
    await seedOperation(h.withPlugin, second);

    // after === null branch (:190)
    const page = await readCanonicalPage(h.noPlugin, ['notes.note_created'], null, 10);
    expect(page.map((o) => o.entityId)).toContain(first.entityId);
    // after !== null branch (:196)
    const rest = await readCanonicalPage(
      h.noPlugin,
      ['notes.note_created'],
      { timestamp: first.timestamp, deviceId: first.deviceId, seq: first.seq },
      10,
    );
    expect(rest.map((o) => o.entityId)).toEqual([second.entityId]);
  });

  it('highestContiguousServerSeq — the self-alias decoy resolves serverSeq (oplog-source.ts:229)', async () => {
    await seedOperation(h.withPlugin, noteOp(1), { serverSeq: 1 });
    await seedOperation(h.withPlugin, noteOp(2), { serverSeq: 2 });
    await seedOperation(h.withPlugin, noteOp(3), { serverSeq: 3 });

    expect(await highestContiguousServerSeq(h.withPlugin, 0)).toBe(3);

    // `SELECT server_seq AS server_seq` was a NO-OP self-alias — the camelCase key resolved only via
    // the plugin. Without it, `row.serverSeq` was undefined and the walk threw.
    expect(await highestContiguousServerSeq(h.noPlugin, 0)).toBe(3);
  });

  it('readPushBatch — signed_core_jcs resolves, not JSON.parse(undefined) (push.ts:51)', async () => {
    const op = noteOp(1);
    await seedOperation(h.withPlugin, op, { syncStatus: 'local' });

    expect((await readPushBatch(h.withPlugin))[0]?.id).toBe(op.id);

    const batch = await readPushBatch(h.noPlugin);
    expect(batch[0]?.id).toBe(op.id);
    expect(batch[0]?.hash).toBe(op.hash);
  });

  it('watermark store read — appliedServerSeq resolves, not a laundered 0 (watermarks.ts:77)', async () => {
    const store = createSqlWatermarkStore(h.withPlugin);
    await store.advanceServerSeq('notes', 7);
    await store.advanceLocalSeq('notes', 4);

    expect((await store.read('notes')).appliedServerSeq).toBe(7);

    // The subject store reads through the no-plugin handle. Before the fix `row.appliedServerSeq`
    // was undefined and `?? 0` laundered it to a plausible watermark of 0 — SILENT (T-19).
    const noPluginState = await createSqlWatermarkStore(h.noPlugin).read('notes');
    expect(noPluginState.appliedServerSeq).toBe(7);
    expect(noPluginState.appliedLocalSeq).toBe(4);
  });
});

describe('the two private readers, via their sync-phase entry points (task 74)', () => {
  it('runPushPhase reaches the CHAIN_GAP path — readSyncStatus resolved sync_status (push.ts:251)', async () => {
    // A CHAIN_GAP result is a NO-OP transition (03 §3): the op stays 'local' and `markSyncResult`
    // writes NOTHING. That is deliberate here — `markSyncResult` is a Kysely BUILDER write whose
    // camelCase→snake identifier mapping legitimately needs the plugin (a DIFFERENT mechanism than
    // raw-`sql` result keys; out of scope for task 74). Choosing the no-op branch keeps this test
    // on `readSyncStatus`'s raw-`sql` reader alone, with no builder write to muddy it.
    const op = noteOp(1);
    await seedOperation(h.noPlugin, op, { syncStatus: 'local' });

    const transport = new FakeTransport();
    transport.scriptPush({
      results: [{ id: op.id, status: 'rejected', code: 'CHAIN_GAP', reason: 'seq skips ahead' }],
      serverTime: 1_726_000_000_000,
    });

    const result = await runPushPhase({
      db: h.noPlugin,
      transport,
      surface: new FakeSurface(),
      clock: new FakeClock(),
      deviceId: signer.id,
      onChainBroken: async () => undefined,
    });

    // `gapped` is true ONLY if `applyPushResult` got PAST its `current === null` early-return, which
    // means `readSyncStatus` resolved the op's status. Before the fix `row.syncStatus` was undefined
    // → status null → 'ignored' → gapped stays false, and the CHAIN_GAP would be silently swallowed.
    expect(result.gapped).toBe(true);
  });

  it('runPullPhase assigns sequential arrival seqs — nextArrivalSeq resolved MAX (pull.ts:411)', async () => {
    const storeId = uuidV4(prng);
    await seedDeviceRegistry(h.noPlugin, [deviceInfoOf(signer, storeId)]);

    const first = noteOp(1);
    const second = noteOp(2);
    const transport = new FakeTransport();
    transport.scriptPull({
      ops: [first, second],
      nextCursor: 2,
      hasMore: false,
      serverTime: 1_726_000_000_000,
    });

    const outcome = await runPullPhase({
      db: h.noPlugin,
      transaction: h.transaction,
      transport,
      surface: new FakeSurface(),
      crypto: noblePort,
      clock: new FakeClock(),
      applyPulledOp: async () => undefined,
    });

    expect(outcome.applied).toBe(2);

    // The arrival counter is MAX(server_seq)+1 per inserted op. Before the fix `nextArrivalSeq`
    // read `row.maxSeq` = undefined and `?? 0` laundered every op to serverSeq 1 — a wrong, but
    // entirely plausible, sequence number (T-19). Correct is 1 then 2.
    const seqs = await sql<{ serverSeq: number }>`
      SELECT server_seq AS "serverSeq" FROM operations ORDER BY seq
    `.execute(h.noPlugin);
    expect(seqs.rows.map((r) => r.serverSeq)).toEqual([1, 2]);
  });
});

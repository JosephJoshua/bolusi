// Pull-side verification + quarantine — the client half of SEC-OPLOG-09 (security-guide §4.1;
// api/01-sync §4.2). The unit half of CHAOS-12; the full harness scenario is task 26.
//
// THE THREAT. The device token authenticates the transport, not the history. A compromised (or
// merely buggy) server can serve any bytes it likes in a pull response. Without client-side
// verification, "the server said so" would be the whole of the client's evidence that an op ever
// happened — and the op log's entire value is that it is signed evidence, not hearsay. So every
// pulled op is verified against the directory's pubkeys, and anything that fails is held out of
// projections.
//
// SIGNATURES HERE ARE REAL (noblePort, real Ed25519). A stubbed verifier would make these tests
// pass against a client that never verified anything — the fixture would be "bad" only because the
// stub said so. Every deny below is paired with a positive control on the SAME fixture shape
// (T-14b): the good op applies, the bad one does not, and the only difference is the cryptography.
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeviceInfo, SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import { runPullPhase } from '../../src/index.js';
import {
  corruptSignature,
  countRows,
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
let stranger: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;
let clockAt: number;

beforeEach(async () => {
  harness = await openSyncHarness();
  const prng = prngFor(90210);
  known = makeDevice(prng, 11);
  stranger = makeDevice(prng, 22); // enrolled elsewhere; absent from the local registry
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  clockAt = 1_726_000_000_000;
  await seedDeviceRegistry(harness.db, [deviceInfoOf(known, storeId)]);
});

afterEach(async () => {
  await harness.close();
});

let opCounter = 0;
function op(
  device: TestDevice,
  over: Partial<{ type: string; body: string }> = {},
): SignedOperation {
  const prng = prngFor(1000 + (opCounter += 1));
  clockAt += 1000;
  return makeSignedNoteOp({
    device,
    seq: opCounter,
    timestamp: clockAt,
    tenantId,
    storeId,
    userId,
    entityId: uuidV7(prng, clockAt),
    payload: { title: `t${opCounter}`, body: over.body ?? `b${opCounter}` },
    prng,
  });
}

function deps() {
  return {
    db: harness.db,
    transaction: harness.transaction,
    transport: harness.transport,
    surface: harness.surface,
    crypto: noblePort,
    clock: harness.clock,
    applyPulledOp: (o: SignedOperation) => harness.engine.applyPulledOp(o),
  };
}

async function quarantinedIds(): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM quarantined_ops ORDER BY server_seq
  `.execute(harness.db);
  return rows.rows.map((r) => r.id);
}

async function cursor(): Promise<number> {
  const rows = await sql<{ pullCursor: number }>`
    SELECT pull_cursor FROM sync_state WHERE id = 1
  `.execute(harness.db);
  return Number(rows.rows[0]?.pullCursor ?? -1);
}

describe('SEC-OPLOG-09 — pull-side verification', () => {
  it('SEC-OPLOG-09: a pulled op with a verified-bad signature is quarantined, never applied, and the cursor advances past it', async () => {
    const good = op(known);
    const tampered = corruptSignature(op(known)); // payload mutated after signing (CHAOS-05 T1)

    harness.transport.scriptPull({
      ops: [good, tampered],
      nextCursor: 42,
      hasMore: false,
      serverTime: clockAt,
    });

    const result = await runPullPhase(deps());

    // The POSITIVE CONTROL, on the same batch: the honest op applied. Without this, "nothing was
    // applied" could mean "verification works" or "the fixture never applies anything" (T-14b).
    expect(result.applied).toBe(1);
    expect(await countRows(harness.db, 'notes')).toBe(1);

    // The deny: quarantined, not in the op log, not in projections.
    expect(await quarantinedIds()).toEqual([tampered.id]);
    expect(result.quarantined).toBe(1);
    const inLog = await sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM operations WHERE id = ${tampered.id}
    `.execute(harness.db);
    expect(Number(inLog.rows[0]?.c)).toBe(0);

    // The counter-intuitive half, and the reason quarantine is a repair rather than a stall: the
    // cursor moves PAST the bad op (api/01 §4.2 — "one bad op must not brick sync").
    expect(await cursor()).toBe(42);

    // Surfaced loudly, asserted by label KEY not copy (T-4).
    const surfaced = harness.surface.ofKind('quarantined');
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.opId).toBe(tampered.id);
    expect(surfaced[0]?.reason).toBe('bad_signature');
    expect(surfaced[0]?.labelKey).toMatch(/^sync\.quarantine\./);
  });

  it('SEC-OPLOG-09: an op from an unknown signer forces exactly ONE fresh-sidecar re-pull, then quarantines', async () => {
    const foreign = op(stranger); // correctly signed, but the signer is not in our registry

    // First pull: the stranger's op, no sidecar. Second (forced) pull: a sidecar that STILL omits
    // the stranger — a server that cannot or will not produce the key.
    harness.transport.scriptPull(
      { ops: [foreign], nextCursor: 7, hasMore: false, serverTime: clockAt },
      {
        ops: [foreign],
        nextCursor: 7,
        hasMore: false,
        serverTime: clockAt,
        devices: [deviceInfoOf(known, storeId)],
        devicesDirectoryVersion: 3,
      },
    );

    const result = await runPullPhase(deps());

    // EXACTLY ONE forced re-pull (api/01 §4.2 / CHAOS-12). Counted, not assumed: a client that
    // re-pulled on every unknown key would let a server spin it forever.
    expect(result.refetches).toBe(1);
    expect(harness.transport.pulls).toHaveLength(2);
    expect(harness.transport.pulls[1]?.devicesDirectoryVersion).toBe(0); // 0 = force fresh
    expect(harness.transport.pulls[1]?.cursor).toBe(harness.transport.pulls[0]?.cursor); // same batch

    // Still unknown after the fresh sidecar ⇒ quarantined, with the reason that distinguishes it
    // from a forgery.
    expect(await quarantinedIds()).toEqual([foreign.id]);
    const reason = await sql<{ reason: string }>`
      SELECT reason FROM quarantined_ops WHERE id = ${foreign.id}
    `.execute(harness.db);
    expect(reason.rows[0]?.reason).toBe('unknown_pubkey');
    expect(await countRows(harness.db, 'notes')).toBe(0);
    expect(await cursor()).toBe(7);
  });

  it('SEC-OPLOG-09: a later sidecar delivering the missing key releases the unknown-key op while the forged one stays quarantined', async () => {
    const foreign = op(stranger);
    const tampered = corruptSignature(op(known));

    // Batch 1: both bad ops; the forced re-pull's sidecar still lacks the stranger.
    harness.transport.scriptPull(
      { ops: [foreign, tampered], nextCursor: 9, hasMore: false, serverTime: clockAt },
      {
        ops: [foreign, tampered],
        nextCursor: 9,
        hasMore: false,
        serverTime: clockAt,
        devices: [deviceInfoOf(known, storeId)],
        devicesDirectoryVersion: 3,
      },
    );
    await runPullPhase(deps());
    expect((await quarantinedIds()).sort()).toEqual([foreign.id, tampered.id].sort());
    expect(await countRows(harness.db, 'notes')).toBe(0);

    // Batch 2: the stranger is enrolled; a new sidecar carries its key. Re-verification is triggered
    // by the SIDECAR, not by the op being re-served — the op is not in this batch at all.
    const later = op(known);
    harness.transport.scriptPull({
      ops: [later],
      nextCursor: 12,
      hasMore: false,
      serverTime: clockAt,
      devices: [deviceInfoOf(known, storeId), deviceInfoOf(stranger, storeId)],
      devicesDirectoryVersion: 4,
    });

    const result = await runPullPhase(deps());

    // The vindicated op is released and applied — via the engine's out-of-order path, since the
    // batch that superseded it has already landed (04 §4.2).
    expect(result.released).toBe(1);
    expect(await quarantinedIds()).toEqual([tampered.id]); // the forgery stays; a bad signature never becomes good
    // Both the released op and this batch's op are now projected.
    expect(await countRows(harness.db, 'notes')).toBe(2);
    const releasedInLog = await sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM operations WHERE id = ${foreign.id}
    `.execute(harness.db);
    expect(Number(releasedInLog.rows[0]?.c)).toBe(1);
  });

  it('SEC-OPLOG-09: sync keeps working across and after quarantine — subsequent valid pulls still apply', async () => {
    const tampered = corruptSignature(op(known));
    harness.transport.scriptPull({
      ops: [tampered],
      nextCursor: 5,
      hasMore: false,
      serverTime: clockAt,
    });
    await runPullPhase(deps());
    expect(await countRows(harness.db, 'notes')).toBe(0);

    // The whole point of advancing the cursor past a bad op: the NEXT pull is unaffected. A client
    // that stalled here would hand any injector a permanent tenant-wide denial of service.
    const a = op(known);
    const b = op(known);
    harness.transport.scriptPull({
      ops: [a, b],
      nextCursor: 8,
      hasMore: false,
      serverTime: clockAt,
    });
    const result = await runPullPhase(deps());

    expect(result.applied).toBe(2);
    expect(await countRows(harness.db, 'notes')).toBe(2);
    expect(await cursor()).toBe(8);
    expect(await quarantinedIds()).toEqual([tampered.id]); // still held, still surfaced, not forgotten
  });

  it('SEC-OPLOG-09: a revoked device’s pre-revocation ops still verify — revocation must not corrupt history', async () => {
    // 03 §5: ops accepted BEFORE revocation remain valid, and the sidecar keeps revoked devices
    // listed precisely so their signatures keep verifying. A client that refused ops from
    // `status: 'revoked'` would retroactively quarantine a device's entire honest history the
    // moment someone revoked it — turning an admin action into silent data loss.
    const historical = op(known);
    const revoked: DeviceInfo = {
      ...deviceInfoOf(known, storeId),
      status: 'revoked',
      revokedAt: clockAt,
    };
    harness.transport.scriptPull({
      ops: [historical],
      nextCursor: 15,
      hasMore: false,
      serverTime: clockAt,
      devices: [revoked],
      devicesDirectoryVersion: 9,
    });

    const result = await runPullPhase(deps());

    expect(result.applied).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(await countRows(harness.db, 'notes')).toBe(1);
  });
});

describe('the one-bad-op trap: a batch is parsed per-op, never through zPullResponse (task 02 review)', () => {
  it('an unparseable op does not fail the batch — the valid ops in it still apply', async () => {
    const good = op(known);
    // `zPullResponse.ops` is STRICT, so this object fails `zSignedOperation`. Parsed as a batch it
    // would throw and — treated as a transport error — put the device into permanent backoff, which
    // is exactly the bricking api/01 §4.2 forbids.
    const garbage = { id: 'not-a-uuid', nonsense: true };

    harness.transport.scriptPull({
      ops: [good, garbage] as unknown as SignedOperation[],
      nextCursor: 20,
      hasMore: false,
      serverTime: clockAt,
    });

    const result = await runPullPhase(deps());

    expect(result.applied).toBe(1); // the good op survived its neighbour
    expect(await countRows(harness.db, 'notes')).toBe(1);
    expect(await cursor()).toBe(20); // and sync moved on
    expect(harness.surface.ofKind('quarantined')).toHaveLength(1); // never silent
  });
});

// THE batch-atomicity suite (api/01-sync §4; testing-guide §3.5 F4/F5; CHAOS-02).
//
// The contract: a pulled batch's op INSERTs, its projection APPLIEs, and the cursor/watermark
// advance all commit in ONE local transaction, or none of them do.
//
// WHY THIS SUITE IS THE ONE THAT MATTERS. The projection engine advances `applied_server_seq` to the
// highest CONTIGUOUS `arrival_seq` *present in the log* — present, not applied (projection/engine.ts →
// oplog-source `highestContiguousSeq`). The engine cannot distinguish the two and is not
// supposed to: the caller's transaction is what makes "present" imply "applied". The client pull is
// the only production path where that promise is made — server-side, projections apply inside the
// PUSH transaction (04 §4.3, 10-db §8) and the server's pull is a pure read. So this file is where
// the promise is kept, and breaking it fails SILENTLY: ops sit durably in the log, never projected,
// while the watermark reports the module caught up. No error. No red test. Permanently wrong.
//
// ASSERTIONS ARE OUTCOMES, NOT MECHANISMS. Every assertion below is about DURABLE STATE — what is
// in the log, what the watermark says, where the cursor points, what the projection contains. None
// of them asks "was a transaction opened?" or "was the wrapper called?". A mechanism-assertion is
// defeated by changing an `await` to a `void`; these are not.
//
// FALSIFIED, NOT ASSUMED (CLAUDE.md §2.11). `commits per-op` below is the falsification kept as a
// live test: it drives the SAME batch through the per-op-commit shape this file exists to forbid and
// asserts the resulting corruption — ops durably in the log, watermark past them, projection missing
// them, cursor moved on. If atomicity were unnecessary, that test would fail. It is the control that
// proves the atomic test is testing something.
import { sql } from 'kysely';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';

import {
  countRows,
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
import { runPullPhase } from '../../src/index.js';
import { noblePort } from '@bolusi/test-support';

let harness: SyncHarness;
let device: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;
let ops: SignedOperation[];

const BATCH_CURSOR = 105;

beforeEach(async () => {
  harness = await openSyncHarness();
  const prng = prngFor(4242);
  device = makeDevice(prng, 7);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  await seedDeviceRegistry(harness.db, [
    {
      id: device.id,
      storeId,
      kind: 'member',
      signingKeyPublic: device.publicKeyBase64,
      status: 'active',
      revokedAt: null,
    },
  ]);
  // Five ops, five distinct notes — so "how many applied" is visible as a row count, and a partial
  // apply is distinguishable from none.
  ops = Array.from({ length: 5 }, (_, i) =>
    makeSignedNoteOp({
      device,
      seq: i + 1,
      timestamp: 1_726_000_000_000 + i * 1000,
      tenantId,
      storeId,
      userId,
      entityId: uuidV7(prng, 1_726_000_000_000 + i * 1000),
      payload: { title: `t${i}`, body: `b${i}` },
      prng,
    }),
  );
});

afterEach(async () => {
  await harness.close();
});

/** Read the module watermark through the engine's own reader — never a hand-rolled query. */
async function watermark(): Promise<number> {
  return (await harness.engine.readWatermarks('notes')).appliedServerSeq;
}

async function cursor(): Promise<number> {
  const result = await sql<{ pullCursor: number }>`
    SELECT pull_cursor FROM sync_state WHERE id = 1
  `.execute(harness.db);
  return Number(result.rows[0]?.pullCursor ?? -1);
}

function pullDeps(applyPulledOp: (op: SignedOperation) => Promise<unknown>) {
  return {
    db: harness.db,
    transaction: harness.transaction,
    transport: harness.transport,
    surface: harness.surface,
    crypto: noblePort,
    clock: harness.clock,
    applyPulledOp,
  };
}

function scriptBatch(): void {
  harness.transport.scriptPull({
    ops,
    nextCursor: BATCH_CURSOR,
    hasMore: false,
    serverTime: 1_726_000_500_000,
  });
}

describe('pulled batches apply atomically (api/01-sync §4)', () => {
  it('applies the whole batch and advances cursor + watermark together', async () => {
    scriptBatch();
    const result = await runPullPhase(pullDeps((op) => harness.engine.applyPulledOp(op)));

    // T-14b positive control: the deny-tests below are only meaningful if the happy path really
    // moves all of this state. Five ops in, five notes out, watermark at the frontier.
    expect(result.applied).toBe(5);
    expect(await countRows(harness.db, 'operations')).toBe(5);
    expect(await countRows(harness.db, 'notes')).toBe(5);
    expect(await cursor()).toBe(BATCH_CURSOR);
    expect(await watermark()).toBe(5);
  });

  it('rolls the ENTIRE batch back when an apply throws mid-batch (F5) — no durable skip', async () => {
    scriptBatch();
    let applied = 0;
    const crashOnThird = async (op: SignedOperation): Promise<unknown> => {
      if (applied === 2) throw new Error('simulated crash mid-batch');
      applied += 1;
      return harness.engine.applyPulledOp(op);
    };

    await expect(runPullPhase(pullDeps(crashOnThird))).rejects.toThrow('simulated crash mid-batch');

    // THE OUTCOME. Two ops had already been applied inside the transaction when the third threw.
    // If the batch were not atomic, those two would be durable — and, far worse, the watermark
    // would have advanced to the highest CONTIGUOUS arrival_seq present, which (the engine inserts
    // before it applies) would already include ops that never projected.
    expect(await countRows(harness.db, 'operations')).toBe(0);
    expect(await countRows(harness.db, 'notes')).toBe(0);
    expect(await watermark()).toBe(0);
    // And the cursor did not move, so the batch is still owed to us.
    expect(await cursor()).toBe(0);
  });

  it('re-pull after a mid-batch crash re-applies cleanly and converges (F5 recovery)', async () => {
    scriptBatch();
    let calls = 0;
    await expect(
      runPullPhase(
        pullDeps(async (op) => {
          calls += 1;
          if (calls === 3) throw new Error('simulated crash mid-batch');
          return harness.engine.applyPulledOp(op);
        }),
      ),
    ).rejects.toThrow();

    // The cursor never moved, so the server re-serves the same batch — the resume, verbatim.
    scriptBatch();
    const result = await runPullPhase(pullDeps((op) => harness.engine.applyPulledOp(op)));

    expect(result.applied).toBe(5);
    expect(await countRows(harness.db, 'notes')).toBe(5);
    expect(await cursor()).toBe(BATCH_CURSOR);
    expect(await watermark()).toBe(5);
  });

  it('re-pull of an already-applied batch is an idempotent no-op (F4) — digest unchanged', async () => {
    scriptBatch();
    await runPullPhase(pullDeps((op) => harness.engine.applyPulledOp(op)));
    const digestBefore = await harness.digest();

    // F4 is "apply committed, crash before the cursor persisted". This pull writes the cursor INSIDE
    // the batch transaction, so F4 is structurally unreachable — but a re-delivery of an applied
    // batch must still be inert (05 §5 dedup by id), because a server may legitimately re-serve it.
    scriptBatch();
    const second = await runPullPhase(pullDeps((op) => harness.engine.applyPulledOp(op)));

    expect(second.applied).toBe(0); // every op deduped by id — none re-applied
    expect(await countRows(harness.db, 'operations')).toBe(5);
    expect(await harness.digest()).toBe(digestBefore); // no projection double-application
  });
});

describe('THE FALSIFICATION — per-op commits durably skip ops (why the batch is one transaction)', () => {
  /**
   * The forbidden shape, reproduced faithfully: insert the batch, then apply op-by-op, COMMITTING
   * between ops. This is what "the pull commits per-op" means in practice, and it is a shape a
   * future refactor could reach for innocently ("smaller transactions, less lock contention").
   *
   * This test asserts the CORRUPTION it produces. It is the control for the suite above: it proves
   * the atomic tests fail for a real reason rather than passing vacuously, and it is the reason
   * anyone reading `pull.ts`'s header should believe the header.
   */
  it('commits per-op: the watermark advances PAST ops that never projected, and nothing revisits them', async () => {
    // Insert every op first (the natural, efficient shape), each in its own committed transaction.
    let arrivalSeq = 0;
    for (const op of ops) {
      arrivalSeq += 1;
      await harness.transaction(async () => {
        await insertRaw(op, arrivalSeq);
      });
    }

    // Now apply only the FIRST op, in its own committed transaction — simulating a crash right
    // after the first per-op commit.
    await harness.transaction(async () => {
      await harness.engine.applyPulledOp(ops[0] as SignedOperation);
    });
    // ...and the cursor advances on its own, as it would once decoupled from the applies.
    await harness.transaction(async () => {
      await sql`UPDATE sync_state SET pull_cursor = ${BATCH_CURSOR} WHERE id = 1`.execute(
        harness.db,
      );
    });

    // ── The damage, asserted ────────────────────────────────────────────────────────────────
    // All five ops are durably in the log...
    expect(await countRows(harness.db, 'operations')).toBe(5);
    // ...but only ONE was ever projected.
    expect(await countRows(harness.db, 'notes')).toBe(1);
    // And here is the silent killer: the watermark says the module is caught up through op 5,
    // because `highestContiguousSeq` counts ops PRESENT in the log — all five are present.
    // Four ops are permanently unprojected and the bookkeeping insists nothing is owed.
    expect(await watermark()).toBe(5);
    // Nothing will ever revisit them: the cursor has moved past, so they are never re-pulled...
    expect(await cursor()).toBe(BATCH_CURSOR);
    // ...and the watermark is at the frontier, so no incremental path re-applies them. The device
    // is now permanently missing four ops with no error anywhere. THIS is what one transaction per
    // batch prevents, and why `pull.ts` inserts+applies+advances inside a single atom.
  });

  /** Same fixture, atomic path: the outcome the falsification proves is not free. */
  it('one transaction per batch: the same interruption leaves nothing behind', async () => {
    scriptBatch();
    await expect(
      runPullPhase(
        pullDeps(async (op) => {
          if (op.id === (ops[1] as SignedOperation).id) throw new Error('crash');
          return harness.engine.applyPulledOp(op);
        }),
      ),
    ).rejects.toThrow('crash');

    expect(await countRows(harness.db, 'operations')).toBe(0);
    expect(await countRows(harness.db, 'notes')).toBe(0);
    expect(await watermark()).toBe(0);
    expect(await cursor()).toBe(0);
  });
});

/** Raw op insert — the falsification's own plumbing, deliberately not the production path. */
async function insertRaw(op: SignedOperation, arrivalSeq: number): Promise<void> {
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status,
      synced_at, arrival_seq
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${null}, ${op.source}, ${0}, ${null}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${`jcs:${op.id}`}, 'synced', ${1}, ${arrivalSeq}
    )
  `.execute(harness.db);
}

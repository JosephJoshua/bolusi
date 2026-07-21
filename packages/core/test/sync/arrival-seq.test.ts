// What `operations.arrival_seq` MEANS on the client — pinned, so the next reader cannot re-derive
// the wrong meaning (task 51; owner ruling D20 §4).
//
// THE TWO-SIDED NAME THIS FILE EXISTS TO PREVENT. The server's `operations.server_seq` (10-db §5)
// is the per-tenant acceptance counter assigned under the `tenant_op_counters` row lock — gapless
// per TENANT, commit-ordered, and the value `WHERE server_seq > cursor` pages over. The client's
// column is NOT that value and never was: `serverSeq` is 05 §2.4 bookkeeping assigned at
// acceptance, i.e. AFTER signing, so it cannot ride inside the signed core, and no sibling field on
// the pull wire carries it (api/01 §4). The column held a LOCAL ARRIVAL COUNTER under a name that
// claimed otherwise — the decoy class of CLAUDE.md §2.11 — and D20 §4 renamed it `arrival_seq`.
//
// WHY THE COUNTER IS CORRECT AND NOT A SHORTCUT (D20 §4, three legs, one test each below):
//
//   1. NOTHING ELSE WRITES IT. `BookkeepingPatch` excludes `serverSeq` deliberately, so an own-
//      device op keeps `arrival_seq` NULL forever — the pull is the column's only writer, so there
//      is no second numbering to collide with.
//   2. IT IS WHAT THE WATERMARK NEEDS. `highestContiguousSeq` pins `applied_server_seq` at the
//      first HOLE. The client's stream is scope-FILTERED (api/01 §4.3), so the server's true
//      serverSeqs are inherently gappy on a multi-store tenant — storing them would freeze the
//      watermark below the first other-store op forever (task 46's class, by another route). Only a
//      GAPLESS counter makes "caught up" expressible on a client at all.
//   3. THE RESUME POINT IS NOT THIS NUMBER. `sync_state.pull_cursor` is the server's `nextCursor`
//      and is the only value the protocol defines as the resume position. The counter never leaves
//      the device — which is why the batch below carries a cursor of 9_999 and the rows still read
//      1, 2, 3.
//
// EVERY ASSERTION QUERIES THE REAL COLUMN. A rename that missed a call site does not fail to
// compile — the reads are raw `sql`, and a stale `server_seq` would fail at RUNTIME against a
// database that no longer has the column. So the schema leg below reads `PRAGMA table_info` and the
// rest read `arrival_seq` out of the real migrated DB through the real pull phase.
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClientOpStore } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import { runPullPhase } from '../../src/index.js';
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

/** Deliberately far from any plausible arrival number, so the two can never be confused. */
const FAR_CURSOR = 9_999;

let harness: SyncHarness;
let device: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;
let prng: ReturnType<typeof prngFor>;

beforeEach(async () => {
  harness = await openSyncHarness();
  prng = prngFor(51);
  device = makeDevice(prng, 9);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  await seedDeviceRegistry(harness.db, [deviceInfoOf(device, storeId)]);
});

afterEach(async () => {
  await harness.close();
});

function noteOp(seq: number): SignedOperation {
  const timestamp = 1_726_000_000_000 + seq * 1000;
  return makeSignedNoteOp({
    device,
    seq,
    timestamp,
    tenantId,
    storeId,
    userId,
    entityId: uuidV7(prng, timestamp),
    payload: { title: `t${seq}`, body: `b${seq}` },
    prng,
  });
}

/** Pull one scripted batch through the REAL pull phase and the REAL engine. */
async function pull(ops: readonly SignedOperation[], nextCursor: number): Promise<number> {
  harness.transport.scriptPull({
    ops: [...ops],
    nextCursor,
    hasMore: false,
    serverTime: 1_726_000_500_000,
  });
  const outcome = await runPullPhase({
    db: harness.db,
    transaction: harness.transaction,
    transport: harness.transport,
    surface: harness.surface,
    crypto: noblePort,
    clock: harness.clock,
    applyPulledOp: (op) => harness.engine.applyPulledOp(op),
  });
  return outcome.applied;
}

/** The stored arrival counters, in device-chain order. Raw `sql` — the column name is the subject. */
async function arrivalSeqs(): Promise<Array<number | null>> {
  const result = await sql<{ arrivalSeq: number | null }>`
    SELECT arrival_seq AS "arrivalSeq" FROM operations ORDER BY seq
  `.execute(harness.db);
  return result.rows.map((row) => (row.arrivalSeq === null ? null : Number(row.arrivalSeq)));
}

async function columnNames(): Promise<string[]> {
  const result = await sql<{ name: string }>`PRAGMA table_info(operations)`.execute(harness.db);
  return result.rows.map((row) => row.name);
}

describe('the client op log names the counter it actually stores (D20 §4)', () => {
  it('has `arrival_seq` and NO `server_seq` — the server column is not mirrored here', async () => {
    const columns = await columnNames();

    expect(columns).toContain('arrival_seq');
    // The rename is only complete if the old name is GONE: a surviving read of `server_seq` would
    // typecheck and fail at runtime, so absence in the live schema is the assertion that matters.
    expect(columns).not.toContain('server_seq');
  });
});

describe('the arrival counter is local, gapless and monotonic (D20 §4)', () => {
  it('numbers pulled ops 1..N regardless of the server cursor', async () => {
    expect(await pull([noteOp(1), noteOp(2), noteOp(3)], FAR_CURSOR)).toBe(3);

    // 1,2,3 — NOT 9_999, and not derived from it. Leg 3: the cursor is the resume point; the
    // arrival counter is a different number with a different job.
    expect(await arrivalSeqs()).toEqual([1, 2, 3]);
    const cursor = await sql<{ pullCursor: number }>`
      SELECT pull_cursor AS "pullCursor" FROM sync_state WHERE id = 1
    `.execute(harness.db);
    expect(Number(cursor.rows[0]?.pullCursor)).toBe(FAR_CURSOR);
  });

  it('continues across batches without a gap or a reuse', async () => {
    await pull([noteOp(1), noteOp(2)], FAR_CURSOR);
    await pull([noteOp(3), noteOp(4)], FAR_CURSOR + 50);

    expect(await arrivalSeqs()).toEqual([1, 2, 3, 4]);
  });

  it('leaves an own-device appended op NULL — the pull is the only writer', async () => {
    const own = noteOp(1);
    // The PRODUCTION op store (T-7: not a re-implementation), which is where `BookkeepingPatch`'s
    // deliberate exclusion of `serverSeq` becomes an observable NULL.
    const store = createClientOpStore({ db: harness.db, driver: harness.driver });
    await store.transaction((tx) =>
      tx.insertOp({ op: own, signedCoreJcs: JSON.stringify({ id: own.id }) }),
    );

    expect(await arrivalSeqs()).toEqual([null]);
  });

  it('is what lets the watermark reach the frontier (leg 2 — gapless ⇒ contiguous)', async () => {
    await pull([noteOp(1), noteOp(2), noteOp(3), noteOp(4)], FAR_CURSOR);

    // `highestContiguousSeq` stops at the first hole. Four ops in ⇒ 4 only if the counter emitted
    // 1,2,3,4 with no gap and no repeat: a gap pins this at the value before it, a reuse at the
    // duplicate. This is the assertion that makes the gapless property LOAD-BEARING rather than
    // decorative (CLAUDE.md §2.11).
    expect((await harness.engine.readWatermarks('notes')).appliedServerSeq).toBe(4);
  });
});

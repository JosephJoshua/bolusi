// The per-tenant counter lock must be taken BEFORE the device chain-head read (task 41; 10-db §3).
//
// THE BUG THIS PROVES (pipeline.ts, pre-fix ordering):
//   loadDevice(...)          reads devices.last_seq/last_hash  ← the chain head, NO lock held
//   lockTenantCounter(...)   FOR UPDATE                        ← taken AFTER the head read
//   head = { device.lastSeq, device.lastHash }                ← uses the pre-lock read, never re-read
// Two concurrent pushes from the SAME device both read the same stale head, both pass classifyChain,
// both allocate a serverSeq, and both INSERT the same (device_id, seq). Under the pre-fix order the
// second insert fails on the UNIQUE(device_id, seq) backstop (a raw constraint error), NOT on a clean
// CHAIN_CONFLICT. The fix moves the lock above loadDevice so the head is read UNDER the lock: the
// second push blocks on the lock, then reads the first push's COMMITTED head and rejects cleanly
// (CHAIN_BROKEN). The UNIQUE constraint stays as defence in depth — the reorder changes which
// mechanism catches the race, not whether it is caught.
//
// WHY THIS TEST LIVES IN apps/server AND NOT IN db-server's concurrency lane. db-server's
// oplog-server-seq-concurrency.test.ts races the two counter STATEMENTS in isolation (it cannot
// import the pipeline — the boundary rule forbids db-server value-importing @bolusi/server). But
// THIS bug is not in the statements; it is in the ORDER of the head-read vs the lock inside the
// pipeline. Only a test that drives `processPushBatch` itself can witness it, and it needs real
// concurrency: two transactions on two REAL pooled connections. apps/server's L3 lane (task 81) runs
// exactly that — postgres:16 in a container, real `pg`, POOL_PER_FILE=2 (the floor that lets two
// transactions be alive at once). PGlite's single in-process connection could not express it.
//
// WHY THE INTERLEAVING IS DETERMINISTIC AND NOT "Promise.all luck" (T-14b). A plain Promise.all
// races on timing: if the winning transaction happened to commit before the loser even issued its
// head-read, the loser would read the fresh head and the race would silently NOT reproduce — a race
// test that can pass under the buggy order is worthless. So both transactions rendezvous at a
// two-party barrier the instant AFTER their `devices` SELECT (the head read) resolves — installed as
// a Kysely plugin on the transaction the pipeline runs against. Under the BUGGY order the head-read
// precedes the lock, so both transactions reach the barrier, the barrier releases them together, and
// they are PROVABLY both past the head-read with neither committed before either touches the lock —
// the exact overlap T-14b demands. Under the FIXED order the head-read is AFTER the lock, so only the
// lock-winner reaches the barrier; the loser is blocked on the FOR UPDATE and can never arrive, which
// would deadlock a strict barrier — hence a per-arrival fallback timeout that lets the lone arriver
// proceed. That timeout fires ONLY on the fixed path (where the race is already impossible) and NEVER
// on the buggy path (where both arrive within milliseconds), so it cannot manufacture a false green.
//
// FALSIFICATION (§2.11): revert the reorder in pipeline.ts (put loadDevice back above
// lockTenantCounter) and this test goes RED — the second push throws
// `duplicate key value violates unique constraint "operations_device_id_seq_key"` instead of
// resolving with a clean CHAIN_BROKEN, so `settled` contains a 'rejected' and `codes` is
// ['accepted', 'duplicate-key…'] not ['CHAIN_BROKEN', 'accepted']. Restore → GREEN.
import { ChainBuilder, makeWorld } from '@bolusi/test-support';
import type { DB } from '@bolusi/db-server';
import {
  SelectQueryNode,
  TableNode,
  sql,
  type Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import {
  APP_ROLE,
  makeDeps,
  makeOplogTestDb,
  readOps,
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

/** True when `node` is a top-level `SELECT ... FROM devices` — the pipeline's `loadDevice` read. */
function isChainHeadRead(node: RootOperationNode): boolean {
  if (!SelectQueryNode.is(node)) return false;
  const froms = node.from?.froms ?? [];
  return froms.some((from) => TableNode.is(from) && from.table.identifier.name === 'devices');
}

interface HeadReadBarrier {
  /** Called once per transaction, right after its chain-head read resolves. */
  arrive(): Promise<void>;
}

/**
 * A two-party rendezvous on the chain-head read. Releases both parties the instant the second
 * arrives (deterministic overlap on the buggy order); a per-arrival `fallbackMs` lets a lone arriver
 * proceed so the FIXED order — where the loser is blocked on the lock and never arrives — does not
 * deadlock. The fallback never fires on the buggy order (both arrive in ms), so it cannot hide a bug.
 */
function makeHeadReadBarrier(parties: number, fallbackMs: number): HeadReadBarrier {
  let arrived = 0;
  let releaseAll!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) {
        releaseAll();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fallback = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, fallbackMs);
      });
      await Promise.race([gate, fallback]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** A Kysely plugin that blocks each transaction at the barrier immediately after its head read. */
function makeBarrierPlugin(barrier: HeadReadBarrier): KyselyPlugin {
  const headReads = new WeakSet<QueryId>();
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      if (isChainHeadRead(args.node)) headReads.add(args.queryId);
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      if (headReads.has(args.queryId)) await barrier.arrive();
      return args.result;
    },
  };
}

interface RacingForTenant {
  readonly forTenant: OplogTestDb['appForTenant'];
  /** The most transactions this handle ever had in-flight at once — 2 proves genuine concurrency. */
  maxInFlight(): number;
}

/**
 * `appForTenant` (SET LOCAL ROLE bolusi_app → RLS enforced, exactly the production path) plus the
 * barrier plugin on the transaction the pipeline runs against, plus an in-flight counter whose peak
 * proves two transactions were alive simultaneously (the thing PGlite structurally cannot do).
 */
function makeRacingForTenant(db: Kysely<DB>, barrier: HeadReadBarrier): RacingForTenant {
  const plugin = makeBarrierPlugin(barrier);
  let inFlight = 0;
  let peak = 0;
  const forTenant: OplogTestDb['appForTenant'] = (tenantId, fn) =>
    db.transaction().execute(async (trx) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await sql`SET LOCAL ROLE ${sql.id(APP_ROLE)}`.execute(trx);
        await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return await fn(trx.withPlugin(plugin));
      } finally {
        inFlight -= 1;
      }
    });
  return { forTenant, maxInFlight: () => peak };
}

describe('the tenant-counter lock precedes the chain-head read (task 41)', () => {
  test('two concurrent same-device pushes serialise on the lock — no UNIQUE(device_id, seq) race', async () => {
    // Provenance first (T-14d): believe these numbers only if a real PG16 produced them.
    expect(testDb.provenance).toMatch(/PostgreSQL 16/);

    const world = makeWorld(4101, serverCryptoPort);
    await seedWorld(testDb.db, world); // active device, lastSeq=0, tenant_op_counters at 1

    // Two DISTINCT genesis ops at the SAME chain position: different timestamps → different ids and
    // hashes, but both seq=1 with previousHash=GENESIS, both signed by the device key. This is the
    // race shape — two different ops (not a dedupe-caught replay) that collide on (device_id, seq=1).
    const opA = new ChainBuilder(world, serverCryptoPort).genesis({ timestamp: 1_726_000_100_000 });
    const opB = new ChainBuilder(world, serverCryptoPort).genesis({ timestamp: 1_726_000_200_000 });
    // Assert the fixture actually sets up the collision (T-14b) — else a passing test proves nothing.
    expect(opA.id).not.toBe(opB.id);
    expect([opA.seq, opB.seq]).toEqual([1, 1]);
    expect([opA.previousHash, opB.previousHash]).toEqual([opB.previousHash, opA.previousHash]); // both genesis

    const barrier = makeHeadReadBarrier(2, 400);
    const racing = makeRacingForTenant(testDb.db, barrier);
    const deps = makeDeps({ forTenant: racing.forTenant });
    const identity = { deviceId: world.deviceId, tenantId: world.tenantId };

    const settled = await Promise.allSettled([
      processPushBatch(deps, identity, [opA]),
      processPushBatch(deps, identity, [opB]),
    ]);

    // Genuine concurrency: both transactions were alive at once (the barrier held one open while the
    // other reached its head read / blocked on the lock). PGlite could never reach 2 here.
    expect(racing.maxInFlight()).toBe(2);

    // No transaction threw. Under the BUGGY order the second insert hits UNIQUE(device_id, seq) and
    // its push REJECTS (throws) — this array is then non-empty → RED. Reasons are surfaced so the
    // falsification run prints exactly which constraint fired.
    const thrown = settled.flatMap((s) => (s.status === 'rejected' ? [String(s.reason)] : []));
    expect(thrown).toEqual([]);

    // Exactly one push accepted, the other a CLEAN CHAIN_BROKEN — the fix's mechanism (05 §8), never
    // a raw constraint error. (One op per push, so results[0] is that push's single outcome.)
    const codes = settled
      .map((s) => {
        if (s.status !== 'fulfilled') return 'THREW';
        const r = s.value.results[0];
        if (r === undefined) return 'EMPTY';
        return r.status === 'rejected' ? r.code : r.status;
      })
      .sort();
    expect(codes).toEqual(['CHAIN_BROKEN', 'accepted']);

    // Defence in depth intact + gaplessness preserved: exactly ONE op landed at seq 1 / serverSeq 1,
    // and the counter advanced by exactly one (the single acceptance). The UNIQUE backstop is
    // untouched — it simply never had to fire, because the lock ordering caught the race first.
    const rows = await readOps(testDb.db, world.tenantId);
    expect(rows.map((r) => Number(r.seq))).toEqual([1]);
    expect(rows.map((r) => Number(r.serverSeq))).toEqual([1]);

    const counter = await testDb.db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', world.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(counter.nextServerSeq)).toBe(2);
  });
});

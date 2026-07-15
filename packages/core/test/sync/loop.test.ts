// The sync-loop machine end to end (03-state-machines §10; api/01-sync §5–§6).
//
// ── THE CLASS SWEEP, AND THE AXIS IT DELIBERATELY LEAVES ────────────────────────────────────────
//
// T-12: the sweep that misses is usually a whole AXIS, not a case. Task 14's lockout sweep enumerated
// clock-rollback, clock-forward, restart and correct-PIN-mid-lockout — every case SEQUENTIAL — and
// missed CONCURRENCY entirely. The equivalent axis here is not "which trigger reason" (that is the
// obvious enumeration, and it is covered below); it is WHEN the trigger lands relative to the cycle's
// await points. A loop is a concurrency object: its bugs live in the interleavings, and every one of
// them is invisible to a suite that only ever triggers a quiescent loop.
//
// So the trigger reasons are swept ACROSS the loop's states (idle / pushing / pulling / backoff) and
// across the interleavings that matter: N triggers landing mid-cycle, a trigger landing while the
// backoff timer is firing, and a trigger landing during the rerun handoff. `EARLY_EXIT_REASONS` is
// swept as a SET so a new reason cannot quietly join the absorbed side.
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PushResult, SignedOperation } from '@bolusi/schemas';

import { noblePort } from '@bolusi/test-support';

import {
  DomainError,
  SYNC_BACKOFF_SCHEDULE_MS,
  SYNC_LOOP_MACHINE,
  SyncTransportError,
  runTransition,
  signedCoreJcsOf,
  type SyncLoopEvent,
  type SyncLoopState,
  type SyncTriggerReason,
} from '../../src/index.js';
import {
  makeDevice,
  makeSignedNoteOp,
  openSyncHarness,
  prngFor,
  uuidV4,
  uuidV7,
  type SyncHarness,
  type TestDevice,
} from './_fixtures.js';

let harness: SyncHarness;
let device: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;

const ALL_REASONS: readonly SyncTriggerReason[] = [
  'connectivity',
  'append',
  'periodic',
  'background',
  'manual',
];
/** 03 §10: only these two cancel a running backoff timer. */
const EARLY_EXIT: readonly SyncTriggerReason[] = ['manual', 'connectivity'];
const ABSORBED = ALL_REASONS.filter((r) => !EARLY_EXIT.includes(r));

beforeEach(async () => {
  harness = await openSyncHarness();
  const prng = prngFor(555);
  device = makeDevice(prng, 3);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
});

afterEach(async () => {
  await harness.close();
});

async function seedLocalOp(seq: number): Promise<SignedOperation> {
  const prng = prngFor(8000 + seq);
  const timestamp = 1_726_000_000_000 + seq * 1000;
  const op = makeSignedNoteOp({
    device,
    seq,
    timestamp,
    tenantId,
    storeId,
    userId,
    entityId: uuidV7(prng, timestamp),
    prng,
  });
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${null}, ${op.source}, ${0}, ${null}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${signedCoreJcsOf(op, noblePort)}, 'local'
    )
  `.execute(harness.db);
  return op;
}

async function syncStateRow(): Promise<{
  lastSuccessfulSyncAt: number | null;
  pushHalted: number;
  syncDisabled: number;
  syncDisabledReason: string | null;
  backoffUntil: number | null;
  lastSyncError: string | null;
}> {
  const rows = await sql<{
    lastSuccessfulSyncAt: number | null;
    pushHalted: number;
    syncDisabled: number;
    syncDisabledReason: string | null;
    backoffUntil: number | null;
    lastSyncError: string | null;
  }>`
    SELECT last_successful_sync_at, push_halted, sync_disabled, sync_disabled_reason,
           backoff_until, last_sync_error
    FROM sync_state WHERE id = 1
  `.execute(harness.db);
  return rows.rows[0] as never;
}

const netFail = () => {
  throw new SyncTransportError('network down');
};

describe('the §10 transition table is encoded data, and invalid pairs throw (03 §1)', () => {
  it('every state and event of 03 §10 is expressible; the table matches the doc', () => {
    expect(SYNC_LOOP_MACHINE.states).toEqual(['idle', 'pushing', 'pulling', 'backoff']);
    expect(SYNC_LOOP_MACHINE.initial).toEqual(['idle']); // 03 §10 "Birth: idle at app start"
    // The doc's rows, transcribed. This IS the parity assertion (03 §1: "a parity test shall assert
    // the code tables equal this doc's tables").
    const expected: Record<SyncLoopState, Partial<Record<SyncLoopEvent, SyncLoopState>>> = {
      idle: { trigger: 'pushing', device_revoked: 'idle' },
      pushing: { push_drained: 'pulling', transport_failure: 'backoff', device_revoked: 'idle' },
      pulling: { pull_drained: 'idle', transport_failure: 'backoff', device_revoked: 'idle' },
      backoff: { timer_elapsed: 'pushing', trigger: 'pushing', device_revoked: 'idle' },
    };
    expect(SYNC_LOOP_MACHINE.transitions).toEqual(expected);
  });

  it('an invalid (state, event) pair throws INVALID_TRANSITION (03 §10 "Invalid: any other pair")', () => {
    // Dev builds crash loudly; production logs and leaves the machine unchanged — the CALLER picks,
    // which is only possible because the executor throws rather than silently no-op'ing.
    expect(() => runTransition(SYNC_LOOP_MACHINE, 'idle', 'pull_drained')).toThrow(DomainError);
    expect(() => runTransition(SYNC_LOOP_MACHINE, 'pushing', 'trigger')).toThrow(DomainError);
    expect(() => runTransition(SYNC_LOOP_MACHINE, 'backoff', 'push_drained')).toThrow(DomainError);
    try {
      runTransition(SYNC_LOOP_MACHINE, 'idle', 'timer_elapsed');
      expect.unreachable('idle + timer_elapsed must be invalid');
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_TRANSITION');
      expect((error as DomainError).details).toMatchObject({
        machine: 'sync_loop',
        from: 'idle',
        event: 'timer_elapsed',
      });
    }
  });

  it('device_revoked is expressible from EVERY state — including idle', () => {
    // A 401 can land on a cycle that is already unwinding. If `idle + device_revoked` threw, the
    // terminal disable would blow up at exactly the moment it matters.
    for (const state of SYNC_LOOP_MACHINE.states) {
      expect(runTransition(SYNC_LOOP_MACHINE, state, 'device_revoked').to).toBe('idle');
    }
  });
});

describe('a full cycle walks idle → pushing → pulling → idle (03 §10)', () => {
  it.each(ALL_REASONS)('trigger reason %s starts a cycle from idle', async (reason) => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    loop.requestSync(reason);
    await loop.settle();

    expect(loop.state).toBe('idle');
    const state = await syncStateRow();
    expect(state.lastSuccessfulSyncAt).toBe(harness.clock.now());
    expect(harness.bundleRefreshes()).toBe(1); // once per loop (api/01 §6)
  });

  it('sets lastSuccessfulSyncAt, lastServerTime and clears the error on an error-free drain', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPull({
      ops: [],
      nextCursor: 0,
      hasMore: false,
      serverTime: 1_726_000_777_000,
    });
    loop.requestSync('manual');
    await loop.settle();

    const state = await syncStateRow();
    expect(state.lastSuccessfulSyncAt).toBe(harness.clock.now());
    expect(state.lastSyncError).toBeNull();
    expect(state.backoffUntil).toBeNull();
    const server = await sql<{ lastServerTime: number }>`
      SELECT last_server_time FROM sync_state WHERE id = 1
    `.execute(harness.db);
    expect(Number(server.rows[0]?.lastServerTime)).toBe(1_726_000_777_000);
  });

  it('pulls until drained, looping while hasMore (api/01 §4)', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPull(
      { ops: [], nextCursor: 10, hasMore: true, serverTime: 1 },
      { ops: [], nextCursor: 20, hasMore: true, serverTime: 2 },
      { ops: [], nextCursor: 30, hasMore: false, serverTime: 3 },
    );
    loop.requestSync('manual');
    await loop.settle();

    expect(harness.transport.pulls).toHaveLength(3);
    // Each pull carries the cursor the previous batch committed — the resume point, not an offset.
    expect(harness.transport.pulls.map((p) => p.cursor)).toEqual([0, 10, 20]);
  });

  it('a failed PUSH never touches lastSuccessfulSyncAt (03 §8)', async () => {
    // "A failed push does not affect staleness" — unpushed local work is a SEPARATE indicator
    // (the derived pendingOperationCount). Conflating them would tell a user their data is stale
    // when it is merely un-uploaded, which is a different problem with a different remedy.
    await seedLocalOp(1);
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPush(netFail);

    loop.requestSync('manual');
    await loop.settle();

    expect(loop.state).toBe('backoff');
    expect((await syncStateRow()).lastSuccessfulSyncAt).toBeNull();
  });
});

describe('trigger guards (03 §10)', () => {
  it('syncDisabled ⇒ NO cycle starts, for any reason including manual', async () => {
    await sql`UPDATE sync_state SET sync_disabled = 1, sync_disabled_reason = 'device_revoked' WHERE id = 1`.execute(
      harness.db,
    );
    const loop = await harness.makeLoop({ deviceId: device.id });

    for (const reason of ALL_REASONS) loop.requestSync(reason);
    await loop.settle();

    // Not even a manual pull-to-refresh restarts a revoked device: recovery is re-enrollment (03 §5).
    expect(harness.transport.pushes).toHaveLength(0);
    expect(harness.transport.pulls).toHaveLength(0);
    expect(loop.state).toBe('idle');
  });

  it('pushHalted ⇒ push is SKIPPED but pull still runs and drains', async () => {
    await seedLocalOp(1);
    await sql`UPDATE sync_state SET push_halted = 1 WHERE id = 1`.execute(harness.db);
    const loop = await harness.makeLoop({ deviceId: device.id });

    loop.requestSync('manual');
    await loop.settle();

    // A device with a broken chain still needs the rest of the tenant's history. Halting both legs
    // would turn a push-side fault into total blindness.
    expect(harness.transport.pushes).toHaveLength(0);
    expect(harness.transport.pulls).toHaveLength(1);
    expect(loop.state).toBe('idle');
    expect((await syncStateRow()).lastSuccessfulSyncAt).not.toBeNull();
  });

  it('requestSync before hydrate() throws rather than defaulting the guards to false', async () => {
    // Defaulting `syncDisabled` to false would let a revoked device sync until the read landed.
    // Failing loudly on a programming error beats a security-relevant guess.
    const { SyncLoop } = await import('../../src/index.js');
    const loop = new SyncLoop({
      db: harness.db,
      transaction: harness.transaction,
      transport: harness.transport,
      surface: harness.surface,
      crypto: (await import('@bolusi/test-support')).noblePort,
      clock: harness.clock,
      timer: harness.timer,
      deviceId: device.id,
      applyPulledOp: async () => undefined,
      bundle: { refresh: async () => 'unchanged' as const },
    });
    expect(() => loop.requestSync('manual')).toThrow(/hydrate/);
  });
});

describe('single-flight + coalescing — the CONCURRENCY axis (03 §10, api/01 §6)', () => {
  it('N concurrent triggers while a cycle runs produce exactly ONE cycle and ONE rerun', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    let pullCalls = 0;
    harness.transport.scriptPull(
      ...Array.from({ length: 10 }, () => () => {
        pullCalls += 1;
        return { ops: [], nextCursor: 0, hasMore: false, serverTime: 1 };
      }),
    );

    // Fire the first trigger, then pile 9 more on WHILE it is in flight (no awaits between).
    loop.requestSync('manual');
    for (let i = 0; i < 9; i += 1)
      loop.requestSync(ALL_REASONS[i % ALL_REASONS.length] as SyncTriggerReason);
    await loop.settle();

    // 10 triggers ⇒ 1 cycle + 1 coalesced rerun = 2. NOT 10. The rerun flag is a flag, not a
    // counter: that is what "triggers coalesce" means, and it is the difference between a busy
    // device and a device that DDoSes its own server on a flaky connection.
    expect(loop.getStats().cycles).toBe(2);
    expect(pullCalls).toBe(2);
    expect(loop.state).toBe('idle');
  });

  it('triggers landing at successive await points still yield one cycle at a time', async () => {
    // The interleaving axis: fire a trigger from INSIDE the transport call, i.e. at the exact await
    // point where a naive check-then-act would have already released the slot.
    const loop = await harness.makeLoop({ deviceId: device.id });
    let inFlight = 0;
    let maxConcurrent = 0;
    harness.transport.scriptPull(
      ...Array.from({ length: 6 }, () => () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        loop.requestSync('periodic'); // re-entrant trigger, mid-cycle
        inFlight -= 1;
        return { ops: [], nextCursor: 0, hasMore: false, serverTime: 1 };
      }),
    );

    loop.requestSync('manual');
    await loop.settle();

    // At no point were two cycles inside the transport simultaneously.
    expect(maxConcurrent).toBe(1);
    expect(loop.state).toBe('idle');
  });

  it('a rerun does not chain forever — one follow-up, then quiescence', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    loop.requestSync('manual');
    loop.requestSync('periodic');
    await loop.settle();
    expect(loop.getStats().cycles).toBe(2);

    // Settled means settled: no stray timer, no pending rerun.
    expect(harness.timer.pending()).toBe(0);
    expect(loop.state).toBe('idle');
  });
});

describe('backoff (api/01 §6: 5 s → 15 s → 60 s → 5 min cap, reset on success)', () => {
  it('the schedule is exactly 03 §10 / api/01 §6', () => {
    expect(SYNC_BACKOFF_SCHEDULE_MS).toEqual([5_000, 15_000, 60_000, 300_000]);
  });

  it('escalates 5 s → 15 s → 60 s → 5 min and CAPS, under FakeClock', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    // Every pull fails, forever.
    harness.transport.scriptPull(...Array.from({ length: 12 }, () => netFail));

    const observed: number[] = [];
    loop.requestSync('manual');
    await loop.settle();

    for (let i = 0; i < 5; i += 1) {
      expect(loop.state).toBe('backoff');
      const at = harness.timer.nextAt();
      expect(at).not.toBeNull();
      observed.push((at as number) - harness.clock.now());
      await harness.timer.advance((at as number) - harness.clock.now());
      await loop.settle();
    }

    // The cap holds forever after — backoff escalates visibility, it never stops retrying.
    expect(observed).toEqual([5_000, 15_000, 60_000, 300_000, 300_000]);
  });

  it('resets to the first delay after a success', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPull(netFail, netFail);
    loop.requestSync('manual');
    await loop.settle();
    await harness.timer.advance(5_000);
    await loop.settle();
    expect(harness.timer.nextAt()).toBe(harness.clock.now() + 15_000); // escalated

    // A success in between must clear `failureCount` — otherwise a device that fails twice a day
    // creeps to the 5-minute cap and stays there for reasons nobody can see.
    harness.transport.scriptPull({ ops: [], nextCursor: 0, hasMore: false, serverTime: 1 });
    await harness.timer.advance(15_000);
    await loop.settle();
    expect(loop.state).toBe('idle');

    harness.transport.scriptPull(netFail);
    loop.requestSync('manual');
    await loop.settle();
    expect(harness.timer.nextAt()).toBe(harness.clock.now() + 5_000); // back to the start
  });

  it.each(ABSORBED)(
    'an automatic trigger (%s) during backoff is absorbed — the timer is untouched',
    async (reason) => {
      const loop = await harness.makeLoop({ deviceId: device.id });
      harness.transport.scriptPull(netFail);
      loop.requestSync('manual');
      await loop.settle();

      const armedAt = harness.timer.nextAt();
      const pullsBefore = harness.transport.pulls.length;

      loop.requestSync(reason);
      await loop.settle();

      // Neither shortened nor reset nor re-armed (03 §10). A 60 s periodic tick inside a 5-minute
      // backoff must not drag the retry forward every minute — that would silently flatten the whole
      // schedule to its shortest interval against a server that is already failing.
      expect(harness.timer.nextAt()).toBe(armedAt);
      expect(harness.timer.pending()).toBe(1);
      expect(harness.transport.pulls.length).toBe(pullsBefore);
      expect(loop.state).toBe('backoff');
    },
  );

  it.each(EARLY_EXIT)(
    'an early-exit trigger (%s) during backoff cancels the timer and re-enters pushing',
    async (reason) => {
      const loop = await harness.makeLoop({ deviceId: device.id });
      harness.transport.scriptPull(netFail);
      loop.requestSync('manual');
      await loop.settle();
      expect(loop.state).toBe('backoff');

      harness.transport.scriptPull({ ops: [], nextCursor: 0, hasMore: false, serverTime: 1 });
      loop.requestSync(reason);
      await loop.settle();

      expect(loop.state).toBe('idle');
      // The cancelled timer must not fire later and start a phantom cycle.
      const cycles = loop.getStats().cycles;
      await harness.timer.advance(600_000);
      await loop.settle();
      expect(loop.getStats().cycles).toBe(cycles);
    },
  );

  it('the early-exit set is exactly {manual, connectivity} — no reason quietly joins it', async () => {
    // The SET is the denominator (T-14). A test that only checked `manual` would not notice
    // `periodic` being added to the early-exit side, which would flatten the schedule silently.
    //
    // Each reason gets its OWN harness: the timer and the transport script are per-harness state,
    // and reusing one across the sweep let a previous iteration's armed timer answer this
    // iteration's question — which is how a sweep reports a result it never measured.
    for (const reason of ALL_REASONS) {
      const own = await openSyncHarness();
      try {
        const loop = await own.makeLoop({ deviceId: device.id });
        own.transport.scriptPull(netFail);
        loop.requestSync('manual');
        await loop.settle();
        expect(loop.state, `${reason}: precondition — in backoff`).toBe('backoff');
        const armedAt = own.timer.nextAt();

        own.transport.scriptPull({ ops: [], nextCursor: 0, hasMore: false, serverTime: 1 });
        loop.requestSync(reason);
        await loop.settle();

        // Early exit ⇒ the timer is gone and a cycle ran. Absorbed ⇒ the timer stands, untouched.
        const exited = loop.state === 'idle' && own.timer.nextAt() === null;
        const absorbed = loop.state === 'backoff' && own.timer.nextAt() === armedAt;
        expect(exited, `${reason} caused an early exit`).toBe(EARLY_EXIT.includes(reason));
        expect(absorbed, `${reason} was absorbed`).toBe(!EARLY_EXIT.includes(reason));
      } finally {
        await own.close();
      }
    }
  });

  it('partial pull progress is KEPT across a backoff (03 §10: cursor already persisted)', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPull(
      { ops: [], nextCursor: 50, hasMore: true, serverTime: 1 }, // this batch commits its cursor
      netFail, // ...then the next one dies
    );
    loop.requestSync('manual');
    await loop.settle();

    expect(loop.state).toBe('backoff');
    const cursor = await sql<{ pullCursor: number }>`
      SELECT pull_cursor FROM sync_state WHERE id = 1
    `.execute(harness.db);
    // api/01 §1: "interruption never restarts a sync from zero". The resume picks up at 50.
    expect(Number(cursor.rows[0]?.pullCursor)).toBe(50);
  });
});

describe('DEVICE_REVOKED 401 (03 §10 "any → idle")', () => {
  it('disables sync, records the reason, surfaces it, and stops all automatic cycles', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPull(() => {
      throw new SyncTransportError('revoked', { code: 'DEVICE_REVOKED', status: 401 });
    });

    loop.requestSync('manual');
    await loop.settle();

    expect(loop.state).toBe('idle'); // NOT backoff — a revoked device must not retry forever
    const state = await syncStateRow();
    expect(state.syncDisabled).toBe(1);
    expect(state.syncDisabledReason).toBe('device_revoked');
    expect(harness.surface.ofKind('sync_disabled')).toHaveLength(1);
    // No backoff timer was armed: there is nothing to retry.
    expect(harness.timer.pending()).toBe(0);

    const pullsBefore = harness.transport.pulls.length;
    for (const reason of ALL_REASONS) loop.requestSync(reason);
    await loop.settle();
    expect(harness.transport.pulls.length).toBe(pullsBefore);
  });

  it('a 401 that is NOT DEVICE_REVOKED backs off instead of disabling sync', async () => {
    // The discrimination that matters: `AUTH_TOKEN_INVALID` is also a 401. `syncDisabled` has no
    // automatic exit (03 §10) and clearing it means re-enrolling the device — so treating an
    // expired token as a revocation would brick a working device on a recoverable error.
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.transport.scriptPull(() => {
      throw new SyncTransportError('token', { code: 'AUTH_TOKEN_INVALID', status: 401 });
    });

    loop.requestSync('manual');
    await loop.settle();

    expect(loop.state).toBe('backoff');
    expect((await syncStateRow()).syncDisabled).toBe(0);
    expect((await syncStateRow()).lastSyncError).toBe('AUTH_TOKEN_INVALID');
  });
});

describe('the loop never throws to its caller (api/01 §6)', () => {
  it.each([
    ['transport failure', () => harness.transport.scriptPull(netFail)],
    [
      'device revoked',
      () =>
        harness.transport.scriptPull(() => {
          throw new SyncTransportError('revoked', { code: 'DEVICE_REVOKED', status: 401 });
        }),
    ],
    ['bundle refresh failure', () => harness.failBundle(1)],
  ])('%s does not throw out of requestSync', async (_name, arrange) => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    arrange();
    // `requestSync` is void and fire-and-forget: step 7 of the append path (04 §5.1) calls it AFTER
    // a command has already committed locally. If it could throw, an offline device would fail
    // commands for the crime of being offline — the exact opposite of the product.
    expect(() => loop.requestSync('manual')).not.toThrow();
    await expect(loop.settle()).resolves.toBeUndefined();
  });

  it('a surfacing sink that throws does not become a loop failure', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    const op = await seedLocalOp(1);
    harness.transport.scriptPush({
      results: [
        { id: op.id, status: 'rejected', code: 'SCHEMA_INVALID', reason: 'bad' } as PushResult,
      ],
      serverTime: 1,
    });
    // The act of REPORTING a problem must not create one.
    harness.surface.emit = () => {
      throw new Error('UI exploded');
    };

    loop.requestSync('manual');
    await loop.settle();

    expect(loop.state).toBe('idle'); // the cycle completed despite the sink
  });

  it('an op-level rejection is NOT a loop failure — no backoff, no failureCount (03 §10)', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    const op = await seedLocalOp(1);
    harness.transport.scriptPush({
      results: [{ id: op.id, status: 'rejected', code: 'SCOPE_VIOLATION', reason: 'nope' }],
      serverTime: 1,
    });

    loop.requestSync('manual');
    await loop.settle();

    // A rejection arrives inside a 200: the server understood us perfectly. A device with one
    // permanently-rejected op must not sit in permanent backoff because of it.
    expect(loop.state).toBe('idle');
    expect(harness.timer.pending()).toBe(0);
    expect((await syncStateRow()).lastSuccessfulSyncAt).not.toBeNull();
  });
});

describe('bundle refresh (api/01 §6, once per loop)', () => {
  it('is invoked exactly once per cycle and 304 (unchanged) is success', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    loop.requestSync('manual');
    await loop.settle();
    expect(harness.bundleRefreshes()).toBe(1);

    loop.requestSync('manual');
    await loop.settle();
    expect(harness.bundleRefreshes()).toBe(2);
    // The fake returns 'unchanged' (a 304) every time — a steady-state device gets one on EVERY
    // cycle, and a loop that treated it as failure would live in permanent backoff.
    expect(loop.state).toBe('idle');
  });

  it('a bundle failure enters backoff and does not mark the sync successful', async () => {
    const loop = await harness.makeLoop({ deviceId: device.id });
    harness.failBundle(1);
    loop.requestSync('manual');
    await loop.settle();

    expect(loop.state).toBe('backoff');
    expect((await syncStateRow()).lastSuccessfulSyncAt).toBeNull();
  });
});

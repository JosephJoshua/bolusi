// THE SYNC CLIENT (task 89) — the acceptance this whole task exists for.
//
// An ENROLLED device's persisted state (a `deviceId`, the seeded `sync_state`, any local ops) is
// given to `createSyncClient`, and the REAL `SyncLoop` (task 15) runs end-to-end against a FAKE
// transport with a FAKE timer and ZERO sockets (T-6: a test that sleeps is a bug). The load-bearing
// assertion is T-19: after the first cycle `lastSuccessfulSyncAt` is a REAL timestamp READ FROM
// `sync_state` — never `?? Date.now()`, never a literal — so the never-connected banner clears.
//
// WHAT THIS DOES NOT CLAIM: that a PRODUCTION device reaches this enrolled state. That needs the
// genesis append (the mobile command-runtime composition task). This proves the loop, given the
// state; sync-client.ts's header states the boundary. The falsifications below break each wiring
// (bundle, transport, the connectivity trigger) and watch the cycle fail LOUDLY (§2.11).
import { readSyncState, stalenessLevel, SyncTransportError } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SignedOperation,
} from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { createSyncClient, type SyncClientDeps } from './sync-client.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };
const T = 1_726_000_000_000;
const DEVICE_ID = '00000000-0000-4000-8000-0000000000ab';

/** A `TimerPort` that RECORDS but never fires — the happy path arms no backoff, and a failed cycle's
 *  backoff is asserted by the loop STATE ('backoff'), never by advancing wall-clock time (T-6). */
class RecordingTimer {
  scheduled = 0;
  // Fewer params than `TimerPort.schedule` is assignable (and avoids unused-var lint): this fake
  // never fires, so it needs neither the delay nor the callback.
  schedule(): () => void {
    this.scheduled += 1;
    return () => undefined;
  }
}

/** A scripted transport (zero sockets). Records requests; `*Rejects` makes a leg fail like the wire.
 *  NOTE push is SKIPPED on an empty local batch (push.ts returns before the transport call), so `pull`
 *  — always issued when a cycle runs — is the reliable "a cycle ran" signal for a device with no ops. */
class FakeTransport {
  readonly pushes: PushRequest[] = [];
  readonly pulls: PullRequest[] = [];
  pushRejects = false;
  pullRejects = false;
  push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(request);
    if (this.pushRejects) {
      return Promise.reject(
        new SyncTransportError('server down', { code: 'INTERNAL', status: 503 }),
      );
    }
    return Promise.resolve({ results: [], serverTime: T });
  }
  pull(request: PullRequest): Promise<PullResponse> {
    this.pulls.push(request);
    if (this.pullRejects) {
      return Promise.reject(
        new SyncTransportError('server down', { code: 'INTERNAL', status: 503 }),
      );
    }
    return Promise.resolve({ ops: [], nextCursor: request.cursor, hasMore: false, serverTime: T });
  }
}

/** A fake `NetInfoPort` — fires immediately with the current state, then on `emit` (NetInfo contract). */
function fakeNetInfo(initial: boolean) {
  let connected = initial;
  const listeners = new Set<(c: boolean) => void>();
  return {
    port: {
      subscribe: (listener: (c: boolean) => void) => {
        listeners.add(listener);
        listener(connected);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(next: boolean) {
      connected = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/** A fake `AppStatePort`: foregrounded, no transitions. The interval arms but the RecordingTimer never
 *  fires it, so the only cycle driver in these tests is the connectivity trigger — exactly the seam
 *  under test. */
const activeAppState = {
  current: () => 'active' as const,
  subscribe: () => () => undefined,
};

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

/** Seed one `syncStatus='local'` op — a real row `readPushBatch` reconstructs (push.ts). */
async function seedLocalOp(opId: string): Promise<void> {
  const core = {
    id: opId,
    tenantId: 'tenant-1',
    storeId: 'store-1',
    userId: 'user-1',
    deviceId: DEVICE_ID,
    seq: 1,
    type: 'platform.user_locale_changed',
    entityType: 'device',
    entityId: DEVICE_ID,
    schemaVersion: 1,
    payload: { locale: 'id' },
    timestamp: T,
    location: null,
    source: 'system',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
  };
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status,
      synced_at, server_seq
    ) VALUES (
      ${core.id}, ${core.tenantId}, ${core.storeId}, ${core.userId}, ${core.deviceId}, ${core.seq},
      ${core.type}, ${core.entityType}, ${core.entityId}, ${core.schemaVersion},
      ${JSON.stringify(core.payload)}, ${core.timestamp}, ${null}, ${core.source}, ${0}, ${null},
      ${core.previousHash}, ${'hh'}, ${'ss'}, ${JSON.stringify(core)}, ${'local'}, ${null}, ${null}
    )
  `.execute(db.db);
}

const clockT = { now: () => T };

interface BuildOptions {
  readonly online?: boolean;
  readonly bundleThrows?: boolean;
  readonly pushRejects?: boolean;
  readonly pullRejects?: boolean;
}

async function build(options: BuildOptions = {}) {
  const transport = new FakeTransport();
  transport.pushRejects = options.pushRejects ?? false;
  transport.pullRejects = options.pullRejects ?? false;
  const timer = new RecordingTimer();
  const net = fakeNetInfo(options.online ?? true);
  let bundleCalls = 0;
  const applied: SignedOperation[] = [];

  const deps: SyncClientDeps = {
    db,
    deviceId: DEVICE_ID,
    transport,
    bundle: {
      refresh: () => {
        bundleCalls += 1;
        if (options.bundleThrows) return Promise.reject(new Error('bundle endpoint down'));
        return Promise.resolve('unchanged'); // 304 — the steady state
      },
    },
    applyPulledOp: (op) => {
      applied.push(op);
      return Promise.resolve();
    },
    crypto: noblePort,
    clock: { now: () => T },
    timer,
    appState: activeAppState,
    netInfo: net.port,
    initialSyncState: await readSyncState(db.db),
  };
  return { client: createSyncClient(deps), transport, timer, net, bundleCalls: () => bundleCalls };
}

describe('the sync client constructs, starts, and drives a REAL cycle (task 89 acceptance)', () => {
  test('an enrolled boot syncs: lastSuccessfulSyncAt becomes a REAL timestamp, banner de-escalates (T-19)', async () => {
    // Before: the seeded row's `last_successful_sync_at` is NULL, which 03 §8 maps to `stale`.
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();
    expect(stalenessLevel(await readSyncState(db.db), clockT)).toBe('stale');

    const { client, transport, bundleCalls } = await build({ online: true });
    await client.start(); // NetInfo reports online → the boot connectivity trigger drives a cycle
    await client.settle();

    // THE LINE THIS TASK EXISTS FOR: a real timestamp, read from the column — not null, not a default.
    const fresh = await readSyncState(db.db);
    expect(fresh.lastSuccessfulSyncAt).toBe(T);
    expect(client.syncState().lastSuccessfulSyncAt).toBe(T);
    // The banner clears: the staleness tier de-escalates off `stale`.
    expect(stalenessLevel(fresh, clockT)).not.toBe('stale');

    // A full cycle ran — pull is always issued, and the once-per-cycle bundle refresh fired. (Push is
    // skipped here: a fresh device has no local ops, so push.ts returns before the transport call.)
    expect(transport.pulls.length).toBeGreaterThan(0);
    expect(bundleCalls()).toBeGreaterThan(0);
    expect(client.state()).toBe('idle'); // drained back to idle (03 §10)
    client.stop();
  });

  test('a local op is CARRIED in the push request — the push half is wired to the log', async () => {
    await seedLocalOp('01920000-0000-7000-8000-0000000000aa');
    const { client, transport } = await build({ online: true });
    await client.start();
    await client.settle();

    const ids = transport.pushes.flatMap((p) => p.ops.map((op) => op.id));
    expect(ids).toContain('01920000-0000-7000-8000-0000000000aa');
    expect(transport.pushes[0]!.deviceId).toBe(DEVICE_ID);
    client.stop();
  });

  test('isOffline and state() are READ FROM THE LIVE INPUTS, not literals', async () => {
    const { client, net } = await build({ online: false });
    await client.start();
    await client.settle();
    // Booted offline: no connectivity trigger fired, so no cycle — the loop is idle and the device
    // reports offline from NetInfo (an INPUT), not from a guess.
    expect(client.isOffline()).toBe(true);
    expect(client.state()).toBe('idle');

    net.emit(true);
    await client.settle();
    expect(client.isOffline()).toBe(false); // connectivity is now a live fact
    client.stop();
  });

  test('subscribe fires on cycle completion — the signal Root re-reads SyncState on', async () => {
    const { client } = await build({ online: true });
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    await client.start();
    await client.settle();
    expect(notifications).toBeGreaterThan(0);
    client.stop();
  });
});

describe('falsification — each wiring broken makes the cycle FAIL LOUDLY (§2.11)', () => {
  test('BREAK THE BUNDLE PORT: refresh() throws → cycle fails → NOT synced, loop in backoff', async () => {
    // This is also the 304-is-a-success control's opposite: normally refresh() resolves and the cycle
    // succeeds; when it throws, the whole cycle fails and lastSuccessfulSyncAt is never written. A
    // producer that (wrongly) threw on a real 304 would put a healthy device here on EVERY cycle.
    const { client } = await build({ online: true, bundleThrows: true });
    await client.start();
    await client.settle();

    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();
    expect(client.syncState().lastSuccessfulSyncAt).toBeNull();
    expect(client.state()).toBe('backoff'); // loud: a backoff timer was armed (03 §10)
    client.stop();
  });

  test('BREAK THE TRANSPORT: pull rejects → cycle fails → NOT synced, loop in backoff', async () => {
    // Pull is always issued (push is skipped on an empty batch), so it is the clean transport-break
    // for a device with no local ops: a rejected pull is a LOOP failure → backoff (03 §10).
    const { client, transport } = await build({ online: true, pullRejects: true });
    await client.start();
    await client.settle();

    expect(transport.pulls.length).toBeGreaterThan(0); // it tried
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();
    expect(client.state()).toBe('backoff');
    client.stop();
  });

  test('BREAK THE TRIGGER: no connectivity signal → NO cycle → NOT synced (with a positive control)', async () => {
    // The connectivity trigger is what starts the loop on an enrolled boot. With no signal, nothing
    // runs — proving the trigger, not the loop, is the driver. Then a genuine connect DOES drive it.
    const { client, transport, net } = await build({ online: false });
    await client.start();
    await client.settle();
    expect(transport.pulls.length).toBe(0); // never started — a pull is issued on every cycle
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();

    // Positive control (T-14b): the trigger works; it simply had no signal. A real regain syncs.
    net.emit(true);
    await client.settle();
    expect(transport.pulls.length).toBeGreaterThan(0);
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBe(T);
    client.stop();
  });
});

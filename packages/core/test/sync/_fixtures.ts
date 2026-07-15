// Sync-loop test harness: a real SQLite DB behind the shim dialect, the real client migrations,
// the REAL projection engine, REAL Ed25519 signatures (noblePort), and fakes for exactly the three
// things @bolusi/core refuses to own — the clock, the timer and the network (08 §3.2).
//
// NOTHING HERE RE-IMPLEMENTS THE SUBJECT (T-7). The engine is the real engine; the migrations are
// the real DDL; the signatures verify for real. The fakes are the injected PORTS, which is what the
// loop is designed around — a test that faked the projection apply or the verification would be
// asserting its own mock.
//
// REAL SIGNATURES ARE NOT A LUXURY HERE. This suite's whole point includes SEC-OPLOG-09 — "a
// verified-bad signature is quarantined". With stubbed crypto, a "bad signature" fixture would be
// bad only because the stub said so, and the test would pass identically against a client that never
// verified anything (T-14b: every deny needs a positive control, and the control has to be real).
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import type { DeviceInfo, PullResponse, PushResponse, SignedOperation } from '@bolusi/schemas';
import { mulberry32, noblePort, type Prng } from '@bolusi/test-support';

import {
  bytesToBase64,
  createProjectionEngine,
  digestModule,
  ProjectionRegistry,
  signOp,
  SyncLoop,
  type ProjectionEngine,
  type SyncSurfacing,
} from '../../src/index.js';
import type { PullRequest, PushRequest } from '@bolusi/schemas';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';
import { notesModule } from '../projection/notes-fixture.js';

/** Deterministic ms-epoch clock (testing-guide §3.3). The ONLY time source the loop sees. */
export class FakeClock {
  constructor(private current = 1_726_000_000_000) {}
  now(): number {
    return this.current;
  }
  /** Advance without firing timers — for pure staleness math. */
  set(at: number): void {
    this.current = at;
  }
}

interface ScheduledTimer {
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/**
 * A timer bound to the FakeClock. `advance(ms)` moves the clock and fires whatever is due, in due
 * order — so backoff is asserted by moving TIME, never by sleeping (T-6: a test that sleeps is a bug).
 *
 * Fires callbacks whose `at` is `<= now` one at a time, re-reading the queue between each, so a
 * callback that schedules another timer behaves exactly as it would against a real event loop.
 */
export class FakeTimer {
  private queue: ScheduledTimer[] = [];
  constructor(private readonly clock: FakeClock) {}

  schedule(delayMs: number, fn: () => void): () => void {
    const entry: ScheduledTimer = { at: this.clock.now() + delayMs, fn, cancelled: false };
    this.queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Pending, non-cancelled timers — the observable "is a backoff armed?" (never a private field). */
  pending(): number {
    return this.queue.filter((t) => !t.cancelled).length;
  }

  /** The soonest pending fire time, or null. Lets a test assert a timer was NOT rescheduled. */
  nextAt(): number | null {
    const live = this.queue.filter((t) => !t.cancelled).map((t) => t.at);
    return live.length === 0 ? null : Math.min(...live);
  }

  /** Advance the clock by `ms`, firing every timer that comes due. */
  async advance(ms: number): Promise<void> {
    const target = this.clock.now() + ms;
    for (;;) {
      const due = this.queue
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.queue = this.queue.filter((t) => t !== due);
      this.clock.set(due.at);
      due.fn();
      // Let the fired callback's async work start before considering the next timer.
      await Promise.resolve();
      await Promise.resolve();
    }
    this.clock.set(target);
  }
}

/** A scripted transport. Each call shifts the next scripted reply; a function reply may throw. */
export class FakeTransport {
  readonly pushes: PushRequest[] = [];
  readonly pulls: PullRequest[] = [];
  private pushScript: Array<PushResponse | (() => PushResponse)> = [];
  private pullScript: Array<PullResponse | (() => PullResponse)> = [];
  /** Reply used once the script is exhausted — the steady state (drained, nothing to say). */
  constructor(
    private readonly defaultPull: PullResponse = {
      ops: [],
      nextCursor: 0,
      hasMore: false,
      serverTime: 1_726_000_000_000,
    },
  ) {}

  scriptPush(...replies: Array<PushResponse | (() => PushResponse)>): this {
    this.pushScript.push(...replies);
    return this;
  }
  scriptPull(...replies: Array<PullResponse | (() => PullResponse)>): this {
    this.pullScript.push(...replies);
    return this;
  }

  async push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(request);
    const next = this.pushScript.shift();
    if (next === undefined) {
      return { results: [], serverTime: 1_726_000_000_000 };
    }
    return typeof next === 'function' ? next() : next;
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    this.pulls.push(request);
    const next = this.pullScript.shift();
    if (next === undefined) return { ...this.defaultPull, nextCursor: request.cursor };
    return typeof next === 'function' ? next() : next;
  }
}

/** Collects surfacings so a test can assert the KEY and the event, never the copy (T-4). */
export class FakeSurface {
  readonly events: SyncSurfacing[] = [];
  emit(event: SyncSurfacing): void {
    this.events.push(event);
  }
  ofKind<K extends SyncSurfacing['kind']>(kind: K): Array<Extract<SyncSurfacing, { kind: K }>> {
    return this.events.filter((e) => e.kind === kind) as Array<Extract<SyncSurfacing, { kind: K }>>;
  }
}

/** A test device with a real Ed25519 keypair. */
export interface TestDevice {
  readonly id: string;
  readonly secretKey: Uint8Array;
  readonly publicKeyBase64: string;
}

const HEX = '0123456789abcdef';
function hex(prng: Prng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += HEX[Math.floor(prng() * 16)] as string;
  return out;
}
/** A syntactically valid v4 UUID — `zUuid` accepts it. */
export function uuidV4(prng: Prng): string {
  const variant = ['8', '9', 'a', 'b'][Math.floor(prng() * 4)] as string;
  return `${hex(prng, 8)}-${hex(prng, 4)}-4${hex(prng, 3)}-${variant}${hex(prng, 3)}-${hex(prng, 12)}`;
}
/** A syntactically valid v7 UUID — `zUuidV7` accepts it (op `id` / `entityId`). */
export function uuidV7(prng: Prng, timestampMs: number): string {
  const time = Math.floor(timestampMs).toString(16).padStart(12, '0').slice(-12);
  const variant = ['8', '9', 'a', 'b'][Math.floor(prng() * 4)] as string;
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(prng, 3)}-${variant}${hex(prng, 3)}-${hex(prng, 12)}`;
}

export function makeDevice(prng: Prng, seedByte: number): TestDevice {
  const seed = new Uint8Array(32).fill(seedByte);
  const pair = noblePort.ed25519Keygen(seed);
  return {
    id: uuidV4(prng),
    secretKey: pair.secretKey,
    publicKeyBase64: bytesToBase64(pair.publicKey),
  };
}

export function deviceInfoOf(device: TestDevice, storeId: string | null): DeviceInfo {
  return {
    id: device.id,
    storeId,
    kind: 'member',
    signingKeyPublic: device.publicKeyBase64,
    status: 'active',
    revokedAt: null,
  };
}

export interface NoteOpOptions {
  readonly device: TestDevice;
  readonly seq: number;
  readonly timestamp: number;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly userId: string;
  readonly entityId: string;
  readonly type?: string;
  readonly payload?: Record<string, unknown>;
  readonly prng: Prng;
}

/** A REAL, correctly-signed `notes` op — verifies against `device.publicKeyBase64`. */
export function makeSignedNoteOp(options: NoteOpOptions): SignedOperation {
  const core = {
    id: uuidV7(options.prng, options.timestamp),
    tenantId: options.tenantId,
    storeId: options.storeId,
    userId: options.userId,
    deviceId: options.device.id,
    seq: options.seq,
    type: options.type ?? 'notes.note_created',
    entityType: 'note',
    entityId: options.entityId,
    schemaVersion: 1,
    payload: (options.payload ?? { title: 't', body: 'b' }) as SignedOperation['payload'],
    timestamp: options.timestamp,
    location: null,
    source: 'ui' as const,
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
  };
  return signOp(core, options.device.secretKey, noblePort);
}

/**
 * Corrupt an op's signature so it is VERIFIED-BAD rather than merely absent (api/01 §4.2).
 *
 * Flips a byte of the payload AFTER signing, leaving `hash`/`signature` untouched — CHAOS-05's T1
 * mutation. The op still parses (the schema is satisfied), the signer is known, and the signature
 * genuinely fails against the recomputed hash. That is the real attack shape: a server rewriting
 * history it does not hold the key for.
 */
export function corruptSignature(op: SignedOperation): SignedOperation {
  return { ...op, payload: { ...op.payload, body: 'tampered' } as SignedOperation['payload'] };
}

export interface SyncHarness {
  readonly db: Kysely<ClientDatabase>;
  readonly driver: DbDriver;
  readonly engine: ProjectionEngine<ClientDatabase>;
  readonly clock: FakeClock;
  readonly timer: FakeTimer;
  readonly transport: FakeTransport;
  readonly surface: FakeSurface;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  digest(): Promise<string>;
  makeLoop(options?: {
    deviceId?: string;
    pushBatchSize?: number;
  }): Promise<SyncLoop<ClientDatabase>>;
  bundleRefreshes(): number;
  failBundle(times: number): void;
  close(): Promise<void>;
}

/**
 * Open a harness: real driver, real migrations, real engine.
 *
 * The transaction is DRIVER-level so the engine's `db`, the loop's `db` and the transaction all
 * share ONE connection — the same shape the append path uses (test/projection/db.ts), and the shape
 * the engine's transaction model requires ("they run inside the caller's").
 */
export async function openSyncHarness(): Promise<SyncHarness> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  const registry = new ProjectionRegistry<ClientDatabase>();
  registry.register(notesModule);
  const engine = createProjectionEngine(db, registry);
  const clock = new FakeClock();
  const timer = new FakeTimer(clock);
  const transport = new FakeTransport();
  const surface = new FakeSurface();
  let bundleCalls = 0;
  let bundleFailures = 0;

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

  return {
    db,
    driver,
    engine,
    clock,
    timer,
    transport,
    surface,
    transaction,
    digest: () => digestModule(db, notesModule, { hash: (d) => noblePort.sha256(d) }),
    bundleRefreshes: () => bundleCalls,
    failBundle: (times: number) => {
      bundleFailures = times;
    },
    makeLoop: async (options = {}) => {
      const loop = new SyncLoop<ClientDatabase>({
        db,
        transaction,
        transport,
        surface,
        crypto: noblePort,
        clock,
        timer,
        deviceId: options.deviceId ?? '00000000-0000-4000-8000-000000000001',
        applyPulledOp: (op) => engine.applyPulledOp(op),
        bundle: {
          refresh: async () => {
            bundleCalls += 1;
            if (bundleFailures > 0) {
              bundleFailures -= 1;
              throw new Error('bundle refresh failed');
            }
            return 'unchanged'; // 304 — the steady state (api/02-auth §5).
          },
        },
        ...(options.pushBatchSize === undefined ? {} : { pushBatchSize: options.pushBatchSize }),
      });
      await loop.hydrate();
      return loop;
    },
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** Seed the `device_registry` mirror directly — the state a prior sidecar would have left. */
export async function seedDeviceRegistry(
  db: Kysely<ClientDatabase>,
  devices: readonly DeviceInfo[],
): Promise<void> {
  for (const device of devices) {
    await sql`
      INSERT INTO device_registry (id, store_id, kind, signing_key_public, status, revoked_at)
      VALUES (${device.id}, ${device.storeId}, ${device.kind}, ${device.signingKeyPublic},
              ${device.status}, ${device.revokedAt})
    `.execute(db);
  }
}

/** Row count of a table — the T-14b fixture check (state exists before an equality means anything). */
export async function countRows(db: Kysely<ClientDatabase>, table: string): Promise<number> {
  const result = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM ${sql.table(table)}`.execute(
    db,
  );
  return Number(result.rows[0]?.c ?? 0);
}

export const prngFor = (seed: number): Prng => mulberry32(seed);

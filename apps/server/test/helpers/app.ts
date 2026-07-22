// Test app builder (testing-guide §2.1 L3/L4: in-process app.fetch, no sockets). Wires the real
// production `createApp` with injected fakes at the I/O boundaries (T-7): a FakeClock, an
// in-memory token store, recording rate-limit stores, an access-log capture, and a stub-call
// capture. No mocking of the middleware chain itself — the real chain runs.
import { createApp } from '../../src/app.js';
import type { ServerDeps } from '../../src/deps.js';
import { RevocationHooks } from '../../src/identity/revocation.js';
import type { AccessLogRecord } from '../../src/middleware/access-log.js';
import { createVerifyToken, InMemoryTokenStore } from '../../src/middleware/auth.js';
import type { RateLimitDecision, RateLimitStore } from '../../src/middleware/rate-limit.js';
import { ImmediateDeliveryDispatcher } from '../../src/push/dispatcher.js';
import { FakePushPort } from '../../src/push/port.js';

/** Records every consume; denies for keys placed in `denyKeys` (retryAfter = `denySeconds`). */
export class RecordingRateLimitStore implements RateLimitStore {
  readonly calls: { key: string; capacityPerMinute: number; nowMs: number }[] = [];
  readonly denyKeys = new Set<string>();
  denySeconds = 42;

  consume(key: string, capacityPerMinute: number, nowMs: number): RateLimitDecision {
    this.calls.push({ key, capacityPerMinute, nowMs });
    return this.denyKeys.has(key)
      ? { allowed: false, retryAfterSeconds: this.denySeconds }
      : { allowed: true, retryAfterSeconds: 0 };
  }
}

export interface FakeClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function makeFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A valid, deterministic UUIDv7 keyed by (ms, counter) — no RNG (T-6), unique per request. */
function detRequestId(ms: number, counter: number): string {
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms % 0x1000000000000, 0, 6);
  b.writeUInt16BE(counter & 0xffff, 6);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x70, 6); // version 7
  b.writeUInt32BE(counter, 8);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface TestHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly tokenStore: InMemoryTokenStore;
  readonly perIpStore: RecordingRateLimitStore;
  readonly perDeviceStore: RecordingRateLimitStore;
  readonly accessLogs: AccessLogRecord[];
  readonly stubCalls: string[];
  readonly clock: FakeClock;
  /** The injected fake push sender — every send is recorded here (CLAUDE.md §6: no real Expo in a
   *  test). The default `unconfiguredPushPort` would THROW; this makes composed delivery assertions
   *  possible and keeps any accidental send off the network (task 134). */
  readonly pushPort: FakePushPort;
  /** The injected on-revoke registry — createApp registers the `device`-alert hook onto it (task
   *  134), so a test fires `revocationHooks.fire(...)` and reads `pushPort` to prove the composed
   *  binding delivers. */
  readonly revocationHooks: RevocationHooks;
  /** The injected fire-and-forget delivery dispatcher (task 134). Deliveries run OFF the request
   *  path, so a composed test drains them with `await deliveries.flush()` before asserting on
   *  `pushPort` — the flush is the deterministic seam the production request path never uses. */
  readonly deliveries: ImmediateDeliveryDispatcher;
}

export function makeTestApp(overrides: Partial<ServerDeps> = {}): TestHarness {
  const tokenStore = new InMemoryTokenStore();
  const perIpStore = new RecordingRateLimitStore();
  const perDeviceStore = new RecordingRateLimitStore();
  const accessLogs: AccessLogRecord[] = [];
  const stubCalls: string[] = [];
  const clock = makeFakeClock();
  const pushPort = new FakePushPort();
  const revocationHooks = new RevocationHooks();
  const deliveries = new ImmediateDeliveryDispatcher();
  let requestCounter = 0;

  const app = createApp({
    now: () => clock.now(),
    newRequestId: () => {
      requestCounter += 1;
      return detRequestId(clock.now(), requestCounter);
    },
    verifyToken: createVerifyToken({ store: tokenStore, now: () => clock.now() }),
    perIpStore,
    perDeviceStore,
    accessLogSink: (record) => accessLogs.push(record),
    onStub: (routeKey) => stubCalls.push(routeKey),
    pushPort,
    revocationHooks,
    deliveryDispatcher: deliveries,
    ...overrides,
  });

  return {
    app,
    tokenStore,
    perIpStore,
    perDeviceStore,
    accessLogs,
    stubCalls,
    clock,
    pushPort,
    revocationHooks,
    deliveries,
  };
}

/** Register an active device token in the harness store and return its bearer header value. */
export function enrollDevice(
  harness: TestHarness,
  fields: { deviceId: string; tenantId: string; storeId: string | null; token: string },
): string {
  harness.tokenStore.add(fields.token, {
    kind: 'device',
    deviceId: fields.deviceId,
    tenantId: fields.tenantId,
    storeId: fields.storeId,
    deviceStatus: 'active',
  });
  return `Bearer ${fields.token}`;
}

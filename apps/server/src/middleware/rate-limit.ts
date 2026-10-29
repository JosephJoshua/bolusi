// Rate limiting (api/00 §11): token bucket, burst = per-minute cap, continuous refill.
// Per source IP on the bearer-exempt /v1/auth/login (pre-auth); per device token elsewhere.
//
// The store is behind an interface and constructor-injected (§11: "the middleware interface
// shall not assume in-memory" — horizontal scaling needs a shared store later). v0 ships the
// in-memory per-process impl; tests swap a fake to prove the seam.
import { isIPv6 } from 'node:net';

import type { MiddlewareHandler } from 'hono';

import { ApiError } from '../errors.js';
import type { AppEnv } from '../env.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until one token is available (ceil, ≥ 1 when denied). Meaningful only when denied. */
  readonly retryAfterSeconds: number;
}

/**
 * A rate-limit store. `consume` attempts to take one token from the bucket named by `key`
 * whose burst capacity is `capacityPerMinute`, at wall-clock `nowMs`.
 */
export interface RateLimitStore {
  consume(key: string, capacityPerMinute: number, nowMs: number): RateLimitDecision;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  capacity: number;
}

/** How often (by the caller's clock) a `consume` sweeps out buckets that have fully refilled. */
const SWEEP_INTERVAL_MS = 60_000;
/** Hard ceiling on live buckets; past it the least recently used bucket with a token left goes. */
const MAX_BUCKETS = 100_000;

/** True when `bucket` has refilled to capacity by `nowMs`, so it says nothing a new one would not. */
function isFull(bucket: Bucket, nowMs: number): boolean {
  const refillPerMs = bucket.capacity / 60_000;
  return bucket.tokens + Math.max(0, nowMs - bucket.updatedAt) * refillPerMs >= bucket.capacity;
}

/** True when `bucket` has not refilled one token by `nowMs`: its key is being refused. */
function isDrained(bucket: Bucket, nowMs: number): boolean {
  const refillPerMs = bucket.capacity / 60_000;
  return bucket.tokens + Math.max(0, nowMs - bucket.updatedAt) * refillPerMs < 1;
}

/**
 * In-memory token-bucket store (api/00 §11 v0: single-instance per-process buckets).
 *
 * Keys come from client addresses and device ids, so the map is bounded: a full bucket is dropped
 * at the next periodic sweep (it reads the same as a missing one), and past `maxBuckets` the least
 * recently used bucket goes. Without this every address ever seen stayed for the process lifetime.
 * A drained bucket is never the one dropped, since dropping it would lift that key's limit: when
 * only drained buckets remain, a new key is refused as limited instead.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxBuckets: number;
  #lastSweepAt: number | undefined;

  constructor(options: { maxBuckets?: number } = {}) {
    this.#maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
  }

  /** Live buckets — for tests of the eviction bound. */
  get size(): number {
    return this.#buckets.size;
  }

  consume(key: string, capacityPerMinute: number, nowMs: number): RateLimitDecision {
    this.#sweep(nowMs);
    const refillPerMs = capacityPerMinute / 60_000;
    const existing = this.#buckets.get(key);
    // Full of drained buckets: refuse a new key rather than lift another key's limit.
    if (existing === undefined && !this.#makeRoom(nowMs)) {
      return { allowed: false, retryAfterSeconds: SWEEP_INTERVAL_MS / 1000 };
    }
    const bucket = existing ?? {
      tokens: capacityPerMinute,
      updatedAt: nowMs,
      capacity: capacityPerMinute,
    };

    // Continuous refill since last touch, capped at burst capacity.
    const refilled = Math.min(
      capacityPerMinute,
      bucket.tokens + Math.max(0, nowMs - bucket.updatedAt) * refillPerMs,
    );

    if (refilled >= 1) {
      this.#put(key, { tokens: refilled - 1, updatedAt: nowMs, capacity: capacityPerMinute });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // Not enough for one token: time to accrue the shortfall.
    this.#put(key, { tokens: refilled, updatedAt: nowMs, capacity: capacityPerMinute });
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) / refillPerMs / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  /** Re-insert so Map order is least-recently-used first. */
  #put(key: string, bucket: Bucket): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
  }

  /** Makes room for one more bucket; false when every bucket is drained. */
  #makeRoom(nowMs: number): boolean {
    if (this.#buckets.size < this.#maxBuckets) return true;
    for (const [key, bucket] of this.#buckets) {
      if (!isDrained(bucket, nowMs)) {
        this.#buckets.delete(key);
        return true;
      }
    }
    return false;
  }

  #sweep(nowMs: number): void {
    if (this.#lastSweepAt !== undefined && nowMs - this.#lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.#lastSweepAt = nowMs;
    for (const [key, bucket] of this.#buckets) {
      if (isFull(bucket, nowMs)) this.#buckets.delete(key);
    }
  }
}

/**
 * The address a per-IP bucket is keyed by. An IPv6 client usually holds a whole /64 and can rotate
 * through it freely, so IPv6 addresses share one bucket per /64; an IPv4-mapped IPv6 address is
 * keyed as the IPv4 address it carries. Anything else (IPv4, 'unknown') is used as is.
 */
export function ipRateKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  const bare = address.split('%')[0] ?? address; // drop a zone id (fe80::1%eth0)
  if (!isIPv6(bare)) return address;
  const [head = '', tail] = bare.split('::');
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  // A '::' stands for the zero groups that bring the address to 8 (a dotted IPv4 tail counts 2).
  const right = tail === undefined ? [] : groups(tail);
  const width = (g: readonly string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const zeros = tail === undefined ? [] : Array<string>(8 - width(left) - width(right)).fill('0');
  const prefix = [...left, ...zeros, ...right].slice(0, 4).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * Enforces one bucket and, on breach, throws `RATE_LIMITED` (429) carrying `retryAfterSeconds`
 * — `respondError` stamps the mandatory `Retry-After` header from it (api/00 §11).
 */
export function enforceBucket(
  store: RateLimitStore,
  key: string,
  capacityPerMinute: number,
  nowMs: number,
): void {
  const decision = store.consume(key, capacityPerMinute, nowMs);
  if (!decision.allowed) {
    throw new ApiError('RATE_LIMITED', { retryAfterSeconds: decision.retryAfterSeconds });
  }
}

/** Per-IP limiter for the pre-auth login route (api/00 §11). */
export function perIpRateLimit(options: {
  store: RateLimitStore;
  capacityPerMinute: number;
  now: () => number;
  clientIp: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    enforceBucket(
      options.store,
      `ip:${ipRateKey(options.clientIp(c))}`,
      options.capacityPerMinute,
      options.now(),
    );
    await next();
  };
}

export interface DeviceRateLimits {
  /** Default authenticated route cap (api/00 §11: 120/min/device). */
  readonly perRoutePerMinute: number;
  /** Realtime connect cap (api/00 §11: 10/min/device). */
  readonly realtimePerMinute: number;
  /** Aggregate cap across all authed routes (api/00 §11: 600/min/device). */
  readonly aggregatePerMinute: number;
}

/**
 * Per-device limiter, keyed by the device from bearerAuth (§13 step 7). Realtime routes use the
 * realtime bucket; everything else the default bucket. Both the route bucket and the aggregate
 * bucket must admit the request — whichever denies first wins its Retry-After.
 *
 * A control session (the owner's password login) has no device; it is held to the default route
 * cap per user, before authorization, so calls it is denied are bounded too. The api/02-auth §9
 * budgets the identity routes charge after authorization still apply on top.
 */
export function perDeviceRateLimit(options: {
  store: RateLimitStore;
  limits: DeviceRateLimits;
  now: () => number;
  isRealtime: (path: string) => boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const device = c.get('device');
    const now = options.now();
    if (device === undefined) {
      const control = c.get('controlSession');
      if (control !== undefined) {
        enforceBucket(
          options.store,
          `ctl:${control.tenantId}:${control.userId}`,
          options.limits.perRoutePerMinute,
          now,
        );
      }
      await next();
      return;
    }
    const realtime = options.isRealtime(c.req.path);
    const routeCap = realtime ? options.limits.realtimePerMinute : options.limits.perRoutePerMinute;
    const bucketName = realtime ? 'realtime' : 'route';
    enforceBucket(options.store, `dev:${bucketName}:${device.deviceId}`, routeCap, now);
    enforceBucket(
      options.store,
      `dev:agg:${device.deviceId}`,
      options.limits.aggregatePerMinute,
      now,
    );
    await next();
  };
}

// Rate limiting (api/00 §11): token bucket, burst = per-minute cap, continuous refill.
// Per source IP on the bearer-exempt /v1/auth/login (pre-auth); per device token elsewhere.
//
// The store is behind an interface and constructor-injected (§11: "the middleware interface
// shall not assume in-memory" — horizontal scaling needs a shared store later). v0 ships the
// in-memory per-process impl; tests swap a fake to prove the seam.
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
}

/** In-memory token-bucket store (api/00 §11 v0: single-instance per-process buckets). */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, Bucket>();

  consume(key: string, capacityPerMinute: number, nowMs: number): RateLimitDecision {
    const refillPerMs = capacityPerMinute / 60_000;
    const bucket = this.#buckets.get(key) ?? { tokens: capacityPerMinute, updatedAt: nowMs };

    // Continuous refill since last touch, capped at burst capacity.
    const refilled = Math.min(
      capacityPerMinute,
      bucket.tokens + Math.max(0, nowMs - bucket.updatedAt) * refillPerMs,
    );

    if (refilled >= 1) {
      this.#buckets.set(key, { tokens: refilled - 1, updatedAt: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // Not enough for one token: time to accrue the shortfall.
    this.#buckets.set(key, { tokens: refilled, updatedAt: nowMs });
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) / refillPerMs / 1000));
    return { allowed: false, retryAfterSeconds };
  }
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
      `ip:${options.clientIp(c)}`,
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
 */
export function perDeviceRateLimit(options: {
  store: RateLimitStore;
  limits: DeviceRateLimits;
  now: () => number;
  isRealtime: (path: string) => boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const device = c.get('device');
    // No device context (e.g. control-session identity routes): the aggregate/route device
    // buckets do not apply. Control-session limits are api/02-auth's (task 13); skip here.
    if (device === undefined) {
      await next();
      return;
    }
    const now = options.now();
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

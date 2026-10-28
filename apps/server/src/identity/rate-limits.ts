// Per-endpoint identity rate limits (api/02-auth §9). api/00 §11 owns the 429 vocabulary and
// delegates the numbers to the owning endpoint doc; these are that surface's values, behind an
// injected, store-agnostic interface ("the middleware interface shall not assume in-memory").
//
// The §9 limits are fixed-window counters / lockouts, not the per-minute token buckets api/00 §11
// uses for the transport layer — a login lockout is "5 failures per 15 min → locked 15 min", which
// a refilling bucket cannot express. So this surface carries its own `WindowLimitStore`.
import { ApiError } from '../errors.js';

export interface RateDecision {
  readonly allowed: boolean;
  /** Seconds until the window resets (≥ 1 when denied); meaningful only when denied. */
  readonly retryAfterSeconds: number;
}

/**
 * A fixed-window counter store. A window opens at the first hit for a key and lasts `windowMs`;
 * counts within it accumulate; the window resets once elapsed.
 */
export interface WindowLimitStore {
  /** Increment `key`'s window count, then report whether it is within `limit`. */
  hit(key: string, limit: number, windowMs: number, nowMs: number): RateDecision;
  /** Take back one earlier `hit` on `key` (e.g. a reserved login-failure slot that succeeded). */
  refund(key: string, windowMs: number, nowMs: number): void;
}

interface Window {
  count: number;
  startedAt: number;
  windowMs: number;
}

/** How often (by the caller's clock) a call sweeps out windows that have ended. */
const SWEEP_INTERVAL_MS = 60_000;
/** Hard ceiling on live windows; past it the least recently used window is dropped. */
const MAX_WINDOWS = 100_000;

/**
 * In-memory fixed-window store (api/00 §11 v0: single-instance). Tests can swap a fake.
 *
 * Keys carry client addresses and caller-chosen login identifiers, so the map is bounded the same
 * way as the token-bucket store (middleware/rate-limit.ts): an ended window is dropped at the next
 * periodic sweep (it reads the same as a missing one), and past `maxWindows` the least recently used
 * window goes.
 */
export class InMemoryWindowLimitStore implements WindowLimitStore {
  readonly #windows = new Map<string, Window>();
  readonly #maxWindows: number;
  #lastSweepAt: number | undefined;

  constructor(options: { maxWindows?: number } = {}) {
    this.#maxWindows = options.maxWindows ?? MAX_WINDOWS;
  }

  /** Live windows — for tests of the eviction bound. */
  get size(): number {
    return this.#windows.size;
  }

  #current(key: string, windowMs: number, nowMs: number): Window {
    this.#sweep(nowMs);
    const existing = this.#windows.get(key);
    const w =
      existing === undefined || nowMs - existing.startedAt >= windowMs
        ? { count: 0, startedAt: nowMs, windowMs }
        : existing;
    // Re-insert so Map order is least-recently-used first, then trim to the ceiling.
    this.#windows.delete(key);
    this.#windows.set(key, w);
    while (this.#windows.size > this.#maxWindows) {
      const oldest = this.#windows.keys().next();
      if (oldest.done === true) break;
      this.#windows.delete(oldest.value);
    }
    return w;
  }

  #sweep(nowMs: number): void {
    if (this.#lastSweepAt !== undefined && nowMs - this.#lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.#lastSweepAt = nowMs;
    for (const [key, w] of this.#windows) {
      if (nowMs - w.startedAt >= w.windowMs) this.#windows.delete(key);
    }
  }

  #decision(w: Window, limit: number, windowMs: number, nowMs: number): RateDecision {
    if (w.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    const remainingMs = w.startedAt + windowMs - nowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  hit(key: string, limit: number, windowMs: number, nowMs: number): RateDecision {
    const w = this.#current(key, windowMs, nowMs);
    w.count += 1;
    return this.#decision(w, limit, windowMs, nowMs);
  }

  refund(key: string, windowMs: number, nowMs: number): void {
    const w = this.#current(key, windowMs, nowMs);
    w.count = Math.max(0, w.count - 1);
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The api/02-auth §9 numeric table, one place. */
export const IDENTITY_LIMITS = {
  loginFailPerIdentifier: { limit: 5, windowMs: 15 * MINUTE },
  loginRequestsPerIp: { limit: 30, windowMs: HOUR },
  enrollPerTenantDay: { limit: 20, windowMs: DAY },
  usersPerTenantDay: { limit: 100, windowMs: DAY },
  revokePerTenantHour: { limit: 20, windowMs: HOUR },
  bundlePerDeviceHour: { limit: 120, windowMs: HOUR },
  passwordPerUserDay: { limit: 5, windowMs: DAY },
} as const;

/** Throw `RATE_LIMITED` (429) when a decision denies — `respondError` stamps `Retry-After`. */
export function enforce(decision: RateDecision): void {
  if (!decision.allowed) {
    throw new ApiError('RATE_LIMITED', { retryAfterSeconds: decision.retryAfterSeconds });
  }
}

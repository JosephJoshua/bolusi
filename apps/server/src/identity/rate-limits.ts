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
  /** Report whether `key` is within `limit` WITHOUT incrementing (retryAfter = window remaining). */
  check(key: string, limit: number, windowMs: number, nowMs: number): RateDecision;
  /** Increment `key`'s window count without evaluating a limit (e.g. login-failure accrual). */
  add(key: string, windowMs: number, nowMs: number): void;
}

interface Window {
  count: number;
  startedAt: number;
}

/** In-memory fixed-window store (api/00 §11 v0: single-instance). Tests can swap a fake. */
export class InMemoryWindowLimitStore implements WindowLimitStore {
  readonly #windows = new Map<string, Window>();

  #current(key: string, windowMs: number, nowMs: number): Window {
    const existing = this.#windows.get(key);
    if (existing === undefined || nowMs - existing.startedAt >= windowMs) {
      const fresh = { count: 0, startedAt: nowMs };
      this.#windows.set(key, fresh);
      return fresh;
    }
    return existing;
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

  check(key: string, limit: number, windowMs: number, nowMs: number): RateDecision {
    const w = this.#current(key, windowMs, nowMs);
    // `check` reads the window without a hit: over-limit iff the count already reached the limit.
    if (w.count < limit) return { allowed: true, retryAfterSeconds: 0 };
    const remainingMs = w.startedAt + windowMs - nowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  add(key: string, windowMs: number, nowMs: number): void {
    const w = this.#current(key, windowMs, nowMs);
    w.count += 1;
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

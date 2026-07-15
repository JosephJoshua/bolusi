// Auth-client constants — the numbers CHAOS-11 (testing-guide §3.6) and SEC-AUTH-01/02 import
// rather than duplicate. Every value here is transcribed from api/02-auth §5.3 (KDF) / §6.4 (idle
// lock) / §6.5 (lockout), which are the decision records. The lockout MACHINE (lockout.ts) imports
// these — it declares no schedule literal of its own, so the harness's imported-constants
// requirement (testing-guide §3.6: "this scenario must not duplicate the numbers as literals") is a
// property of the code, not a hope.
import type { KdfParams } from '../crypto/port.js';

// ── PIN KDF parameters (api/02-auth §5.3) ────────────────────────────────────────────────────────
//
// The DEFAULT argon2id profile (`m=32768 KiB, t=3, p=1`, 32-byte output) is `DEFAULT_KDF_PARAMS`,
// owned by the crypto port (crypto/port.ts) and already on the `@bolusi/core` surface — ONE
// definition (CLAUDE.md §2.8). Auth owns the floor + the bounds + the enforcement (SEC-AUTH-01).

/**
 * The documented **floor** (api/02-auth §5.3, D8): `m=19456 KiB, t=2, p=1`, 32-byte output. Permitted
 * ONLY if the on-device benchmark on the 2 GB target exceeds 300 ms at default params (SEC-AUTH-10,
 * task 27). It is a named constant precisely so the floor is *reachable* by swapping the params a
 * verifier is built with — the default is never hardcoded where the floor could not take its place
 * (D12: the parameter choice is unvalidated on real hardware, so the swap must stay possible).
 */
export const FLOOR_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLength: 32,
});

/**
 * Accepted verifier-parameter bounds (api/02-auth §5.3), enforced everywhere a verifier is
 * constructed or accepted (SEC-AUTH-01, the DoS guard): a hostile verifier declaring `mKiB =
 * 1048576` must never reach a verifying device. `p` is fixed at 1; salt is exactly 16 bytes; hash
 * is exactly 32 bytes.
 */
export const PIN_KDF_BOUNDS = Object.freeze({
  /** `mKiB ∈ [19456, 65536]` — floor .. ceiling. */
  memoryCostMin: 19456,
  memoryCostMax: 65536,
  /** `t ∈ [2, 4]`. */
  timeCostMin: 2,
  timeCostMax: 4,
  /** `p = 1`, fixed. */
  parallelism: 1,
  /** salt: exactly 16 bytes. */
  saltBytes: 16,
  /** hash: exactly 32 bytes. */
  hashBytes: 32,
});

// ── PIN escalation / lockout schedule (api/02-auth §6.5; mirror 03-state-machines §9.1) ───────────

/** Attempts 1–3 are free (no delay). The 4th consecutive attempt is the first throttled one. */
export const PIN_FREE_ATTEMPTS = 3;

/** The 10th consecutive failure hard-locks PIN auth for this user on this device (§6.5). */
export const PIN_HARD_LOCK_THRESHOLD = 10;

/** The escalation cap: from the 6th consecutive failure onward every window is 300 s (§6.5). */
export const PIN_LOCKOUT_DELAY_CAP_MS = 300_000;

/**
 * The escalation schedule (api/02-auth §6.5): after the Nth **consecutive** failure, the next
 * attempt is not evaluated until `delayMs` has elapsed. The `consecutiveFailures` key is the count
 * the failure *reached*: reaching 3 opens a 30 s window before the 4th attempt, reaching 4 → 60 s,
 * reaching 5 → 120 s, and reaching 6 pins the cap that also covers 7/8/9 (§6.5's "6–9 → 300 s cap").
 * Reaching 10 is the hard lock and has no window (there is no next attempt).
 *
 * This array is THE schedule — `delayMsForFailureCount` derives from it, the machine imports it, and
 * CHAOS-11 (task 26) asserts these exact values. No literal `30_000`/`60_000`/… appears in the
 * machine (testing-guide §3.6).
 */
export const PIN_LOCKOUT_SCHEDULE = [
  { consecutiveFailures: 3, delayMs: 30_000 },
  { consecutiveFailures: 4, delayMs: 60_000 },
  { consecutiveFailures: 5, delayMs: 120_000 },
  { consecutiveFailures: 6, delayMs: PIN_LOCKOUT_DELAY_CAP_MS },
] as const;

/**
 * The delay (ms) that must elapse after reaching `consecutiveFailures` before the next attempt is
 * evaluated. `< PIN_FREE_ATTEMPTS` → 0 (free); `≥ PIN_HARD_LOCK_THRESHOLD` → the cap, though the
 * machine treats that count as `locked_out` and never offers a next attempt. Derived from
 * `PIN_LOCKOUT_SCHEDULE` — the counts 7/8/9 fall through to the greatest schedule entry (the cap).
 */
export function delayMsForFailureCount(consecutiveFailures: number): number {
  if (consecutiveFailures < PIN_FREE_ATTEMPTS) return 0;
  let delayMs = 0;
  for (const step of PIN_LOCKOUT_SCHEDULE) {
    if (consecutiveFailures >= step.consecutiveFailures) delayMs = step.delayMs;
  }
  return delayMs;
}

// ── Idle lock (api/02-auth §6.4) ─────────────────────────────────────────────────────────────────

/** Default idle-lock timeout: 300 s (api/02-auth §6.4, OQ-1002). */
export const IDLE_LOCK_DEFAULT_SECONDS = 300;
/** Clamp floor: 60 s. */
export const IDLE_LOCK_MIN_SECONDS = 60;
/** Clamp ceiling: 3600 s. */
export const IDLE_LOCK_MAX_SECONDS = 3600;

/** Clamp a tenant's `idleLockSeconds` to [60, 3600] (api/02-auth §6.4). Non-finite → the default. */
export function clampIdleLockSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return IDLE_LOCK_DEFAULT_SECONDS;
  return Math.max(IDLE_LOCK_MIN_SECONDS, Math.min(IDLE_LOCK_MAX_SECONDS, Math.trunc(seconds)));
}

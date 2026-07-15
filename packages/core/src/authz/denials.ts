// Denial emission (02-permissions §7): denials are OPERATIONS, not a side log.
//
// WHY OPS (§7). Denials must reach owners across devices, and the op log is the only sync channel
// (api/01-sync §8 — sync moves ops, nothing else). It is tamper-evident, and it attributes each
// denial to user + device + time for free. The rejected alternative — a local table plus a bespoke
// upload — loses tamper evidence, adds a second sync path, and dies with a lost device.
//
// NEVER RECURSIVE (§7). `auth.permission_denied` is one of exactly FIVE op types the runtime
// appends without passing through the command layer (§4) — a denial log must not itself be
// deniable, or the first thing an attacker does is trip the check that stops the logging. This
// module therefore holds NO reference to the evaluator and performs no permission check. That is a
// structural property, and the suite pins it so a future refactor cannot quietly add one.
//
// THROTTLE (§7). At most one denial op per `(userId, permissionId, target)` per 5-minute window
// per device. Repeats increment an in-memory counter flushed into the NEXT emitted op's
// `suppressedRepeats`. The counter is memory-only and lost on restart — accepted by §7, because
// the signal is the PATTERN, not the exact count. Without the throttle, a retry loop against a
// denied command writes an unbounded op stream into an append-only log that syncs to every device.
//
// Platform-free: no clock of its own (`now` is injected, per testing-guide T-6), no timers.
import type { DenialReason } from './evaluate.js';

/** The op type (§7, api/02-auth §6.2). One of the five runtime-emitted types (§4). */
export const PERMISSION_DENIED_OP_TYPE = 'auth.permission_denied';

/** `entityType` for the denial op (§7): each denial is its own entity, one row per op. */
export const PERMISSION_DENIAL_ENTITY_TYPE = 'permission_denial';

/** §7: at most one denial op per `(userId, permissionId, target)` per 5 minutes, per device. */
export const DENIAL_THROTTLE_WINDOW_MS = 5 * 60 * 1000;

/** Which runtime raised the denial (§7). Queries are checked identically to commands (04 §6). */
export type DenialSurface = 'command' | 'query';

/**
 * The `auth.permission_denied` payload (§7). **All keys are ALWAYS present** — an absent key would
 * make an old denial indistinguishable from a denial of a kind we had not thought of.
 */
export interface PermissionDeniedPayload {
  readonly permissionId: string;
  readonly surface: DenialSurface;
  /** The command/query name that was denied. */
  readonly target: string;
  readonly reason: DenialReason;
  /** The EVALUATION scope — null for tenant-scope checks. Distinct from the envelope's storeId. */
  readonly scopeStoreId: string | null;
  /** Repeats suppressed since the previous emission for this tuple. `0` on a first denial. */
  readonly suppressedRepeats: number;
}

/** A denial the enforcement point recorded, before throttling. */
export interface DenialAttempt {
  /** The acting user — part of the throttle key and of the envelope's attribution. */
  readonly userId: string;
  readonly permissionId: string;
  readonly surface: DenialSurface;
  readonly target: string;
  readonly reason: DenialReason;
  readonly scopeStoreId: string | null;
  /**
   * §7: `source` / `agentInitiated` MIRROR the denied attempt's values — a denied agent attempt
   * must be visible AS one (ARCH-001 §9.3). The emitter passes them through to the port, which
   * stamps them on the envelope.
   */
  readonly source: string;
  readonly agentInitiated: boolean;
  readonly agentConversationId?: string | null;
}

/** The envelope hints the port needs, mirrored from the denied attempt (§7). */
export interface DenialEmissionContext {
  readonly userId: string;
  readonly source: string;
  readonly agentInitiated: boolean;
  readonly agentConversationId?: string | null;
}

/**
 * The runtime emission seam (§4's runtime-emitted ops). Task 06 owns the op append path and task
 * 10 binds it here; this module builds the payload and decides WHETHER to emit, never HOW.
 */
export interface DenialEmissionPort {
  emit(payload: PermissionDeniedPayload, context: DenialEmissionContext): void | Promise<void>;
}

interface ThrottleState {
  /** When the current window opened = when this tuple last EMITTED. */
  windowStartedAt: number;
  /** Repeats suppressed since that emission, to be flushed into the next one. */
  suppressed: number;
}

/** Options for `DenialEmitter`. */
export interface DenialEmitterOptions {
  /** ms-epoch clock, injected (T-6). Production passes the system clock; tests a FakeClock. */
  readonly now: () => number;
  /** Override the §7 window. Exists for the suite's boundary cases; production uses the default. */
  readonly windowMs?: number;
}

/**
 * Builds and throttles `auth.permission_denied` payloads (§7).
 *
 * State is in-memory and per-device by construction (one emitter per app instance). A restart
 * resets the counters — §7 accepts this explicitly.
 */
export class DenialEmitter {
  private readonly port: DenialEmissionPort;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly throttle = new Map<string, ThrottleState>();

  constructor(port: DenialEmissionPort, options: DenialEmitterOptions) {
    this.port = port;
    this.now = options.now;
    this.windowMs = options.windowMs ?? DENIAL_THROTTLE_WINDOW_MS;
  }

  /**
   * Record a denial. Emits at most one op per `(userId, permissionId, target)` per window.
   *
   * Returns the emitted payload, or `null` when the attempt was suppressed (counted into the next
   * emission's `suppressedRepeats`).
   *
   * **The caller MUST deny regardless of what this returns or throws.** A denial that was already
   * decided is not up for reconsideration because its audit record failed to append — `null` here
   * means "already logged recently", never "allowed".
   */
  async record(attempt: DenialAttempt): Promise<PermissionDeniedPayload | null> {
    const key = throttleKey(attempt.userId, attempt.permissionId, attempt.target);
    const now = this.now();
    const state = this.throttle.get(key);

    if (state !== undefined && now - state.windowStartedAt < this.windowMs) {
      state.suppressed += 1;
      return null;
    }

    const suppressedRepeats = state?.suppressed ?? 0;
    // Open the new window BEFORE awaiting the port: two concurrent denials of the same tuple must
    // not both slip through while the first is mid-append.
    this.throttle.set(key, { windowStartedAt: now, suppressed: 0 });

    const payload: PermissionDeniedPayload = {
      permissionId: attempt.permissionId,
      surface: attempt.surface,
      target: attempt.target,
      reason: attempt.reason,
      scopeStoreId: attempt.scopeStoreId,
      suppressedRepeats,
    };
    const context: DenialEmissionContext = {
      userId: attempt.userId,
      source: attempt.source,
      agentInitiated: attempt.agentInitiated,
      agentConversationId: attempt.agentConversationId ?? null,
    };
    await this.port.emit(payload, context);
    return payload;
  }

  /** Repeats currently suppressed for a tuple — awaiting the next emission. For tests/diagnostics. */
  suppressedCount(userId: string, permissionId: string, target: string): number {
    return this.throttle.get(throttleKey(userId, permissionId, target))?.suppressed ?? 0;
  }

  /** Tracked tuples — the throttle's denominator (T-14). */
  get trackedTuples(): number {
    return this.throttle.size;
  }
}

/** ` ` cannot occur in a UUIDv7 or a `<module>.<action>` id, so tuples cannot collide. */
function throttleKey(userId: string, permissionId: string, target: string): string {
  return `${userId} ${permissionId} ${target}`;
}

/**
 * Structural validation of a §7 payload: every key present, correct type, `suppressedRepeats` a
 * non-negative integer.
 *
 * `@bolusi/schemas` does NOT yet carry the `auth.permission_denied` Zod payload (02-permissions §7
 * owns the shape; the auth op registry is api/02-auth §6.2). This task was scoped not to touch
 * `packages/schemas`, so the shape is asserted here and the Zod schema remains a follow-up for the
 * task that lands the auth op registry — at which point THIS function should be deleted in favour
 * of it, not kept alongside as a second definition (CLAUDE.md §2.8).
 */
export function isPermissionDeniedPayload(value: unknown): value is PermissionDeniedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expected = [
    'permissionId',
    'reason',
    'scopeStoreId',
    'suppressedRepeats',
    'surface',
    'target',
  ];
  if (keys.length !== expected.length) return false;
  if (!keys.every((key, index) => key === expected[index])) return false;
  if (typeof payload.permissionId !== 'string') return false;
  if (payload.surface !== 'command' && payload.surface !== 'query') return false;
  if (typeof payload.target !== 'string') return false;
  if (typeof payload.reason !== 'string') return false;
  if (payload.scopeStoreId !== null && typeof payload.scopeStoreId !== 'string') return false;
  if (typeof payload.suppressedRepeats !== 'number') return false;
  if (!Number.isInteger(payload.suppressedRepeats) || payload.suppressedRepeats < 0) return false;
  return true;
}

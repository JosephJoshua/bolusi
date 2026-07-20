// THE enforcement point (02-permissions §4) — "the only control is step 2 of the command/query
// runtime". Singular, in the doc and here.
//
// WHY THIS IS ONE CLASS SHARED BY BOTH RUNTIMES, extracted from `CommandRuntime` when the query
// runtime landed (task 11). 02 §4 names ONE control and says queries are "checked identically" to
// commands. The tempting alternative — give the query runtime its own evaluator reference and its
// own denial emitter — type-checks, passes tests, and quietly produces TWO controls:
//
//   * two implementations of "evaluate, emit, throw", which drift (CLAUDE.md §2.8). The drift that
//     matters is not a typo; it is that a later fix to one is a fix to half the surface, and the
//     half that keeps the bug is the half nobody re-reads.
//   * two §7 throttle memories. The throttle is per `(userId, permissionId, target)` per 5-minute
//     window PER DEVICE, and a second in-memory counter makes "per device" false: the same user
//     hammering the same permission through both surfaces gets two independent budgets.
//
// So both runtimes hold a reference to one instance of this, and it holds the only evaluator
// reference either of them uses.
import type { DenialAttempt, DenialEmitter, DenialSurface } from '../authz/denials.js';
import type { PermissionEvaluator } from '../authz/memo.js';
import { DomainError } from '../errors/domain-error.js';
import type { CommandIdentity, InvocationMeta } from './ctx.js';
import type { DenialAuditDiagnosticsPort, DenialAuditFailure, RuntimeTimerPort } from './ports.js';

/**
 * Default bound on the denial-audit emit (task 40, liveness). A denied command's `auth.permission_denied`
 * op is best-effort; this is how long the enforcement point waits for its append before abandoning it and
 * denying anyway. Long enough that a merely-slow / lock-contended client append (op-sqlite WAL) still
 * records; short enough that a never-settling one cannot wedge `execute()`. Override per app via
 * `CommandRuntimeOptions.denialAuditTimeoutMs`.
 */
export const DENIAL_AUDIT_EMIT_TIMEOUT_MS = 2_000;

/**
 * The injected bound for the denial-audit emit (task 40). `null` = UNBOUNDED — the pre-task-40 behaviour,
 * kept so a composition root that does not wire a `RuntimeTimerPort` is byte-for-byte unaffected. When
 * present, a hung emit is abandoned after `timeoutMs` and the denial proceeds — see `requirePermission`.
 */
export interface DenialAuditBound {
  readonly timer: RuntimeTimerPort;
  readonly timeoutMs: number;
}

/**
 * The single enforcement point. Constructed by `CommandRuntime` (which owns the op-emission channel
 * the denial emitter needs) and handed to the query runtime.
 */
export class PermissionEnforcementPoint {
  readonly #evaluator: PermissionEvaluator;
  readonly #denialEmitter: DenialEmitter;
  /**
   * The task-40 liveness bound, or `null` for the unbounded (pre-task-40) await. Applied to the ONE
   * emit both `requirePermission` and `denyRestriction` await — a single place, so a hung audit can
   * wedge neither.
   */
  readonly #auditBound: DenialAuditBound | null;
  /**
   * Where a LOST denial audit is SURFACED (task 99), or `null` for the pre-task-99 silence. Read in
   * exactly one place — `#recordBounded`'s catch — because that is the one place an audit can be
   * lost, for both denial classes.
   */
  readonly #auditDiagnostics: DenialAuditDiagnosticsPort | null;
  /**
   * Denial audits lost in an unbroken run. A single transient failure is FR-1045's accepted
   * tolerance; a CLIMBING count is the incomplete audit trail. Reset by the next append that does
   * not fail — which includes a throttled one, since a suppressed repeat proves the store answered.
   */
  #consecutiveAuditFailures = 0;

  constructor(
    evaluator: PermissionEvaluator,
    denialEmitter: DenialEmitter,
    auditBound: DenialAuditBound | null = null,
    auditDiagnostics: DenialAuditDiagnosticsPort | null = null,
  ) {
    this.#evaluator = evaluator;
    this.#denialEmitter = denialEmitter;
    this.#auditBound = auditBound;
    this.#auditDiagnostics = auditDiagnostics;
  }

  /**
   * A silent, synchronous check — no denial op, no throw (02 §9.1's data gating; 02 §6's
   * `usePermission` UI convenience).
   *
   * NOT the control. This answers "may they?" for a caller that is going to SHAPE something
   * accordingly (omit a column, hide a button). `requirePermission` is what gates entry. The
   * distinction is load-bearing: this one deliberately leaves no audit trace, because a gated
   * column is not a denied attempt and logging one per row per column would bury the real denials
   * the §7 log exists to surface.
   */
  hasPermission(identity: CommandIdentity, permissionId: string): boolean {
    return this.#evaluator.hasPermission({
      userId: identity.userId,
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      permissionId,
    }).allowed;
  }

  /**
   * THE control (02 §4). Fail closed: the evaluator DECIDES (task 09) and this acts on the answer.
   *
   *   allowed → return.
   *   denied  → emit the denial op (§7, throttled), then THROW `PERMISSION_DENIED`.
   *
   * ORDER MATTERS: the emission is awaited BEFORE the throw so a denial is recorded even when the
   * caller swallows the error. The throw is NOT conditional on the emission succeeding — see below.
   *
   * WHY IT THROWS AND NEVER RETURNS AN EMPTY RESULT. FR-1036 / 02 §4: an empty result leaks "the
   * store exists and is quiet", and a silently-filtered `200 []` is indistinguishable from a
   * legitimate empty page. This is the shared root of that rule for both surfaces — for a query it
   * is the difference between `{ rows: [] }` and `PERMISSION_DENIED` (security-guide §2.2).
   */
  async requirePermission(
    identity: CommandIdentity,
    permissionId: string,
    target: string,
    surface: DenialSurface,
    invocation: InvocationMeta,
  ): Promise<void> {
    const decision = this.#evaluator.hasPermission({
      userId: identity.userId,
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      permissionId,
    });

    if (decision.allowed) return;

    // NO `try` HERE, AND THAT IS THE POINT (task 99). `#recordBounded` is TOTAL — it never rejects
    // and never hangs — so the throw below is unconditional by CONSTRUCTION rather than by a caller
    // remembering to wrap it. A denial that was already DECIDED is not up for reconsideration
    // because its audit record failed to append (task 09's `record` says this explicitly): if the
    // emission's failure propagated, a full disk or a locked store would turn a denial into a
    // generic error, and a caller distinguishing "denied" from "log broke" is a caller that can be
    // made to stop denying. Failed, hung, or lost — the deny is thrown, and the loss is SURFACED
    // inside `#recordBounded` instead of vanishing.
    await this.#recordBounded({
      userId: identity.userId,
      permissionId,
      surface,
      target,
      reason: decision.reason,
      // The EVALUATION scope (§7) — distinct from the envelope's storeId, which the emission
      // channel stamps from the device.
      scopeStoreId: identity.storeId,
      source: invocation.source,
      agentInitiated: invocation.agentInitiated,
      agentConversationId: invocation.agentConversationId,
    });

    throw new DomainError(
      'PERMISSION_DENIED',
      { permissionId, target, surface, reason: decision.reason },
      `${identity.userId} lacks ${permissionId} for ${surface} ${target} (02-permissions §4)`,
    );
  }

  /**
   * Record + throw a **handler-declared** §5.4 restriction denial (02 §7 amended "Emitted by").
   *
   * Unlike `requirePermission`, this does NOT consult the evaluator: a §5.4 targeting /
   * privileged-target restriction (an owner resetting the `main_owner`'s PIN, a PIN change targeting
   * someone else) needs the directory and is decided INSIDE a handler, so the decision is already
   * made by the caller. This method's only job is to make that denial AUDITED the same way an
   * evaluator denial is — through the SAME throttled emitter, so `auth.permission_denied` stays one
   * emission path and one §7 throttle (CLAUDE.md §2.8), never a second, unthrottled channel.
   *
   * SAME ORDER, SAME REASONS AS `requirePermission` (task 10, reviewed and load-bearing): the emit
   * is awaited BEFORE the throw so a denial is recorded even when the caller swallows the error, and
   * the throw is NOT conditional on the emission succeeding — the `catch` wraps the AUDIT, not the
   * DECISION. A restriction denial that was already decided is not un-decided because its audit
   * record failed to append; that is exactly where fail-closed would go to die.
   *
   * @throws {DomainError} always `PERMISSION_DENIED`, reason `restriction_violated`.
   */
  async denyRestriction(
    identity: CommandIdentity,
    permissionId: string,
    target: string,
    surface: DenialSurface,
    invocation: InvocationMeta,
    detail: string,
  ): Promise<never> {
    // Same shape as `requirePermission`, and now the SAME CODE: `#recordBounded` is total, so the
    // two denial classes share one swallow AND one surfacing point rather than mirroring a `catch`
    // each (CLAUDE.md §2.8 — the mirrored pair is exactly how task 99's silence came to exist on
    // both paths at once, and how a fix to one would have been a fix to half the surface).
    await this.#recordBounded({
      userId: identity.userId,
      permissionId,
      surface,
      target,
      reason: 'restriction_violated',
      // The EVALUATION scope (§7) — distinct from the envelope's storeId, mirrored from an
      // evaluator denial so the two denial classes project identically.
      scopeStoreId: identity.storeId,
      source: invocation.source,
      agentInitiated: invocation.agentInitiated,
      agentConversationId: invocation.agentConversationId,
    });

    throw new DomainError(
      'PERMISSION_DENIED',
      { permissionId, target, surface, reason: 'restriction_violated' },
      detail,
    );
  }

  /**
   * Emit the denial audit op — BOUNDED (task 40) and TOTAL (task 99). **This method never rejects
   * and never hangs**, which is what lets both denial paths above throw without a `try`.
   *
   * This is on the ONE path an attacker can provoke at will: every denial emits `auth.permission_denied`
   * (02 §7), and a denial is the one thing a denied actor can trigger freely. A wedged client write on
   * it (a stuck op-sqlite WAL lock) would otherwise freeze `execute()` forever — there is no timeout or
   * abort anywhere on the chain (execute → requirePermission → DenialEmitter.record → port.emit →
   * appendLocalOps → store.transaction). With a `RuntimeTimerPort` wired, a hung emit is abandoned after
   * the budget; a genuinely FAILED emit REJECTS. The bound never makes the deny wait on the audit
   * SUCCEEDING; it only stops the deny waiting FOREVER.
   *
   * THREE OUTCOMES, and the middle one is task 99's whole point:
   *
   *   settled   → the op is recorded (or throttled — §7 suppressed it deliberately). Nothing lost.
   *   failed    → the append rejected. The record is LOST → surfaced.
   *   timed_out → the append was abandoned at the bound. The record is EQUALLY LOST → surfaced.
   *
   * Before task 99 the last two were indistinguishable from the first to everything outside this
   * class, so a persistent fault made the FR-1045 trail incomplete with no observable trace.
   *
   * With no timer wired (`#auditBound === null`) it awaits the emit as before — unchanged for callers
   * that predate the bound, and a failure there is surfaced identically.
   */
  async #recordBounded(attempt: DenialAttempt): Promise<void> {
    let outcome: 'settled' | 'timed_out';
    try {
      // EVERYTHING that can throw is inside this try, including `record()` itself — a synchronous
      // throw from the emitter must reach the surfacing, not the caller.
      const emit = this.#denialEmitter.record(attempt);
      const bound = this.#auditBound;
      if (bound === null) {
        await emit;
        outcome = 'settled';
      } else {
        outcome = await boundEmit(emit, bound);
      }
    } catch (error) {
      this.#surfaceLostAudit(attempt, 'failed', error);
      return;
    }

    if (outcome === 'timed_out') {
      // Task 40 abandons a hung emit and the deny proceeds — unchanged. What changes here is that
      // the ABANDONMENT is no longer silent: a wedged store loses the FR-1045 record just as
      // completely as a broken one does, and an operator needs to see both.
      this.#surfaceLostAudit(attempt, 'timed_out', undefined);
      return;
    }

    // Reached only when the append settled: the store answered, so any run of losses has ended.
    this.#consecutiveAuditFailures = 0;
  }

  /**
   * Report ONE lost denial audit (task 99). The only writer of `#consecutiveAuditFailures` upward,
   * and the only caller of the diagnostics port.
   *
   * **Cannot break the deny.** The count is advanced BEFORE the sink is called, and the call is
   * wrapped: a sink that throws is discarded here rather than propagating into `#recordBounded`'s
   * caller, where it would do precisely what task 10 forbade — let a broken log change a decided
   * denial into something else. This is the one place a silent catch is still right, because there
   * is nowhere left to report to.
   */
  #surfaceLostAudit(
    attempt: DenialAttempt,
    outcome: DenialAuditFailure['outcome'],
    error: unknown,
  ): void {
    this.#consecutiveAuditFailures += 1;
    const sink = this.#auditDiagnostics;
    if (sink === null) return;

    try {
      sink.auditAppendFailed({
        outcome,
        consecutiveFailures: this.#consecutiveAuditFailures,
        userId: attempt.userId,
        permissionId: attempt.permissionId,
        target: attempt.target,
        surface: attempt.surface,
        reason: attempt.reason,
        scopeStoreId: attempt.scopeStoreId,
        ...(outcome === 'failed' ? { error } : {}),
      });
    } catch {
      // See above: the reporter of a broken audit must not become a second way to break a denial.
    }
  }
}

/**
 * Resolve when `emit` settles OR when the bound elapses — whichever comes first (task 40).
 *
 * A timed-out emit makes the race RESOLVE (best-effort audit abandoned); the caller then denies
 * unconditionally, as it does for a failed emit. A REJECTING emit still rejects the race, into that
 * same swallowing catch. `Promise.race` keeps a handler on `emit` even after the timeout wins, so a
 * late rejection from the abandoned append raises no unhandledRejection. The append itself is not —
 * and cannot be — cancelled from here: a hung client transaction is the store's to resolve; this only
 * frees `execute()`. The happy path cancels the pending timeout, so nothing leaks.
 */
function boundEmit(
  emit: Promise<unknown>,
  bound: DenialAuditBound,
): Promise<'settled' | 'timed_out'> {
  let cancel: () => void = () => {};
  const timeout = new Promise<'timed_out'>((resolve) => {
    cancel = bound.timer.schedule(bound.timeoutMs, () => {
      resolve('timed_out');
    });
  });
  // WHICH ARM WON is returned, not discarded (task 99): both arms resolve, so a caller that only
  // sees "resolved" cannot tell a recorded audit from an abandoned one — which is how a wedged
  // store stayed as invisible as a broken one.
  return Promise.race([emit.then(() => 'settled' as const), timeout]).finally(() => {
    cancel();
  });
}

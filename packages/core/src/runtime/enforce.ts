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
import type { RuntimeTimerPort } from './ports.js';

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

  constructor(
    evaluator: PermissionEvaluator,
    denialEmitter: DenialEmitter,
    auditBound: DenialAuditBound | null = null,
  ) {
    this.#evaluator = evaluator;
    this.#denialEmitter = denialEmitter;
    this.#auditBound = auditBound;
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

    try {
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
    } catch {
      // A denial that was already DECIDED is not up for reconsideration because its audit record
      // failed to append (task 09's `record` says this explicitly). Swallowing here is what makes
      // the throw below unconditional: if the emission's failure propagated, a full disk or a
      // locked store would turn a denial into a generic error — and a caller distinguishing
      // "denied" from "log broke" is a caller that can be made to stop denying. A HUNG emit does
      // not reach this catch — `#recordBounded` (task 40) bounds it and RESOLVES on timeout, so a
      // timed-out audit falls straight through the try to the same unconditional throw below.
      // Failed or hung, the deny is thrown; neither can wedge us forever.
    }

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
    try {
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
    } catch {
      // Swallow — see the method doc: the deny is not conditional on the audit (task 10), and a
      // hung audit is bounded and treated identically (task 40).
    }

    throw new DomainError(
      'PERMISSION_DENIED',
      { permissionId, target, surface, reason: 'restriction_violated' },
      detail,
    );
  }

  /**
   * Emit the denial audit op, BOUNDED so a never-settling append cannot wedge the caller (task 40).
   *
   * This is on the ONE path an attacker can provoke at will: every denial emits `auth.permission_denied`
   * (02 §7), and a denial is the one thing a denied actor can trigger freely. A wedged client write on
   * it (a stuck op-sqlite WAL lock) would otherwise freeze `execute()` forever — there is no timeout or
   * abort anywhere on the chain (execute → requirePermission → DenialEmitter.record → port.emit →
   * appendLocalOps → store.transaction). With a `RuntimeTimerPort` wired, a hung emit is abandoned after
   * the budget and REJECTS into the caller's swallowing `catch`, so the denial is thrown unconditionally
   * — exactly as it is for a FAILED emit (task 10). The bound never makes the deny wait on the audit
   * SUCCEEDING; it only stops the deny waiting FOREVER.
   *
   * With no timer wired (`#auditBound === null`) it awaits the emit as before — unchanged for callers
   * that predate the bound.
   */
  async #recordBounded(attempt: DenialAttempt): Promise<void> {
    const emit = this.#denialEmitter.record(attempt);
    const bound = this.#auditBound;
    if (bound === null) {
      await emit;
      return;
    }
    await boundEmit(emit, bound);
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
function boundEmit(emit: Promise<unknown>, bound: DenialAuditBound): Promise<unknown> {
  let cancel: () => void = () => {};
  const timeout = new Promise<void>((resolve) => {
    cancel = bound.timer.schedule(bound.timeoutMs, () => {
      resolve();
    });
  });
  return Promise.race([emit, timeout]).finally(() => {
    cancel();
  });
}

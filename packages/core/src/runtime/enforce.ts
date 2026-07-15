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
import type { DenialEmitter, DenialSurface } from '../authz/denials.js';
import type { PermissionEvaluator } from '../authz/memo.js';
import { DomainError } from '../errors/domain-error.js';
import type { CommandIdentity, InvocationMeta } from './ctx.js';

/**
 * The single enforcement point. Constructed by `CommandRuntime` (which owns the op-emission channel
 * the denial emitter needs) and handed to the query runtime.
 */
export class PermissionEnforcementPoint {
  readonly #evaluator: PermissionEvaluator;
  readonly #denialEmitter: DenialEmitter;

  constructor(evaluator: PermissionEvaluator, denialEmitter: DenialEmitter) {
    this.#evaluator = evaluator;
    this.#denialEmitter = denialEmitter;
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
      await this.#denialEmitter.record({
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
      // "denied" from "log broke" is a caller that can be made to stop denying.
    }

    throw new DomainError(
      'PERMISSION_DENIED',
      { permissionId, target, surface, reason: decision.reason },
      `${identity.userId} lacks ${permissionId} for ${surface} ${target} (02-permissions §4)`,
    );
  }
}

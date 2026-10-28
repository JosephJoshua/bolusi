// Per-op-type rules: what must be true of the current records for an op of this type to be
// recorded (a legal state change, a target that exists in this store, a value only this device may
// mint). Declared once, next to the type's schema and permission (`OperationDeclaration.rule`), and
// run on BOTH sides:
//
//   the device — by the append path, on every op a command produces, inside the append
//                transaction and before the insert, against the device's projection. A command
//                cannot save an op its rule refuses, so a handler has no separate copy of the rule.
//   the server — by push ingestion, against the server's own projection, after the permission
//                check. A refusal spends the op's chain position like any other (pipeline.ts).
//
// The server's answer is the one that counts: it judges against every op it has accepted, while a
// device only knows what it has pulled. A device that acted on a stale view gets the refusal back
// and rolls the op out of its projection.
//
// A rule reads; it never writes. It refuses by throwing a `RuleRefusal`: a `DomainError` that also
// names one of its module's declared reasons (`defineRefusals`), so the person sees what exactly was
// wrong ("Servisan ini sudah dibatalkan"), both when the device refuses a command and when the
// server's refusal comes back under sync problems. Anything else it throws is a fault, not a verdict.
import type { Kysely } from 'kysely';

import type { SignedOperation } from '@bolusi/schemas';

import {
  DomainError,
  type DomainErrorCode,
  type DomainErrorDetails,
} from '../errors/domain-error.js';

/** What a rule may consult besides the op itself. */
export interface OpRuleContext<DB> {
  /** The judging side's projection, inside the transaction that will record the op. */
  readonly db: Kysely<DB>;
  /**
   * Whether `userId` holds `permissionId` in the op's store, by the judging side's directory: the
   * device's synced copy on a device, the server's own on the server. For ops that name another
   * user who must be able to do something (a technician being assigned).
   */
  holdsPermission(userId: string, permissionId: string): Promise<boolean>;
  /**
   * Whether `userId` holds `permissionId` in the op's store AND may use it for `amount` rupiah:
   * within the limit their store set for a limited role (authz/limits.ts), or with no limit. The
   * same directory as `holdsPermission`.
   */
  withinLimit(userId: string, permissionId: string, amount: number): Promise<boolean>;
}

/** Throws a `DomainError` when `op` must not be recorded against the current records. */
export type OpRule<DB> = (op: SignedOperation, ctx: OpRuleContext<DB>) => Promise<void>;

/**
 * A rule's refusal. `refusal` is the copy key `<module>.refusal.<reason>`: the device shows it for a
 * refused command, and the server sends it back as a RULE_VIOLATED op's reason.
 */
export class RuleRefusal extends DomainError {
  readonly refusal: string;

  constructor(
    code: DomainErrorCode,
    refusal: string,
    details?: DomainErrorDetails,
    message?: string,
  ) {
    super(code, { ...details, refusal }, message ?? refusal);
    this.refusal = refusal;
  }
}

/** A module's closed set of refusal reasons, and the one way its rules refuse. */
export interface Refusals<R extends string> {
  readonly reasons: readonly R[];
  /**
   * Refuse with `reason`. `code` is the DomainError class a caller can branch on (default
   * INVALID_TRANSITION); the reason is what the person reads.
   */
  refuse(
    reason: R,
    options?: {
      readonly code?: DomainErrorCode;
      readonly details?: DomainErrorDetails;
      readonly message?: string;
    },
  ): RuleRefusal;
}

/**
 * Declare a module's refusal reasons. List them in the manifest's `refusals`, and give each one copy
 * at `<module>.refusal.<reason>` in every shipped locale: a gate test fails on a reason with none.
 */
export function defineRefusals<const R extends string>(
  moduleId: string,
  reasons: readonly R[],
): Refusals<R> {
  return {
    reasons,
    refuse: (reason, options = {}) =>
      new RuleRefusal(
        options.code ?? 'INVALID_TRANSITION',
        `${moduleId}.refusal.${reason}`,
        options.details,
        options.message,
      ),
  };
}

/** The refusal copy key a thrown error carries, or null when it is not a rule's refusal. */
export function refusalKeyOf(error: unknown): string | null {
  return error instanceof RuleRefusal ? error.refusal : null;
}

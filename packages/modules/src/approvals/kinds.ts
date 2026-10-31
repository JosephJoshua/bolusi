// What can be asked for. A module whose decisions an owner may hand out declares each as a kind:
// the command approval runs, who may ask, who may decide, and what the request depends on. The
// approvals module knows no other module; the one module list (src/index.ts) hands it the kinds,
// as it hands money its document sources.
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { CommandContext, CommandHandlerResult } from '@bolusi/core';

/** Where a request is judged: the business and store it was asked in. */
export interface ApprovalScope {
  readonly tenantId: string;
  readonly storeId: string;
}

/** What a request is about, as the asker's store records it (a servisan). */
export interface ApprovalTarget {
  readonly entityType: string;
  readonly entityId: string;
}

export interface ApprovalKind<Input = never> {
  /** `<module>.<decision>`, e.g. `repair.discount`; its copy is `approvals.kind.<id>`. */
  readonly id: string;
  /** What is asked: the input of the command approval runs. */
  readonly input: z.ZodType<Input>;
  /**
   * The command approval runs, as the approver. Left out, the approval is a permit the counter uses
   * later, with the customer there (Bayar nanti at handover), and the owning module's rules read it.
   */
  readonly handler?: (
    input: Input,
    ctx: CommandContext,
  ) => CommandHandlerResult<unknown> | Promise<CommandHandlerResult<unknown>>;
  /** The command's own permission, required of the approver as running it would. */
  readonly commandPermission: string;
  /**
   * The decision's permission, the one a limit covers: whoever decides holds it (within their
   * limit, which the command's own rules check), and holding it lets someone ask too.
   */
  readonly permission: string;
  /** Who else may ask: someone who can start this work (the counter asks for a discount). */
  readonly askPermission: string;
  /** Whether the input really needs a decision (a discount lowers the price). */
  readonly fits: (input: Input) => boolean;
  readonly target: (input: Input) => ApprovalTarget;
  /**
   * What the decision is worth in rupiah, for the approver to read and the limit to count, or null
   * when the target is gone. Read with the same queries on the device and the server.
   */
  readonly amount: (
    db: Kysely<never>,
    scope: ApprovalScope,
    input: Input,
  ) => Promise<number | null>;
  /**
   * What the approver's limit counts when they approve, if more than `amount`: this decision with
   * the ones of its kind already standing on the target (a servisan's other discounts). Checked
   * on the approval itself, so it is refused together with a decision over the approver's limit.
   */
  readonly counted?: (db: Kysely<never>, scope: ApprovalScope, input: Input) => Promise<number>;
  /**
   * The permission whose limit the decision's own rules hold the approver to, when not
   * `permission` (a down payment fix voids payments, so the refund limit counts it).
   */
  readonly limitPermission?: string;
  /**
   * What the request depends on, as one string (the servisan's state and price): a request asked
   * against one basis no longer fits once it changes, and is never approved then. Null when the
   * target is gone.
   */
  readonly basis: (db: Kysely<never>, scope: ApprovalScope, input: Input) => Promise<string | null>;
}

/** The registered kinds, by id. */
export type ApprovalKinds = Readonly<Record<string, ApprovalKind>>;

/** Declares a kind with its input type checked against its handler. */
export function approvalKind<Input>(kind: ApprovalKind<Input>): ApprovalKind {
  return kind as unknown as ApprovalKind;
}

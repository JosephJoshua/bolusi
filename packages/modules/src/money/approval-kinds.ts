// The money decisions an owner may hand out through an approval request (approvals/kinds.ts):
// cancelling a payment recorded by mistake, giving money back, and lowering a bill. The counter
// that took a payment asks to cancel it from Kas; a manager asks for a refund or a lower bill
// beyond their limit from the servisan. Approving runs the same command as the approver, whose
// refund limit its rules count (`takenOffDocument`). Each request is about the money's document (a
// servisan), so it waits where the servisan's other requests do.
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { zUuid } from '@bolusi/schemas';

import { approvalKind, type ApprovalKinds, type ApprovalScope } from '../approvals/kinds.js';
import {
  reduceChargeHandler,
  reduceChargeInput,
  refundHandler,
  refundInput,
  voidPaymentHandler,
  voidPaymentInput,
} from './commands.js';
import {
  CASH_ACCOUNT,
  MONEY_APPROVAL_KIND,
  MONEY_PERMISSION,
  paymentAccountIdOf,
} from './constants.js';
import type { MoneyDocumentSources } from './documents.js';
import { documentBalance, takenOffDocument, voidCounted } from './rules.js';
import type { MoneyDatabase } from './schema.js';

export const voidPaymentRequestInput = voidPaymentInput
  .extend({
    /** The payment's document, which the request is about. */
    document: z.object({ kind: z.string().min(1).max(40), id: zUuid }).strict(),
  })
  .strict();
export type VoidPaymentRequestInput = z.input<typeof voidPaymentRequestInput>;
type Input = z.output<typeof voidPaymentRequestInput>;

/** The payment, while it still counts and is the document's as asked. */
function livePayment(db: Kysely<never>, scope: ApprovalScope, input: Input) {
  return (db as unknown as Kysely<MoneyDatabase>)
    .selectFrom('moneyEntries')
    .select(['id', 'amount', 'account', 'documentKind', 'documentId'])
    .where('id', '=', input.entryId)
    .where('storeId', '=', scope.storeId)
    .where('kind', '=', 'payment_received')
    .where('voidedBy', 'is', null)
    .where('documentKind', '=', input.document.kind)
    .where('documentId', '=', input.document.id)
    .executeTakeFirst();
}

export const refundRequestInput = refundInput
  .extend({
    /**
     * The method's name as the asker saw it, so the owner reads where the money goes back. Not for
     * cash, which every reader names in their own language; for any other it must be the name the
     * store gave it (`refundBasis`), so the request never reads as going back some other way.
     */
    methodLabel: z.string().trim().min(1).max(80),
  })
  .strict();
export type RefundRequestInput = z.input<typeof refundRequestInput>;

type Db = Kysely<MoneyDatabase>;
type Document = { readonly kind: string; readonly id: string };

/** Whether the document still has money on it (it exists for the ledger). */
async function hasMoney(db: Db, scope: ApprovalScope, document: Document): Promise<boolean> {
  const row = await db
    .selectFrom('moneyEntries')
    .select('id')
    .where('storeId', '=', scope.storeId)
    .where('documentKind', '=', document.kind)
    .where('documentId', '=', document.id)
    .executeTakeFirst();
  return row !== undefined;
}

/** How many records the document has, and how many of them are voided: any money moving shows. */
async function moneyMoved(db: Db, scope: ApprovalScope, document: Document): Promise<string> {
  const moved = await db
    .selectFrom('moneyEntries')
    .select((eb) => [
      eb.fn.countAll<number>().as('all'),
      eb.fn.count<number>('voidedBy').as('voided'),
    ])
    .where('storeId', '=', scope.storeId)
    .where('documentKind', '=', document.kind)
    .where('documentId', '=', document.id)
    .executeTakeFirst();
  return `${Number(moved?.all ?? 0)}|${Number(moved?.voided ?? 0)}`;
}

/** Any money moving on the document changes what a refund or a lower bill would count. */
async function documentBasis(db: Db, scope: ApprovalScope, document: Document) {
  if (!(await hasMoney(db, scope, document))) return null;
  return `${document.id}|${await moneyMoved(db, scope, document)}`;
}

/** A refund's basis; none (it cannot be asked) when its method's name is not the method's own. */
async function refundBasis(
  db: Db,
  scope: ApprovalScope,
  input: z.output<typeof refundRequestInput>,
) {
  if (input.account !== CASH_ACCOUNT) {
    const id = paymentAccountIdOf(input.account);
    const account =
      id === null
        ? undefined
        : await db
            .selectFrom('moneyAccounts')
            .select('name')
            .where('id', '=', id)
            .where('tenantId', '=', scope.tenantId)
            .executeTakeFirst();
    if (account?.name !== input.methodLabel) return null;
  }
  return documentBasis(db, scope, input.document);
}

const latest = (scope: ApprovalScope) => ({ ...scope, at: Number.MAX_SAFE_INTEGER });

export function createMoneyApprovalKinds(sources: MoneyDocumentSources): ApprovalKinds {
  return {
    [MONEY_APPROVAL_KIND.voidPayment]: approvalKind({
      id: MONEY_APPROVAL_KIND.voidPayment,
      input: voidPaymentRequestInput,
      handler: (input, ctx) =>
        voidPaymentHandler({ entryId: input.entryId, reason: input.reason }, ctx),
      commandPermission: MONEY_PERMISSION.voidPayment,
      permission: MONEY_PERMISSION.voidPayment,
      // Whoever takes payments may ask to take one back.
      askPermission: MONEY_PERMISSION.receive,
      fits: () => true,
      target: (input) => ({ entityType: input.document.kind, entityId: input.document.id }),
      amount: async (db, scope, input) => {
        const entry = await livePayment(db, scope, input);
        return entry === undefined ? null : Number(entry.amount);
      },
      // With what was already taken off the document, as the void's rule counts it.
      counted: async (db, scope, input) => {
        const entry = await livePayment(db, scope, input);
        if (entry === undefined) return 0;
        return voidCounted(db as unknown as Db, sources, latest(scope), entry);
      },
      // Any money moving on the document since changes what the void would count.
      basis: async (db, scope, input) => {
        if ((await livePayment(db, scope, input)) === undefined) return null;
        return `${input.entryId}|${await moneyMoved(db as unknown as Db, scope, input.document)}`;
      },
    }),
    [MONEY_APPROVAL_KIND.refund]: approvalKind({
      id: MONEY_APPROVAL_KIND.refund,
      input: refundRequestInput,
      handler: ({ document, account, amount, reason, reference }, ctx) =>
        refundHandler({ document, account, amount, reason, reference }, ctx),
      commandPermission: MONEY_PERMISSION.receive,
      permission: MONEY_PERMISSION.refund,
      // Only someone who gives money back asks: a manager beyond their limit.
      askPermission: MONEY_PERMISSION.refund,
      fits: () => true,
      target: (input) => ({ entityType: input.document.kind, entityId: input.document.id }),
      amount: async (db, scope, input) =>
        (await hasMoney(db as unknown as Db, scope, input.document)) ? input.amount : null,
      // As the refund's rules count it: beyond the overpayment the bill comes down first, and the
      // two count once, with everything already taken off the servisan.
      counted: async (db, scope, input) => {
        const money = db as unknown as Db;
        const credit = Math.max(0, -(await documentBalance(money, scope.storeId, input.document)));
        return takenOffDocument(money, sources, latest(scope), input.document, {
          reduced: Math.max(0, input.amount - credit),
          refund: { account: input.account, amount: input.amount },
        });
      },
      basis: (db, scope, input) => refundBasis(db as unknown as Db, scope, input),
    }),
    [MONEY_APPROVAL_KIND.reduceCharge]: approvalKind({
      id: MONEY_APPROVAL_KIND.reduceCharge,
      input: reduceChargeInput,
      handler: reduceChargeHandler,
      commandPermission: MONEY_PERMISSION.refund,
      permission: MONEY_PERMISSION.refund,
      askPermission: MONEY_PERMISSION.refund,
      fits: () => true,
      target: (input) => ({ entityType: input.document.kind, entityId: input.document.id }),
      amount: async (db, scope, input) =>
        (await hasMoney(db as unknown as Db, scope, input.document)) ? input.amount : null,
      counted: (db, scope, input) =>
        takenOffDocument(db as unknown as Db, sources, latest(scope), input.document, {
          reduced: input.amount,
        }),
      basis: (db, scope, input) => documentBasis(db as unknown as Db, scope, input.document),
    }),
  };
}

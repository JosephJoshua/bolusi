// The money decisions an owner may hand out through an approval request (approvals/kinds.ts):
// cancelling a payment recorded by mistake. The counter that took it asks from Kas; approving runs
// the same void as the approver, whose refund limit its rule counts (`voidCounted`). The request is
// about the payment's document (a servisan), so it waits where the servisan's other requests do.
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { zUuid } from '@bolusi/schemas';

import { approvalKind, type ApprovalKinds, type ApprovalScope } from '../approvals/kinds.js';
import { voidPaymentHandler, voidPaymentInput } from './commands.js';
import { MONEY_APPROVAL_KIND, MONEY_PERMISSION } from './constants.js';
import type { MoneyDocumentSources } from './documents.js';
import { voidCounted } from './rules.js';
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
        const at = { ...scope, at: Number.MAX_SAFE_INTEGER };
        return voidCounted(db as unknown as Kysely<MoneyDatabase>, sources, at, entry);
      },
      // Any money moving on the document since changes what the void would count.
      basis: async (db, scope, input) => {
        if ((await livePayment(db, scope, input)) === undefined) return null;
        const moved = await (db as unknown as Kysely<MoneyDatabase>)
          .selectFrom('moneyEntries')
          .select((eb) => [
            eb.fn.countAll<number>().as('all'),
            eb.fn.count<number>('voidedBy').as('voided'),
          ])
          .where('storeId', '=', scope.storeId)
          .where('documentKind', '=', input.document.kind)
          .where('documentId', '=', input.document.id)
          .executeTakeFirst();
        return [input.entryId, Number(moved?.all ?? 0), Number(moved?.voided ?? 0)].join('|');
      },
    }),
  };
}

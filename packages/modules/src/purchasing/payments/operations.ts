// The supplier payment op types. Store-scoped, and read only with "Tagihan supplier": who the store
// paid, how much and from where is the owner's, so a store device holds none of it. Paid from the
// drawer, the same command also records money's `money.supplier_paid` under the payment's id, so
// the drawer's book (and only it) shows the cash leaving.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

import {
  MAX_PAYMENT,
  MAX_PAYMENT_REFERENCE,
  MAX_PURCHASING_NOTE,
  OWNER_FUNDS,
  PURCHASING_OP,
  PURCHASING_PAYMENT_ENTITY,
  PURCHASING_PERMISSION,
} from '../constants.js';
import type { PurchasingDatabase } from '../schema.js';
import { zOptionalPayloadText } from '../../shared/optional-text.js';
import { supplierPaidApplier, supplierPaymentVoidedApplier } from './applier.js';
import { supplierPaidRule, supplierPaymentVoidedRule } from './rules.js';

/** The drawer, a store bank account, or the owner's own money. */
export const zPaymentSource = z.union([
  z.literal('cash'),
  z.string().regex(/^account:[0-9a-f-]{36}$/),
  z.literal(OWNER_FUNDS),
]);

export const supplierPaidPayload = z
  .object({
    supplierId: zUuidV7,
    /** The bill it pays; null when paid ahead of any bill (it is then the supplier's credit). */
    billId: zUuidV7.nullable(),
    amount: z.number().int().min(1).max(MAX_PAYMENT),
    source: zPaymentSource,
    reference: zOptionalPayloadText(MAX_PAYMENT_REFERENCE),
    note: zOptionalPayloadText(MAX_PURCHASING_NOTE),
  })
  .strict();

export const supplierPaymentVoidedPayload = z
  .object({ reason: z.string().trim().min(1).max(MAX_PURCHASING_NOTE) })
  .strict();

const P = PURCHASING_PERMISSION;

export const PAYMENT_OPERATIONS: Readonly<
  Record<string, OperationDeclaration<PurchasingDatabase>>
> = {
  [PURCHASING_OP.supplierPaid]: {
    schemaVersion: 1,
    payload: supplierPaidPayload,
    reversal: 'Cancelled by purchasing.supplier_payment_voided.',
    apply: supplierPaidApplier,
    rule: supplierPaidRule,
    permission: P.paySuppliers,
    read: P.bills,
    entityType: PURCHASING_PAYMENT_ENTITY,
  },
  [PURCHASING_OP.supplierPaymentVoided]: {
    schemaVersion: 1,
    payload: supplierPaymentVoidedPayload,
    reversal: 'Final: a payment cancelled by mistake is recorded again instead.',
    apply: supplierPaymentVoidedApplier,
    rule: supplierPaymentVoidedRule,
    permission: P.paySuppliers,
    read: P.bills,
    entityType: PURCHASING_PAYMENT_ENTITY,
  },
};

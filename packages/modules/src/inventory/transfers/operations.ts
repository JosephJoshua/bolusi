// The transfer op types: parts sent from one store to another (product-scope.md, "Transfers
// between stores"). Each is store-scoped to the store that records it, and names the other store
// (`otherStore`) so both stores' devices see the transfer, its arrivals and its settlements. The
// stock itself moves in inventory's movement ops, next to each of these in the same save.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

import { zOptionalPayloadText } from '../../shared/optional-text.js';
import {
  INVENTORY_OP,
  INVENTORY_PERMISSION,
  INVENTORY_TRANSFER_ARRIVAL_ENTITY,
  INVENTORY_TRANSFER_ENTITY,
  INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
  MAX_MOVEMENT_QTY,
  MAX_TRANSFER_LINES,
  SETTLEMENT_OUTCOMES,
} from '../constants.js';
import type { InventoryDatabase } from '../schema.js';
import {
  transferCancelledApplier,
  transferReceivedApplier,
  transferSentApplier,
  transferSettledApplier,
} from './applier.js';
import {
  transferCancelledRule,
  transferReceivedRule,
  transferSentRule,
  transferSettledRule,
} from './rules.js';

export const MAX_TRANSFER_NOTE = 500;
const MAX_LINE_NAME = 200;

/** `TR-K7Q-0001`: the sending device's code and its own counter. */
export const TRANSFER_NUMBER_PATTERN = /^TR-[0-9A-Z]{3}-\d{4,9}$/;

const zQty = z.number().int().min(1).max(MAX_MOVEMENT_QTY);

function onePerPart<T extends { itemId: string }>(lines: readonly T[]): boolean {
  return new Set(lines.map((line) => line.itemId)).size === lines.length;
}

export const transferSentPayload = z
  .object({
    transferNumber: z.string().regex(TRANSFER_NUMBER_PATTERN),
    toStoreId: zUuidV7,
    note: zOptionalPayloadText(MAX_TRANSFER_NOTE),
    lines: z
      .array(
        z
          .object({ itemId: zUuidV7, name: z.string().trim().min(1).max(MAX_LINE_NAME), qty: zQty })
          .strict(),
      )
      .min(1)
      .max(MAX_TRANSFER_LINES)
      .refine(onePerPart, { message: 'a part twice' }),
  })
  .strict();

const zQtyLines = z
  .array(z.object({ itemId: zUuidV7, qty: zQty }).strict())
  .min(1)
  .max(MAX_TRANSFER_LINES)
  .refine(onePerPart, { message: 'a part twice' });

export const transferReceivedPayload = z
  .object({
    transferId: zUuidV7,
    /** The sending store, so it sees what arrived. */
    fromStoreId: zUuidV7,
    note: zOptionalPayloadText(MAX_TRANSFER_NOTE),
    lines: zQtyLines,
  })
  .strict();

export const transferCancelledPayload = z
  .object({
    /** The receiving store, so it stops waiting. */
    toStoreId: zUuidV7,
    reason: zOptionalPayloadText(MAX_TRANSFER_NOTE),
  })
  .strict();

export const transferSettledPayload = z
  .object({
    transferId: zUuidV7,
    toStoreId: zUuidV7,
    /** Required when anything is written off (the rule checks). */
    reason: zOptionalPayloadText(MAX_TRANSFER_NOTE),
    lines: z
      .array(
        z.object({ itemId: zUuidV7, outcome: z.enum(SETTLEMENT_OUTCOMES), qty: zQty }).strict(),
      )
      .min(1)
      .max(MAX_TRANSFER_LINES * SETTLEMENT_OUTCOMES.length)
      .refine(
        (lines) =>
          new Set(lines.map((line) => `${line.itemId}:${line.outcome}`)).size === lines.length,
        { message: 'a part and outcome twice' },
      ),
  })
  .strict();

const P = INVENTORY_PERMISSION;

function field<K extends string>(key: K) {
  return (payload: unknown): string | null => {
    const value = (payload as Record<K, unknown>)[key];
    return typeof value === 'string' ? value : null;
  };
}

export const TRANSFER_OPERATIONS: Readonly<
  Record<string, OperationDeclaration<InventoryDatabase>>
> = {
  [INVENTORY_OP.transferSent]: {
    schemaVersion: 1,
    payload: transferSentPayload,
    otherStore: field('toStoreId'),
    reversal: 'Withdrawn by inventory.transfer_cancelled while nothing has arrived.',
    apply: transferSentApplier,
    rule: transferSentRule,
    permission: P.transfer,
    read: P.read,
    entityType: INVENTORY_TRANSFER_ENTITY,
  },
  [INVENTORY_OP.transferReceived]: {
    schemaVersion: 1,
    payload: transferReceivedPayload,
    otherStore: field('fromStoreId'),
    reversal: "Corrected by a stock count, or settled by the sending store's owner.",
    apply: transferReceivedApplier,
    rule: transferReceivedRule,
    permission: P.receive,
    read: P.read,
    entityType: INVENTORY_TRANSFER_ARRIVAL_ENTITY,
  },
  [INVENTORY_OP.transferCancelled]: {
    schemaVersion: 1,
    payload: transferCancelledPayload,
    otherStore: field('toStoreId'),
    reversal: 'Final: the parts are sent again as a new transfer.',
    apply: transferCancelledApplier,
    rule: transferCancelledRule,
    permission: P.transfer,
    read: P.read,
    entityType: INVENTORY_TRANSFER_ENTITY,
  },
  [INVENTORY_OP.transferSettled]: {
    schemaVersion: 1,
    payload: transferSettledPayload,
    otherStore: field('toStoreId'),
    reversal: 'Corrected by another settlement the other way (lost parts that arrived after all).',
    apply: transferSettledApplier,
    rule: transferSettledRule,
    permission: P.settleTransfer,
    read: P.read,
    entityType: INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
  },
};

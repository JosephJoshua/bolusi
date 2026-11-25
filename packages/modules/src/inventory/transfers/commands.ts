// The transfer commands. Each writes the transfer's own record and, next to it in the same save,
// the stock it moves (inventory's movement ops), so stock never moves without its transfer saying so.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import { zOptionalText } from '../../shared/optional-text.js';
import { stockReceivedOp, type OpDraft } from '../commands.js';
import {
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  INVENTORY_TRANSFER_ARRIVAL_ENTITY,
  INVENTORY_TRANSFER_ENTITY,
  INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
  MAX_MOVEMENT_QTY,
  MAX_TRANSFER_LINES,
  type SettlementOutcome,
} from '../constants.js';
import type { zStockSink } from '../operations.js';
import { getItemQuery } from '../queries.js';
import { INVENTORY_REFUSALS } from '../refusals.js';
import { MAX_TRANSFER_NOTE } from './operations.js';
import { excessLines, settlementFits } from './state.js';
import { getTransferQuery, nextTransferNumberQuery, type TransferDetailRow } from './queries.js';

function invalid(field: string, issue: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { field, issue });
}

function stockSentOp(
  ctx: CommandContext,
  sent: {
    readonly itemId: string;
    readonly qty: number;
    readonly sink: z.infer<typeof zStockSink>;
  },
): OpDraft {
  return ctx.op({
    type: INVENTORY_OP.stockSent,
    entityType: INVENTORY_MOVEMENT_ENTITY,
    entityId: ctx.newId(),
    payload: { itemId: sent.itemId, qty: sent.qty, sink: sent.sink },
  });
}

const zQtyLines = z
  .array(
    z
      .object({ itemId: z.string().min(1), qty: z.number().int().min(0).max(MAX_MOVEMENT_QTY) })
      .strict(),
  )
  .min(1)
  .max(MAX_TRANSFER_LINES);

/** The lines that carry a quantity, each part once. */
function counted(lines: z.output<typeof zQtyLines>) {
  const kept = lines.filter((line) => line.qty > 0);
  if (kept.length === 0) throw invalid('lines', 'nothing to record');
  if (new Set(kept.map((line) => line.itemId)).size !== kept.length) {
    throw invalid('lines', 'a part twice');
  }
  return kept;
}

async function loadTransfer(ctx: CommandContext, transferId: string): Promise<TransferDetailRow> {
  const transfer = (await ctx.query(getTransferQuery, { transferId })).rows[0];
  if (transfer === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: INVENTORY_TRANSFER_ENTITY,
      entityId: transferId,
    });
  }
  return transfer;
}

// ── send ───────────────────────────────────────────────────────────────────────────────────────

export const sendTransferInput = z
  .object({
    toStoreId: z.string().min(1),
    note: zOptionalText(MAX_TRANSFER_NOTE),
    lines: zQtyLines,
  })
  .strict();
export type SendTransferInput = z.input<typeof sendTransferInput>;

/** Send parts to another store: they leave this store's stock at once and travel until received. */
export async function sendTransferHandler(
  input: z.output<typeof sendTransferInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ transferId: string; transferNumber: string }>> {
  if (input.toStoreId === ctx.storeId) throw invalid('toStoreId', 'the sending store');
  const lines = [];
  for (const line of counted(input.lines)) {
    const item = (await ctx.query(getItemQuery, { itemId: line.itemId })).rows[0];
    if (item === undefined) {
      throw new DomainError('ENTITY_NOT_FOUND', {
        entityType: 'inventory_item',
        entityId: line.itemId,
      });
    }
    if (item.archived) {
      throw INVENTORY_REFUSALS.refuse('itemArchived', { details: { entityId: line.itemId } });
    }
    lines.push({ itemId: line.itemId, name: item.name.slice(0, 200), qty: line.qty });
  }
  const { transferNumber } = (await ctx.query(nextTransferNumberQuery, { deviceId: ctx.deviceId }))
    .rows[0]!;
  const transferId = ctx.newId();
  const sink = {
    kind: 'transfer' as const,
    id: transferId,
    label: transferNumber,
    toStoreId: input.toStoreId,
  };
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.transferSent,
        entityType: INVENTORY_TRANSFER_ENTITY,
        entityId: transferId,
        payload: { transferNumber, toStoreId: input.toStoreId, note: input.note, lines },
      }),
      ...lines.map((line) => stockSentOp(ctx, { itemId: line.itemId, qty: line.qty, sink })),
    ],
    result: { transferId, transferNumber },
  };
}

// ── receive ────────────────────────────────────────────────────────────────────────────────────

export const receiveTransferInput = z
  .object({
    transferId: z.string().min(1),
    /** What arrived, per part; a part that did not come is left out or sent as 0. */
    lines: zQtyLines,
    note: zOptionalText(MAX_TRANSFER_NOTE),
  })
  .strict();
export type ReceiveTransferInput = z.input<typeof receiveTransferInput>;

/** Record what arrived here from another store, and add it to this store's stock. */
export async function receiveTransferHandler(
  input: z.output<typeof receiveTransferInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ arrivalId: string }>> {
  const transfer = await loadTransfer(ctx, input.transferId);
  if (transfer.direction !== 'in') throw invalid('transferId', 'not sent to this store');
  if (!transfer.can.receive) throw invalid('transferId', `transfer is ${transfer.stage}`);
  const arrived = counted(input.lines);
  const onTransfer = new Map(transfer.lines.map((line) => [line.itemId, line]));
  for (const line of arrived) {
    const sent = onTransfer.get(line.itemId);
    if (sent === undefined) throw invalid('lines', 'not on the transfer');
    if (sent.arrived + line.qty > sent.sent) throw invalid('lines', 'more than was sent');
  }
  const arrivalId = ctx.newId();
  const source = {
    kind: 'transfer_arrival' as const,
    id: arrivalId,
    label: transfer.transferNumber,
  };
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.transferReceived,
        entityType: INVENTORY_TRANSFER_ARRIVAL_ENTITY,
        entityId: arrivalId,
        payload: {
          transferId: transfer.id,
          fromStoreId: transfer.fromStoreId,
          note: input.note,
          lines: arrived,
        },
      }),
      ...arrived.map((line) =>
        stockReceivedOp(ctx, { itemId: line.itemId, qty: line.qty, source }),
      ),
    ],
    result: { arrivalId },
  };
}

// ── cancel ─────────────────────────────────────────────────────────────────────────────────────

export const cancelTransferInput = z
  .object({ transferId: z.string().min(1), reason: zOptionalText(MAX_TRANSFER_NOTE) })
  .strict();
export type CancelTransferInput = z.input<typeof cancelTransferInput>;

/** Take a transfer back before anything arrived: every part returns to this store's stock. */
export async function cancelTransferHandler(
  input: z.output<typeof cancelTransferInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ transferId: string }>> {
  const transfer = await loadTransfer(ctx, input.transferId);
  if (transfer.direction !== 'out') throw invalid('transferId', 'not sent from this store');
  if (!transfer.can.cancel) throw invalid('transferId', `transfer is ${transfer.stage}`);
  const source = {
    kind: 'transfer_cancel' as const,
    id: transfer.id,
    label: transfer.transferNumber,
  };
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.transferCancelled,
        entityType: INVENTORY_TRANSFER_ENTITY,
        entityId: transfer.id,
        payload: { toStoreId: transfer.toStoreId, reason: input.reason },
      }),
      ...transfer.lines
        .filter((line) => line.sent > 0)
        .map((line) => stockReceivedOp(ctx, { itemId: line.itemId, qty: line.sent, source })),
    ],
    result: { transferId: transfer.id },
  };
}

// ── settle ─────────────────────────────────────────────────────────────────────────────────────

/** What the owner says per part: missing ones back or lost; an excess as arrived after all. */
const SETTLE_CHOICES = ['back', 'lost', 'arrived'] as const;

export const settleTransferInput = z
  .object({
    transferId: z.string().min(1),
    reason: zOptionalText(MAX_TRANSFER_NOTE),
    lines: z
      .array(
        z
          .object({
            itemId: z.string().min(1),
            outcome: z.enum(SETTLE_CHOICES),
            qty: z.number().int().min(0).max(MAX_MOVEMENT_QTY),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TRANSFER_LINES * SETTLE_CHOICES.length),
  })
  .strict();
export type SettleTransferInput = z.input<typeof settleTransferInput>;

/**
 * Close what a sent transfer is missing (back on this store's shelf, or written off with a reason),
 * or what it is over: parts the receiver counted in after all. Those undo a write-off first (no
 * stock moves) and then a take-back (they leave this store's stock again).
 */
export async function settleTransferHandler(
  input: z.output<typeof settleTransferInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ settlementId: string }>> {
  const transfer = await loadTransfer(ctx, input.transferId);
  if (transfer.direction !== 'out') throw invalid('transferId', 'not sent from this store');
  const asked = input.lines.filter((line) => line.qty > 0);
  if (asked.length === 0) throw invalid('lines', 'nothing to record');
  if (asked.some((line) => line.outcome === 'lost') && input.reason === null) {
    throw invalid('reason', 'required to write parts off');
  }
  if (new Set(asked.map((line) => `${line.itemId}:${line.outcome}`)).size !== asked.length) {
    throw invalid('lines', 'a part and outcome twice');
  }
  const onTransfer = new Map(transfer.lines.map((line) => [line.itemId, line]));
  const lines: { itemId: string; outcome: SettlementOutcome; qty: number }[] = [];
  for (const line of asked) {
    const current = onTransfer.get(line.itemId);
    if (current === undefined) throw invalid('lines', 'not on the transfer');
    if (line.outcome === 'arrived') {
      for (const part of excessLines(current, line.qty))
        lines.push({ itemId: line.itemId, ...part });
    } else {
      lines.push(line);
    }
  }
  for (const current of transfer.lines) {
    if (
      !settlementFits(
        current,
        lines.filter((line) => line.itemId === current.itemId),
      )
    ) {
      throw invalid('lines', 'more than is open');
    }
  }
  const settlementId = ctx.newId();
  const ref = { id: settlementId, label: transfer.transferNumber };
  const ops: OpDraft[] = [
    ctx.op({
      type: INVENTORY_OP.transferSettled,
      entityType: INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
      entityId: settlementId,
      payload: {
        transferId: transfer.id,
        toStoreId: transfer.toStoreId,
        reason: input.reason,
        lines,
      },
    }),
  ];
  for (const line of lines) {
    if (line.outcome === 'back') {
      ops.push(
        stockReceivedOp(ctx, {
          itemId: line.itemId,
          qty: line.qty,
          source: { kind: 'transfer_settlement', ...ref },
        }),
      );
    } else if (line.outcome === 'arrived') {
      ops.push(
        stockSentOp(ctx, {
          itemId: line.itemId,
          qty: line.qty,
          sink: { kind: 'transfer_settlement', ...ref },
        }),
      );
    }
  }
  return { ops, result: { settlementId } };
}

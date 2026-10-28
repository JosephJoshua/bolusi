// The `inventory` commands: the only write path. Handlers compose op drafts; whether each may be
// recorded is its type's rule (rules.ts), run on the device before saving and on the server on push.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import {
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  INVENTORY_ITEM_ENTITY,
  MAX_COUNTED_QTY,
  MAX_MOVEMENT_QTY,
  MAX_PART_FITS,
  PART_USE_KINDS,
} from './constants.js';
import { MAX_NOTE, MAX_PART_CODE, MAX_PART_NAME, zPartFit } from './operations.js';
import { compactModel } from '../shared/model-key.js';
import { getItemQuery, type ItemDetailRow } from './queries.js';

/** Blank optional text is no text. */
const zOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === null || value === '' ? null : value));

const zPartDetails = z
  .object({
    name: z.string().trim().min(1).max(MAX_PART_NAME),
    code: zOptionalText(MAX_PART_CODE),
    // The same model picked twice is listed once.
    fits: z
      .array(zPartFit)
      .max(MAX_PART_FITS)
      .default([])
      .transform((fits) =>
        fits.filter(
          (fit, i) =>
            fits.findIndex(
              (other) =>
                compactModel(other.brand, other.model) === compactModel(fit.brand, fit.model),
            ) === i,
        ),
      ),
  })
  .strict();

async function loadPart(ctx: CommandContext, itemId: string): Promise<ItemDetailRow> {
  const part = (await ctx.query(getItemQuery, { itemId })).rows[0];
  if (part === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: INVENTORY_ITEM_ENTITY,
      entityId: itemId,
    });
  }
  return part;
}

function sameFits(
  a: readonly { brand: string; model: string }[],
  b: readonly { brand: string; model: string }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((fit, i) => fit.brand === b[i]!.brand && fit.model === b[i]!.model)
  );
}

function nothingChanged(field: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { field, issue: 'nothing changed' });
}

// ── the parts list ───────────────────────────────────────────────────────────────────────────

export const addItemInput = zPartDetails;
export type AddPartInput = z.input<typeof addItemInput>;

export function addItemHandler(
  input: z.output<typeof addItemInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ itemId: string }> {
  const itemId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.itemAdded,
        entityType: INVENTORY_ITEM_ENTITY,
        entityId: itemId,
        payload: { name: input.name, code: input.code, fits: input.fits },
      }),
    ],
    result: { itemId },
  };
}

export const editItemInput = zPartDetails
  .extend({ itemId: z.string().min(1), archived: z.boolean() })
  .strict();
export type EditPartInput = z.input<typeof editItemInput>;

export async function editItemHandler(
  input: z.output<typeof editItemInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ itemId: string }>> {
  const part = await loadPart(ctx, input.itemId);
  if (
    part.name === input.name &&
    part.code === input.code &&
    sameFits(part.models, input.fits) &&
    part.archived === input.archived
  ) {
    throw nothingChanged('name');
  }
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.itemEdited,
        entityType: INVENTORY_ITEM_ENTITY,
        entityId: part.id,
        payload: { name: input.name, code: input.code, fits: input.fits, archived: input.archived },
      }),
    ],
    result: { itemId: part.id },
  };
}

// ── counts ─────────────────────────────────────────────────────────────────────────────────────

export const countStockInput = z
  .object({
    counts: z
      .array(
        z
          .object({
            itemId: z.string().min(1),
            counted: z.number().int().min(0).max(MAX_COUNTED_QTY),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    note: zOptionalText(MAX_NOTE),
  })
  .strict();
export type CountStockInput = z.input<typeof countStockInput>;

/**
 * Record what was counted on the shelf, one movement per part. Each carries what this device
 * showed, so the stock becomes the count here and a take another phone has not synced yet still
 * comes off once it does. A count that matches is recorded too: it is the proof someone looked.
 */
export async function countStockHandler(
  input: z.output<typeof countStockInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ movementIds: readonly string[] }>> {
  const ops = [];
  const movementIds: string[] = [];
  const seen = new Set<string>();
  for (const count of input.counts) {
    if (seen.has(count.itemId)) {
      throw new DomainError('VALIDATION_FAILED', { field: 'counts', issue: 'a part twice' });
    }
    seen.add(count.itemId);
    const part = await loadPart(ctx, count.itemId);
    const movementId = ctx.newId();
    movementIds.push(movementId);
    ops.push(
      ctx.op({
        type: INVENTORY_OP.stockCounted,
        entityType: INVENTORY_MOVEMENT_ENTITY,
        entityId: movementId,
        payload: {
          itemId: part.id,
          counted: count.counted,
          expected: part.onHand,
          note: input.note,
        },
      }),
    );
  }
  return { ops, result: { movementIds } };
}

// ── parts used ─────────────────────────────────────────────────────────────────────────────────

export const usePartInput = z
  .object({
    itemId: z.string().min(1),
    qty: z.number().int().min(1).max(MAX_MOVEMENT_QTY),
    use: z
      .object({
        kind: z.enum(PART_USE_KINDS),
        id: z.string().min(1),
        /** How the use reads in lists (the servisan number); the rule checks it. */
        label: z.string().min(1).max(60),
      })
      .strict(),
  })
  .strict();
export type UsePartInput = z.input<typeof usePartInput>;

function useOp(ctx: CommandContext, type: string, input: z.output<typeof usePartInput>) {
  const movementId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type,
        entityType: INVENTORY_MOVEMENT_ENTITY,
        entityId: movementId,
        payload: { itemId: input.itemId, qty: input.qty, use: input.use },
      }),
    ],
    result: { movementId },
  };
}

/** Take a part off the shelf for a use. Stock may go below zero; the owner sees it flagged. */
export function takePartHandler(
  input: z.output<typeof usePartInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ movementId: string }> {
  return useOp(ctx, INVENTORY_OP.itemTaken, input);
}

/** Put an unused part back on the shelf. Only what the use took can go back. */
export function putBackPartHandler(
  input: z.output<typeof usePartInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ movementId: string }> {
  return useOp(ctx, INVENTORY_OP.itemPutBack, input);
}

// The `inventory` commands: the only write path. Handlers compose op drafts; whether each may be
// recorded is its type's rule (rules.ts), run on the device before saving and on the server on push.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import {
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  INVENTORY_PART_ENTITY,
  MAX_COUNTED_QTY,
  MAX_MOVEMENT_QTY,
  PART_USE_KINDS,
} from './constants.js';
import { MAX_NOTE, MAX_PART_CODE, MAX_PART_FITS, MAX_PART_NAME } from './operations.js';
import { getPartQuery, type PartRow } from './queries.js';

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
    fits: zOptionalText(MAX_PART_FITS),
  })
  .strict();

async function loadPart(ctx: CommandContext, partId: string): Promise<PartRow> {
  const part = (await ctx.query(getPartQuery, { partId })).rows[0];
  if (part === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: INVENTORY_PART_ENTITY,
      entityId: partId,
    });
  }
  return part;
}

function nothingChanged(field: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { field, issue: 'nothing changed' });
}

// ── the parts list ───────────────────────────────────────────────────────────────────────────

export const addPartInput = zPartDetails;
export type AddPartInput = z.input<typeof addPartInput>;

export function addPartHandler(
  input: z.output<typeof addPartInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ partId: string }> {
  const partId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.partAdded,
        entityType: INVENTORY_PART_ENTITY,
        entityId: partId,
        payload: { name: input.name, code: input.code, fits: input.fits },
      }),
    ],
    result: { partId },
  };
}

export const editPartInput = zPartDetails
  .extend({ partId: z.string().min(1), archived: z.boolean() })
  .strict();
export type EditPartInput = z.input<typeof editPartInput>;

export async function editPartHandler(
  input: z.output<typeof editPartInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ partId: string }>> {
  const part = await loadPart(ctx, input.partId);
  if (
    part.name === input.name &&
    part.code === input.code &&
    part.fits === input.fits &&
    part.archived === input.archived
  ) {
    throw nothingChanged('name');
  }
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.partEdited,
        entityType: INVENTORY_PART_ENTITY,
        entityId: part.id,
        payload: { name: input.name, code: input.code, fits: input.fits, archived: input.archived },
      }),
    ],
    result: { partId: part.id },
  };
}

// ── counts ─────────────────────────────────────────────────────────────────────────────────────

export const countStockInput = z
  .object({
    counts: z
      .array(
        z
          .object({
            partId: z.string().min(1),
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
    if (seen.has(count.partId)) {
      throw new DomainError('VALIDATION_FAILED', { field: 'counts', issue: 'a part twice' });
    }
    seen.add(count.partId);
    const part = await loadPart(ctx, count.partId);
    const movementId = ctx.newId();
    movementIds.push(movementId);
    ops.push(
      ctx.op({
        type: INVENTORY_OP.stockCounted,
        entityType: INVENTORY_MOVEMENT_ENTITY,
        entityId: movementId,
        payload: {
          partId: part.id,
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
    partId: z.string().min(1),
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
        payload: { partId: input.partId, qty: input.qty, use: input.use },
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
  return useOp(ctx, INVENTORY_OP.partTaken, input);
}

/** Put an unused part back on the shelf. Only what the use took can go back. */
export function putBackPartHandler(
  input: z.output<typeof usePartInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ movementId: string }> {
  return useOp(ctx, INVENTORY_OP.partPutBack, input);
}

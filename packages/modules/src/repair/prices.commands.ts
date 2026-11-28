// The repair price list's commands: the business owner saves and removes rows, and a store owner
// sets what their store charges instead. Whether each op may be recorded is its rule's (rules.ts).
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';
import { zMoneyIdr, zUuidV7 } from '@bolusi/schemas';

import {
  MAX_LINE_AMOUNT,
  REPAIR_OP,
  REPAIR_PRICE_ENTITY,
  REPAIR_STORE_PRICES_ENTITY,
} from './constants.js';
import { MAX_PRICE_MODELS, MAX_PRICE_QUALITY, MAX_STORE_PRICES, zOptionId } from './operations.js';
import { zPartFit } from '../inventory/operations.js';

/** Rows one save may hold: a run of the PC's sheet, saved in turn. */
export const MAX_PRICES_PER_SAVE = 100;

const zPriceInput = zMoneyIdr.min(1).max(MAX_LINE_AMOUNT);

export const savePricesInput = z
  .object({
    rows: z
      .array(
        z
          .object({
            /** The row being changed; absent for a new one, whose id is minted here. */
            priceId: zUuidV7.optional(),
            repairType: zOptionId,
            models: z.array(zPartFit).min(1).max(MAX_PRICE_MODELS),
            quality: z.string().trim().max(MAX_PRICE_QUALITY),
            amount: zPriceInput,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PRICES_PER_SAVE),
  })
  .strict();
export type SavePricesInput = z.input<typeof savePricesInput>;

/** Save rows of the price list, new or changed, all or none. */
export async function savePricesHandler(
  input: z.output<typeof savePricesInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ priceIds: readonly string[] }>> {
  const priceIds: string[] = [];
  const ops = input.rows.map(({ priceId, ...row }) => {
    const id = priceId ?? ctx.newId();
    priceIds.push(id);
    return ctx.op({
      type: REPAIR_OP.priceSaved,
      entityType: REPAIR_PRICE_ENTITY,
      entityId: id,
      payload: row,
    });
  });
  return { ops, result: { priceIds } };
}

export const removePricesInput = z
  .object({ priceIds: z.array(zUuidV7).min(1).max(MAX_PRICES_PER_SAVE) })
  .strict();
export type RemovePricesInput = z.input<typeof removePricesInput>;

/** Take rows off the price list. Servisan already quoted keep their prices. */
export async function removePricesHandler(
  input: z.output<typeof removePricesInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<null>> {
  return {
    ops: [...new Set(input.priceIds)].map((priceId) =>
      ctx.op({
        type: REPAIR_OP.priceRemoved,
        entityType: REPAIR_PRICE_ENTITY,
        entityId: priceId,
        payload: {},
      }),
    ),
    result: null,
  };
}

export const setStorePricesInput = z
  .object({
    prices: z
      .array(z.object({ priceId: zUuidV7, amount: zPriceInput.nullable() }).strict())
      .min(1)
      .max(MAX_STORE_PRICES),
  })
  .strict();
export type SetStorePricesInput = z.input<typeof setStorePricesInput>;

/** Set what this store charges for rows of the list; null charges the list's price again. */
export async function setStorePricesHandler(
  input: z.output<typeof setStorePricesInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<null>> {
  if (ctx.storeId === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'prices', issue: 'this device has no store' },
      'a store-less device cannot set store prices',
    );
  }
  // One price per row: the last one given stands.
  const byRow = new Map(input.prices.map((price) => [price.priceId, price.amount]));
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.storePricesSet,
        entityType: REPAIR_STORE_PRICES_ENTITY,
        entityId: ctx.storeId,
        payload: { prices: [...byRow].map(([priceId, amount]) => ({ priceId, amount })) },
      }),
    ],
    result: null,
  };
}

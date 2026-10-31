// The `inventory` commands: the only write path. Handlers compose op drafts; whether each may be
// recorded is its type's rule (rules.ts), run on the device before saving and on the server on push.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import {
  cleanTags,
  cleanValues,
  formatItemName,
  zCategoryShape,
  type CategoryField,
  type FieldValues,
} from './categories.js';
import {
  INVENTORY_CATEGORY_ENTITY,
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  INVENTORY_ITEM_ENTITY,
  MAX_ITEM_TAGS,
  MAX_COUNTED_QTY,
  MAX_MOVEMENT_QTY,
  MAX_PART_FITS,
  PART_USE_KINDS,
  type StockSourceKind,
} from './constants.js';

type OpDraft = ReturnType<CommandContext['op']>;
import { MAX_BARCODE, MAX_NOTE, MAX_PART_CODE, MAX_PART_NAME, zPartFit } from './operations.js';
import { compactModel } from '../shared/model-key.js';
import {
  getItemQuery,
  itemsInCategoryQuery,
  listCategoriesQuery,
  type CategoryRow,
  type ItemDetailRow,
} from './queries.js';

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
    /** Ignored when `nameAuto`: the category's format names it. */
    name: z.string().trim().max(MAX_PART_NAME).default(''),
    nameAuto: z.boolean().default(false),
    code: zOptionalText(MAX_PART_CODE),
    barcode: zOptionalText(MAX_BARCODE),
    categoryId: z.string().min(1).nullable().default(null),
    values: z.record(z.string(), z.array(z.string())).default({}),
    tags: z.array(z.string()).default([]),
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

type PartDetailsInput = z.output<typeof zPartDetails>;

async function loadCategory(ctx: CommandContext, categoryId: string): Promise<CategoryRow> {
  const category = (await ctx.query(listCategoriesQuery, { includeArchived: true })).rows.find(
    (row) => row.id === categoryId,
  );
  if (category === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: INVENTORY_CATEGORY_ENTITY,
      entityId: categoryId,
    });
  }
  return category;
}

/**
 * What an item's op says: values kept to its category's fields, tags once each, and the name
 * filled in from the category's format when it is not typed.
 */
async function itemPayload(ctx: CommandContext, input: PartDetailsInput) {
  const category = input.categoryId === null ? null : await loadCategory(ctx, input.categoryId);
  const values: FieldValues = category === null ? {} : cleanValues(category.fields, input.values);
  const tags = cleanTags(input.tags);
  if (tags.length > MAX_ITEM_TAGS) {
    throw new DomainError('VALIDATION_FAILED', { field: 'tags', issue: 'too many' });
  }
  const nameAuto = input.nameAuto && category !== null;
  const name = nameAuto ? formatItemName(category, values, input.fits) : input.name;
  if (name === '') throw new DomainError('VALIDATION_FAILED', { field: 'name', issue: 'empty' });
  return {
    name: name.slice(0, MAX_PART_NAME),
    nameAuto,
    code: input.code,
    barcode: input.barcode,
    categoryId: input.categoryId,
    values,
    tags,
    fits: input.fits,
  };
}

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

export async function addItemHandler(
  input: z.output<typeof addItemInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ itemId: string }>> {
  const itemId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.itemAdded,
        entityType: INVENTORY_ITEM_ENTITY,
        entityId: itemId,
        payload: await itemPayload(ctx, input),
      }),
    ],
    result: { itemId },
  };
}

export const editItemInput = zPartDetails
  .extend({ itemId: z.string().min(1), archived: z.boolean() })
  .strict();
export type EditPartInput = z.input<typeof editItemInput>;

function sameValues(a: FieldValues, b: FieldValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function editItemHandler(
  input: z.output<typeof editItemInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ itemId: string }>> {
  const part = await loadPart(ctx, input.itemId);
  const payload = await itemPayload(ctx, input);
  if (
    part.name === payload.name &&
    part.nameAuto === payload.nameAuto &&
    part.code === payload.code &&
    part.barcode === payload.barcode &&
    part.categoryId === payload.categoryId &&
    sameValues(part.values, payload.values) &&
    sameValues({ tags: part.tags }, { tags: payload.tags }) &&
    sameFits(part.models, payload.fits) &&
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
        payload: { ...payload, archived: input.archived },
      }),
    ],
    result: { itemId: part.id },
  };
}

// ── categories ─────────────────────────────────────────────────────────────────────────────────

export const addCategoryInput = zCategoryShape.extend({ isPart: z.boolean() }).strict();
export type AddCategoryInput = z.input<typeof addCategoryInput>;

export function addCategoryHandler(
  input: z.output<typeof addCategoryInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ categoryId: string }> {
  const categoryId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: INVENTORY_OP.categoryAdded,
        entityType: INVENTORY_CATEGORY_ENTITY,
        entityId: categoryId,
        payload: input,
      }),
    ],
    result: { categoryId },
  };
}

export const editCategoryInput = addCategoryInput
  .extend({ categoryId: z.string().min(1), archived: z.boolean() })
  .strict();
export type EditCategoryInput = z.input<typeof editCategoryInput>;

/**
 * Change a category. Its items named by its format are renamed to match, in the same save, so the
 * list reads one way; names someone typed stay as they are.
 */
export async function editCategoryHandler(
  input: z.output<typeof editCategoryInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ categoryId: string; renamed: number }>> {
  const { categoryId, archived, ...shape } = input;
  const current = await loadCategory(ctx, categoryId);
  if (
    current.name === shape.name &&
    current.isPart === shape.isPart &&
    current.nameFormat === shape.nameFormat &&
    JSON.stringify(current.fields) === JSON.stringify(shape.fields) &&
    current.archived === archived
  ) {
    throw nothingChanged('name');
  }
  const ops = [
    ctx.op({
      type: INVENTORY_OP.categoryEdited,
      entityType: INVENTORY_CATEGORY_ENTITY,
      entityId: categoryId,
      payload: { ...shape, archived },
    }),
  ];
  const fields: readonly CategoryField[] = shape.fields;
  for (const item of (await ctx.query(itemsInCategoryQuery, { categoryId })).rows) {
    if (!item.nameAuto) continue;
    const values = cleanValues(fields, item.values);
    const name = formatItemName({ fields, nameFormat: shape.nameFormat }, values, item.models);
    if (name === '' || (name === item.name && sameValues(values, item.values))) continue;
    ops.push(
      ctx.op({
        type: INVENTORY_OP.itemEdited,
        entityType: INVENTORY_ITEM_ENTITY,
        entityId: item.id,
        payload: {
          name: name.slice(0, MAX_PART_NAME),
          nameAuto: true,
          code: item.code,
          barcode: item.barcode,
          categoryId,
          values,
          tags: item.tags,
          fits: item.models,
          archived: item.archived,
        },
      }),
    );
  }
  return { ops, result: { categoryId, renamed: ops.length - 1 } };
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

// ── parts received ─────────────────────────────────────────────────────────────────────────────

/**
 * Parts that arrived, as the module that brought them adds them next to its own record (a receipt
 * from a supplier). The receive rule asks that module whether its record really lists them.
 */
export function stockReceivedOp(
  ctx: CommandContext,
  received: {
    readonly itemId: string;
    readonly qty: number;
    readonly source: {
      readonly kind: StockSourceKind;
      readonly id: string;
      readonly label: string;
    };
  },
): OpDraft {
  return ctx.op({
    type: INVENTORY_OP.stockReceived,
    entityType: INVENTORY_MOVEMENT_ENTITY,
    entityId: ctx.newId(),
    payload: { itemId: received.itemId, qty: received.qty, source: received.source },
  });
}

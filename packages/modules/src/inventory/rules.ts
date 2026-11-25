// The `inventory` op rules, run by the device before saving and by the server before accepting a
// push (core module/op-rules.ts). Every read is constrained to the op's tenant, and movements to the
// op's store, so an op naming another business's part or another store's stock finds nothing.
//
// Stock is allowed to go below zero (owner decision, 2026-10-28): two phones taking the last part
// offline must not block a repair. The owner sees it flagged instead.
import type { OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { categoryProblem, type CategoryShape } from './categories.js';
import {
  INVENTORY_CATEGORY_ENTITY,
  INVENTORY_ITEM_ENTITY,
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_PERMISSION,
  type StockSinkKind,
} from './constants.js';
import type { PartUseTargets } from './part-use.js';
import { INVENTORY_REFUSALS } from './refusals.js';
import type { InventoryDatabase } from './schema.js';
import type { AllStockSourceTargets } from './stock-source.js';
import { STOCK_SINKS } from './transfers/sources.js';

type Rule = OpRule<InventoryDatabase>;
type Db = Parameters<Rule>[1]['db'];

export { INVENTORY_REFUSALS };
const { refuse } = INVENTORY_REFUSALS;

interface UsePayload {
  readonly itemId: string;
  readonly qty: number;
  readonly use: {
    readonly kind: keyof PartUseTargets;
    readonly id: string;
    readonly label: string;
  };
}

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

async function findPart(db: Db, op: SignedOperation, itemId: string) {
  return db
    .selectFrom('inventoryItems')
    .select(['id', 'archived', 'updatedAt'])
    .where('id', '=', itemId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirst();
}

async function requirePart(db: Db, op: SignedOperation, itemId: string) {
  const part = await findPart(db, op, itemId);
  if (part === undefined) {
    throw refuse('itemNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: INVENTORY_ITEM_ENTITY, entityId: itemId },
    });
  }
  return part;
}

/** Movement ids are fresh per op; a second op reusing one is a replay or a forgery. */
async function requireFreshMovement(db: Db, op: SignedOperation): Promise<void> {
  const row = await db
    .selectFrom('inventoryMovements')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (row !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'movementId', issue: 'already exists' },
    });
  }
}

/** How many of a part are still out on one use in this store: taken minus put back. */
export async function outOnUse(
  db: Db,
  op: Pick<SignedOperation, 'tenantId' | 'storeId'>,
  itemId: string,
  useId: string,
): Promise<number> {
  const row = await db
    .selectFrom('inventoryMovements')
    .select((eb) => eb.fn.sum<number | string | null>('qty').as('net'))
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .where('itemId', '=', itemId)
    .where('useId', '=', useId)
    .executeTakeFirst();
  // Takes are negative, so what is out is the negated sum.
  return -Number(row?.net ?? 0);
}

/** An item names a category of this business, if any. An archived one still counts. */
async function requireCategoryOf(db: Db, op: SignedOperation): Promise<void> {
  const { categoryId } = payloadOf<{ categoryId: string | null }>(op);
  if (categoryId === null) return;
  const row = await db
    .selectFrom('inventoryCategories')
    .select('id')
    .where('id', '=', categoryId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirst();
  if (row === undefined) {
    throw refuse('categoryNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: INVENTORY_CATEGORY_ENTITY, entityId: categoryId },
    });
  }
}

export const itemAddedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('inventoryItems')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'itemId', issue: 'already exists' },
    });
  }
  await requireCategoryOf(db, op);
};

export const itemEditedRule: Rule = async (op, { db }) => {
  await requirePart(db, op, op.entityId);
  await requireCategoryOf(db, op);
};

/** The payload's shape is checked by its schema; what fields and format must agree on, here. */
function requireSoundCategory(op: SignedOperation): void {
  const problem = categoryProblem(payloadOf<CategoryShape>(op));
  if (problem !== null) {
    throw refuse('categoryInvalid', {
      code: 'VALIDATION_FAILED',
      details: { field: 'fields', issue: problem },
    });
  }
}

export const categoryAddedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('inventoryCategories')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'categoryId', issue: 'already exists' },
    });
  }
  requireSoundCategory(op);
};

export const categoryEditedRule: Rule = async (op, { db }) => {
  const row = await db
    .selectFrom('inventoryCategories')
    .select('id')
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirst();
  if (row === undefined) {
    throw refuse('categoryNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: INVENTORY_CATEGORY_ENTITY, entityId: op.entityId },
    });
  }
  requireSoundCategory(op);
};

export const stockCountedRule: Rule = async (op, { db }) => {
  await requireFreshMovement(db, op);
  await requirePart(db, op, payloadOf<{ itemId: string }>(op).itemId);
};

async function checkUse(
  targets: PartUseTargets,
  op: SignedOperation,
  ctx: Parameters<Rule>[1],
  action: 'take' | 'putBack',
): Promise<UsePayload> {
  const payload = payloadOf<UsePayload>(op);
  const { label } = await targets[payload.use.kind].check({
    op,
    useId: payload.use.id,
    action,
    db: ctx.db,
    holdsPermission: (userId, permissionId) => ctx.holdsPermission(userId, permissionId),
  });
  // The label is only for display, but it is signed: it must say what the use really is.
  if (label !== payload.use.label) {
    throw refuse('wrongUse', {
      code: 'VALIDATION_FAILED',
      details: { field: 'use.label', issue: `expected ${label}` },
    });
  }
  return payload;
}

export function itemTakenRule(targets: PartUseTargets): Rule {
  return async (op, ctx) => {
    await requireFreshMovement(ctx.db, op);
    const payload = payloadOf<UsePayload>(op);
    const part = await requirePart(ctx.db, op, payload.itemId);
    // A take the phone recorded before the part was archived (by phone time) still counts: the
    // part left the shelf, so refusing it would only leave the stock wrong.
    if (Number(part.archived) === 1 && Number(part.updatedAt) <= op.timestamp) {
      throw refuse('itemArchived', { details: { entityId: payload.itemId } });
    }
    await checkUse(targets, op, ctx, 'take');
  };
}

export function itemPutBackRule(targets: PartUseTargets): Rule {
  return async (op, ctx) => {
    await requireFreshMovement(ctx.db, op);
    const payload = payloadOf<UsePayload>(op);
    // An archived part can still come back: it was taken before it left the list.
    await requirePart(ctx.db, op, payload.itemId);
    await checkUse(targets, op, ctx, 'putBack');
    // Only what this use took can go back, so a put-back never invents stock.
    const out = await outOnUse(ctx.db, op, payload.itemId, payload.use.id);
    if (payload.qty > out) {
      throw refuse('moreThanTaken', {
        code: 'VALIDATION_FAILED',
        details: { field: 'qty', issue: `only ${String(out)} taken` },
      });
    }
  };
}

interface ReceivedPayload {
  readonly itemId: string;
  readonly qty: number;
  readonly source: {
    readonly kind: keyof AllStockSourceTargets;
    readonly id: string;
    readonly label: string;
  };
}

/**
 * Parts come into stock only as their source says: the receipt lists this part in this quantity,
 * and it comes in once. An archived part can still arrive (it was on the order).
 */
export function stockReceivedRule(sources: AllStockSourceTargets): Rule {
  return async (op, ctx) => {
    await requireFreshMovement(ctx.db, op);
    const payload = payloadOf<ReceivedPayload>(op);
    await requirePart(ctx.db, op, payload.itemId);
    const { label } = await sources[payload.source.kind].check({
      op,
      sourceId: payload.source.id,
      itemId: payload.itemId,
      qty: payload.qty,
      db: ctx.db,
      holdsPermission: (userId, permissionId) => ctx.holdsPermission(userId, permissionId),
    });
    if (label !== payload.source.label) {
      throw refuse('wrongSource', {
        code: 'VALIDATION_FAILED',
        details: { field: 'source.label', issue: `expected ${label}` },
      });
    }
    const already = await ctx.db
      .selectFrom('inventoryMovements')
      .select('id')
      .where('tenantId', '=', op.tenantId)
      .where('useId', '=', payload.source.id)
      .where('itemId', '=', payload.itemId)
      .where('kind', '=', 'received')
      .executeTakeFirst();
    if (already !== undefined) {
      throw refuse('alreadyRecorded', {
        code: 'VALIDATION_FAILED',
        details: { field: 'source.id', issue: 'already in stock' },
      });
    }
  };
}

/**
 * A price goes on stock that arrived in this store, for the part that arrived. The person who
 * received it may price it once, at receiving or later; anyone else, or a second price (a fix),
 * needs to see costs, so nobody overwrites a price they cannot read.
 */
export const stockCostedRule: Rule = async (op, ctx) => {
  const payload = payloadOf<{ readonly itemId: string }>(op);
  const movement = await ctx.db
    .selectFrom('inventoryMovements')
    .select(['kind', 'itemId', 'userId'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (
    movement === undefined ||
    movement.kind !== 'received' ||
    movement.itemId !== payload.itemId
  ) {
    throw refuse('notReceived', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: INVENTORY_MOVEMENT_ENTITY, entityId: op.entityId },
    });
  }
  if (await ctx.holdsPermission(op.userId, INVENTORY_PERMISSION.readCost)) return;
  // Judged where costs are held (the server, an owner's phone); a store device has none to find.
  const priced = await ctx.db
    .selectFrom('inventoryCosts')
    .select('movementId')
    .where('movementId', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirst();
  if (movement.userId !== op.userId || priced !== undefined) {
    throw refuse('costNotYours', {
      code: 'PERMISSION_DENIED',
      details: { permissionId: INVENTORY_PERMISSION.readCost, issue: 'priced by someone else' },
    });
  }
};

interface SentPayload {
  readonly itemId: string;
  readonly qty: number;
  readonly sink: { readonly kind: StockSinkKind; readonly id: string; readonly label: string };
}

/**
 * Parts leave stock only as their transfer (or settlement) says: this part, in this quantity, by
 * the same person, once. An archived part can still be sent: it was on the transfer.
 */
export const stockSentRule: Rule = async (op, ctx) => {
  await requireFreshMovement(ctx.db, op);
  const payload = payloadOf<SentPayload>(op);
  await requirePart(ctx.db, op, payload.itemId);
  const { label } = await STOCK_SINKS[payload.sink.kind].check({
    op,
    sourceId: payload.sink.id,
    itemId: payload.itemId,
    qty: payload.qty,
    db: ctx.db,
  });
  if (label !== payload.sink.label) {
    throw refuse('wrongSource', {
      code: 'VALIDATION_FAILED',
      details: { field: 'sink.label', issue: `expected ${label}` },
    });
  }
  const already = await ctx.db
    .selectFrom('inventoryMovements')
    .select('id')
    .where('tenantId', '=', op.tenantId)
    .where('useId', '=', payload.sink.id)
    .where('itemId', '=', payload.itemId)
    .where('kind', '=', 'sent')
    .executeTakeFirst();
  if (already !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'sink.id', issue: 'already sent' },
    });
  }
};

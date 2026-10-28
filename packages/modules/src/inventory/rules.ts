// The `inventory` op rules, run by the device before saving and by the server before accepting a
// push (core module/op-rules.ts). Every read is constrained to the op's tenant, and movements to the
// op's store, so an op naming another business's part or another store's stock finds nothing.
//
// Stock is allowed to go below zero (owner decision, 2026-10-28): two phones taking the last part
// offline must not block a repair. The owner sees it flagged instead.
import { defineRefusals, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { INVENTORY_ITEM_ENTITY } from './constants.js';
import type { PartUseTargets } from './part-use.js';
import type { InventoryDatabase } from './schema.js';

type Rule = OpRule<InventoryDatabase>;
type Db = Parameters<Rule>[1]['db'];

/** Every reason a stock change is refused, each with copy at `inventory.refusal.<reason>`. */
export const INVENTORY_REFUSALS = defineRefusals('inventory', [
  'alreadyRecorded',
  'itemNotFound',
  'itemArchived',
  'moreThanTaken',
  'wrongUse',
] as const);
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
};

export const itemEditedRule: Rule = async (op, { db }) => {
  await requirePart(db, op, op.entityId);
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

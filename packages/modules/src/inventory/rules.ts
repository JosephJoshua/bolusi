// The `inventory` op rules, run by the device before saving and by the server before accepting a
// push (core module/op-rules.ts). Every read is constrained to the op's tenant, and movements to the
// op's store, so an op naming another business's part or another store's stock finds nothing.
//
// Stock is allowed to go below zero (owner decision, 2026-10-28): two phones taking the last part
// offline must not block a repair. The owner sees it flagged instead.
import { defineRefusals, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { INVENTORY_PART_ENTITY } from './constants.js';
import type { PartUseTargets } from './part-use.js';
import type { InventoryDatabase } from './schema.js';

type Rule = OpRule<InventoryDatabase>;
type Db = Parameters<Rule>[1]['db'];

/** Every reason a stock change is refused, each with copy at `inventory.refusal.<reason>`. */
export const INVENTORY_REFUSALS = defineRefusals('inventory', [
  'alreadyRecorded',
  'partNotFound',
  'partArchived',
  'moreThanTaken',
  'wrongUse',
] as const);
const { refuse } = INVENTORY_REFUSALS;

interface UsePayload {
  readonly partId: string;
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

async function findPart(db: Db, op: SignedOperation, partId: string) {
  return db
    .selectFrom('inventoryParts')
    .select(['id', 'archived'])
    .where('id', '=', partId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirst();
}

async function requirePart(db: Db, op: SignedOperation, partId: string) {
  const part = await findPart(db, op, partId);
  if (part === undefined) {
    throw refuse('partNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: INVENTORY_PART_ENTITY, entityId: partId },
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
  partId: string,
  useId: string,
): Promise<number> {
  const row = await db
    .selectFrom('inventoryMovements')
    .select((eb) => eb.fn.sum<number | string | null>('qty').as('net'))
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .where('partId', '=', partId)
    .where('useId', '=', useId)
    .executeTakeFirst();
  // Takes are negative, so what is out is the negated sum.
  return -Number(row?.net ?? 0);
}

export const partAddedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('inventoryParts')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'partId', issue: 'already exists' },
    });
  }
};

export const partEditedRule: Rule = async (op, { db }) => {
  await requirePart(db, op, op.entityId);
};

export const stockCountedRule: Rule = async (op, { db }) => {
  await requireFreshMovement(db, op);
  await requirePart(db, op, payloadOf<{ partId: string }>(op).partId);
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

export function partTakenRule(targets: PartUseTargets): Rule {
  return async (op, ctx) => {
    await requireFreshMovement(ctx.db, op);
    const payload = payloadOf<UsePayload>(op);
    const part = await requirePart(ctx.db, op, payload.partId);
    if (Number(part.archived) === 1) {
      throw refuse('partArchived', { details: { entityId: payload.partId } });
    }
    await checkUse(targets, op, ctx, 'take');
  };
}

export function partPutBackRule(targets: PartUseTargets): Rule {
  return async (op, ctx) => {
    await requireFreshMovement(ctx.db, op);
    const payload = payloadOf<UsePayload>(op);
    // An archived part can still come back: it was taken before it left the list.
    await requirePart(ctx.db, op, payload.partId);
    await checkUse(targets, op, ctx, 'putBack');
    // Only what this use took can go back, so a put-back never invents stock.
    const out = await outOnUse(ctx.db, op, payload.partId, payload.use.id);
    if (payload.qty > out) {
      throw refuse('moreThanTaken', {
        code: 'VALIDATION_FAILED',
        details: { field: 'qty', issue: `only ${String(out)} taken` },
      });
    }
  };
}

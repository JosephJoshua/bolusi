// What parts cost the store on many uses at once (a month of servisan, for commission), read from
// the same movements and prices as one part's cost (queries.ts `itemCost`) and folded the same way
// (cost.ts). Takes any reader, so a rule on the server and a query on a device read alike.
import type { ReadonlyProjectionDb } from '@bolusi/core';

import { chunks } from '../shared/chunks.js';
import type { MovementKind } from './constants.js';
import { costOnUse, foldCost, type CostFold, type CostMovement } from './cost.js';
import type { InventoryDatabase } from './schema.js';

export interface CostScope {
  readonly tenantId: string;
  readonly storeId: string;
}

export interface CostedMovement extends CostMovement {
  readonly label: string | null;
  readonly useKind: string | null;
  readonly useId: string | null;
}

/** Each part's movements in this store with the prices typed for its receipts, and their fold. */
export async function costedItems(
  db: ReadonlyProjectionDb<InventoryDatabase>,
  scope: CostScope,
  itemIds: readonly string[],
): Promise<Map<string, { rows: CostedMovement[]; fold: CostFold }>> {
  const byItem = new Map<string, CostedMovement[]>();
  const prices = new Map<string, number>();
  for (const ids of chunks([...new Set(itemIds)])) {
    const costs = await db
      .selectFrom('inventoryCosts')
      .select(['movementId', 'unitCost'])
      .where('tenantId', '=', scope.tenantId)
      .where('storeId', '=', scope.storeId)
      .where('itemId', 'in', ids)
      .execute();
    for (const row of costs) prices.set(row.movementId, Number(row.unitCost));
    const movements = await db
      .selectFrom('inventoryMovements')
      .selectAll()
      .where('tenantId', '=', scope.tenantId)
      .where('storeId', '=', scope.storeId)
      .where('itemId', 'in', ids)
      .execute();
    for (const row of movements) {
      const list = byItem.get(row.itemId) ?? [];
      list.push({
        id: row.id,
        at: Number(row.at),
        kind: row.kind as MovementKind,
        qty: Number(row.qty),
        counted: row.counted === null ? null : Number(row.counted),
        unitCost: null,
        label: row.useLabel,
        useKind: row.useKind,
        useId: row.useId,
      });
      byItem.set(row.itemId, list);
    }
  }
  const out = new Map<string, { rows: CostedMovement[]; fold: CostFold }>();
  for (const itemId of new Set(itemIds)) {
    const rows = (byItem.get(itemId) ?? []).map((row) => ({
      ...row,
      unitCost: prices.get(row.id) ?? null,
    }));
    out.set(itemId, { rows, fold: foldCost(rows) });
  }
  return out;
}

/**
 * What the parts still out on each use cost the store, each at its average when taken: 0 for a use
 * that took none, null while a price it depends on is not typed yet.
 */
export async function costsOfUses(
  db: ReadonlyProjectionDb<InventoryDatabase>,
  scope: CostScope,
  useKind: string,
  useIds: readonly string[],
): Promise<Map<string, number | null>> {
  const uses = new Map<string, Set<string>>();
  for (const ids of chunks([...new Set(useIds)])) {
    const rows = await db
      .selectFrom('inventoryMovements')
      .select(['itemId', 'useId'])
      .distinct()
      .where('tenantId', '=', scope.tenantId)
      .where('storeId', '=', scope.storeId)
      .where('useKind', '=', useKind)
      .where('useId', 'in', ids)
      .execute();
    for (const row of rows) {
      const items = uses.get(row.useId!) ?? new Set<string>();
      items.add(row.itemId);
      uses.set(row.useId!, items);
    }
  }
  const items = await costedItems(
    db,
    scope,
    [...uses.values()].flatMap((set) => [...set]),
  );
  const out = new Map<string, number | null>();
  for (const useId of useIds) {
    let total: number | null = 0;
    for (const itemId of uses.get(useId) ?? []) {
      const { rows, fold } = items.get(itemId)!;
      const onUse = rows.filter((row) => row.useKind === useKind);
      const { cost } = costOnUse(onUse, fold, useId);
      total = total === null || cost === null ? null : total + cost;
    }
    out.set(useId, total);
  }
  return out;
}

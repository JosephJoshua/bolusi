// Part costs (owner decisions 2026-10-28, least-privilege sync 2026-11-01): a buy price per piece
// typed at receiving or later, a moving average cost per store worked out from the records, and
// costs travelling in their own change type that only people who may see costs read.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { foldCost, type CostMovement } from '../src/inventory/cost.js';
import { inventoryOperations } from '../src/inventory/operations.js';
import { PRESET_ROLE_ABILITIES, permissionsFor } from '../src/role-abilities.js';
import type { ItemCostRow } from '../src/inventory/queries.js';
import type { ReceiptCostRow } from '../src/purchasing/queries.js';
import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(
  seed: number,
  readHere?: (permissionId: string) => boolean,
): Promise<RepairHarness> {
  const h = await openRepairHarness(seed, undefined, readHere === undefined ? {} : { readHere });
  open.push(h);
  return h;
}

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(refusal);
}

/** A placed order for 3 LCDs (one already on the shelf from a count) and 2 batteries. */
async function placed(h: RepairHarness) {
  const { supplierId } = (await h.purchasing(
    'addSupplier',
    { name: 'Sumber Jaya', phone: null, note: null },
    h.storeOwnerId,
  )) as { supplierId: string };
  const add = async (name: string) =>
    (
      (await h.runInventory('addItem', { name, code: null, fits: [] }, h.storeOwnerId)) as {
        itemId: string;
      }
    ).itemId;
  const lcd = await add('LCD Redmi Note 10 + frame');
  const battery = await add('Baterai Redmi Note 10');
  await h.runInventory('countStock', { counts: [{ itemId: lcd, counted: 1 }] }, h.storeOwnerId);
  const { orderId } = (await h.purchasing(
    'draftOrder',
    {
      supplierId,
      note: null,
      lines: [
        { itemId: lcd, qty: 3 },
        { itemId: battery, qty: 2 },
      ],
      place: true,
    },
    h.storeOwnerId,
  )) as { orderId: string };
  return { lcd, battery, orderId };
}

async function cost(h: RepairHarness, itemId: string): Promise<ItemCostRow> {
  return (await h.queryInventory('itemCost', { itemId }, h.storeOwnerId)).rows[0] as ItemCostRow;
}

async function orderCosts(h: RepairHarness, orderId: string): Promise<ReceiptCostRow[]> {
  return (await h.purchasingQuery('orderCosts', { orderId }, h.storeOwnerId))
    .rows as ReceiptCostRow[];
}

describe('the average cost fold', () => {
  const move = (
    id: string,
    at: number,
    kind: CostMovement['kind'],
    qty: number,
    extra: Partial<CostMovement> = {},
  ): CostMovement => ({ id, at, kind, qty, counted: null, unitCost: null, ...extra });

  test('matches a hand-worked table', () => {
    // at | what                        | on hand | average
    //  1 | counted 10 (no price)       |      10 | none
    //  2 | 5 in at 100                 |      15 | 100 (first price)
    //  3 | 3 taken                     |      12 | 100
    //  4 | 4 in at 130                 |      16 | (12×100 + 4×130) ÷ 16 = 107.5 → 108
    //  5 | 2 in, no price yet          |      18 | 108, one receipt unpriced
    //  6 | counted 0                   |       0 | 108
    //  7 | 1 in at 90                  |       1 | 90 (nothing on hand to mix with)
    const fold = foldCost([
      move('g', 7, 'received', 1, { unitCost: 90 }),
      move('a', 1, 'counted', 10, { counted: 10 }),
      move('b', 2, 'received', 5, { unitCost: 100 }),
      move('c', 3, 'taken', -3),
      move('d', 4, 'received', 4, { unitCost: 130 }),
      move('e', 5, 'received', 2),
      move('f', 6, 'counted', -18, { counted: 0 }),
    ]);
    expect(fold.average).toBe(90);
    expect(fold.unpriced).toBe(1);
    expect(fold.at.get('a')).toBeNull();
    expect(fold.at.get('c')).toBe(100);
    expect(fold.at.get('d')).toBe(108);
    expect(fold.at.get('f')).toBe(108);
  });

  test('stock below zero takes the next price as it is; ties keep id order', () => {
    const fold = foldCost([
      move('b', 1, 'received', 2, { unitCost: 50_000 }),
      move('a', 1, 'taken', -1),
      move('c', 2, 'taken', -4),
      move('d', 3, 'received', 3, { unitCost: 70_000 }),
    ]);
    // a (take) runs before b at the same time: nothing priced yet.
    expect(fold.at.get('a')).toBeNull();
    // -1 + 2 - 4 = -3 on hand, so the next price stands alone.
    expect(fold.average).toBe(70_000);
  });

  test('rounds half up once per receipt, in whole rupiah', () => {
    const fold = foldCost([
      move('a', 1, 'received', 2, { unitCost: 10_001 }),
      move('b', 2, 'received', 1, { unitCost: 10_000 }),
    ]);
    // (2 × 10.001 + 10.000) ÷ 3 = 10.000,67 → 10.001
    expect(fold.average).toBe(10_001);
  });
});

describe('buy prices at receiving', () => {
  test('a price per piece goes with what arrived, and the average follows it', async () => {
    const h = await harness(7301);
    const { lcd, battery, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      {
        orderId,
        lines: [
          { itemId: lcd, qty: 2, unitCost: 185_000 },
          { itemId: battery, qty: 2 },
        ],
      },
      h.storeOwnerId,
    );
    const priced = await orderCosts(h, orderId);
    expect(priced.map((row) => [row.itemId, row.qty, row.unitCost])).toEqual([
      [lcd, 2, 185_000],
      [battery, 2, null],
    ]);
    // The one counted before had no price, so the first price is the average.
    expect(await cost(h, lcd)).toMatchObject({ average: 185_000, unpriced: 0 });
    expect(await cost(h, battery)).toMatchObject({ average: null, unpriced: 1 });

    // Filled in later from the supplier's nota.
    const movementId = priced[1]!.movementId;
    await h.runInventory('priceStock', { movementId, unitCost: 60_000 }, h.storeOwnerId);
    expect(await cost(h, battery)).toMatchObject({ average: 60_000, unpriced: 0 });

    // A second delivery mixes in: (3 × 185.000 + 1 × 205.000) ÷ 4 = 190.000.
    await h.purchasing(
      'receiveOrder',
      { orderId, lines: [{ itemId: lcd, qty: 1, unitCost: 205_000 }] },
      h.storeOwnerId,
    );
    const lcdCost = await cost(h, lcd);
    expect(lcdCost.average).toBe(190_000);
    expect(lcdCost.receipts.map((row) => row.unitCost)).toEqual([205_000, 185_000]);
  });

  test('prices travel apart from quantities, read only with Lihat harga beli', async () => {
    const h = await harness(7302);
    const { lcd, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      { orderId, lines: [{ itemId: lcd, qty: 3, unitCost: 185_000 }] },
      h.storeOwnerId,
    );
    const ops = await h.ownOps();
    const received = ops.find((op) => op.type === 'purchasing.order_received')!;
    const stock = ops.find((op) => op.type === 'inventory.stock_received')!;
    const priced = ops.find((op) => op.type === 'inventory.stock_costed')!;
    expect(JSON.stringify(received.payload)).not.toContain('185000');
    expect(JSON.stringify(stock.payload)).not.toContain('185000');
    expect(priced).toMatchObject({
      entityType: 'inventory_cost',
      entityId: stock.entityId,
      payload: { itemId: lcd, unitCost: 185_000 },
    });
    const declared = inventoryOperations({} as never, {} as never);
    expect(declared['inventory.stock_costed']!.read).toBe('inventory.read_cost');
    expect(declared['inventory.stock_received']!.read).toBe('inventory.read');
  });

  test('a fix replaces the price; a price on anything but a delivery is refused', async () => {
    const h = await harness(7303);
    const { lcd, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      { orderId, lines: [{ itemId: lcd, qty: 3, unitCost: 1_850_000 }] },
      h.storeOwnerId,
    );
    const movementId = (await orderCosts(h, orderId))[0]!.movementId;
    await h.runInventory('priceStock', { movementId, unitCost: 185_000 }, h.ownerId);
    expect((await cost(h, lcd)).average).toBe(185_000);

    const count = (await h.ownOps()).find((op) => op.type === 'inventory.stock_counted')!;
    await expectRefused(
      h.runInventory('priceStock', { movementId: count.entityId, unitCost: 1 }, h.ownerId),
      'VALIDATION_FAILED',
    );
    const priced = (await h.ownOps()).find((op) => op.type === 'inventory.stock_costed')!;
    await expectRefused(
      h.checkRule({ ...priced, entityId: count.entityId } as SignedOperation),
      'ENTITY_NOT_FOUND',
      'inventory.refusal.notReceived',
    );
  });

  test('without Lihat harga beli, only the receiver prices it, and only once', async () => {
    const h = await harness(7304);
    const { lcd, battery, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      {
        orderId,
        lines: [
          { itemId: lcd, qty: 3, unitCost: 185_000 },
          { itemId: battery, qty: 2 },
        ],
      },
      h.storeOwnerId,
    );
    const priced = (await h.ownOps()).find((op) => op.type === 'inventory.stock_costed')!;
    const seesNoCosts = { holdsPermission: () => Promise.resolve(false) };
    const ok = () => Promise.resolve(true);
    // Someone else, even before anyone priced it.
    const battMove = (await orderCosts(h, orderId)).find((row) => row.itemId === battery)!;
    const forBattery = {
      ...priced,
      entityId: battMove.movementId,
      payload: { itemId: battery, unitCost: 60_000 },
    } as SignedOperation;
    await expectRefused(
      h.checkRule({ ...forBattery, userId: h.cashierId }, ok, seesNoCosts),
      'PERMISSION_DENIED',
      'inventory.refusal.costNotYours',
    );
    // The receiver, the first time: fine.
    await expect(h.checkRule(forBattery, ok, seesNoCosts)).resolves.toBeUndefined();
    // A second price over one they cannot read: refused.
    await expectRefused(
      h.checkRule(priced, ok, seesNoCosts),
      'PERMISSION_DENIED',
      'inventory.refusal.costNotYours',
    );
  });
});

describe('who sees costs', () => {
  test('without Lihat harga beli there is no cost to read', async () => {
    const h = await harness(7305);
    const { lcd, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      { orderId, lines: [{ itemId: lcd, qty: 3, unitCost: 185_000 }] },
      h.storeOwnerId,
    );
    await expectRefused(
      h.queryInventory('itemCost', { itemId: lcd }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await expectRefused(
      h.purchasingQuery('orderCosts', { orderId }, h.cashierId),
      'PERMISSION_DENIED',
    );
  });

  test('on a device without costs, the cost says it needs internet, never Rp 0', async () => {
    let costsHere = true;
    const h = await harness(7306, (read) => read !== 'inventory.read_cost' || costsHere);
    const { lcd, orderId } = await placed(h);
    costsHere = false;
    await expect(
      h.queryInventory('itemCost', { itemId: lcd }, h.storeOwnerId),
    ).rejects.toMatchObject({ code: 'NOT_ON_DEVICE' });
    await expect(orderCosts(h, orderId)).rejects.toMatchObject({ code: 'NOT_ON_DEVICE' });
    // The order itself still opens: its prices are read apart.
    const detail = await h.purchasingQuery('getOrder', { orderId }, h.storeOwnerId);
    expect(detail.rows).toHaveLength(1);
  });

  test('no staff preset holds it, so store devices start without costs', () => {
    for (const abilities of Object.values(PRESET_ROLE_ABILITIES)) {
      expect(permissionsFor(new Set(abilities))).not.toContain('inventory.read_cost');
    }
  });
});

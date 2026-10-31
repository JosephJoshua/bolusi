// Buying parts through the real runtime (owner decisions 2026-10-28): suppliers once for the
// business, orders per store going Draft, then Dipesan, then received in one or more deliveries,
// the stock each delivery brings in, the order sent to the supplier as WhatsApp text, and two
// phones receiving one order offline.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';
import type { SignedOperation } from '@bolusi/schemas';

import enCatalog from '../purchasing/i18n/en.json' with { type: 'json' };
import idCatalog from '../purchasing/i18n/id.json' with { type: 'json' };
import { registerPurchasingCatalog } from '../src/purchasing/i18n.js';
import {
  orderMessage,
  orderMessageUrl,
  orderStage,
  type OrderDetailRow,
} from '../src/purchasing/index.js';
import { loadOrderPages, type PurchasingRuntime } from '../src/purchasing/runtime.js';
import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerPurchasingCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
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

async function addItem(h: RepairHarness, name: string, stock = 0): Promise<string> {
  const { itemId } = (await h.runInventory(
    'addItem',
    { name, code: null, fits: [] },
    h.storeOwnerId,
  )) as { itemId: string };
  if (stock > 0) {
    await h.runInventory('countStock', { counts: [{ itemId, counted: stock }] }, h.storeOwnerId);
  }
  return itemId;
}

async function addSupplier(h: RepairHarness, name = 'Sumber Jaya', phone = '0812 3456 7890') {
  return (
    (await h.purchasing('addSupplier', { name, phone, note: null }, h.storeOwnerId)) as {
      supplierId: string;
    }
  ).supplierId;
}

async function onHand(h: RepairHarness, itemId: string): Promise<number> {
  return (await h.queryInventory('getItem', { itemId }, h.ownerId)).rows[0].onHand as number;
}

async function order(h: RepairHarness, orderId: string): Promise<OrderDetailRow> {
  return (await h.purchasingQuery('getOrder', { orderId }, h.storeOwnerId))
    .rows[0] as OrderDetailRow;
}

/** A supplier, two parts and a placed order for 3 LCDs and 2 batteries. */
async function placed(h: RepairHarness) {
  const supplierId = await addSupplier(h);
  const lcd = await addItem(h, 'LCD Redmi Note 10 + frame', 1);
  const battery = await addItem(h, 'Baterai Redmi Note 10');
  const { orderId, orderNumber } = (await h.purchasing(
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
  )) as { orderId: string; orderNumber: string };
  return { supplierId, lcd, battery, orderId, orderNumber };
}

describe('suppliers', () => {
  test('one list for the business; the same name twice is refused', async () => {
    const h = await harness(7101);
    await addSupplier(h, 'Sumber Jaya');
    await expectRefused(addSupplier(h, ' sumber jaya '), 'VALIDATION_FAILED');
    const rows = (await h.purchasingQuery('listSuppliers', {}, h.ownerId)).rows;
    expect(rows.map((row) => row.name)).toEqual(['Sumber Jaya']);
  });

  test('staff without "Belanja sparepart" can neither see nor add suppliers', async () => {
    const h = await harness(7102);
    await expectRefused(
      h.purchasing('addSupplier', { name: 'Toko A', phone: null, note: null }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await expectRefused(h.purchasingQuery('listSuppliers', {}, h.cashierId), 'PERMISSION_DENIED');
  });
});

describe('an order from draft to received', () => {
  test('a draft is numbered by this device, edited freely, then placed and fixed', async () => {
    const h = await harness(7103);
    const supplierId = await addSupplier(h);
    const lcd = await addItem(h, 'LCD A');
    const battery = await addItem(h, 'Baterai A');
    const { orderId, orderNumber } = (await h.purchasing(
      'draftOrder',
      { supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    )) as { orderId: string; orderNumber: string };
    expect(orderNumber).toMatch(/^PO-[0-9A-Z]{3}-0001$/);
    expect((await order(h, orderId)).stage).toBe('draft');

    await h.purchasing(
      'editOrder',
      {
        orderId,
        supplierId,
        note: 'Yang original',
        lines: [
          { itemId: lcd, qty: 2 },
          { itemId: battery, qty: 1 },
        ],
        place: true,
      },
      h.storeOwnerId,
    );
    const placedOrder = await order(h, orderId);
    expect(placedOrder.stage).toBe('ordered');
    expect(placedOrder.lines.map((line) => [line.name, line.qty])).toEqual([
      ['LCD A', 2],
      ['Baterai A', 1],
    ]);

    // Dipesan: the supplier has the list, so it no longer changes.
    await expectRefused(
      h.purchasing(
        'editOrder',
        { orderId, supplierId, note: null, lines: [{ itemId: lcd, qty: 5 }] },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    const next = (await h.purchasing(
      'draftOrder',
      { supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    )) as { orderNumber: string };
    expect(next.orderNumber).toBe(orderNumber.replace(/0001$/, '0002'));
  });

  test('the server refuses an edit to a placed order, whatever the phone sends', async () => {
    const h = await harness(7104);
    const { orderId, lcd, supplierId } = await placed(h);
    const edit = {
      ...((await h.ownOps()).find(
        (op) => op.type === 'purchasing.order_drafted',
      ) as SignedOperation),
      type: 'purchasing.order_edited',
      entityId: orderId,
      payload: { supplierId, note: null, lines: [{ itemId: lcd, name: 'LCD', qty: 9 }] },
    } as unknown as SignedOperation;
    await expectRefused(h.checkRule(edit), 'INVALID_TRANSITION', 'purchasing.refusal.notDraft');
  });

  test('a delivery in two parts: stock rises with each, and the order reads as it fills', async () => {
    const h = await harness(7105);
    const { lcd, battery, orderId, orderNumber } = await placed(h);

    await h.purchasing(
      'receiveOrder',
      {
        orderId,
        lines: [
          { itemId: lcd, qty: 2 },
          { itemId: battery, qty: 0 },
        ],
      },
      h.storeOwnerId,
    );
    expect(await onHand(h, lcd)).toBe(3);
    expect(await onHand(h, battery)).toBe(0);
    let current = await order(h, orderId);
    expect(current.stage).toBe('partial');
    expect(current.lines.map((line) => line.received)).toEqual([2, 0]);

    await h.purchasing(
      'receiveOrder',
      {
        orderId,
        lines: [
          { itemId: lcd, qty: 1 },
          { itemId: battery, qty: 2 },
        ],
      },
      h.storeOwnerId,
    );
    current = await order(h, orderId);
    expect(current.stage).toBe('received');
    expect(current.receipts).toHaveLength(2);
    expect(await onHand(h, lcd)).toBe(4);
    expect(await onHand(h, battery)).toBe(2);

    // The stock history says where the parts came from.
    const item = (await h.queryInventory('getItem', { itemId: battery }, h.ownerId)).rows[0];
    expect(item.movements[0]).toMatchObject({ kind: 'received', qty: 2, useLabel: orderNumber });

    // Done orders leave the open list.
    const openOrders = (await h.purchasingQuery('listOrders', {}, h.storeOwnerId)).rows;
    expect(openOrders).toHaveLength(0);
    const done = (await h.purchasingQuery('listOrders', { filter: 'done' }, h.storeOwnerId)).rows;
    expect(done.map((row) => row.id)).toEqual([orderId]);
  });

  test('a draft cannot be received, nor a part that is not on the order', async () => {
    const h = await harness(7106);
    const supplierId = await addSupplier(h);
    const lcd = await addItem(h, 'LCD');
    const other = await addItem(h, 'Kamera');
    const { orderId } = (await h.purchasing(
      'draftOrder',
      { supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    )) as { orderId: string };
    await expectRefused(
      h.purchasing('receiveOrder', { orderId, lines: [{ itemId: lcd, qty: 1 }] }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
    await h.purchasing(
      'editOrder',
      { orderId, supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }], place: true },
      h.storeOwnerId,
    );
    await expectRefused(
      h.purchasing('receiveOrder', { orderId, lines: [{ itemId: other, qty: 1 }] }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
  });

  test('cancelling after part arrived keeps what came and closes the rest', async () => {
    const h = await harness(7107);
    const { lcd, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      { orderId, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    );
    await h.purchasing('cancelOrder', { orderId, reason: 'Stok supplier habis' }, h.storeOwnerId);
    const current = await order(h, orderId);
    expect(current.stage).toBe('cancelled');
    expect(current.cancelReason).toBe('Stok supplier habis');
    expect(await onHand(h, lcd)).toBe(2);
    await expectRefused(
      h.purchasing('receiveOrder', { orderId, lines: [{ itemId: lcd, qty: 1 }] }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
  });
});

describe('the stock a receipt brings in', () => {
  async function receivedOps(h: RepairHarness) {
    const { lcd, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      { orderId, lines: [{ itemId: lcd, qty: 2 }] },
      h.storeOwnerId,
    );
    const ops = await h.ownOps();
    const stock = ops.filter((op) => op.type === 'inventory.stock_received').at(-1)!;
    return { stock, lcd };
  }

  test('a second movement for the same receipt and part is refused', async () => {
    const h = await harness(7108);
    const { stock } = await receivedOps(h);
    const again = { ...stock, entityId: '01900000-0000-7000-8000-000000000001' };
    await expectRefused(
      h.checkRule(again),
      'VALIDATION_FAILED',
      'inventory.refusal.alreadyRecorded',
    );
  });

  test('more than the receipt lists is refused, so stock cannot be invented', async () => {
    const h = await harness(7109);
    const { stock } = await receivedOps(h);
    const inflated = {
      ...stock,
      entityId: '01900000-0000-7000-8000-000000000002',
      payload: { ...(stock.payload as object), qty: 20 },
    } as SignedOperation;
    await expectRefused(
      h.checkRule(inflated),
      'VALIDATION_FAILED',
      'purchasing.refusal.receiptMismatch',
    );
  });

  test('another person cannot bring in stock against someone else’s receipt', async () => {
    const h = await harness(7110);
    const { stock } = await receivedOps(h);
    const someoneElse = {
      ...stock,
      entityId: '01900000-0000-7000-8000-000000000003',
      userId: h.cashierId,
    } as SignedOperation;
    await expectRefused(
      h.checkRule(someoneElse),
      'VALIDATION_FAILED',
      'purchasing.refusal.receiptMismatch',
    );
  });
});

describe('two phones receiving one order offline', () => {
  test('both count it in full: stock takes both, and the order reads "Diterima lebih"', async () => {
    const early = await harness(7111);
    const { lcd, battery, orderId } = await placed(early);
    const late = await openRepairHarness(7112, {
      tenantId: early.tenantId,
      storeId: early.storeId,
      users: [
        early.cashierId,
        early.technicianId,
        early.technician2Id,
        early.zeroUserId,
        early.ownerId,
        early.storeOwnerId,
      ],
    });
    open.push(late);
    let arrival = 1;
    for (const op of await early.ownOps()) await late.deliverPulled(op, arrival++);
    const synced = new Set((await early.ownOps()).map((op) => op.id));

    const full = {
      orderId,
      lines: [
        { itemId: lcd, qty: 3 },
        { itemId: battery, qty: 2 },
      ],
    };
    await early.purchasing('receiveOrder', full, early.storeOwnerId);
    await late.purchasing('receiveOrder', full, late.storeOwnerId);
    for (const op of await early.ownOps()) {
      if (!synced.has(op.id)) await late.deliverPulled(op, arrival++);
    }
    for (const op of await late.ownOps()) {
      if (!synced.has(op.id)) await early.deliverPulled(op, 1000 + arrival++);
    }

    for (const phone of [early, late]) {
      expect(await onHand(phone, lcd)).toBe(7);
      const current = await order(phone, orderId);
      expect(current.stage).toBe('over');
      expect(current.receipts).toHaveLength(2);
    }
  });
});

describe('the order on WhatsApp', () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({
    itemId: `item-${String(i)}`,
    name: `LCD Samsung Galaxy A${String(i + 10)} + frame`,
    qty: (i % 3) + 1,
    received: 0,
  }));
  const long = {
    orderNumber: 'PO-K7Q-0012',
    supplierName: 'Sumber Jaya',
    supplierPhone: '0812-3456-7890',
    note: 'Kirim sebelum Sabtu',
    lines,
  };

  test('a long order lists every part with its quantity, the note and the store, no prices', () => {
    const text = orderMessage(long, 'Bolusi Sorong');
    const rows = text.split('\n');
    expect(rows[0]).toBe('Halo Sumber Jaya, kami mau pesan:');
    expect(rows[1]).toBe('1. LCD Samsung Galaxy A10 + frame: 1 pcs');
    expect(rows[40]).toBe('40. LCD Samsung Galaxy A49 + frame: 1 pcs');
    expect(text).toContain('Catatan: Kirim sebelum Sabtu');
    expect(rows.at(-1)).toBe('Bolusi Sorong (PO-K7Q-0012)');
    expect(text).not.toMatch(/Rp/);
  });

  test('opens WhatsApp on the supplier’s number, or nothing without one', () => {
    const url = orderMessageUrl(long, null)!;
    expect(url.startsWith('https://wa.me/6281234567890?text=')).toBe(true);
    expect(decodeURIComponent(url.split('?text=')[1]!)).toBe(orderMessage(long, null));
    expect(orderMessageUrl({ ...long, supplierPhone: null }, null)).toBeNull();
  });
});

describe('review round 1 (2026-10-31)', () => {
  test('a line that came over does not close an order with another still to come', () => {
    expect(
      orderStage('ordered', [
        { qty: 5, received: 6 },
        { qty: 5, received: 0 },
      ]),
    ).toBe('partial');
    expect(
      orderStage('ordered', [
        { qty: 5, received: 6 },
        { qty: 5, received: 5 },
      ]),
    ).toBe('over');
  });

  test('an order that came in full cannot be cancelled, on the phone or the server', async () => {
    const h = await harness(7120);
    const { lcd, battery, orderId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      {
        orderId,
        lines: [
          { itemId: lcd, qty: 4 },
          { itemId: battery, qty: 2 },
        ],
      },
      h.storeOwnerId,
    );
    expect((await order(h, orderId)).stage).toBe('over');
    await expectRefused(
      h.purchasing('cancelOrder', { orderId, reason: null }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
    const placedOp = (await h.ownOps()).find((op) => op.type === 'purchasing.order_placed')!;
    const cancel = {
      ...placedOp,
      type: 'purchasing.order_cancelled',
      payload: { reason: null },
    } as unknown as SignedOperation;
    await expectRefused(
      h.checkRule(cancel),
      'INVALID_TRANSITION',
      'purchasing.refusal.nothingToCancel',
    );
    expect((await order(h, orderId)).stage).toBe('over');
  });

  test('an order number is the drafting device’s own, used once', async () => {
    const h = await harness(7121);
    await placed(h);
    const drafted = (await h.ownOps()).find((op) => op.type === 'purchasing.order_drafted')!;
    const payload = drafted.payload as { orderNumber: string };
    const code = payload.orderNumber.slice(3, 6);
    const otherCode = code === 'ZZZ' ? 'YYY' : 'ZZZ';
    const fresh = (orderNumber: string, n: number) =>
      ({
        ...drafted,
        entityId: `01900000-0000-7000-8000-00000000010${String(n)}`,
        payload: { ...payload, orderNumber },
      }) as SignedOperation;
    await expectRefused(
      h.checkRule(fresh(`PO-${otherCode}-0009`, 1)),
      'VALIDATION_FAILED',
      'purchasing.refusal.numberNotThisDevice',
    );
    await expectRefused(
      h.checkRule(fresh(payload.orderNumber, 2)),
      'VALIDATION_FAILED',
      'purchasing.refusal.numberUsed',
    );
  });

  test('a draft that was never placed takes no delivery, however the phone dates it', async () => {
    const h = await harness(7122);
    const { orderId: placedId, lcd, supplierId } = await placed(h);
    await h.purchasing(
      'receiveOrder',
      { orderId: placedId, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    );
    const { orderId: draftId } = (await h.purchasing(
      'draftOrder',
      { supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    )) as { orderId: string };
    await h.purchasing('cancelOrder', { orderId: draftId, reason: null }, h.storeOwnerId);
    const received = (await h.ownOps()).find((op) => op.type === 'purchasing.order_received')!;
    const backdated = {
      ...received,
      entityId: '01900000-0000-7000-8000-000000000201',
      timestamp: 1,
      payload: { ...(received.payload as object), orderId: draftId },
    } as SignedOperation;
    await expectRefused(
      h.checkRule(backdated),
      'INVALID_TRANSITION',
      'purchasing.refusal.notOrdered',
    );
  });

  test('a draft is not placed with a supplier archived since it was written', async () => {
    const h = await harness(7123);
    const supplierId = await addSupplier(h);
    const lcd = await addItem(h, 'LCD Redmi Note 10 + frame');
    const draft = { supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }] };
    const { orderId } = (await h.purchasing('draftOrder', draft, h.storeOwnerId)) as {
      orderId: string;
    };
    await h.purchasing(
      'editSupplier',
      { supplierId, name: 'Sumber Jaya', phone: null, note: null, archived: true },
      h.storeOwnerId,
    );
    await expectRefused(
      h.purchasing('editOrder', { orderId, ...draft, place: true }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
  });
});

describe('review round 2 (2026-10-31)', () => {
  test('placing a draft whose part was archived since says which kind of problem it is', async () => {
    const h = await harness(7124);
    const supplierId = await addSupplier(h);
    const lcd = await addItem(h, 'LCD Redmi Note 10 + frame');
    const draft = { supplierId, note: null, lines: [{ itemId: lcd, qty: 1 }] };
    const { orderId } = (await h.purchasing('draftOrder', draft, h.storeOwnerId)) as {
      orderId: string;
    };
    await h.runInventory(
      'editItem',
      { itemId: lcd, name: 'LCD Redmi Note 10 + frame', code: null, fits: [], archived: true },
      h.storeOwnerId,
    );
    await expectRefused(
      h.purchasing('editOrder', { orderId, ...draft, place: true }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'purchasing.refusal.partArchived',
    );
  });

  test('order numbers keep counting past the highest this device has', async () => {
    const h = await harness(7125);
    const first = await placed(h);
    const second = (await h.purchasing(
      'draftOrder',
      { supplierId: first.supplierId, note: null, lines: [{ itemId: first.lcd, qty: 1 }] },
      h.storeOwnerId,
    )) as { orderNumber: string };
    const counter = (n: string) => Number(n.slice(7));
    expect(counter(second.orderNumber)).toBe(counter(first.orderNumber) + 1);
    expect(second.orderNumber.slice(0, 7)).toBe(first.orderNumber.slice(0, 7));
  });

  test('the order list pages past the query’s page cap', async () => {
    const pages = [
      { rows: [{ id: 'a' }, { id: 'b' }], nextCursor: '2' },
      { rows: [{ id: 'c' }], nextCursor: null },
    ];
    const asked: unknown[] = [];
    const rt = {
      query: (_name: string, input: unknown) => {
        asked.push(input);
        return Promise.resolve(pages[asked.length - 1]);
      },
    } as unknown as PurchasingRuntime;
    const loaded = await loadOrderPages(rt, 'done', 5, 2);
    expect(loaded.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(loaded.hasMore).toBe(false);
    expect(asked).toEqual([
      { filter: 'done', limit: 2, offset: 0 },
      { filter: 'done', limit: 2, offset: 2 },
    ]);
  });
});

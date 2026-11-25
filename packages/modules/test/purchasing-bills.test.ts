// Supplier bills ("Tagihan supplier", transfers-bills-returns.md): an owner records a supplier's
// nota against an order or on its own, corrects it or voids it. Each part's price is the bill's;
// how it compares with what was ordered and what arrived is read, never refused. Store staff
// without "Tagihan supplier" never see a bill, even when they buy.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';
import type { SignedOperation } from '@bolusi/schemas';

import enCatalog from '../purchasing/i18n/en.json' with { type: 'json' };
import idCatalog from '../purchasing/i18n/id.json' with { type: 'json' };
import {
  billLineCheck,
  type BillDetailRow,
  type BillRow,
} from '../src/purchasing/bills/queries.js';
import { billCheckKey, billDraftOf } from '../src/purchasing/bills/bill-form.js';
import { registerPurchasingCatalog } from '../src/purchasing/i18n.js';
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

const DAY = 86_400_000;
const BILLED_ON = Date.UTC(2026, 10, 20);

async function addItem(h: RepairHarness, name: string): Promise<string> {
  return (
    (await h.runInventory('addItem', { name, code: null, fits: [] }, h.storeOwnerId)) as {
      itemId: string;
    }
  ).itemId;
}

async function addSupplier(h: RepairHarness, name = 'Sumber Jaya'): Promise<string> {
  return (
    (await h.purchasing('addSupplier', { name, phone: null, note: null }, h.storeOwnerId)) as {
      supplierId: string;
    }
  ).supplierId;
}

/** A placed order for 3 LCDs and 2 batteries, of which 2 LCDs have arrived. */
async function partlyArrived(h: RepairHarness) {
  const supplierId = await addSupplier(h);
  const lcd = await addItem(h, 'LCD Redmi Note 10');
  const battery = await addItem(h, 'Baterai Redmi Note 10');
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
  await h.purchasing('receiveOrder', { orderId, lines: [{ itemId: lcd, qty: 2 }] }, h.storeOwnerId);
  return { supplierId, lcd, battery, orderId };
}

async function bill(h: RepairHarness, billId: string): Promise<BillDetailRow> {
  return (await h.purchasingQuery('getBill', { billId }, h.storeOwnerId)).rows[0] as BillDetailRow;
}

describe('recording a bill', () => {
  test('against an order: numbered here, totalled, and compared with what arrived', async () => {
    const h = await harness(7301);
    const { supplierId, lcd, battery, orderId } = await partlyArrived(h);
    const { billId, billNumber } = (await h.purchasing(
      'recordBill',
      {
        supplierId,
        orderId,
        supplierRef: ' INV-889 ',
        billedOn: BILLED_ON,
        dueOn: BILLED_ON + 14 * DAY,
        charges: 25_000,
        note: null,
        lines: [
          { itemId: lcd, qty: 3, unitPrice: 350_000 },
          { itemId: battery, qty: 2, unitPrice: 120_000 },
        ],
      },
      h.ownerId,
    )) as { billId: string; billNumber: string };
    expect(billNumber).toMatch(/^TG-[0-9A-Z]{3}-0001$/);

    const row = await bill(h, billId);
    expect(row).toMatchObject({
      billNumber,
      supplierName: 'Sumber Jaya',
      supplierRef: 'INV-889',
      status: 'open',
      charges: 25_000,
      total: 3 * 350_000 + 2 * 120_000 + 25_000,
    });
    expect(row.lines.map((line) => [line.name, line.ordered, line.received])).toEqual([
      ['LCD Redmi Note 10', 3, 2],
      ['Baterai Redmi Note 10', 2, 0],
    ]);
    // Billed ahead of the parts: shown for the owner to check, not refused.
    expect(row.lines.map(billLineCheck)).toEqual([
      { kind: 'notArrived', count: 1 },
      { kind: 'notArrived', count: 2 },
    ]);
  });

  test('without an order, paid at once: no due date and nothing to compare', async () => {
    const h = await harness(7302);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    const { billId } = (await h.purchasing(
      'recordBill',
      {
        supplierId,
        billedOn: BILLED_ON,
        lines: [{ itemId: glass, qty: 10, unitPrice: 5_000 }],
      },
      h.storeOwnerId,
    )) as { billId: string };
    const row = await bill(h, billId);
    expect(row).toMatchObject({ orderId: null, dueOn: null, charges: 0, total: 50_000 });
    expect(row.lines.map(billLineCheck)).toEqual([null]);
  });

  test('the first and last days the form takes are saved in any time zone', async () => {
    const h = await harness(7310);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    // 1 January 2020 starts at 15:00 UTC the day before in WIT (UTC+9), the screens' local day.
    const firstDay = Date.UTC(2019, 11, 31, 15);
    const { billId } = (await h.purchasing(
      'recordBill',
      {
        supplierId,
        billedOn: firstDay,
        lines: [{ itemId: glass, qty: 1, unitPrice: 5_000 }],
      },
      h.storeOwnerId,
    )) as { billId: string };
    expect((await bill(h, billId)).billedOn).toBe(firstDay);
    // A nota of 31 December 2099 due a year later, in a time zone west of UTC.
    const lastDay = Date.UTC(2099, 11, 31, 10);
    await expect(
      h.purchasing(
        'recordBill',
        {
          supplierId,
          supplierRef: 'LAST',
          billedOn: lastDay,
          dueOn: lastDay + 365 * DAY,
          lines: [{ itemId: glass, qty: 1, unitPrice: 5_000 }],
        },
        h.storeOwnerId,
      ),
    ).resolves.toBeDefined();
  });

  test('a part billed on two bills of one order counts against what arrived once', async () => {
    const h = await harness(7303);
    const { supplierId, lcd, orderId } = await partlyArrived(h);
    const record = (qty: number) =>
      h.purchasing(
        'recordBill',
        { supplierId, orderId, billedOn: BILLED_ON, lines: [{ itemId: lcd, qty, unitPrice: 1 }] },
        h.ownerId,
      ) as Promise<{ billId: string }>;
    await record(2);
    const { billId } = await record(1);
    expect(billLineCheck((await bill(h, billId)).lines[0]!)).toEqual({
      kind: 'notArrived',
      count: 1,
    });
  });

  test('a part never ordered is flagged', async () => {
    const h = await harness(7304);
    const { supplierId, orderId } = await partlyArrived(h);
    const other = await addItem(h, 'Konektor cas');
    const { billId } = (await h.purchasing(
      'recordBill',
      {
        supplierId,
        orderId,
        billedOn: BILLED_ON,
        lines: [{ itemId: other, qty: 1, unitPrice: 15_000 }],
      },
      h.ownerId,
    )) as { billId: string };
    expect(billLineCheck((await bill(h, billId)).lines[0]!)).toEqual({ kind: 'notOrdered' });
  });

  test('the same supplier nota twice, a due date before the bill, or a part twice is refused', async () => {
    const h = await harness(7305);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    const input = {
      supplierId,
      supplierRef: 'INV-1',
      billedOn: BILLED_ON,
      lines: [{ itemId: glass, qty: 1, unitPrice: 5_000 }],
    };
    await h.purchasing('recordBill', input, h.ownerId);
    await expectRefused(
      h.purchasing('recordBill', { ...input, supplierRef: 'inv-1' }, h.ownerId),
      'VALIDATION_FAILED',
    );
    // Another supplier may print the same number.
    const other = await addSupplier(h, 'Mitra Sel');
    await h.purchasing('recordBill', { ...input, supplierId: other }, h.ownerId);
    await expectRefused(
      h.purchasing(
        'recordBill',
        { ...input, supplierRef: null, dueOn: BILLED_ON - DAY },
        h.ownerId,
      ),
      'VALIDATION_FAILED',
    );
    await expectRefused(
      h.purchasing(
        'recordBill',
        {
          ...input,
          supplierRef: null,
          lines: [input.lines[0]!, input.lines[0]!],
        },
        h.ownerId,
      ),
      'VALIDATION_FAILED',
    );
  });
});

describe('who sees bills', () => {
  test('staff without "Tagihan supplier" can neither record nor read one', async () => {
    const h = await harness(7306);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    const input = {
      supplierId,
      billedOn: BILLED_ON,
      lines: [{ itemId: glass, qty: 1, unitPrice: 5_000 }],
    };
    await expectRefused(h.purchasing('recordBill', input, h.managerId), 'PERMISSION_DENIED');
    await expectRefused(h.purchasingQuery('listBills', {}, h.managerId), 'PERMISSION_DENIED');
    await expectRefused(h.purchasingQuery('listBills', {}, h.cashierId), 'PERMISSION_DENIED');
  });
});

describe('the server rules', () => {
  test('an order from another supplier, a draft, or an unknown supplier is refused', async () => {
    const h = await harness(7307);
    const { lcd, orderId } = await partlyArrived(h);
    const other = await addSupplier(h, 'Mitra Sel');
    await h.purchasing(
      'recordBill',
      {
        supplierId: other,
        billedOn: BILLED_ON,
        lines: [{ itemId: lcd, qty: 1, unitPrice: 1 }],
      },
      h.ownerId,
    );
    const recorded = (await h.ownOps()).find((op) => op.type === 'purchasing.bill_recorded')!;
    const payload = recorded.payload as Record<string, unknown>;
    const forged = (n: number, change: Record<string, unknown>) =>
      ({
        ...recorded,
        entityId: `01900000-0000-7000-8000-00000000020${String(n)}`,
        payload: {
          ...payload,
          billNumber: `${String(payload.billNumber).slice(0, 7)}000${String(n)}`,
          ...change,
        },
      }) as SignedOperation;
    await expectRefused(
      h.checkRule(forged(2, { orderId })),
      'VALIDATION_FAILED',
      'purchasing.refusal.orderOtherSupplier',
    );
    await expectRefused(
      h.checkRule(forged(3, { supplierId: '01900000-0000-7000-8000-0000000002ff' })),
      'ENTITY_NOT_FOUND',
      'purchasing.refusal.supplierNotFound',
    );

    const { orderId: draftId } = (await h.purchasing(
      'draftOrder',
      { supplierId: other, note: null, lines: [{ itemId: lcd, qty: 1 }] },
      h.storeOwnerId,
    )) as { orderId: string };
    await expectRefused(
      h.checkRule(forged(4, { orderId: draftId })),
      'INVALID_TRANSITION',
      'purchasing.refusal.orderNotPlaced',
    );
  });

  test('a bill number is the recording device’s own, used once', async () => {
    const h = await harness(7308);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    await h.purchasing(
      'recordBill',
      { supplierId, billedOn: BILLED_ON, lines: [{ itemId: glass, qty: 1, unitPrice: 1 }] },
      h.ownerId,
    );
    const recorded = (await h.ownOps()).find((op) => op.type === 'purchasing.bill_recorded')!;
    const payload = recorded.payload as { billNumber: string };
    const code = payload.billNumber.slice(3, 6);
    const otherCode = code === 'ZZZ' ? 'YYY' : 'ZZZ';
    const fresh = (billNumber: string, n: number) =>
      ({
        ...recorded,
        entityId: `01900000-0000-7000-8000-00000000030${String(n)}`,
        payload: { ...payload, billNumber },
      }) as SignedOperation;
    await expectRefused(
      h.checkRule(fresh(`TG-${otherCode}-0009`, 1)),
      'VALIDATION_FAILED',
      'purchasing.refusal.billNumberNotThisDevice',
    );
    await expectRefused(
      h.checkRule(fresh(payload.billNumber, 2)),
      'VALIDATION_FAILED',
      'purchasing.refusal.billNumberUsed',
    );
  });
});

describe('correcting and voiding', () => {
  test('an edit replaces the lines; a void keeps the bill in the history, closed', async () => {
    const h = await harness(7309);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    const lens = await addItem(h, 'Lensa kamera');
    const { billId } = (await h.purchasing(
      'recordBill',
      { supplierId, billedOn: BILLED_ON, lines: [{ itemId: glass, qty: 10, unitPrice: 5_000 }] },
      h.ownerId,
    )) as { billId: string };
    const details = {
      billId,
      supplierId,
      billedOn: BILLED_ON,
      lines: [{ itemId: glass, qty: 10, unitPrice: 5_000 }],
    };
    await expectRefused(h.purchasing('editBill', details, h.ownerId), 'VALIDATION_FAILED');
    await h.purchasing(
      'editBill',
      {
        ...details,
        charges: 10_000,
        lines: [
          { itemId: lens, qty: 1, unitPrice: 40_000 },
          { itemId: glass, qty: 8, unitPrice: 5_000 },
        ],
      },
      h.ownerId,
    );
    let row = await bill(h, billId);
    // Corrected in the form, the prices read as they are typed: grouped.
    expect(billDraftOf(row, Date.now()).lines.every((line) => !/\d{4}/.test(line.price))).toBe(
      true,
    );
    expect(row.lines.map((line) => [line.name, line.qty])).toEqual([
      ['Lensa kamera', 1],
      ['Tempered glass', 8],
    ]);
    expect(row.total).toBe(40_000 + 40_000 + 10_000);

    await h.purchasing('voidBill', { billId, reason: 'Salah supplier' }, h.ownerId);
    row = await bill(h, billId);
    expect(row).toMatchObject({ status: 'void', voidReason: 'Salah supplier' });
    expect(row.voidedAt).not.toBeNull();
    const openBills = (await h.purchasingQuery('listBills', {}, h.ownerId)).rows as BillRow[];
    expect(openBills).toHaveLength(0);
    const all = (await h.purchasingQuery('listBills', { filter: 'all' }, h.ownerId))
      .rows as BillRow[];
    expect(all.map((one) => one.id)).toEqual([billId]);

    await expectRefused(h.purchasing('editBill', details, h.ownerId), 'VALIDATION_FAILED');
    const voided = (await h.ownOps()).find((op) => op.type === 'purchasing.bill_voided')!;
    await expectRefused(
      h.checkRule({ ...voided, id: '01900000-0000-7000-8000-0000000004aa' } as SignedOperation),
      'INVALID_TRANSITION',
      'purchasing.refusal.billVoid',
    );
  });

  test('open bills list the soonest due first, those without a due date last', async () => {
    const h = await harness(7310);
    const supplierId = await addSupplier(h);
    const glass = await addItem(h, 'Tempered glass');
    const record = async (supplierRef: string, dueOn: number | null) =>
      h.purchasing(
        'recordBill',
        {
          supplierId,
          supplierRef,
          billedOn: BILLED_ON,
          dueOn,
          lines: [{ itemId: glass, qty: 1, unitPrice: 1 }],
        },
        h.ownerId,
      );
    await record('A', null);
    await record('B', BILLED_ON + 30 * DAY);
    await record('C', BILLED_ON + 7 * DAY);
    const rows = (await h.purchasingQuery('listBills', {}, h.ownerId)).rows as BillRow[];
    expect(rows.map((row) => row.supplierRef)).toEqual(['C', 'B', 'A']);
  });
});

describe('the check a bill asks for', () => {
  const line = (qty: number, ordered: number | null, received: number | null) => ({
    qty,
    ordered,
    received,
    billedElsewhere: 0,
  });
  test('names only what is off: not arrived, not ordered, or both', () => {
    expect(billCheckKey([line(2, 2, 2)])).toBeNull();
    expect(billCheckKey([line(2, null, null)])).toBeNull();
    expect(billCheckKey([line(3, 3, 1)])).toBe('purchasing.bill.checkArrived');
    expect(billCheckKey([line(1, null, 0), line(2, 2, 2)])).toBe('purchasing.bill.checkOrdered');
    expect(billCheckKey([line(3, 3, 1), line(1, null, 0)])).toBe('purchasing.bill.checkBoth');
  });
});

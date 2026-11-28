/**
 * A `PurchasingRuntime` over in-memory demo orders for the browser preview, built by the repair
 * demo so a delivery received here lands on the same demo shelf the parts list shows. Uses the
 * module's own pure pieces (stage, still to come, the order message) and mirrors the commands'
 * checks closely enough that a reviewer sees the same flow and refusals.
 */
import { DomainError } from '@bolusi/core';

import { INVENTORY_PERMISSION } from '../inventory/constants.js';
import type { DemoInventoryRuntime } from '../inventory/demo.js';
import { PURCHASING_PERMISSION, type BillStatus, type OrderStatus } from './constants.js';
import { billTotal, type BillDetailRow, type BillRow } from './bills/queries.js';
import {
  orderStage,
  type OrderDetailRow,
  type OrderLineRow,
  type OrderRow,
  type ReceiptCostRow,
  type ReceiptRow,
  type SupplierRow,
} from './queries.js';
import type { PurchasingRuntime } from './runtime.js';

export interface DemoPurchasingOptions {
  readonly now: number;
  readonly actor: () => {
    readonly userId: string;
    readonly name: string;
    readonly permissions: readonly string[];
  };
  readonly inventory: DemoInventoryRuntime;
  readonly storeName: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly notify: () => void;
}

interface DemoOrder {
  id: string;
  orderNumber: string;
  supplierId: string;
  status: OrderStatus;
  note: string | null;
  createdBy: string;
  createdAt: number;
  orderedAt: number | null;
  cancelledAt: number | null;
  lines: { itemId: string; name: string; qty: number }[];
}

interface DemoBill {
  id: string;
  billNumber: string;
  supplierId: string;
  orderId: string | null;
  supplierRef: string | null;
  billedOn: number;
  dueOn: number | null;
  charges: number;
  note: string | null;
  status: BillStatus;
  createdAt: number;
  voidedAt: number | null;
  voidReason: string | null;
  lines: { itemId: string; name: string; qty: number; unitPrice: number }[];
}

type Input = Record<string, unknown>;
type Line = { itemId: string; qty: number; unitCost?: number | null };

const DAY = 86_400_000;

export function demoPurchasingRuntime(options: DemoPurchasingOptions): PurchasingRuntime {
  const { now, actor, inventory } = options;
  let ids = 0;
  // The preview's time is pinned, so what happens here is dated from it, a minute apart.
  let ticks = 0;
  const clock = (): number => now + (ticks += 1) * 60_000;
  const newId = (prefix: string): string => `${prefix}-${String((ids += 1))}`;
  const suppliers: SupplierRow[] = [
    {
      id: 'sup-1',
      name: 'Sumber Jaya Sparepart',
      phone: '0812 4455 6677',
      note: null,
      archived: false,
    },
    {
      id: 'sup-2',
      name: 'Mitra Ponsel Jayapura',
      phone: '0821 9988 1122',
      note: 'Kirim lewat kapal, 3 hari',
      archived: false,
    },
    { id: 'sup-3', name: 'Toko Abadi', phone: null, note: null, archived: false },
  ];
  const orders: DemoOrder[] = [];
  type DemoReceiptLine = ReceiptRow['lines'][number] & { movementId: string };
  const receipts: (Omit<ReceiptRow, 'lines'> & {
    orderId: string;
    lines: DemoReceiptLine[];
  })[] = [];
  let counter = 0;
  const nextNumber = (): string => `PO-W4M-${String((counter += 1)).padStart(4, '0')}`;

  const bills: DemoBill[] = [];
  let billCounter = 0;
  const nextBillNumber = (): string => `TG-W4M-${String((billCounter += 1)).padStart(4, '0')}`;

  const itemName = async (itemId: string): Promise<string> =>
    (await inventory.query('getItem', { itemId })).rows[0]?.name ?? itemId;

  const linesOf = (order: DemoOrder): OrderLineRow[] =>
    order.lines.map((line) => ({
      ...line,
      received: receipts
        .filter((receipt) => receipt.orderId === order.id)
        .flatMap((receipt) => receipt.lines)
        .filter((got) => got.itemId === line.itemId)
        .reduce((sum, got) => sum + got.qty, 0),
    }));
  const row = (order: DemoOrder): OrderRow => {
    const lines = linesOf(order);
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      supplierId: order.supplierId,
      supplierName: suppliers.find((s) => s.id === order.supplierId)?.name ?? '',
      status: order.status,
      stage: orderStage(order.status, lines),
      lineCount: lines.length,
      orderedQty: lines.reduce((sum, line) => sum + line.qty, 0),
      receivedQty: lines.reduce((sum, line) => sum + line.received, 0),
      createdAt: order.createdAt,
      orderedAt: order.orderedAt,
    };
  };
  const detail = (order: DemoOrder): OrderDetailRow => ({
    ...row(order),
    supplierPhone: suppliers.find((s) => s.id === order.supplierId)?.phone ?? null,
    note: order.note,
    createdBy: order.createdBy,
    createdByName: actor().name,
    cancelledAt: order.cancelledAt,
    cancelReason: null,
    lines: linesOf(order),
    receipts: receipts
      .filter((r) => r.orderId === order.id)
      .sort((a, b) => b.at - a.at)
      .map((receipt) => ({
        ...receipt,
        lines: receipt.lines.map(({ itemId, name, qty }) => ({ itemId, name, qty })),
      })),
  });
  const find = (orderId: unknown): DemoOrder => {
    const order = orders.find((o) => o.id === orderId);
    if (order === undefined)
      throw new DomainError('ENTITY_NOT_FOUND', { entityId: String(orderId) });
    return order;
  };
  const invalid = (field: string, issue: string) =>
    new DomainError('VALIDATION_FAILED', { field, issue });
  const named = async (lines: readonly Line[]) =>
    Promise.all(lines.map(async (line) => ({ ...line, name: await itemName(line.itemId) })));

  const billRow = (bill: DemoBill): BillRow => ({
    id: bill.id,
    billNumber: bill.billNumber,
    supplierId: bill.supplierId,
    supplierName: suppliers.find((s) => s.id === bill.supplierId)?.name ?? '',
    supplierRef: bill.supplierRef,
    orderId: bill.orderId,
    orderNumber: orders.find((o) => o.id === bill.orderId)?.orderNumber ?? null,
    billedOn: bill.billedOn,
    dueOn: bill.dueOn,
    status: bill.status,
    total: billTotal(bill.lines, bill.charges),
  });
  const billDetail = (bill: DemoBill): BillDetailRow => {
    const order = orders.find((o) => o.id === bill.orderId);
    const onOrder = order === undefined ? undefined : linesOf(order);
    return {
      ...billRow(bill),
      charges: bill.charges,
      note: bill.note,
      createdBy: actor().userId,
      createdByName: actor().name,
      createdAt: bill.createdAt,
      voidedAt: bill.voidedAt,
      voidedByName: bill.voidedAt === null ? null : actor().name,
      voidReason: bill.voidReason,
      lines: bill.lines.map((line) => {
        const ordered = onOrder?.find((one) => one.itemId === line.itemId);
        return {
          itemId: line.itemId,
          name: line.name,
          qty: line.qty,
          unitPrice: line.unitPrice,
          amount: line.qty * line.unitPrice,
          ordered: onOrder === undefined ? null : (ordered?.qty ?? null),
          received: onOrder === undefined ? null : (ordered?.received ?? 0),
          billedElsewhere: bills
            .filter((b) => b.id !== bill.id && b.status === 'open' && b.orderId === bill.orderId)
            .flatMap((b) => b.lines)
            .filter((l) => l.itemId === line.itemId)
            .reduce((sum, l) => sum + l.qty, 0),
        };
      }),
    };
  };
  const findBill = (billId: unknown): DemoBill => {
    const bill = bills.find((b) => b.id === billId);
    if (bill === undefined) throw new DomainError('ENTITY_NOT_FOUND', { entityId: String(billId) });
    if (bill.status === 'void') throw invalid('billId', 'bill is void');
    return bill;
  };
  /** The bill's details as the commands take them, each part named as the list names it. */
  const billFields = async (input: Input) => {
    const ref = typeof input['supplierRef'] === 'string' ? input['supplierRef'].trim() : '';
    const dueOn = (input['dueOn'] as number | null | undefined) ?? null;
    if (dueOn !== null && dueOn < Number(input['billedOn'])) {
      throw invalid('dueOn', 'due before the bill date');
    }
    return {
      supplierId: String(input['supplierId']),
      orderId: (input['orderId'] as string | null | undefined) ?? null,
      supplierRef: ref === '' ? null : ref,
      billedOn: Number(input['billedOn']),
      dueOn,
      charges: Number(input['charges'] ?? 0),
      note: (input['note'] as string | null | undefined) ?? null,
      lines: await Promise.all(
        (input['lines'] as { itemId: string; qty: number; unitPrice: number }[]).map(
          async (line) => ({ ...line, name: await itemName(line.itemId) }),
        ),
      ),
    };
  };
  const notaTwice = (
    fields: { supplierId: string; supplierRef: string | null },
    id: string | null,
  ) =>
    fields.supplierRef !== null &&
    bills.some(
      (b) =>
        b.id !== id &&
        b.status === 'open' &&
        b.supplierId === fields.supplierId &&
        b.supplierRef?.toLowerCase() === fields.supplierRef?.toLowerCase(),
    );

  const receive = (
    order: DemoOrder,
    lines: readonly Line[],
    at: number,
    note: string | null,
  ): string => {
    const id = newId('rcpt');
    receipts.push({
      id,
      orderId: order.id,
      at,
      userId: actor().userId,
      userName: actor().name,
      note,
      lines: lines.map((line) => ({
        itemId: line.itemId,
        qty: line.qty,
        name: order.lines.find((l) => l.itemId === line.itemId)?.name ?? '',
        movementId: inventory.receiveDemoStock(
          line.itemId,
          line.qty,
          { id, label: order.orderNumber },
          line.unitCost ?? null,
          at,
        ),
      })),
    });
    return id;
  };

  const queries: Record<string, (input: Input) => Promise<unknown>> = {
    listSuppliers: (input) =>
      Promise.resolve({
        rows: suppliers
          .filter((s) => input['includeArchived'] === true || !s.archived)
          .sort((a, b) => a.name.localeCompare(b.name, 'id')),
        nextCursor: null,
      }),
    listOrders: (input) => {
      const open = (input['filter'] ?? 'open') === 'open';
      const rows = orders
        .map(row)
        .filter((o) => ['draft', 'ordered', 'partial'].includes(o.stage) === open)
        .sort((a, b) => b.createdAt - a.createdAt);
      return Promise.resolve({ rows, nextCursor: null });
    },
    listBills: (input) => {
      const rows = bills
        .filter((b) => input['filter'] !== 'open' || b.status === 'open')
        .filter(
          (b) =>
            input['orderId'] === undefined ||
            input['orderId'] === null ||
            b.orderId === input['orderId'],
        )
        .sort((a, b) => b.billedOn - a.billedOn || b.createdAt - a.createdAt)
        .map(billRow);
      return Promise.resolve({ rows, nextCursor: null });
    },
    getBill: (input) => {
      const bill = bills.find((b) => b.id === input['billId']);
      return Promise.resolve({
        rows: bill === undefined ? [] : [billDetail(bill)],
        nextCursor: null,
      });
    },
    orderCosts: (input) => {
      if (!actor().permissions.includes(INVENTORY_PERMISSION.readCost)) {
        throw new DomainError('PERMISSION_DENIED', {});
      }
      const rows: ReceiptCostRow[] = receipts
        .filter((r) => r.orderId === input['orderId'])
        .sort((a, b) => b.at - a.at)
        .flatMap((receipt) =>
          receipt.lines.map((line) => ({
            receiptId: receipt.id,
            at: receipt.at,
            movementId: line.movementId,
            itemId: line.itemId,
            name: line.name,
            qty: line.qty,
            unitCost: inventory.demoCostOf(line.movementId),
          })),
        );
      return Promise.resolve({ rows, nextCursor: null });
    },
    getOrder: (input) => {
      const order = orders.find((o) => o.id === input['orderId']);
      return Promise.resolve({
        rows: order === undefined ? [] : [detail(order)],
        nextCursor: null,
      });
    },
  };

  const commands: Record<string, (input: Input) => Promise<unknown>> = {
    addSupplier: (input) => {
      const name = String(input['name']).trim();
      if (suppliers.some((s) => !s.archived && s.name.toLowerCase() === name.toLowerCase())) {
        throw invalid('name', 'already on the list');
      }
      const id = newId('sup');
      suppliers.push({
        id,
        name,
        phone: (input['phone'] as string | null) ?? null,
        note: (input['note'] as string | null) ?? null,
        archived: false,
      });
      return Promise.resolve({ supplierId: id });
    },
    editSupplier: (input) => {
      const supplier = suppliers.find((s) => s.id === input['supplierId']);
      if (supplier === undefined) throw new DomainError('ENTITY_NOT_FOUND', {});
      Object.assign(supplier, {
        name: String(input['name']).trim(),
        phone: input['phone'] ?? null,
        note: input['note'] ?? null,
        archived: input['archived'] === true,
      });
      return Promise.resolve({ supplierId: supplier.id });
    },
    draftOrder: async (input) => {
      const id = newId('po');
      const order: DemoOrder = {
        id,
        orderNumber: nextNumber(),
        supplierId: String(input['supplierId']),
        status: input['place'] === true ? 'ordered' : 'draft',
        note: (input['note'] as string | null) ?? null,
        createdBy: actor().userId,
        createdAt: clock(),
        orderedAt: input['place'] === true ? clock() : null,
        cancelledAt: null,
        lines: await named(input['lines'] as Line[]),
      };
      orders.push(order);
      return { orderId: id, orderNumber: order.orderNumber };
    },
    editOrder: async (input) => {
      const order = find(input['orderId']);
      if (order.status !== 'draft') throw invalid('orderId', `order is ${order.status}`);
      order.supplierId = String(input['supplierId']);
      order.note = (input['note'] as string | null) ?? null;
      order.lines = await named(input['lines'] as Line[]);
      if (input['place'] === true) {
        order.status = 'ordered';
        order.orderedAt = clock();
      }
      return { orderId: order.id };
    },
    cancelOrder: (input) => {
      const order = find(input['orderId']);
      order.status = 'cancelled';
      order.cancelledAt = clock();
      return Promise.resolve({ orderId: order.id });
    },
    recordBill: async (input) => {
      const fields = await billFields(input);
      if (notaTwice(fields, null)) throw invalid('supplierRef', 'already recorded');
      const bill: DemoBill = {
        id: newId('bill'),
        billNumber: nextBillNumber(),
        ...fields,
        status: 'open',
        createdAt: clock(),
        voidedAt: null,
        voidReason: null,
      };
      bills.push(bill);
      return { billId: bill.id, billNumber: bill.billNumber };
    },
    editBill: async (input) => {
      const bill = findBill(input['billId']);
      const fields = await billFields(input);
      if (notaTwice(fields, bill.id)) throw invalid('supplierRef', 'already recorded');
      Object.assign(bill, fields);
      return { billId: bill.id };
    },
    voidBill: (input) => {
      const bill = findBill(input['billId']);
      bill.status = 'void';
      bill.voidedAt = clock();
      bill.voidReason = String(input['reason']).trim();
      return Promise.resolve({ billId: bill.id });
    },
    receiveOrder: (input) => {
      const order = find(input['orderId']);
      if (order.status !== 'ordered') throw invalid('orderId', `order is ${order.status}`);
      const lines = (input['lines'] as Line[]).filter((line) => line.qty > 0);
      if (lines.length === 0) throw invalid('lines', 'nothing arrived');
      return Promise.resolve({
        receiptId: receive(order, lines, clock(), (input['note'] as string | null) ?? null),
      });
    },
  };

  // Seeds: a delivery half in, one placed this morning, a draft, and one done last week.
  const seeded = (async () => {
    const parts = (await inventory.query('listItems', { limit: 6 })).rows;
    const pick = (i: number) => parts[i % Math.max(1, parts.length)]!;
    if (parts.length === 0) return;
    const make = async (
      supplierId: string,
      lines: readonly [number, number][],
      status: OrderStatus,
      daysAgo: number,
      note: string | null = null,
    ): Promise<DemoOrder> => {
      const order: DemoOrder = {
        id: newId('po'),
        orderNumber: nextNumber(),
        supplierId,
        status,
        note,
        createdBy: actor().userId,
        createdAt: now - daysAgo * DAY,
        orderedAt: status === 'draft' ? null : now - daysAgo * DAY + 3_600_000,
        cancelledAt: null,
        lines: lines.map(([i, qty]) => ({ itemId: pick(i).id, name: pick(i).name, qty })),
      };
      orders.push(order);
      return order;
    };
    const done = await make(
      'sup-2',
      [
        [3, 2],
        [4, 5],
      ],
      'ordered',
      8,
    );
    receive(
      done,
      done.lines.map((line, i) => ({ ...line, unitCost: i === 0 ? 185_000 : 45_000 })),
      now - 5 * DAY,
      null,
    );
    const half = await make(
      'sup-1',
      [
        [0, 3],
        [1, 2],
        [2, 4],
      ],
      'ordered',
      3,
      'Yang original, jangan KW',
    );
    receive(
      half,
      [
        { itemId: half.lines[0]!.itemId, qty: 3, unitCost: 320_000 },
        { itemId: half.lines[2]!.itemId, qty: 1 },
      ],
      now - DAY,
      null,
    );
    await make('sup-1', [[5, 2]], 'ordered', 0);
    // Bills: the done order's nota on 30 days, the half-in order billed in full ahead of its
    // parts, a cash buy with no order, and one entered twice and voided.
    const day = (daysAgo: number): number => {
      const date = new Date(now - daysAgo * DAY);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    };
    const bill = (
      fields: Omit<
        DemoBill,
        'id' | 'billNumber' | 'createdAt' | 'voidedAt' | 'voidReason' | 'status'
      >,
      status: BillStatus = 'open',
    ): void => {
      bills.push({
        id: newId('bill'),
        billNumber: nextBillNumber(),
        ...fields,
        status,
        createdAt: fields.billedOn + 10 * 3_600_000,
        voidedAt: status === 'void' ? fields.billedOn + 11 * 3_600_000 : null,
        voidReason: status === 'void' ? 'Nota dicatat dua kali' : null,
      });
    };
    const priced = (order: DemoOrder, prices: readonly number[]) =>
      order.lines.map((line, i) => ({ ...line, unitPrice: prices[i] ?? 0 }));
    bill({
      supplierId: done.supplierId,
      orderId: done.id,
      supplierRef: 'INV/MP/2611',
      billedOn: day(5),
      dueOn: day(5) + 30 * DAY,
      charges: 45_000,
      note: null,
      lines: priced(done, [185_000, 65_000]),
    });
    bill({
      supplierId: half.supplierId,
      orderId: half.id,
      supplierRef: 'SJ-0912',
      billedOn: day(2),
      dueOn: day(2) + 14 * DAY,
      charges: 0,
      note: 'Nota datang duluan',
      lines: priced(half, [350_000, 120_000, 25_000]),
    });
    bill({
      supplierId: 'sup-3',
      orderId: null,
      supplierRef: null,
      billedOn: day(1),
      dueOn: null,
      charges: 0,
      note: null,
      lines: [{ itemId: pick(2).id, name: pick(2).name, qty: 10, unitPrice: 15_000 }],
    });
    bill(
      {
        supplierId: done.supplierId,
        orderId: done.id,
        supplierRef: 'INV/MP/2611-B',
        billedOn: day(5),
        dueOn: null,
        charges: 0,
        note: null,
        lines: priced(done, [185_000, 65_000]),
      },
      'void',
    );
    await make(
      'sup-3',
      [
        [1, 1],
        [3, 1],
      ],
      'draft',
      0,
    );
    options.notify();
  })();

  const runtime = {
    get userId() {
      return actor().userId;
    },
    query: async (name: string, input: Input) => {
      await seeded;
      const reads = ['listBills', 'getBill'].includes(name)
        ? PURCHASING_PERMISSION.bills
        : PURCHASING_PERMISSION.buy;
      if (!actor().permissions.includes(reads)) {
        throw new DomainError('PERMISSION_DENIED', {});
      }
      return queries[name]!(input);
    },
    run: async (name: string, input: Input) => {
      await seeded;
      const result = await commands[name]!(input);
      options.notify();
      return result;
    },
    hasPermission: (id: string) => actor().permissions.includes(id),
    colleagueHasPermission: () => false,
    limitOf: () => null,
    newId: () => newId('new'),
    subscribe: options.subscribe,
    storeName: () => Promise.resolve(options.storeName),
  };
  return runtime as unknown as PurchasingRuntime;
}

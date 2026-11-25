// What the bill form holds, on the phone and the PC alike: the same lines and prices, the same
// payment terms, the same checks before saving and the same input to the commands. Pure.
import { formatDate } from '@bolusi/i18n';

import { parseRupiah } from '../../shared/rupiah.js';
import { MAX_BILL_CHARGES, MAX_LINE_QTY, MAX_ORDER_LINES, MAX_UNIT_PRICE } from '../constants.js';
import { tp, type PurchasingKey } from '../i18n.js';
import type { OrderDetailRow, OrderFilter } from '../queries.js';
import { billLineCheck, billTotal, type BillDetailRow, type BillLineRow } from './queries.js';

/** Belanja's lists: the running orders, the done ones, and (for whoever reads them) the bills. */
export type BelanjaTab = OrderFilter | 'bills';

export interface BillDraftLine {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
  /** The price per piece as typed ("350.000"). */
  readonly price: string;
}

/** Days to pay after the nota's date, as suppliers give them; 0 is paid at once. */
export const BILL_TERMS = [0, 7, 14, 30] as const;
export type BillTerm = (typeof BILL_TERMS)[number] | 'other';

/** The nota's date: today, yesterday, or one typed as dd/mm/yyyy. */
export type BilledDay = 'today' | 'yesterday' | 'other';

export interface BillDraft {
  readonly supplierId: string | null;
  /** The order it bills; its supplier is the bill's. */
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly supplierRef: string;
  readonly billedDay: BilledDay;
  /** The typed date when `billedDay` is `other`. */
  readonly billedText: string;
  readonly term: BillTerm;
  /** Days typed when `term` is `other`. */
  readonly termDays: string;
  readonly charges: string;
  readonly note: string;
  readonly lines: readonly BillDraftLine[];
}

export const EMPTY_BILL: BillDraft = {
  supplierId: null,
  orderId: null,
  orderNumber: null,
  supplierRef: '',
  billedDay: 'today',
  billedText: '',
  term: 0,
  termDays: '',
  charges: '',
  note: '',
  lines: [],
};

const DAY_MS = 86_400_000;

/** The start of `ms`'s day on this device, which is how a bill's days are recorded. */
export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `days` after a day's start, still a day's start across a clock change. */
function addDays(day: number, days: number): number {
  const date = new Date(day);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "20/11/2026" as typed, to the start of that day; null when it is not a real date. */
export function parseDay(text: string): number | null {
  const match = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$/.exec(text);
  if (match === null) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return year < 2020 || year > 2099 ? null : date.getTime();
}

/** The nota's date the draft says, or null while a typed one is not a date. */
export function billedOnOf(draft: BillDraft, now: number): number | null {
  switch (draft.billedDay) {
    case 'today':
      return startOfDay(now);
    case 'yesterday':
      return addDays(startOfDay(now), -1);
    case 'other':
      return parseDay(draft.billedText);
  }
}

const MAX_TERM_DAYS = 365;

/** The days to pay the draft says, or null while typed ones are missing or past a year. */
export function termDaysOf(draft: BillDraft): number | null {
  if (draft.term !== 'other') return draft.term;
  const digits = draft.termDays.replace(/\D/g, '');
  if (digits === '') return null;
  const days = Number(digits);
  return days >= 1 && days <= MAX_TERM_DAYS ? days : null;
}

/** When it must be paid: null with no terms, or while the date or the days are not complete. */
export function dueOnOf(draft: BillDraft, now: number): number | null {
  const billedOn = billedOnOf(draft, now);
  const days = termDaysOf(draft);
  if (billedOn === null || days === null || days === 0) return null;
  return addDays(billedOn, days);
}

/** A bill opened against an order: its supplier, and each part at what arrived, or was ordered. */
export function billDraftFromOrder(order: OrderDetailRow): BillDraft {
  return {
    ...EMPTY_BILL,
    supplierId: order.supplierId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    lines: order.lines.map((line) => ({
      itemId: line.itemId,
      name: line.name,
      qty: line.received > 0 ? line.received : line.qty,
      price: '',
    })),
  };
}

/** A bill as the form opens it to correct. */
export function billDraftOf(bill: BillDetailRow, now: number): BillDraft {
  const today = startOfDay(now);
  const days =
    bill.dueOn === null ? 0 : Math.round((startOfDay(bill.dueOn) - bill.billedOn) / DAY_MS);
  const term: BillTerm = (BILL_TERMS as readonly number[]).includes(days)
    ? (days as BillTerm)
    : 'other';
  const billedDay: BilledDay =
    bill.billedOn === today
      ? 'today'
      : bill.billedOn === addDays(today, -1)
        ? 'yesterday'
        : 'other';
  return {
    supplierId: bill.supplierId,
    orderId: bill.orderId,
    orderNumber: bill.orderNumber,
    supplierRef: bill.supplierRef ?? '',
    billedDay,
    billedText: billedDay === 'other' ? formatDate(bill.billedOn) : '',
    term,
    termDays: term === 'other' ? String(days) : '',
    charges: bill.charges === 0 ? '' : String(bill.charges),
    note: bill.note ?? '',
    lines: bill.lines.map((line) => ({
      itemId: line.itemId,
      name: line.name,
      qty: line.qty,
      price: String(line.unitPrice),
    })),
  };
}

const clampQty = (qty: number): number => Math.min(MAX_LINE_QTY, Math.max(1, Math.round(qty)));

/** A part added; one already on the bill gets one more instead of a second line. */
export function addBillLine(draft: BillDraft, item: { id: string; name: string }): BillDraft {
  const at = draft.lines.findIndex((line) => line.itemId === item.id);
  if (at >= 0) return setBillLine(draft, item.id, { qty: draft.lines[at]!.qty + 1 });
  if (draft.lines.length >= MAX_ORDER_LINES) return draft;
  return {
    ...draft,
    lines: [...draft.lines, { itemId: item.id, name: item.name, qty: 1, price: '' }],
  };
}

export function setBillLine(
  draft: BillDraft,
  itemId: string,
  change: { readonly qty?: number; readonly price?: string },
): BillDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) =>
      line.itemId !== itemId
        ? line
        : {
            ...line,
            ...(change.qty === undefined ? {} : { qty: clampQty(change.qty) }),
            ...(change.price === undefined ? {} : { price: change.price }),
          },
    ),
  };
}

export function removeBillLine(draft: BillDraft, itemId: string): BillDraft {
  return { ...draft, lines: draft.lines.filter((line) => line.itemId !== itemId) };
}

/** A line's price per piece, or null while it is not typed. 0 is a part given free. */
export const linePrice = (line: Pick<BillDraftLine, 'price'>): number | null =>
  parseRupiah(line.price, MAX_UNIT_PRICE);

export const chargesOf = (draft: Pick<BillDraft, 'charges'>): number =>
  parseRupiah(draft.charges, MAX_BILL_CHARGES) ?? 0;

/** The total so far: every priced line and the charges. */
export function draftTotal(draft: BillDraft): number {
  return billTotal(
    draft.lines.map((line) => ({ qty: line.qty, unitPrice: linePrice(line) ?? 0 })),
    chargesOf(draft),
  );
}

/** What the draft still needs before it can be saved, first thing first; null when complete. */
export function billGap(draft: BillDraft, now: number): PurchasingKey | null {
  if (draft.supplierId === null) return 'purchasing.bill.gap.supplier';
  if (draft.lines.length === 0) return 'purchasing.bill.gap.lines';
  if (draft.lines.some((line) => linePrice(line) === null)) return 'purchasing.bill.gap.price';
  if (billedOnOf(draft, now) === null) return 'purchasing.bill.gap.date';
  if (termDaysOf(draft) === null) return 'purchasing.bill.gap.days';
  return null;
}

/** The command input for a complete draft (`recordBill`, or `editBill` with the bill's id). */
export function billInput(draft: BillDraft, now: number) {
  const trimmed = (text: string) => (text.trim() === '' ? null : text.trim());
  return {
    supplierId: draft.supplierId ?? '',
    orderId: draft.orderId,
    supplierRef: trimmed(draft.supplierRef),
    billedOn: billedOnOf(draft, now) ?? startOfDay(now),
    dueOn: dueOnOf(draft, now),
    charges: chargesOf(draft),
    note: trimmed(draft.note),
    lines: draft.lines.map((line) => ({
      itemId: line.itemId,
      qty: line.qty,
      unitPrice: linePrice(line) ?? 0,
    })),
  };
}

/** Whether the form holds anything a back press would lose. */
export function billDraftChanged(draft: BillDraft, from: BillDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(from);
}

// ── reading a bill ─────────────────────────────────────────────────────────────────────────────

/** "Jatuh tempo 04/12/2026", or "Tanpa tempo". */
export function dueText(bill: { readonly dueOn: number | null }): string {
  return bill.dueOn === null
    ? tp('purchasing.bill.noDue')
    : tp('purchasing.bill.due', { date: formatDate(bill.dueOn) });
}

/** "Nota INV-889 · 20/11/2026": the supplier's number when it has one, and the nota's date. */
export function notaText(bill: {
  readonly supplierRef: string | null;
  readonly billedOn: number;
}): string {
  const date = formatDate(bill.billedOn);
  return bill.supplierRef === null
    ? tp('purchasing.bill.notaDate', { date })
    : tp('purchasing.bill.nota', { ref: bill.supplierRef, date });
}

/** What a billed part needs checked against its order, or null when it matches. */
export function billLineHint(
  line: Pick<BillLineRow, 'qty' | 'ordered' | 'received' | 'billedElsewhere'>,
): string | null {
  const check = billLineCheck(line);
  if (check === null) return null;
  return check.kind === 'notOrdered'
    ? tp('purchasing.bill.notOrdered')
    : tp('purchasing.bill.notArrived', { count: check.count });
}

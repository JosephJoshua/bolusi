// What the order and receive forms hold, on the phone and the PC alike: the same lines, the same
// checks before saving, the same input to the commands. Platform-free and pure.
import { MAX_LINE_QTY, MAX_ORDER_LINES, type OrderStage } from './constants.js';
import { stillToCome, type OrderDetailRow } from './queries.js';

export interface DraftLine {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
}

export interface OrderDraft {
  readonly supplierId: string | null;
  readonly note: string;
  readonly lines: readonly DraftLine[];
}

export const EMPTY_ORDER: OrderDraft = { supplierId: null, note: '', lines: [] };

/** A draft order as the form opens it, to finish or change. */
export function draftOf(order: OrderDetailRow): OrderDraft {
  return {
    supplierId: order.supplierId,
    note: order.note ?? '',
    lines: order.lines.map((line) => ({ itemId: line.itemId, name: line.name, qty: line.qty })),
  };
}

const clampQty = (qty: number): number => Math.min(MAX_LINE_QTY, Math.max(1, Math.round(qty)));

/** A part added; one already on the order gets one more instead of a second line. */
export function addLine(draft: OrderDraft, item: { id: string; name: string }): OrderDraft {
  const at = draft.lines.findIndex((line) => line.itemId === item.id);
  if (at >= 0) return setQty(draft, item.id, draft.lines[at]!.qty + 1);
  if (draft.lines.length >= MAX_ORDER_LINES) return draft;
  return { ...draft, lines: [...draft.lines, { itemId: item.id, name: item.name, qty: 1 }] };
}

export function setQty(draft: OrderDraft, itemId: string, qty: number): OrderDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) =>
      line.itemId === itemId ? { ...line, qty: clampQty(qty) } : line,
    ),
  };
}

export function removeLine(draft: OrderDraft, itemId: string): OrderDraft {
  return { ...draft, lines: draft.lines.filter((line) => line.itemId !== itemId) };
}

/** Ready to save: a supplier and at least one part. */
export function canSave(draft: OrderDraft): boolean {
  return draft.supplierId !== null && draft.lines.length > 0;
}

/** Whether the form holds anything a back press would lose. */
export function draftChanged(draft: OrderDraft, from: OrderDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(from);
}

/** The command input for this draft: new (`draftOrder`) or a change to one (`editOrder`). */
export function orderInput(draft: OrderDraft, place: boolean) {
  return {
    supplierId: draft.supplierId ?? '',
    note: draft.note.trim() === '' ? null : draft.note.trim(),
    lines: draft.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })),
    place,
  };
}

// ── receiving ──────────────────────────────────────────────────────────────────────────────────

/** What arrived, per part, as the receive form opens: what is still to come on each line. */
export function receiveStart(order: OrderDetailRow): Readonly<Record<string, number>> {
  return Object.fromEntries(order.lines.map((line) => [line.itemId, stillToCome(line)]));
}

export function receiveInput(
  order: OrderDetailRow,
  counts: Readonly<Record<string, number>>,
  note: string,
) {
  return {
    orderId: order.id,
    lines: order.lines.map((line) => ({ itemId: line.itemId, qty: counts[line.itemId] ?? 0 })),
    note: note.trim() === '' ? null : note.trim(),
  };
}

export function receivedTotal(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, qty) => sum + qty, 0);
}

// ── what an order offers ───────────────────────────────────────────────────────────────────────

export type OrderAction = 'place' | 'edit' | 'receive' | 'send' | 'cancel';

/**
 * What a buyer can do with an order at its stage, the main step first: finish a draft and place
 * it; receive what is still to come on a placed one, and send it to the supplier. A cancel closes
 * a draft or whatever has not arrived. Done orders offer nothing.
 */
export function orderActions(stage: OrderStage): readonly OrderAction[] {
  switch (stage) {
    case 'draft':
      return ['place', 'edit', 'cancel'];
    case 'ordered':
    case 'partial':
      return ['receive', 'send', 'cancel'];
    case 'received':
    case 'over':
    case 'cancelled':
      return [];
  }
}

/** Whether an order's lines say how many came ("1 dari 4"): once anything could have arrived. */
export function showsReceived(stage: OrderStage): boolean {
  return stage !== 'draft' && stage !== 'ordered';
}

/** How a stage reads as a chip: its tone and icon. */
export const STAGE_CHIP: Readonly<
  Record<
    OrderStage,
    {
      readonly tone: 'neutral' | 'warning' | 'success' | 'danger';
      readonly icon: 'pending' | 'check' | 'warning' | 'remove' | 'edit';
    }
  >
> = {
  draft: { tone: 'neutral', icon: 'edit' },
  ordered: { tone: 'neutral', icon: 'pending' },
  partial: { tone: 'warning', icon: 'pending' },
  received: { tone: 'success', icon: 'check' },
  over: { tone: 'warning', icon: 'warning' },
  cancelled: { tone: 'neutral', icon: 'remove' },
};

// What the transfer screens (phone and PC) work out from a transfer before they call a command: the
// send draft, what a receive starts at, and what a settlement offers. The commands and rules judge
// the result again; these only keep the screens from offering what they would refuse.
import type { TransferStage } from '../constants.js';
import { ti } from '../i18n.js';
import type { ItemRow } from '../queries.js';
import type { TransferDetailRow, TransferRow } from './queries.js';
import type { TransferLineState } from './state.js';

export const TRANSFER_STAGE_CHIP: Readonly<
  Record<
    TransferStage,
    {
      readonly tone: 'neutral' | 'warning' | 'success' | 'danger';
      readonly icon: 'pending' | 'check' | 'warning' | 'remove';
    }
  >
> = {
  sent: { tone: 'neutral', icon: 'pending' },
  partial: { tone: 'warning', icon: 'pending' },
  done: { tone: 'success', icon: 'check' },
  cancelled: { tone: 'neutral', icon: 'remove' },
  over: { tone: 'danger', icon: 'warning' },
};

export interface StoreChoice {
  readonly id: string;
  readonly name: string;
}

/** A store's name, or a plain "Toko lain" for one this device has not heard of yet. */
export function storeName(stores: readonly StoreChoice[], storeId: string): string {
  return (
    stores.find((store) => store.id === storeId)?.name ?? ti('inventory.transfer.list.otherStore')
  );
}

/** "Ke Toko B" or "Dari Toko A": the other store, from this one's side. */
export function otherStoreText(
  row: Pick<TransferRow, 'direction' | 'fromStoreId' | 'toStoreId'>,
  stores: readonly StoreChoice[],
): string {
  return row.direction === 'out'
    ? ti('inventory.transfer.list.to', { store: storeName(stores, row.toStoreId) })
    : ti('inventory.transfer.list.from', { store: storeName(stores, row.fromStoreId) });
}

/** "2 sparepart · 3 dari 5 sampai". */
export function transferProgress(
  row: Pick<TransferRow, 'lineCount' | 'arrivedQty' | 'sentQty'>,
): string {
  return [
    ti('inventory.transfer.list.parts', { count: row.lineCount }),
    ti('inventory.transfer.list.progress', { arrived: row.arrivedQty, sent: row.sentQty }),
  ].join(' · ');
}

// ── sending ────────────────────────────────────────────────────────────────────────────────────

export interface SendLine {
  readonly itemId: string;
  readonly name: string;
  readonly onHand: number;
  readonly qty: number;
}

export interface SendDraft {
  readonly toStoreId: string | null;
  readonly lines: readonly SendLine[];
  readonly note: string;
}

export const EMPTY_SEND: SendDraft = { toStoreId: null, lines: [], note: '' };

/** A picked part joins the draft at 1, or adds one more when it is already on it. */
export function addSendLine(draft: SendDraft, item: Pick<ItemRow, 'id' | 'name' | 'onHand'>) {
  const existing = draft.lines.find((line) => line.itemId === item.id);
  return {
    ...draft,
    lines:
      existing === undefined
        ? [...draft.lines, { itemId: item.id, name: item.name, onHand: item.onHand, qty: 1 }]
        : draft.lines.map((line) =>
            line.itemId === item.id ? { ...line, qty: line.qty + 1 } : line,
          ),
  };
}

export function setSendQty(draft: SendDraft, itemId: string, qty: number): SendDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) => (line.itemId === itemId ? { ...line, qty } : line)),
  };
}

export function removeSendLine(draft: SendDraft, itemId: string): SendDraft {
  return { ...draft, lines: draft.lines.filter((line) => line.itemId !== itemId) };
}

export function canSend(draft: SendDraft): boolean {
  return draft.toStoreId !== null && draft.lines.some((line) => line.qty > 0);
}

export function sendChanged(draft: SendDraft): boolean {
  return draft.toStoreId !== null || draft.lines.length > 0 || draft.note.trim() !== '';
}

export function sendInput(draft: SendDraft) {
  return {
    toStoreId: draft.toStoreId ?? '',
    note: draft.note.trim() === '' ? null : draft.note.trim(),
    lines: draft.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })),
  };
}

// ── receiving ──────────────────────────────────────────────────────────────────────────────────

/** What is still to come of a part: sent, less what arrived. */
export function stillToCome(line: Pick<TransferLineState, 'sent' | 'arrived'>): number {
  return Math.max(0, line.sent - line.arrived);
}

/** The lines a receive offers: the parts still to come. */
export function receivableLines(transfer: TransferDetailRow): readonly TransferLineState[] {
  return transfer.lines.filter((line) => stillToCome(line) > 0);
}

/** Each part opens at what is still to come; the person sets what actually came. */
export function receiveStart(transfer: TransferDetailRow): Readonly<Record<string, number>> {
  return Object.fromEntries(
    receivableLines(transfer).map((line) => [line.itemId, stillToCome(line)]),
  );
}

export function receiveInput(
  transfer: TransferDetailRow,
  counts: Readonly<Record<string, number>>,
  note: string,
) {
  return {
    transferId: transfer.id,
    lines: receivableLines(transfer).map((line) => ({
      itemId: line.itemId,
      qty: counts[line.itemId] ?? 0,
    })),
    note: note.trim() === '' ? null : note.trim(),
  };
}

export function countTotal(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, qty) => sum + qty, 0);
}

// ── settling ───────────────────────────────────────────────────────────────────────────────────

/** An open transfer settles what is missing; an over one settles the excess as arrived. */
export type SettleMode = 'missing' | 'over';

export function settleMode(transfer: Pick<TransferDetailRow, 'stage'>): SettleMode {
  return transfer.stage === 'over' ? 'over' : 'missing';
}

/** The parts a settlement is about: missing ones, or ones with more recorded than sent. */
export function settleLines(transfer: TransferDetailRow): readonly TransferLineState[] {
  return settleMode(transfer) === 'over'
    ? transfer.lines.filter((line) => line.missing < 0)
    : transfer.lines.filter((line) => line.missing > 0);
}

export interface SettleCounts {
  /** Missing parts: back on this store's shelf. */
  readonly back: Readonly<Record<string, number>>;
  /** Missing parts: written off. */
  readonly lost: Readonly<Record<string, number>>;
  /** An excess: arrived after all. */
  readonly arrived: Readonly<Record<string, number>>;
}

/** Missing parts open as all back on the shelf; an excess opens as all arrived. */
export function settleStart(transfer: TransferDetailRow): SettleCounts {
  const lines = settleLines(transfer);
  const over = settleMode(transfer) === 'over';
  return {
    back: over ? {} : Object.fromEntries(lines.map((line) => [line.itemId, line.missing])),
    lost: {},
    arrived: over ? Object.fromEntries(lines.map((line) => [line.itemId, -line.missing])) : {},
  };
}

export type SettleProblem = 'nothing' | 'tooMany' | 'needReason';

/** Why the settlement cannot be saved yet, or null. */
export function settleProblem(
  transfer: TransferDetailRow,
  counts: SettleCounts,
  reason: string,
): SettleProblem | null {
  const lines = settleLines(transfer);
  const qty = (map: Readonly<Record<string, number>>, itemId: string) => map[itemId] ?? 0;
  let total = 0;
  for (const line of lines) {
    if (settleMode(transfer) === 'over') {
      const arrived = qty(counts.arrived, line.itemId);
      if (arrived > -line.missing) return 'tooMany';
      total += arrived;
    } else {
      const closing = qty(counts.back, line.itemId) + qty(counts.lost, line.itemId);
      if (closing > line.missing) return 'tooMany';
      total += closing;
    }
  }
  if (total === 0) return 'nothing';
  const writesOff = lines.some((line) => qty(counts.lost, line.itemId) > 0);
  if (writesOff && reason.trim() === '') return 'needReason';
  return null;
}

export function settleInput(transfer: TransferDetailRow, counts: SettleCounts, reason: string) {
  const lines: { itemId: string; outcome: 'back' | 'lost' | 'arrived'; qty: number }[] = [];
  for (const line of settleLines(transfer)) {
    for (const outcome of ['back', 'lost', 'arrived'] as const) {
      const qty = counts[outcome][line.itemId] ?? 0;
      if (qty > 0) lines.push({ itemId: line.itemId, outcome, qty });
    }
  }
  return {
    transferId: transfer.id,
    reason: reason.trim() === '' ? null : reason.trim(),
    lines,
  };
}

// ── what this person may do ────────────────────────────────────────────────────────────────────

export type TransferStep = 'receive' | 'settle' | 'cancel';

/**
 * What the person looking may do with the transfer now: the receiving store receives what is still
 * to come; the sender cancels before anything moved; the sending owner settles what is left open.
 */
export function transferSteps(
  transfer: Pick<TransferDetailRow, 'direction' | 'can'>,
  holds: { readonly receive: boolean; readonly transfer: boolean; readonly settle: boolean },
): readonly TransferStep[] {
  const steps: TransferStep[] = [];
  if (transfer.direction === 'in') {
    if (holds.receive && transfer.can.receive) steps.push('receive');
    return steps;
  }
  if (holds.settle && (transfer.can.settleMissing || transfer.can.settleOver)) steps.push('settle');
  if (holds.transfer && transfer.can.cancel) steps.push('cancel');
  return steps;
}

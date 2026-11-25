// Where a transfer's parts are, read from its lines, arrivals and settlements. Nothing here is
// stored: the rules, the queries and the screens all read it through this one fold, so a screen never
// offers what the rules refuse.
//
// Per part: what was sent (what left the sender's stock, not merely what was listed), less what arrived, less what the sender took back (a cancel, or an owner
// settling it as back on the shelf), less what was written off, plus what an owner settled as having
// arrived after all (a write-off undone, or a take-back undone). What is left is "Belum sampai". It goes below zero only when an arrival recorded
// offline crossed a cancel or a settlement: more is then accounted for than was sent, and the sending
// owner settles the difference as arrived.
import type { Kysely } from 'kysely';

import type { SettlementOutcome, TransferStage } from '../constants.js';
import type { InventoryDatabase } from '../schema.js';

export interface TransferLineState {
  readonly itemId: string;
  readonly name: string;
  /** What the sender listed. */
  readonly listed: number;
  /**
   * What actually left the sender's stock for it (its `inventory.stock_sent`): the listed qty, or 0
   * when the movement never came. Only what was sent can arrive or come back.
   */
  readonly sent: number;
  readonly arrived: number;
  /** Back on the sender's shelf: cancelled, or settled as back. */
  readonly back: number;
  readonly lost: number;
  /** Written off, then counted in by the receiver after all. */
  readonly found: number;
  /** Taken back by the sender, then counted in by the receiver after all. */
  readonly arrivedLate: number;
  /** "Belum sampai": below zero when more is accounted for than was sent. */
  readonly missing: number;
}

export interface TransferState {
  readonly id: string;
  readonly fromStoreId: string;
  readonly toStoreId: string;
  readonly transferNumber: string;
  readonly cancelled: boolean;
  readonly cancelledAt: number | null;
  readonly sentBy: string;
  readonly lines: readonly TransferLineState[];
  readonly stage: TransferStage;
}

/** How a transfer reads, from its lines. */
export function transferStage(
  cancelled: boolean,
  lines: readonly Pick<TransferLineState, 'arrived' | 'missing'>[],
): TransferStage {
  if (lines.some((line) => line.missing < 0)) return 'over';
  if (cancelled) return 'cancelled';
  if (lines.every((line) => line.missing === 0)) return 'done';
  return lines.some((line) => line.arrived > 0) ? 'partial' : 'sent';
}

/** What may still be done: the sender cancels or settles, the receiving store records an arrival. */
export function transferActions(state: Pick<TransferState, 'stage' | 'lines' | 'cancelled'>): {
  readonly cancel: boolean;
  readonly settleMissing: boolean;
  readonly settleOver: boolean;
  readonly receive: boolean;
} {
  const untouched = state.lines.every(
    (line) => line.arrived === 0 && line.back === 0 && line.lost === 0,
  );
  const open = state.stage === 'sent' || state.stage === 'partial';
  return {
    cancel: state.stage === 'sent' && untouched,
    settleMissing: open,
    settleOver: state.stage === 'over',
    // Parts written off or taken back can still turn up: the receiver records them, and the
    // transfer then reads as over for the sender to settle as arrived.
    receive: !state.cancelled && state.lines.some((line) => line.arrived < line.sent),
  };
}

type Db = Pick<Kysely<InventoryDatabase>, 'selectFrom'>;

function key(transferId: string, itemId: string): string {
  return `${transferId}:${itemId}`;
}

function sums(rows: readonly { transferId: string; itemId: string; qty: number | string }[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = key(row.transferId, row.itemId);
    map.set(k, (map.get(k) ?? 0) + Number(row.qty));
  }
  return map;
}

/** Transfers of this business and where their parts are, by id; unknown ids are left out. */
export async function loadTransferStates(
  db: Db,
  tenantId: string,
  transferIds: readonly string[],
): Promise<Map<string, TransferState>> {
  const out = new Map<string, TransferState>();
  if (transferIds.length === 0) return out;
  const transfers = await db
    .selectFrom('inventoryTransfers')
    .select(['id', 'storeId', 'toStoreId', 'transferNumber', 'cancelledAt', 'sentBy'])
    .where('tenantId', '=', tenantId)
    .where('id', 'in', transferIds)
    .execute();
  if (transfers.length === 0) return out;
  const ids = transfers.map((row) => row.id);
  const lines = await db
    .selectFrom('inventoryTransferLines')
    .select(['transferId', 'itemId', 'itemName', 'qty'])
    .where('tenantId', '=', tenantId)
    .where('transferId', 'in', ids)
    .orderBy('transferId')
    .orderBy('position')
    .execute();
  // The sender's movements reach the receiving store with the transfer (`otherStore`).
  const moved = await db
    .selectFrom('inventoryMovements')
    .select(['useId', 'storeId', 'itemId', 'qty'])
    .where('tenantId', '=', tenantId)
    .where('kind', '=', 'sent')
    .where('useKind', '=', 'transfer')
    .where('useId', 'in', ids)
    .execute();
  const left = new Map<string, number>();
  const fromOf = new Map(transfers.map((row) => [row.id, row.storeId]));
  for (const row of moved) {
    if (row.useId === null || fromOf.get(row.useId) !== row.storeId) continue;
    const k = key(row.useId, row.itemId);
    left.set(k, (left.get(k) ?? 0) - Number(row.qty));
  }
  const arrived = sums(
    await db
      .selectFrom('inventoryTransferArrivalLines')
      .select(['transferId', 'itemId', 'qty'])
      .where('tenantId', '=', tenantId)
      .where('transferId', 'in', ids)
      .execute(),
  );
  const settled = await db
    .selectFrom('inventoryTransferSettlementLines')
    .select(['transferId', 'itemId', 'qty', 'outcome'])
    .where('tenantId', '=', tenantId)
    .where('transferId', 'in', ids)
    .execute();
  const by = (outcome: SettlementOutcome) => sums(settled.filter((row) => row.outcome === outcome));
  const back = by('back');
  const lost = by('lost');
  const late = by('arrived');
  const found = by('found');
  for (const transfer of transfers) {
    const cancelled = transfer.cancelledAt !== null;
    const states = lines
      .filter((line) => line.transferId === transfer.id)
      .map((line): TransferLineState => {
        const k = key(transfer.id, line.itemId);
        const sent = left.get(k) ?? 0;
        const came = arrived.get(k) ?? 0;
        // A cancel takes back everything sent: it is only allowed before anything moved.
        const backQty = (cancelled ? sent : 0) + (back.get(k) ?? 0);
        const lostQty = lost.get(k) ?? 0;
        const lateQty = late.get(k) ?? 0;
        const foundQty = found.get(k) ?? 0;
        return {
          itemId: line.itemId,
          name: line.itemName,
          listed: Number(line.qty),
          sent,
          arrived: came,
          back: backQty,
          lost: lostQty,
          found: foundQty,
          arrivedLate: lateQty,
          missing: sent - came - backQty - lostQty + foundQty + lateQty,
        };
      });
    out.set(transfer.id, {
      id: transfer.id,
      fromStoreId: transfer.storeId,
      toStoreId: transfer.toStoreId,
      transferNumber: transfer.transferNumber,
      cancelled,
      cancelledAt: transfer.cancelledAt === null ? null : Number(transfer.cancelledAt),
      sentBy: transfer.sentBy,
      lines: states,
      stage: transferStage(cancelled, states),
    });
  }
  return out;
}

/** The transfer and where its parts are, or undefined when this business has no such transfer. */
export async function loadTransferState(
  db: Db,
  tenantId: string,
  transferId: string,
): Promise<TransferState | undefined> {
  return (await loadTransferStates(db, tenantId, [transferId])).get(transferId);
}

/**
 * Whether one part's settlement lines fit what is open on it: missing parts close down to zero
 * (back or written off), an excess up to zero (a write-off or a take-back undone, each only as far
 * as one was recorded), never both at once.
 */
export function settlementFits(
  current: TransferLineState,
  lines: readonly { readonly outcome: SettlementOutcome; readonly qty: number }[],
): boolean {
  const qty = (outcome: SettlementOutcome) =>
    lines.filter((line) => line.outcome === outcome).reduce((sum, line) => sum + line.qty, 0);
  const closing = qty('back') + qty('lost');
  const found = qty('found');
  const arrived = qty('arrived');
  const opening = found + arrived;
  if (closing > 0 && opening > 0) return false;
  if (closing > 0) return closing <= Math.max(0, current.missing);
  return (
    opening <= Math.max(0, -current.missing) &&
    found <= current.lost - current.found &&
    arrived <= current.back - current.arrivedLate
  );
}

/**
 * An excess of `qty` on one part as the lines that settle it: write-offs undone first (no stock
 * moves, the parts never came back), then take-backs (they leave the sender's stock again).
 */
export function excessLines(
  current: TransferLineState,
  qty: number,
): { readonly outcome: 'found' | 'arrived'; readonly qty: number }[] {
  const found = Math.min(qty, Math.max(0, current.lost - current.found));
  const lines: { outcome: 'found' | 'arrived'; qty: number }[] = [];
  if (found > 0) lines.push({ outcome: 'found', qty: found });
  if (qty - found > 0) lines.push({ outcome: 'arrived', qty: qty - found });
  return lines;
}

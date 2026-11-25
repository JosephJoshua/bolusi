// A part's average cost in one store (owner decision 2026-10-28: moving weighted average per store,
// not FIFO). It is worked out when read, from the store's stock movements and the prices typed for
// what arrived, never kept as a running total, so a price filled in late or a movement that synced
// late lands in the right place, and every reader of the same records gets the same answer.
//
// Movements run in the order stock does (queries.ts `stockByPart`): by when they happened on the
// phone, then by id. A count sets what is on hand and keeps the average. A take, a put-back or a send
// to another store moves stock at the average. A priced receipt mixes in: (on hand × average + received × price) ÷ (on hand
// + received), rounded half up to whole rupiah; with nothing (or less than nothing) on hand, or no
// average yet, its price becomes the average. A receipt with no price yet adds stock at the average,
// and says so: the average is then not complete.
import type { MovementKind } from './constants.js';

export interface CostMovement {
  readonly id: string;
  readonly at: number;
  readonly kind: MovementKind;
  /** Signed change to stock; for a count, what it changed by. */
  readonly qty: number;
  /** For a count: how many were counted. */
  readonly counted: number | null;
  /** For a receipt: what a piece cost, or null while nobody has typed it. */
  readonly unitCost: number | null;
}

export interface CostFold {
  /** Rupiah per piece now, or null before any priced receipt. */
  readonly average: number | null;
  /** Receipts in this store whose price is not typed yet. */
  readonly unpriced: number;
  /** The average each movement went out or came in at (a take's cost per piece), by id. */
  readonly at: ReadonlyMap<string, number | null>;
}

/** total ÷ pieces in whole rupiah, half up, in integers. */
function roundedAverage(total: number, pieces: number): number {
  return Math.floor((2 * total + pieces) / (2 * pieces));
}

export function foldCost(movements: readonly CostMovement[]): CostFold {
  const ordered = [...movements].sort((a, b) =>
    a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at - b.at,
  );
  let onHand = 0;
  let average: number | null = null;
  let unpriced = 0;
  const at = new Map<string, number | null>();
  for (const movement of ordered) {
    switch (movement.kind) {
      case 'counted':
        onHand = movement.counted ?? onHand + movement.qty;
        break;
      case 'taken':
      case 'put_back':
      case 'sent':
        onHand += movement.qty;
        break;
      case 'received':
        if (movement.unitCost === null) {
          unpriced += 1;
        } else if (average === null || onHand <= 0) {
          average = movement.unitCost;
        } else {
          average = roundedAverage(
            onHand * average + movement.qty * movement.unitCost,
            onHand + movement.qty,
          );
        }
        onHand += movement.qty;
        break;
      default: {
        // A new movement kind must say how it moves the average.
        const unhandled: never = movement.kind;
        throw new Error(`no cost rule for movement kind ${String(unhandled)}`);
      }
    }
    at.set(movement.id, average);
  }
  return { average, unpriced, at };
}

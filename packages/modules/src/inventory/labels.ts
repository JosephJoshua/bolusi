// How stock movements read in a history: what happened, and the signed change.
import { ti } from './i18n.js';
import type { MovementRow } from './queries.js';

/** "Diambil untuk K7Q-0042", "Dihitung: 5". */
export function movementTitle(movement: MovementRow): string {
  switch (movement.kind) {
    case 'counted':
      return ti('inventory.movement.counted', { count: movement.counted ?? 0 });
    case 'taken':
      return ti('inventory.movement.taken', { use: movement.useLabel ?? '' });
    case 'put_back':
      return ti('inventory.movement.putBack', { use: movement.useLabel ?? '' });
  }
}

/** The change as the shelf saw it: "+2", "−1", or "±0" for a count that matched. */
export function signedQty(qty: number): string {
  if (qty === 0) return '±0';
  return qty > 0 ? `+${String(qty)}` : `−${String(-qty)}`;
}

/** Stock as shown beside a part: a true minus sign below zero, so "−1" never reads as "- 1". */
export function stockText(onHand: number): string {
  return onHand < 0 ? `−${String(-onHand)}` : String(onHand);
}

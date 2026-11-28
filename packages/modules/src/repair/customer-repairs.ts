// A customer's other servisan, listed on each of their servisan (owner decision, 2026-11-28): the
// counter sees at a glance that the phone came back under warranty, or that this is a regular.
//
// Platform-free, so the phone and the counter PC list the same rows with the same words.
import { formatDate, keepCodeWhole } from '@bolusi/i18n';

import { amountOwed, ticketStatus } from './flows.js';
import { statusLabel } from './labels.js';
import type { TicketSummaryRow } from './queries.js';

/** How many of the customer's servisan are read: `listTickets` pages at 100. */
export const PAST_REPAIRS_LIMIT = 100;
/** How many show before "Tampilkan semua". */
export const PAST_REPAIRS_SHOWN = 5;

/** The customer's servisan other than this one, newest first as `listTickets` returns them. */
export function otherRepairs(
  rows: readonly TicketSummaryRow[],
  ticketId: string,
): TicketSummaryRow[] {
  return rows.filter((row) => row.id !== ticketId);
}

export interface PastRepairLine {
  readonly id: string;
  /** The phone, as the board names it. */
  readonly device: string;
  /** When it came in, its number, where it stands and the complaint. */
  readonly detail: string;
  /** What the customer was charged: the repair, or the fee of a cancel. */
  readonly amount: number;
}

export function pastRepairLine(row: TicketSummaryRow): PastRepairLine {
  return {
    id: row.id,
    device: [row.deviceBrand, row.deviceModel].filter((s) => s.trim() !== '').join(' '),
    detail: [
      formatDate(row.createdAt),
      keepCodeWhole(row.ticketNumber),
      statusLabel(ticketStatus(row)),
      row.complaint.trim(),
    ]
      .filter((s) => s !== '')
      .join(' · '),
    amount: amountOwed(row),
  };
}

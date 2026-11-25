// How one transfer reads on the phone and the PC alike: the line beside each part, the sender line,
// the hint under the summary, what happened since, and which step leads. Each screen only draws it.
import { formatDate, formatDateTime } from '@bolusi/i18n';

import { INVENTORY_PERMISSION } from '../constants.js';
import { ti, type InventoryKey } from '../i18n.js';
import { transferSteps, type TransferStep } from './form.js';
import type { TransferDetailRow } from './queries.js';
import type { TransferLineState } from './state.js';

/** "Belum sampai 1", "Lebih 1" or "Tidak terkirim" beside a part, or null when it is settled. */
export function lineStatus(
  line: TransferLineState,
): { readonly text: string; readonly tone: 'warning' | 'danger' } | null {
  if (line.sent === 0) return { text: ti('inventory.transfer.detail.notSent'), tone: 'danger' };
  if (line.missing > 0) {
    return {
      text: ti('inventory.transfer.detail.missing', { count: line.missing }),
      tone: 'warning',
    };
  }
  if (line.missing < 0) {
    return {
      text: ti('inventory.transfer.detail.extra', { count: -line.missing }),
      tone: 'danger',
    };
  }
  return null;
}

/** "3 dari 4 sampai". */
export function lineProgress(line: TransferLineState): string {
  return ti('inventory.transfer.detail.arrivedOf', { arrived: line.arrived, sent: line.sent });
}

/** "Dikirim 20/07/2026 oleh Andi Pratama". */
export function sentLine(row: TransferDetailRow): string {
  return row.sentByName === null
    ? ti('inventory.transfer.detail.sentAt', { date: formatDate(row.sentAt) })
    : ti('inventory.transfer.detail.sent', { date: formatDate(row.sentAt), name: row.sentByName });
}

/** What the summary says under the sender line: an excess to check, or what settling does. */
export function summaryHint(
  row: TransferDetailRow,
): { readonly key: InventoryKey; readonly tone: 'muted' | 'danger' } | null {
  if (row.stage === 'over') return { key: 'inventory.transfer.detail.overHint', tone: 'danger' };
  if (row.stage === 'partial' && row.direction === 'out') {
    return { key: 'inventory.transfer.detail.missingHint', tone: 'muted' };
  }
  return null;
}

export interface TransferLead {
  readonly steps: readonly TransferStep[];
  /** The step the screen offers first, or none. */
  readonly primary: 'receive' | 'settle' | null;
  /** Settling while the parts are still on their way: offered quietly, beside the parts. */
  readonly settleQuietly: boolean;
}

/**
 * What the person may do, and what leads: receiving, or settling once something is known to be
 * short or over. While the parts are still on their way settling waits quietly beside them.
 */
export function transferLead(
  transfer: TransferDetailRow,
  reader: { hasPermission(permissionId: string): boolean },
): TransferLead {
  const steps = transferSteps(transfer, {
    receive: reader.hasPermission(INVENTORY_PERMISSION.receive),
    transfer: reader.hasPermission(INVENTORY_PERMISSION.transfer),
    settle: reader.hasPermission(INVENTORY_PERMISSION.settleTransfer),
  });
  const settleLeads = steps.includes('settle') && transfer.stage !== 'sent';
  return {
    steps,
    primary: steps.includes('receive') ? 'receive' : settleLeads ? 'settle' : null,
    settleQuietly: steps.includes('settle') && !settleLeads,
  };
}

export interface HistoryEntry {
  readonly key: string;
  readonly title: string;
  readonly meta: string;
  readonly detail?: string;
}

/** Arrivals, settlements and a cancel, newest first. */
export function transferHistory(row: TransferDetailRow): readonly HistoryEntry[] {
  const entries: (HistoryEntry & { readonly at: number })[] = [];
  const meta = (at: number, name: string | null) =>
    [formatDateTime(at), name].filter((part) => part !== null).join(' · ');
  const parts = (lines: readonly { readonly name: string; readonly qty: number }[]) =>
    lines
      .map((line) => ti('inventory.transfer.detail.line', { name: line.name, qty: line.qty }))
      .join(', ');
  for (const arrival of row.arrivals) {
    entries.push({
      at: arrival.at,
      key: arrival.id,
      title: `${ti('inventory.transfer.detail.arrival')}: ${parts(arrival.lines)}`,
      meta: meta(arrival.at, arrival.userName),
      ...(arrival.note === null ? {} : { detail: arrival.note }),
    });
  }
  for (const settlement of row.settlements) {
    for (const outcome of ['back', 'lost', 'found', 'arrived'] as const) {
      const lines = settlement.lines.filter((line) => line.outcome === outcome);
      if (lines.length === 0) continue;
      entries.push({
        at: settlement.at,
        key: `${settlement.id}:${outcome}`,
        title: `${ti(`inventory.transfer.outcome.${outcome}`)}: ${parts(lines)}`,
        meta: meta(settlement.at, settlement.userName),
        ...(settlement.reason === null ? {} : { detail: settlement.reason }),
      });
    }
  }
  if (row.cancelledAt !== null) {
    entries.push({
      at: row.cancelledAt,
      key: 'cancelled',
      title: ti('inventory.transfer.stage.cancelled'),
      meta: meta(row.cancelledAt, row.cancelledByName),
      ...(row.cancelReason === null ? {} : { detail: row.cancelReason }),
    });
  }
  return entries
    .sort((a, b) => b.at - a.at)
    .map((entry) => ({
      key: entry.key,
      title: entry.title,
      meta: entry.meta,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    }));
}

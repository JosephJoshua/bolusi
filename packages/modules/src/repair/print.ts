// The repair slips, as printable documents (core `print`): the intake receipt the customer leaves
// with, and the handover slip ("Nota servisan") for a pickup or a cancel. Platform-free, so the phone
// (PDF and system print) and the desktop app (ESC/P and its printers) print the same paper.
//
// Built from what the ticket recorded, in the current language. The phone's unlock code is never
// printed: the slip leaves the store and the code is stored encrypted for a reason.
import { formatDate, formatDateTime, formatMoney } from '@bolusi/i18n';
import type {
  PrintAmountRow,
  PrintBlock,
  PrintDocument,
  PrintField,
  PrintHeader,
  PrintImage,
} from '@bolusi/core';

import type { SlipKind } from './constants.js';
import { ticketStatus } from './flows.js';
import { tn } from './i18n.js';
import { CHECK_STATE_KEY, PRICE_KIND_KEY, optionLabel, statusLabel } from './labels.js';
import type { QuoteLineRow, TicketDetailRow } from './queries.js';

/** What a slip needs besides the ticket. */
export interface SlipContext {
  readonly header: PrintHeader;
  /** The store's terms for this slip, one per line; null prints the app's default terms. */
  readonly terms: string | null;
  readonly printedAt: number;
  readonly printedByName: string | null;
}

export interface HandoverSlipContext extends SlipContext {
  /** Who handed the phone back, printed under the store's signature line. */
  readonly handedOverByName: string | null;
  /** The signature the customer gave on screen, shown on plain paper above their line. */
  readonly signature: PrintImage | null;
}

/** Owner-typed terms: one per non-empty line. */
export function slipTerms(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function deviceName(ticket: TicketDetailRow): string {
  return [ticket.deviceBrand, ticket.deviceModel].filter((part) => part.trim() !== '').join(' ');
}

function common(
  ticket: TicketDetailRow,
  ctx: SlipContext,
  slip: SlipKind,
  title: string,
  jobName: string,
  meta: readonly string[],
  parts: Pick<PrintDocument, 'blocks' | 'aside' | 'closing'>,
): PrintDocument {
  const printed =
    ctx.printedByName === null
      ? tn('repair.slip.printed', { date: formatDateTime(ctx.printedAt) })
      : tn('repair.slip.printedBy', {
          date: formatDateTime(ctx.printedAt),
          name: ctx.printedByName,
        });
  return {
    jobName,
    header: ctx.header,
    title,
    reference: ticket.ticketNumber,
    // The print log counts earlier prints, so this one is the next.
    meta:
      ticket.slipPrints[slip] > 0
        ? [...meta, tn('repair.slip.reprint', { count: ticket.slipPrints[slip] + 1 })]
        : meta,
    ...parts,
    copies: [tn('repair.slip.copy.store'), tn('repair.slip.copy.customer')],
    plyNote: tn('repair.slip.plyNote'),
    footer: printed,
  };
}

function customerFields(ticket: TicketDetailRow): PrintField[] {
  const fields: PrintField[] = [
    { label: tn('repair.slip.field.customer'), value: ticket.customerName },
  ];
  if (ticket.customerPhone !== null && ticket.customerPhone !== '') {
    fields.push({ label: tn('repair.slip.field.phone'), value: ticket.customerPhone });
  }
  fields.push({ label: tn('repair.slip.field.device'), value: deviceName(ticket) });
  if (ticket.deviceColor.trim() !== '') {
    fields.push({ label: tn('repair.slip.field.color'), value: ticket.deviceColor });
  }
  if (ticket.deviceImei !== null && ticket.deviceImei !== '') {
    fields.push({ label: tn('repair.slip.field.imei'), value: ticket.deviceImei });
  }
  return fields;
}

function lineRow(line: QuoteLineRow): PrintAmountRow {
  const description = line.description.trim();
  return {
    label: description === '' ? tn(PRICE_KIND_KEY[line.kind]) : description,
    amount: formatMoney(line.amount),
  };
}

/** Total, then DP and what is left, when something was paid up front. */
function totals(totalLabel: string, total: number, downPayment: number | null): PrintAmountRow[] {
  const rows: PrintAmountRow[] = [
    { label: totalLabel, amount: formatMoney(total), strong: downPayment === null },
  ];
  if (downPayment !== null && downPayment > 0) {
    rows.push({ label: tn('repair.slip.downPayment'), amount: formatMoney(-downPayment) });
    rows.push({
      label: tn('repair.slip.balance'),
      amount: formatMoney(Math.max(0, total - downPayment)),
      strong: true,
    });
  }
  return rows;
}

function termsBlocks(terms: string | null, fallback: string): PrintBlock[] {
  const items = slipTerms(terms ?? fallback);
  return items.length === 0
    ? []
    : [
        { kind: 'heading', text: tn('repair.slip.section.terms') },
        { kind: 'terms', items },
      ];
}

/** The receipt the customer leaves with at intake: the phone as received and the price quoted. */
export function intakeSlip(ticket: TicketDetailRow, ctx: SlipContext): PrintDocument {
  const meta = [tn('repair.slip.received', { date: formatDateTime(ticket.createdAt) })];
  if (ticket.estimatedReadyAt !== null) {
    meta.push(tn('repair.slip.readyBy', { date: formatDate(ticket.estimatedReadyAt) }));
  }
  const fields = customerFields(ticket);
  if (ticket.createdByName !== null) {
    fields.push({ label: tn('repair.slip.field.receivedBy'), value: ticket.createdByName });
  }
  const checks = ticket.checklist.map((check) => {
    const label = optionLabel('checks', { id: check.item, label: check.label });
    const state = tn(CHECK_STATE_KEY[check.state]);
    const note = check.note.trim();
    return note === '' ? `${label}: ${state}` : `${label}: ${state} (${note})`;
  });
  const accessories = ticket.peripherals.map(({ item, label }) =>
    optionLabel('accessories', { id: item, label }),
  );
  // The price the customer left with; later changes belong on the handover slip.
  const lines = ticket.quoteLines.filter((line) => line.status === 'intake');
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const blocks: PrintBlock[] = [
    { kind: 'fields', fields },
    { kind: 'heading', text: tn('repair.slip.section.complaint') },
    { kind: 'paragraph', text: ticket.complaint },
  ];
  if (ticket.intakeNotes.trim() !== '') {
    blocks.push({ kind: 'paragraph', text: ticket.intakeNotes, muted: true });
  }
  if (checks.length > 0) {
    blocks.push(
      { kind: 'heading', text: tn('repair.slip.section.condition') },
      { kind: 'list', items: checks },
    );
  }
  blocks.push({ kind: 'heading', text: tn('repair.slip.section.accessories') });
  blocks.push(
    accessories.length === 0
      ? { kind: 'paragraph', text: tn('repair.slip.noAccessories') }
      : { kind: 'list', items: accessories },
  );
  const aside: PrintBlock[] = [
    { kind: 'heading', text: tn('repair.slip.section.estimate') },
    {
      kind: 'amounts',
      rows: lines.map(lineRow),
      totals: totals(tn('repair.slip.estimateTotal'), total, ticket.downPayment),
    },
    ...termsBlocks(ctx.terms, tn('repair.slip.terms.intake')),
  ];
  const closing: PrintBlock[] = [
    {
      kind: 'signatures',
      slots: [
        { role: tn('repair.slip.sign.customer'), name: ticket.customerName, image: null },
        { role: tn('repair.slip.sign.staff'), name: ticket.createdByName, image: null },
      ],
    },
  ];
  return common(
    ticket,
    ctx,
    'intake',
    tn('repair.slip.intakeTitle'),
    tn('repair.slip.job.intake', { number: ticket.ticketNumber }),
    meta,
    { blocks, aside, closing },
  );
}

/**
 * The slip the customer signs when collecting the phone, which is also their receipt: the work and
 * its price, or the cancellation fee for a cancelled servisan.
 */
export function handoverSlip(ticket: TicketDetailRow, ctx: HandoverSlipContext): PrintDocument {
  const cancelled = ticket.outcome === 'cancelled';
  const meta = [tn('repair.slip.received', { date: formatDateTime(ticket.createdAt) })];
  if (ticket.returnedAt !== null) {
    meta.push(tn('repair.slip.returned', { date: formatDateTime(ticket.returnedAt) }));
  }
  const fields = customerFields(ticket);
  if (ticket.technicianName !== null) {
    fields.push({ label: tn('repair.slip.field.technician'), value: ticket.technicianName });
  }
  // A returned phone's status reads "Sudah diambil"; the slip says how the repair ended instead.
  fields.push({
    label: tn('repair.slip.field.status'),
    value: statusLabel(ticketStatus({ outcome: ticket.outcome, location: 'in_store' })),
  });
  if (cancelled && ticket.outcomeNote !== null && ticket.outcomeNote.trim() !== '') {
    fields.push({ label: tn('repair.slip.field.cancelReason'), value: ticket.outcomeNote });
  }
  const amounts: PrintBlock = cancelled
    ? {
        kind: 'amounts',
        rows: [{ label: tn('repair.cancel.fee'), amount: formatMoney(ticket.cancelFee ?? 0) }],
        totals: totals(tn('repair.slip.total'), ticket.cancelFee ?? 0, ticket.downPayment),
      }
    : {
        kind: 'amounts',
        // What counts toward the total: intake lines and agreed changes, never open proposals.
        rows: ticket.quoteLines
          .filter((line) => line.status === 'intake' || line.status === 'applied')
          .map(lineRow),
        totals: totals(tn('repair.slip.total'), ticket.quoteTotal, ticket.downPayment),
      };
  const aside: PrintBlock[] = [
    { kind: 'heading', text: tn('repair.slip.section.costs') },
    amounts,
    ...termsBlocks(ctx.terms, tn('repair.slip.terms.handover')),
  ];
  const closing: PrintBlock[] = [
    {
      kind: 'signatures',
      slots: [
        {
          role: tn('repair.slip.sign.customerPickup'),
          name: ticket.customerName,
          image: ctx.signature,
        },
        { role: tn('repair.slip.sign.staff'), name: ctx.handedOverByName, image: null },
      ],
    },
  ];
  return common(
    ticket,
    ctx,
    'handover',
    tn('repair.slip.handoverTitle'),
    tn('repair.slip.job.handover', { number: ticket.ticketNumber }),
    meta,
    { blocks: [{ kind: 'fields', fields }], aside, closing },
  );
}

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

import type { MediaRefMime, ThumbnailRef } from '@bolusi/schemas';

import type { SlipKind } from './constants.js';
import {
  amountOwed,
  balanceAfterDownPayment,
  photoInSlot,
  photoThumbnailRef,
  ticketStatus,
} from './flows.js';
import { tn } from './i18n.js';
import {
  CHECK_STATE_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  repairTypeLabel,
  statusLabel,
  warrantyTerms,
} from './labels.js';
import type { PrintSettings, QuoteLineRow, TicketDetailRow } from './queries.js';

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

/** Brand and model, with the colour after them: "Samsung Galaxy A15 (Hitam)". */
function deviceName(ticket: TicketDetailRow): string {
  const name = [ticket.deviceBrand, ticket.deviceModel]
    .filter((part) => part.trim() !== '')
    .join(' ');
  const color = ticket.deviceColor.trim();
  return color === '' ? name : `${name} (${color})`;
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
  if (ticket.deviceImei !== null && ticket.deviceImei !== '') {
    fields.push({ label: tn('repair.slip.field.imei'), value: ticket.deviceImei });
  }
  if (ticket.repairTypes.length > 0) {
    fields.push({
      label: tn('repair.condition.repairTypes'),
      value: ticket.repairTypes.map(repairTypeLabel).join(', '),
    });
  }
  if (ticket.claimOf !== null) {
    fields.push({ label: tn('repair.slip.field.claimOf'), value: ticket.claimOf.ticketNumber });
  }
  return fields;
}

/**
 * Each repair type's warranty, from the day the phone went home: "Ganti layar : s/d 27/11/2026". A
 * claim runs under its servisan's warranty, so its slip prints that one: a claim never extends it.
 */
function warrantyBlocks(ticket: TicketDetailRow): PrintBlock[] {
  const { repairTypes, returnedAt } = ticket.claimOf === null ? ticket : ticket.claimOf;
  return repairTypes.length === 0
    ? []
    : [
        { kind: 'heading', text: tn('repair.warranty.title') },
        {
          kind: 'fields',
          fields: repairTypes.map((type) => ({
            label: repairTypeLabel(type),
            value: warrantyTerms(type, returnedAt),
          })),
        },
      ];
}

function lineRow(line: QuoteLineRow): PrintAmountRow {
  const description = line.description.trim();
  return {
    label: description === '' ? tn(PRICE_KIND_KEY[line.kind]) : description,
    amount: formatMoney(line.amount),
  };
}

/**
 * Total, then what was paid and what is left to pay, or what the store gives back when more was
 * paid (a cancelled servisan whose fee is below its DP). At intake that payment is the DP; on the
 * handover slip it is everything paid so far, the DP and the rest at pickup.
 */
function totals(
  totalLabel: string,
  total: number,
  paidSoFar: number | null,
  paidLabel: string,
  /** False when the total is no longer what the customer owes, so a balance would be wrong. */
  withBalance = true,
): PrintAmountRow[] {
  const paid = paidSoFar ?? 0;
  const rows: PrintAmountRow[] = [
    { label: totalLabel, amount: formatMoney(total), strong: paid === 0 || !withBalance },
  ];
  if (paid > 0) rows.push({ label: paidLabel, amount: formatMoney(-paid) });
  if (paid > 0 && withBalance) {
    const balance = balanceAfterDownPayment(total, paid);
    rows.push({
      label: tn(balance.kind === 'due' ? 'repair.slip.balance' : 'repair.slip.refund'),
      amount: formatMoney(balance.amount),
      strong: true,
    });
  }
  return rows;
}

/** What the customer is billed: the agreed price or the cancellation fee, less any reduction. */
function billTotal(ticket: TicketDetailRow): number {
  return amountOwed(ticket) - ticket.chargeReduced;
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

/**
 * The checklist by state, faults first, each fault with its note:
 * "Rusak : Layar (retak di pojok kiri), Layar sentuh", "Normal : Kamera, Speaker, ...".
 */
function conditionFields(ticket: TicketDetailRow): PrintField[] {
  return (['issue', 'ok', 'not_checked'] as const).flatMap((state) => {
    const checks = ticket.checklist
      .filter((check) => check.state === state)
      .map((check) => {
        const label = optionLabel('checks', { id: check.item, label: check.label });
        const note = check.note.trim();
        return note === '' ? label : `${label} (${note})`;
      });
    return checks.length === 0
      ? []
      : [{ label: tn(CHECK_STATE_KEY[state]), value: checks.join(', ') }];
  });
}

/** The receipt the customer leaves with at intake: the phone as received and the price quoted. */
export function intakeSlip(ticket: TicketDetailRow, ctx: SlipContext): PrintDocument {
  const meta = [tn('repair.slip.received', { date: formatDateTime(ticket.createdAt) })];
  if (ticket.estimatedReadyAt !== null) {
    meta.push(tn('repair.slip.readyBy', { date: formatDate(ticket.estimatedReadyAt) }));
  }
  // Who received the phone signs under the store's line, so it is not a field as well.
  const fields = customerFields(ticket);
  const accessories = ticket.peripherals.map(({ item, label }) =>
    optionLabel('accessories', { id: item, label }),
  );
  fields.push({
    label: tn('repair.slip.field.accessories'),
    value: accessories.length === 0 ? tn('repair.slip.noAccessories') : accessories.join(', '),
  });
  const checks = conditionFields(ticket);
  // The price the customer left with; later changes belong on the handover slip.
  const lines = ticket.quoteLines.filter((line) => line.status === 'intake');
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  // What was paid counts against the estimate only while the estimate is still the bill: once the
  // price changed or the servisan was cancelled, the balance belongs on the handover slip.
  const estimateStands = ticket.outcome !== 'cancelled' && billTotal(ticket) === total;
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
      { kind: 'fields', fields: checks },
    );
  }
  const aside: PrintBlock[] = [
    { kind: 'heading', text: tn('repair.slip.section.estimate') },
    {
      kind: 'amounts',
      rows: lines.map(lineRow),
      totals: totals(
        tn('repair.slip.estimateTotal'),
        total,
        ticket.downPayment,
        // Reprinted after pickup, what was paid is more than the DP.
        tn(ticket.location === 'returned' ? 'repair.slip.paid' : 'repair.slip.downPayment'),
        estimateStands,
      ),
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
  const rows: PrintAmountRow[] = cancelled
    ? [{ label: tn('repair.cancel.fee'), amount: formatMoney(ticket.cancelFee ?? 0) }]
    : // What counts toward the total: intake lines and agreed changes, never open proposals.
      ticket.quoteLines
        .filter((line) => line.status === 'intake' || line.status === 'applied')
        .map(lineRow);
  // An owner's reduction on the money ledger lowers the bill, so the slip matches what is owed.
  if (ticket.chargeReduced > 0) {
    rows.push({ label: tn('repair.slip.reduced'), amount: formatMoney(-ticket.chargeReduced) });
  }
  const amounts: PrintBlock = {
    kind: 'amounts',
    rows,
    totals: totals(
      tn('repair.slip.total'),
      billTotal(ticket),
      ticket.downPayment,
      tn('repair.slip.paid'),
    ),
  };
  const aside: PrintBlock[] = [
    { kind: 'heading', text: tn('repair.slip.section.costs') },
    amounts,
    // The terms are about the repair and its warranty, which a cancelled servisan does not have.
    ...(cancelled ? [] : termsBlocks(ctx.terms, tn('repair.slip.terms.handover'))),
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
    {
      // A cancelled servisan was not repaired, so it carries no warranty.
      blocks: [{ kind: 'fields', fields }, ...(cancelled ? [] : warrantyBlocks(ticket))],
      aside,
      closing,
    },
  );
}

/** The signature a slip shows, to load before building it: the customer's, on a handover slip. */
export function slipSignature(ticket: TicketDetailRow, slip: SlipKind): ThumbnailRef | null {
  const signature = slip === 'handover' ? photoInSlot(ticket, 'signature') : null;
  return signature === null ? null : photoThumbnailRef(signature);
}

/** The store's logo, to load before printing; null when it has none. */
export function logoRef(settings: PrintSettings): ThumbnailRef | null {
  return settings.logo === null
    ? null
    : { kind: 'signed', ...settings.logo, mime: settings.logo.mime as MediaRefMime };
}

/** The top of every page this store prints: its name (or the one set for slips), address, phone. */
export function storeHeader(
  settings: PrintSettings,
  storeName: string,
  logo: PrintImage | null,
): PrintHeader {
  return {
    name: settings.name ?? storeName,
    lines: [settings.address, settings.phone].filter((line) => line.trim() !== ''),
    logo,
  };
}

/** Everything besides the ticket that goes on a slip, as the platform resolved it. */
export interface SlipSources {
  readonly settings: PrintSettings;
  /** The store's own name, printed when the owner has not set another. */
  readonly storeName: string;
  /** The logo and signature (`logoRef`, `slipSignature`), loaded; null leaves one out. */
  readonly logo: PrintImage | null;
  readonly signature: PrintImage | null;
  readonly printedAt: number;
  readonly printedByName: string | null;
}

/** A slip with this store's header and terms: what every platform prints. */
export function slipDocument(
  ticket: TicketDetailRow,
  slip: SlipKind,
  sources: SlipSources,
): PrintDocument {
  const { settings } = sources;
  const ctx: SlipContext = {
    header: storeHeader(settings, sources.storeName, sources.logo),
    terms: slip === 'intake' ? settings.intakeTerms : settings.handoverTerms,
    printedAt: sources.printedAt,
    printedByName: sources.printedByName,
  };
  return slip === 'intake'
    ? intakeSlip(ticket, ctx)
    : handoverSlip(ticket, {
        ...ctx,
        handedOverByName: ticket.returnedByName,
        signature: sources.signature,
      });
}

/**
 * A test page for setting up a printer: the store's header, the paper it was printed for and a
 * ruler across the printable width, so the counter can see the text fits and the form lines up
 * before printing a real slip.
 */
export function testPageDocument(
  header: PrintHeader,
  paperLabel: string,
  printedAt: number,
): PrintDocument {
  return {
    jobName: tn('repair.testPage.job'),
    header,
    title: tn('repair.testPage.title'),
    reference: paperLabel,
    meta: [tn('repair.slip.printed', { date: formatDateTime(printedAt) })],
    blocks: [
      { kind: 'ruler', caption: tn('repair.testPage.ruler') },
      { kind: 'paragraph', text: tn('repair.testPage.check') },
    ],
    aside: [],
    closing: [],
    copies: [],
    plyNote: null,
    footer: null,
  };
}

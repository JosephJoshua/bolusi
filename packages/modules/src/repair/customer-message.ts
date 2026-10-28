// WhatsApp messages from the counter to the customer (owner decision, 2026-10-28): the link to follow
// the repair online, the phone is ready to collect, or a price change waits for the customer's yes. The app writes the message and opens
// WhatsApp on the customer's number; the counter person checks it and presses send. No WhatsApp API:
// it is free, works with the store's own WhatsApp, and nothing is sent without a person.
//
// Platform-free, so the phone and the counter PC write the same words.
import { formatMoney } from '@bolusi/i18n';

import { amountOwed, balanceAfterDownPayment, type RepairAbilities } from './flows.js';
import { tn, type RepairKey } from './i18n.js';
import type { QuoteLineRow, TicketDetailRow } from './queries.js';
import { statusLink } from './status-link.js';
import { whatsAppNumber, whatsAppUrl } from './whatsapp.js';

export { whatsAppNumber, whatsAppUrl };

export type CustomerMessageKind = 'statusLink' | 'ready' | 'priceChange';

/** The button that writes each message: send the link, tell the customer, or ask them. */
export const MESSAGE_ACTION_KEY: Readonly<Record<CustomerMessageKind, RepairKey>> = {
  statusLink: 'repair.message.sendLink',
  ready: 'repair.message.notify',
  priceChange: 'repair.message.ask',
};

/** The servisan's status page under `site`; null without a link code or a site. */
function linkOf(ticket: Pick<TicketDetailRow, 'statusCode'>, site: string | null): string | null {
  return ticket.statusCode === null || site === null ? null : statusLink(site, ticket.statusCode);
}

/**
 * The message the counter can send now, or null. A finished phone still in the store with no price
 * waiting is ready to collect; an open one with changes waiting needs the customer's answer; any
 * other phone in the store can have its status link sent (right after intake, mostly). Mirrors who
 * talks to the customer: whoever takes in phones and records the customer's yes.
 */
export function customerMessageKind(
  ticket: Pick<
    TicketDetailRow,
    'location' | 'outcome' | 'pendingProposals' | 'customerPhone' | 'statusCode'
  >,
  can: Pick<RepairAbilities, 'intake' | 'quoteChange'>,
  site: string | null = null,
): CustomerMessageKind | null {
  if (ticket.location !== 'in_store' || whatsAppNumber(ticket.customerPhone) === null) return null;
  if (ticket.outcome === 'cancelled') return can.intake ? 'ready' : null;
  if (ticket.pendingProposals > 0) return can.quoteChange ? 'priceChange' : null;
  if (ticket.outcome === 'repaired') return can.intake ? 'ready' : null;
  return can.intake && linkOf(ticket, site) !== null ? 'statusLink' : null;
}

/** The WhatsApp link that opens this message to the customer, or null without a usable number. */
export function customerMessageUrl(
  kind: CustomerMessageKind,
  ticket: TicketDetailRow,
  storeName: string | null,
  site: string | null = null,
): string | null {
  const number = whatsAppNumber(ticket.customerPhone);
  return number === null
    ? null
    : whatsAppUrl(number, customerMessage(kind, ticket, storeName, site));
}

function device(ticket: Pick<TicketDetailRow, 'deviceBrand' | 'deviceModel'>): string {
  return [ticket.deviceBrand.trim(), ticket.deviceModel.trim()].filter((s) => s !== '').join(' ');
}

/** The money lines of a ready message: what is owed, and the down payment taken off it. */
function owedLines(ticket: TicketDetailRow): string[] {
  const owed = amountOwed(ticket);
  const cancelled = ticket.outcome === 'cancelled';
  const lines: string[] = [];
  if (!cancelled || owed > 0) {
    lines.push(
      tn(cancelled ? 'repair.message.fee' : 'repair.message.total', { amount: formatMoney(owed) }),
    );
  }
  if (ticket.downPayment !== null) {
    const balance = balanceAfterDownPayment(owed, ticket.downPayment);
    lines.push(tn('repair.message.downPayment', { amount: formatMoney(ticket.downPayment) }));
    const key: RepairKey =
      balance.kind === 'refund' ? 'repair.message.refund' : 'repair.message.due';
    lines.push(tn(key, { amount: formatMoney(balance.amount) }));
  }
  return lines;
}

function priceLine(line: QuoteLineRow): string {
  return `- ${line.description}: ${formatMoney(line.amount)}`;
}

/**
 * The words of a message, in the app's language like the slips. `storeName` is the name the customer
 * knows the store by (the slips' header); null leaves it out. With a `site`, every message carries
 * the servisan's status link.
 */
export function customerMessage(
  kind: CustomerMessageKind,
  ticket: TicketDetailRow,
  storeName: string | null,
  site: string | null = null,
): string {
  const name = ticket.customerName.trim();
  const phone = device(ticket);
  const number = tn('repair.message.number', { number: ticket.ticketNumber });
  const link = linkOf(ticket, site);
  const track = link === null ? [] : [tn('repair.message.track', { link })];
  if (kind === 'statusLink') {
    return [
      storeName === null
        ? tn('repair.message.received', { name, device: phone })
        : tn('repair.message.receivedAt', { name, device: phone, store: storeName }),
      number,
      ...track,
      tn('repair.message.thanks'),
    ].join('\n');
  }
  if (kind === 'priceChange') {
    const waiting = ticket.quoteLines.filter((line) => line.status === 'proposed');
    const total = ticket.quoteTotal + waiting.reduce((sum, line) => sum + line.amount, 0);
    return [
      tn('repair.message.priceChange', { name, device: phone }),
      number,
      ...waiting.map(priceLine),
      tn('repair.message.newTotal', { amount: formatMoney(total) }),
      ...track,
      tn('repair.message.askAgree'),
    ].join('\n');
  }
  const opening =
    ticket.outcome === 'cancelled'
      ? storeName === null
        ? tn('repair.message.cancelled', { name, device: phone })
        : tn('repair.message.cancelledAt', { name, device: phone, store: storeName })
      : storeName === null
        ? tn('repair.message.ready', { name, device: phone })
        : tn('repair.message.readyAt', { name, device: phone, store: storeName });
  return [opening, number, ...owedLines(ticket), ...track, tn('repair.message.thanks')].join('\n');
}

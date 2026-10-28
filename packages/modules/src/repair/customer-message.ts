// WhatsApp messages from the counter to the customer (owner decision, 2026-10-28): the phone is ready
// to collect, or a price change waits for the customer's yes. The app writes the message and opens
// WhatsApp on the customer's number; the counter person checks it and presses send. No WhatsApp API:
// it is free, works with the store's own WhatsApp, and nothing is sent without a person.
//
// Platform-free, so the phone and the counter PC write the same words.
import { formatMoney } from '@bolusi/i18n';

import { amountOwed, balanceAfterDownPayment, type RepairAbilities } from './flows.js';
import { tn, type RepairKey } from './i18n.js';
import type { QuoteLineRow, TicketDetailRow } from './queries.js';

export type CustomerMessageKind = 'ready' | 'priceChange';

/** The button that writes each message: tell the customer, or ask them. */
export const MESSAGE_ACTION_KEY: Readonly<Record<CustomerMessageKind, RepairKey>> = {
  ready: 'repair.message.notify',
  priceChange: 'repair.message.ask',
};

/**
 * The number as WhatsApp links want it: country code first, digits only (`6281234567890`). A number
 * written with `+` or `00` keeps its own country; one without is Indonesian (`0812…`, `812…`,
 * `62812…`). Null when it cannot be a full number.
 */
export function whatsAppNumber(phone: string | null): string | null {
  if (phone === null) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  const international = trimmed.startsWith('+')
    ? digits
    : digits.startsWith('00')
      ? digits.slice(2)
      : digits.startsWith('0')
        ? `62${digits.slice(1)}`
        : digits.startsWith('8')
          ? `62${digits}`
          : digits.startsWith('62')
            ? digits
            : '';
  // "+62 0812…": the trunk 0 is not dialled after the country code.
  const number = international.startsWith('620') ? `62${international.slice(3)}` : international;
  // 62 8xx… is at least 10 digits; the longest numbers anywhere are 15.
  return number.length >= 10 && number.length <= 15 ? number : null;
}

export function whatsAppUrl(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/**
 * The message the counter can send now, or null. A finished phone still in the store with no price
 * waiting is ready to collect; an open one with changes waiting needs the customer's answer. Mirrors
 * who talks to the customer: whoever takes in phones and records the customer's yes.
 */
export function customerMessageKind(
  ticket: Pick<TicketDetailRow, 'location' | 'outcome' | 'pendingProposals' | 'customerPhone'>,
  can: Pick<RepairAbilities, 'intake' | 'quoteChange'>,
): CustomerMessageKind | null {
  if (ticket.location !== 'in_store' || whatsAppNumber(ticket.customerPhone) === null) return null;
  if (ticket.outcome === 'cancelled') return can.intake ? 'ready' : null;
  if (ticket.pendingProposals > 0) return can.quoteChange ? 'priceChange' : null;
  return ticket.outcome === 'repaired' && can.intake ? 'ready' : null;
}

/** The WhatsApp link that opens this message to the customer, or null without a usable number. */
export function customerMessageUrl(
  kind: CustomerMessageKind,
  ticket: TicketDetailRow,
  storeName: string | null,
): string | null {
  const number = whatsAppNumber(ticket.customerPhone);
  return number === null ? null : whatsAppUrl(number, customerMessage(kind, ticket, storeName));
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
 * knows the store by (the slips' header); null leaves it out.
 */
export function customerMessage(
  kind: CustomerMessageKind,
  ticket: TicketDetailRow,
  storeName: string | null,
): string {
  const name = ticket.customerName.trim();
  const phone = device(ticket);
  const number = tn('repair.message.number', { number: ticket.ticketNumber });
  if (kind === 'priceChange') {
    const waiting = ticket.quoteLines.filter((line) => line.status === 'proposed');
    const total = ticket.quoteTotal + waiting.reduce((sum, line) => sum + line.amount, 0);
    return [
      tn('repair.message.priceChange', { name, device: phone }),
      number,
      ...waiting.map(priceLine),
      tn('repair.message.newTotal', { amount: formatMoney(total) }),
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
  return [opening, number, ...owedLines(ticket), tn('repair.message.thanks')].join('\n');
}

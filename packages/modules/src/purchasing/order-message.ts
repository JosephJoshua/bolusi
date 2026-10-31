// The order as a WhatsApp message to the supplier (owner decision, 2026-10-28). The app writes it
// and opens WhatsApp on the supplier's number (or the share sheet when it has none); the buyer
// checks it and presses send. Parts only, never prices: the supplier quotes those.
//
// Platform-free, so the phone and the counter PC write the same words.
import { whatsAppNumber, whatsAppUrl } from '../shared/whatsapp.js';
import { tp } from './i18n.js';
import type { OrderDetailRow } from './queries.js';

type MessageOrder = Pick<
  OrderDetailRow,
  'orderNumber' | 'supplierName' | 'note' | 'lines' | 'supplierPhone'
>;

/** "Halo Sumber Jaya, kami mau pesan:", the numbered parts, the note, and who is asking. */
export function orderMessage(order: MessageOrder, storeName: string | null): string {
  const lines = [
    tp('purchasing.message.greeting', { supplier: order.supplierName }),
    ...order.lines.map((line, i) =>
      tp('purchasing.message.line', { n: i + 1, name: line.name, qty: line.qty }),
    ),
  ];
  if (order.note !== null) lines.push('', tp('purchasing.message.note', { note: order.note }));
  lines.push('', tp('purchasing.message.thanks'));
  lines.push(
    storeName === null || storeName.trim() === ''
      ? order.orderNumber
      : `${storeName.trim()} (${order.orderNumber})`,
  );
  return lines.join('\n');
}

/** The WhatsApp link that opens this order to the supplier, or null without a usable number. */
export function orderMessageUrl(order: MessageOrder, storeName: string | null): string | null {
  const number = whatsAppNumber(order.supplierPhone);
  return number === null ? null : whatsAppUrl(number, orderMessage(order, storeName));
}

// WhatsApp links: the counter messaging a customer (customer-message.ts), and a customer messaging
// the store from their status page (customer-page.ts). On its own so the page loads only this.

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

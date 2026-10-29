// How a customer's phone number and a device's IMEI are checked and stored, the same on the phone,
// the counter PC and in the commands. Platform-free.
import { whatsAppNumber } from './customer-message.js';

/**
 * The number as it is stored: digits only, Indonesian numbers from their trunk 0 (`081234567890`
 * whether typed `0812-3456-7890`, `+62 812 3456 7890` or `812…`), other countries with their `+`.
 * So one customer's number is one string, and search and duplicates see it once. Null for nothing.
 */
export function normalizePhone(text: string): string | null {
  const trimmed = text.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return null;
  const international = trimmed.startsWith('+')
    ? digits
    : digits.startsWith('00')
      ? digits.slice(2)
      : null;
  if (international !== null) {
    if (!international.startsWith('62')) return `+${international}`;
    const local = international.slice(2);
    return local.startsWith('0') ? local : `0${local}`;
  }
  if (digits.startsWith('62')) return `0${digits.slice(2)}`;
  if (digits.startsWith('8')) return `0${digits}`;
  return digits;
}

/**
 * True when a typed number cannot be called or sent a WhatsApp: too short, too long or no area. A
 * mobile number (08…) has at least 10 digits; a 9-digit one is a landline with its area code.
 */
export function phoneInvalid(text: string): boolean {
  const phone = normalizePhone(text);
  if (phone === null) return false;
  if (phone.startsWith('08') && phone.length < 10) return true;
  return whatsAppNumber(phone) === null;
}

/**
 * True when a typed IMEI is not one: an IMEI is 15 digits whose last is a Luhn check digit, so a
 * slip of one digit or a swapped pair is caught. Empty is fine (the IMEI is optional).
 */
export function imeiInvalid(text: string): boolean {
  const digits = text.replace(/[\s-]/g, '');
  if (digits === '') return false;
  if (!/^\d{15}$/.test(digits)) return true;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    let d = Number(digits[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 !== 0;
}

/** The IMEI as it is stored: its digits, or null when none was typed. */
export function normalizeImei(text: string): string | null {
  const digits = text.replace(/[\s-]/g, '');
  return digits === '' ? null : digits;
}

/** Whether two customer records name the same person: the same number and the same name. */
export function sameCustomer(
  a: { readonly name: string; readonly phone: string | null },
  b: { readonly name: string; readonly phone: string | null },
): boolean {
  const name = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');
  const phoneA = a.phone === null ? null : normalizePhone(a.phone);
  return (
    phoneA !== null &&
    phoneA === (b.phone === null ? null : normalizePhone(b.phone)) &&
    name(a.name) === name(b.name)
  );
}

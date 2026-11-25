// Typing money in whole rupiah, shared by every module's amount fields.
import { formatMoney } from '@bolusi/i18n';

/**
 * Whole rupiah from what was typed ("650.000", "Rp 650000"); null when there are no digits or the
 * amount is more than `max`.
 */
export function parseRupiah(text: string, max: number): number | null {
  const digits = text.replace(/\D/g, '');
  if (digits === '') return null;
  const value = Number(digits);
  return value <= max ? value : null;
}

/** Whether a keystroke in an amount field should be kept: a too-long amount is not typed at all. */
export function acceptsRupiahText(text: string, max: number): boolean {
  return text.replace(/\D/g, '') === '' || parseRupiah(text, max) !== null;
}

/** Typed digits as rupiah ("Rp 50.000"); an emptied field stays empty rather than "Rp 0". */
export function rupiahFieldText(digits: string, max: number): string {
  const amount = parseRupiah(digits, max);
  return amount === null ? '' : formatMoney(amount);
}

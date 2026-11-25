// Rupiah typed into a field, the same on every screen: digits only, shown with thousands dots as
// they are typed ("650.000"), and read back as whole rupiah.
import { formatNumber } from '@bolusi/i18n';

/** Whole rupiah from what was typed ("650.000", "Rp 650000"); null with no digits or past `max`. */
export function rupiahFrom(text: string, max: number): number | null {
  const digits = text.replace(/\D/g, '');
  if (digits === '') return null;
  const value = Number(digits);
  return value <= max ? value : null;
}

/** Whether a keystroke should be kept: an amount past `max` is not typed at all. */
export function keepsRupiahText(text: string, max: number): boolean {
  return text.replace(/\D/g, '') === '' || rupiahFrom(text, max) !== null;
}

/** What was typed, with thousands dots ("650.000"); empty stays empty. */
export function groupedRupiah(text: string): string {
  const digits = text.replace(/\D/g, '');
  return digits === '' ? '' : formatNumber(Number(digits));
}

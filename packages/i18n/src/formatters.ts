// Number, currency, date formatting (07-i18n §5). This module is the single formatting
// authority: UI code never calls `Intl` directly, and the shared ESLint config fails any
// `new Intl.` outside this package. All inputs are ms-epoch integers or integer IDR.
import { getLocale } from './instance.js';
import { INTL_LOCALE_TAG, type Locale } from './locale.js';
import { t } from './t.js';

/** Intl inserts U+00A0 after `Rp`; thermal printers and cheap Android font fallbacks mangle it. */
const MINUS = '\u2212';
const NBSP = / /g;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function tagFor(locale: Locale): string {
  return INTL_LOCALE_TAG[locale];
}

// Intl formatter construction is expensive; build each at most once.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const timeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * §5.1: money is locale-independent by design — `Rp` + `id-ID` grouping in every locale, so a
 * figure always matches the printed receipt and never turns into `IDR 250,000` under the `en`
 * toggle. The explicit fraction-digit options are mandatory: CLDR's IDR defaults must not be
 * trusted (FR-1160 — never `Rp 250.000,00`).
 */
const moneyFormat = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function numberFormatFor(locale: Locale): Intl.NumberFormat {
  const tag = tagFor(locale);
  let format = numberFormats.get(tag);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag);
    numberFormats.set(tag, format);
  }
  return format;
}

function dateFormatFor(locale: Locale): Intl.DateTimeFormat {
  const tag = tagFor(locale);
  let format = dateFormats.get(tag);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(tag, { day: '2-digit', month: '2-digit', year: 'numeric' });
    dateFormats.set(tag, format);
  }
  return format;
}

function timeFormatFor(locale: Locale): Intl.DateTimeFormat {
  const tag = tagFor(locale);
  let format = timeFormats.get(tag);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: false });
    timeFormats.set(tag, format);
  }
  return format;
}

/**
 * Integer IDR → `Rp 250.000`. Identical in every locale (§5.1). Below zero it takes a true minus
 * sign, `−Rp 50.000`, so it matches the `+Rp`/`−Rp` the app writes itself and never reads as a dash.
 * The dot-matrix printer folds it back to ASCII.
 */
export function formatMoney(amountIdr: number): string {
  return moneyFormat.format(amountIdr).replace(NBSP, ' ').replace(/^-/, MINUS);
}

/**
 * A phone number as people read it aloud: `0812-3456-7890`. Indonesian mobile numbers group in
 * fours from the front; `+62` and `62` become `0`. Anything else (a landline, a short code, a
 * foreign number) is shown as typed, so nothing a person entered is ever lost.
 */
export function formatPhone(phone: string): string {
  const compact = phone.replace(/[\s.-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return phone;
  const digits = compact.replace(/^\+?62/, '0');
  if (!/^08\d{8,11}$/.test(digits)) return phone;
  return [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8)].join('-');
}

/**
 * A number written on screen (a phone, an IMEI) that may only wrap where its words do: the spaces
 * and hyphens between its digits become non-breaking ones, so a large font moves the whole number
 * to the next line instead of splitting it ("0812-3456-" / "7890"). Screen text only: the
 * dot-matrix codepage has no non-breaking hyphen, so slips print `formatPhone` as it is.
 */
export function keepNumbersWhole(text: string): string {
  return text.replace(/(\d)([ -])(?=\d)/g, (_, digit: string, gap: string) =>
    gap === ' ' ? `${digit}\u00A0` : `${digit}\u2011`,
  );
}

/** Counts and quantities, never money — active-locale grouping (§5.2). */
export function formatNumber(value: number): string {
  return numberFormatFor(getLocale()).format(value).replace(NBSP, ' ');
}

/** ms-epoch → `14/07/2026`. Day-first in both locales (§5.2). Device timezone, no conversion. */
export function formatDate(msEpoch: number): string {
  return dateFormatFor(getLocale()).format(msEpoch).replace(NBSP, ' ');
}

/** ms-epoch → `14.30` (id) / `14:30` (en). 24-hour clock (§5.2). */
export function formatTime(msEpoch: number): string {
  return timeFormatFor(getLocale()).format(msEpoch).replace(NBSP, ' ');
}

/** ms-epoch → `14/07/2026 14.30` (§5.2). */
export function formatDateTime(msEpoch: number): string {
  return `${formatDate(msEpoch)} ${formatTime(msEpoch)}`;
}

/**
 * §5.3: `Intl.RelativeTimeFormat` is unreliable on Hermes and is never used — relative time is
 * catalog copy instead. Callers compute `deltaMs` server-relative (api/01-sync §7); raw
 * device-clock arithmetic is not a valid input.
 */
export function formatRelative(deltaMs: number): string {
  const elapsed = Math.max(0, deltaMs);
  if (elapsed < MINUTE_MS) return t('core.time.justNow');
  if (elapsed < HOUR_MS)
    return t('core.time.minutesAgo', { count: Math.floor(elapsed / MINUTE_MS) });
  if (elapsed < DAY_MS) return t('core.time.hoursAgo', { count: Math.floor(elapsed / HOUR_MS) });
  return t('core.time.daysAgo', { count: Math.floor(elapsed / DAY_MS) });
}

/**
 * Durations such as PIN-lockout waits (§5.3). Rounded up: a wait must never be under-promised.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / SECOND_MS));
  if (seconds < 60) return t('core.time.durationSeconds', { count: seconds });
  return t('core.time.durationMinutes', { count: Math.ceil(seconds / 60) });
}

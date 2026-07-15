// Number, currency, date formatting (07-i18n §5). This module is the single formatting
// authority: UI code never calls `Intl` directly, and the shared ESLint config fails any
// `new Intl.` outside this package. All inputs are ms-epoch integers or integer IDR.
import { getLocale } from './instance.js';
import { INTL_LOCALE_TAG, type Locale } from './locale.js';
import { t } from './t.js';

/** Intl inserts U+00A0 after `Rp`; thermal printers and cheap Android font fallbacks mangle it. */
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

/** Integer IDR → `Rp 250.000`. Identical in every locale (§5.1). */
export function formatMoney(amountIdr: number): string {
  return moneyFormat.format(amountIdr).replace(NBSP, ' ');
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

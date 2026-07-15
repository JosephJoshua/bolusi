// The 07-i18n §5.4 golden vectors, defined once and executed twice: on Node (stage 4) and on the
// Hermes VM (stage 6, release-blocking). Hermes ships only a subset of Intl, so a vector that is
// green on Node proves nothing about the device — hence the shared definition and the standalone
// Hermes entry next to this file.
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatTime,
  initI18n,
  setLocale,
  t,
  type Locale,
} from '../src/index.js';

export interface VectorResult {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

/**
 * 2026-07-14 14:30 **local time**. §5.2 renders in the device timezone with no conversion, so
 * building the instant from local parts keeps the vectors identical under any CI or device TZ —
 * a UTC epoch would make the expected output timezone-dependent.
 */
export const VECTOR_INSTANT_MS = new Date(2026, 6, 14, 14, 30, 0, 0).getTime();

export function runI18nVectors(): VectorResult[] {
  initI18n({ locale: 'id' });

  const results: VectorResult[] = [];
  const check = (name: string, expected: string, actual: string) => {
    results.push({ name, expected, actual, ok: actual === expected });
  };

  // Money is locale-independent by design (§5.1) — assert it in both locales.
  for (const locale of ['id', 'en'] satisfies Locale[]) {
    setLocale(locale);
    check(`formatMoney(250000) [${locale}]`, 'Rp 250.000', formatMoney(250000));
    check(`formatDate(2026-07-14) [${locale}]`, '14/07/2026', formatDate(VECTOR_INSTANT_MS));
  }

  setLocale('id');
  check('formatMoney(0)', 'Rp 0', formatMoney(0));
  check('formatMoney(1500500)', 'Rp 1.500.500', formatMoney(1500500));
  check('formatMoney(-50000)', '-Rp 50.000', formatMoney(-50000));
  check('formatTime(14:30) [id]', '14.30', formatTime(VECTOR_INSTANT_MS));
  check('formatNumber(1234567) [id]', '1.234.567', formatNumber(1234567));

  setLocale('en');
  check('formatTime(14:30) [en]', '14:30', formatTime(VECTOR_INSTANT_MS));
  check('formatNumber(1234567) [en]', '1,234,567', formatNumber(1234567));

  // The plural vector: proves ICU plural selection works, which depends on Intl.PluralRules.
  // If THIS is the vector that fails on Hermes, the §2 contingency applies — add
  // @formatjs/intl-pluralrules (and nothing else from FormatJS) and re-run.
  check(
    't(auth.pin.attemptsLeft, {count: 1}) [en]',
    '1 try left',
    t('auth.pin.attemptsLeft', { count: 1 }),
  );

  setLocale('id');
  return results;
}

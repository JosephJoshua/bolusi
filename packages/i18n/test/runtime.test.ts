// Runtime behavior of the catalog: locale switching, the §6 fallback/missing-key contract, and
// the §4.2 unknown-code path.
//
// Asserting catalog copy here is deliberate: this package's public behavior IS the catalog, and
// ui-labels.md is its change-control surface. Other packages' tests never assert UI copy.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatDuration,
  formatRelative,
  humanizeKey,
  initI18n,
  setLocale,
  t,
  translateErrorCode,
  translateRejectionCode,
  type I18nLogger,
} from '../src/index.js';
import { resetWarnOnceState } from '../src/logger.js';

type WarnFn = I18nLogger['warn'];

const spyWarn = () => vi.fn<WarnFn>();

function withSpyLogger(locale: 'id' | 'en' = 'id') {
  const warn = spyWarn();
  resetWarnOnceState();
  initI18n({ locale, logger: { warn } });
  return warn;
}

beforeEach(() => {
  resetWarnOnceState();
});

describe('locale round-trip (07-i18n §1)', () => {
  it('starts in id, toggles to en, and back', () => {
    initI18n({ locale: 'id' });
    expect(t('core.action.save')).toBe('Simpan');

    setLocale('en');
    expect(t('core.action.save')).toBe('Save');

    setLocale('id');
    expect(t('core.action.save')).toBe('Simpan');
  });

  it('defaults to id with no locale given (§1)', () => {
    initI18n();
    expect(t('core.action.save')).toBe('Simpan');
  });

  it('renders ICU plurals in en and plain interpolation in id (§3.2)', () => {
    initI18n({ locale: 'en' });
    expect(t('auth.pin.attemptsLeft', { count: 1 })).toBe('1 try left');
    expect(t('auth.pin.attemptsLeft', { count: 3 })).toBe('3 tries left');

    setLocale('id');
    expect(t('auth.pin.attemptsLeft', { count: 1 })).toBe('Sisa 1 kesempatan');
    expect(t('auth.pin.attemptsLeft', { count: 3 })).toBe('Sisa 3 kesempatan');
  });

  it('falls back zh → id, since zh is scaffolded with no catalog (§1, §6)', () => {
    initI18n({ locale: 'zh' });
    expect(t('core.action.save')).toBe('Simpan');
  });

  it('passes pre-formatted values through as strings (§3.2)', () => {
    initI18n({ locale: 'id' });
    expect(t('auth.pin.wait', { duration: '2 menit' })).toBe(
      'Terlalu banyak salah. Tunggu 2 menit.',
    );
  });
});

describe('missing keys (07-i18n §6)', () => {
  it('renders the id value and logs once per key per session when a key is missing in en', () => {
    const warn = spyWarn();
    resetWarnOnceState();

    // Simulate an en gap the parity gate would normally have caught pre-merge. Safe to mutate:
    // initI18n hands i18next its own structural copy of the generated catalog.
    const instance = initI18n({ locale: 'en', logger: { warn } });
    instance.removeResourceBundle('en', 'translation');
    instance.addResourceBundle('en', 'translation', { core: { action: {} } }, true, true);

    expect(t('core.action.save')).toBe('Simpan');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('core.action.save');

    // Second call: the value still renders, but nothing new is logged.
    expect(t('core.action.save')).toBe('Simpan');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not log a fallback when the active locale has the key', () => {
    const warn = withSpyLogger('en');
    expect(t('core.action.save')).toBe('Save');
    expect(warn).not.toHaveBeenCalled();
  });

  it('humanizes the final segment and never shows the raw dotted key', () => {
    expect(humanizeKey('auth.pin.attemptsLeft')).toBe('Attempts left');
    expect(humanizeKey('core.action.save')).toBe('Save');
  });

  it('renders the humanized segment — not the key — when a key is absent everywhere', () => {
    const warn = spyWarn();
    resetWarnOnceState();
    const instance = initI18n({ locale: 'id', logger: { warn } });

    const rendered = instance.t('auth.pin.attemptsLeft' as never, { count: 1 });
    expect(rendered).toBe('Sisa 1 kesempatan');

    // A key in no catalog at all: the emergency degradation path.
    const absent = instance.t('auth.pin.neverDefined' as never);
    expect(absent).toBe('Never defined');
    expect(absent).not.toContain('auth.pin');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('derived error and rejection copy (07-i18n §4.2, §4.3)', () => {
  it('derives the key from the code — no mapping table', () => {
    initI18n({ locale: 'id' });
    expect(translateErrorCode('ROLE_IN_USE')).toBe(t('core.errors.ROLE_IN_USE'));
    expect(translateRejectionCode('CHAIN_BROKEN')).toBe(t('core.rejection.CHAIN_BROKEN'));
  });

  it('renders UNEXPECTED and logs for an unknown error code', () => {
    const warn = withSpyLogger('id');
    expect(translateErrorCode('NOT_A_REAL_CODE')).toBe(t('core.errors.UNEXPECTED'));
    expect(translateErrorCode('NOT_A_REAL_CODE')).toBe('Terjadi kesalahan. Coba lagi.');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('NOT_A_REAL_CODE');
  });

  it('renders UNEXPECTED and logs for an unknown rejection code', () => {
    const warn = withSpyLogger('id');
    expect(translateRejectionCode('NOT_A_REAL_REJECTION')).toBe(t('core.errors.UNEXPECTED'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('translates every code in both locales', () => {
    initI18n({ locale: 'en' });
    expect(translateErrorCode('PIN_LOCKED')).toBe(
      'PIN locked. Ask the store owner to unlock it or set a new PIN.',
    );
    setLocale('id');
    expect(translateErrorCode('PIN_LOCKED')).toContain('PIN terkunci.');
  });
});

describe('formatRelative / formatDuration (07-i18n §5.3)', () => {
  beforeEach(() => {
    initI18n({ locale: 'id' });
  });

  it('selects justNow under 60 s', () => {
    expect(formatRelative(0)).toBe('baru saja');
    expect(formatRelative(59_999)).toBe('baru saja');
  });

  it('selects minutesAgo from 60 s', () => {
    expect(formatRelative(60_000)).toBe('1 menit lalu');
    expect(formatRelative(59 * 60_000)).toBe('59 menit lalu');
  });

  it('selects hoursAgo from 60 min', () => {
    expect(formatRelative(60 * 60_000)).toBe('1 jam lalu');
    expect(formatRelative(23 * 60 * 60_000)).toBe('23 jam lalu');
  });

  it('selects daysAgo from 24 h', () => {
    expect(formatRelative(24 * 60 * 60_000)).toBe('1 hari lalu');
  });

  it('pluralizes the boundaries in en', () => {
    setLocale('en');
    expect(formatRelative(60_000)).toBe('1 minute ago');
    expect(formatRelative(120_000)).toBe('2 minutes ago');
    expect(formatRelative(24 * 60 * 60_000)).toBe('1 day ago');
  });

  it('selects durationSeconds then durationMinutes, rounding up so a wait is never under-promised', () => {
    expect(formatDuration(30_000)).toBe('30 detik');
    expect(formatDuration(59_000)).toBe('59 detik');
    expect(formatDuration(60_000)).toBe('1 menit');
    expect(formatDuration(90_000)).toBe('2 menit');

    setLocale('en');
    expect(formatDuration(1_000)).toBe('1 second');
    expect(formatDuration(30_000)).toBe('30 seconds');
    expect(formatDuration(60_000)).toBe('1 minute');
  });
});

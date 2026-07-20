// Every label key these screens reference exists in BOTH the `id` and `en` catalogs
// (this task's acceptance: "i18n: every label key referenced by these screens exists in BOTH id and
// en catalogs (key-existence test)").
//
// WHY THIS IS A REAL GATE AND NOT A RESTATEMENT. Two of the key families these screens render are
// DERIVED at runtime from a code, not written as literals: `core.rejection.<CODE>` (05 §8's closed
// set) and `core.errors.<CODE>` (04 §5.3's registry). Derived keys are invisible to the compiler —
// `TranslationKey` cannot check them — so they are exactly the keys that can go missing without
// anything failing until a cashier is looking at `core.rejection.CHAIN_HALTED` on a screen.
//
// The static keys the screens use ARE compiler-checked (t() takes the generated union), so this file
// deliberately covers the derived ones plus the handful of screen keys that arrive through a
// `satisfies Record<…>` map, where the value type is `string` rather than `TranslationKey`.
import { hasKey, LOCALES, SELECTABLE_LOCALES, type Locale } from '@bolusi/i18n';
import { describe, expect, test } from 'vitest';

import { failureKey } from './enrollment/model.js';
import { PIN_MESSAGE_KEY } from './pin/model.js';
import { categoryNameKey, localeNameKey, MUTABLE_PUSH_CATEGORIES } from './settings/model.js';
import { SWITCHER_EMPTY_CTA_KEY, SWITCHER_LOCK_KEY } from './switcher/model.js';
import { MEDIA_STATUS_KEY, REASSURANCE_KEY } from './sync-status/model.js';

/**
 * The catalogs a v0 user can actually reach. `zh` is scaffolded in `LOCALES` but ships NO catalog
 * (07-i18n §1), so asserting against it would fail every key. `SELECTABLE_LOCALES` is the honest
 * denominator — and the assertion below pins that it really is {id, en}, so a future `zh` catalog
 * joins this gate automatically instead of silently escaping it.
 */
const CATALOGS: readonly Locale[] = SELECTABLE_LOCALES;

/** 05-operation-log §8's closed rejection-code set, as ui-labels.md seeds it. */
const REJECTION_CODES = [
  'BAD_SIGNATURE',
  'CHAIN_BROKEN',
  'CHAIN_GAP',
  'CHAIN_HALTED',
  'DEVICE_REVOKED',
  'SCHEMA_INVALID',
  'SCOPE_VIOLATION',
  'UNKNOWN_TYPE',
] as const;

/** The DomainError codes these screens can actually render (04 §5.3 subset + transport codes). */
const ERROR_CODES = [
  'NOT_AUTHENTICATED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UNEXPECTED',
  'NETWORK',
  'DEVICE_NOT_ENROLLED',
  'USER_DEACTIVATED',
  'PIN_RATE_LIMITED',
  'PIN_LOCKED',
] as const;

/** Assert a key resolves in every shipping catalog, naming the locale that failed. */
function expectInEveryCatalog(key: string): void {
  for (const locale of CATALOGS) {
    expect(hasKey(key, locale), `${key} missing in '${locale}'`).toBe(true);
  }
}

describe('the gate`s own denominator (T-14 — a guard must assert its own coverage)', () => {
  test('the catalogs under test are exactly id and en', () => {
    // If this list were ever empty — or silently reduced to one locale — every `expectInEveryCatalog`
    // below would pass vacuously while checking nothing. That is the failure mode CLAUDE.md §2.11
    // names: a guard whose failure mode is "silently checks nothing".
    expect([...CATALOGS].sort()).toEqual(['en', 'id']);
    expect(CATALOGS.length).toBeGreaterThan(1);
  });

  test('`zh` is excluded because it ships no catalog, not because it passes', () => {
    expect(LOCALES).toContain('zh');
    expect(CATALOGS).not.toContain('zh');
    // Prove the exclusion is load-bearing: zh genuinely has no rows, so including it would fail.
    expect(hasKey('auth.pin.title', 'zh')).toBe(false);
  });

  test('hasKey actually discriminates — a nonsense key is absent in every catalog', () => {
    // T-13 (interrogate the oracle): if `hasKey` returned true for everything, every assertion in
    // this file would be green and meaningless.
    for (const locale of CATALOGS) {
      expect(hasKey('core.errors.NO_SUCH_CODE_EXISTS', locale)).toBe(false);
    }
  });
});

describe('derived keys — the ones the compiler cannot check', () => {
  test('every rejection code in 05 §8`s closed set has a row in both catalogs', () => {
    let covered = 0;
    for (const code of REJECTION_CODES) {
      expectInEveryCatalog(`core.rejection.${code}`);
      covered += 1;
    }
    expect(covered).toBe(REJECTION_CODES.length);
    expect(covered).toBe(8);
  });

  test('every error code these screens can render has a row in both catalogs', () => {
    let covered = 0;
    for (const code of ERROR_CODES) {
      expectInEveryCatalog(`core.errors.${code}`);
      covered += 1;
    }
    expect(covered).toBe(ERROR_CODES.length);
    expect(covered).toBeGreaterThan(0);
  });

  test('every enrollment failure leg resolves a real key', () => {
    // The wizard's four buckets plus the fallback — the copy a user sees when enrollment fails is
    // the whole of what stands between them and a brick.
    expectInEveryCatalog(failureKey({ kind: 'credentials' }));
    expectInEveryCatalog(failureKey({ kind: 'rateLimited', retryAfterSeconds: 30 }));
    expectInEveryCatalog(failureKey({ kind: 'notPermitted' }));
    expectInEveryCatalog(failureKey({ kind: 'offline' }));
    expectInEveryCatalog(failureKey({ kind: 'unexpected', code: 'UNEXPECTED' }));
  });
});

describe('screen key maps', () => {
  test('every PIN view`s message key exists (null for `entry` is deliberate)', () => {
    let checked = 0;
    for (const [kind, key] of Object.entries(PIN_MESSAGE_KEY)) {
      if (key === null) {
        expect(kind).toBe('entry');
        continue;
      }
      expectInEveryCatalog(key);
      checked += 1;
    }
    // entry has no message; the other three do.
    expect(checked).toBe(3);
  });

  test('every switcher state headline key exists, plus the CTA and the lock explanation', () => {
    // task 65 deleted the `SWITCHER_KEY` decoy map (the screen never read it — §2.8). These are the
    // headline keys `SwitcherScreen` ACTUALLY renders: the empty/error/unauthorized `ListState`
    // titles, and the always-present screen title. `loading` is omitted deliberately — it is a
    // spinner with no headline, which is exactly the misfit the decoy map hid.
    const switcherHeadlineKeys = [
      'core.status.empty',
      'core.errors.UNEXPECTED',
      'core.errors.PERMISSION_DENIED',
      'auth.switcher.title',
    ] as const;
    for (const key of switcherHeadlineKeys) expectInEveryCatalog(key);
    expectInEveryCatalog(SWITCHER_EMPTY_CTA_KEY);
    expectInEveryCatalog(SWITCHER_LOCK_KEY);
  });

  test('every sync-status reassurance and media-status key exists', () => {
    for (const key of Object.values(REASSURANCE_KEY)) expectInEveryCatalog(key);
    for (const key of Object.values(MEDIA_STATUS_KEY)) expectInEveryCatalog(key);
    expect(Object.values(REASSURANCE_KEY)).toHaveLength(4);
    expect(Object.values(MEDIA_STATUS_KEY)).toHaveLength(3);
  });

  test('every settings key exists — languages and mutable push categories', () => {
    for (const locale of SELECTABLE_LOCALES) expectInEveryCatalog(localeNameKey(locale));
    for (const category of MUTABLE_PUSH_CATEGORIES) expectInEveryCatalog(categoryNameKey(category));
    expectInEveryCatalog('core.settings.language');
  });
});
